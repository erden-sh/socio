/**
 * The in-process import (CB-380), operators only:
 *
 *   GET  /api/operator/bundles          the bundles under BACKUP_DIR/bundles/
 *   POST /api/operator/bundles/import   { bundle, apply?, spaceMap?, terms?, keepNumbersStrict? }
 *   GET  /api/operator/bundles/import   the current or last run, with its report
 *
 * An import runs inside the live server, so nothing has to stop: its writes
 * go through the server's own connection in chunked transactions. One runs
 * at a time, in the background; the POST answers 202 at once. A bundle is
 * named, never given as a path: only directories directly under
 * `BACKUP_DIR/bundles/` can be read.
 *
 * `bundleImports` is that one-at-a-time runner. The routes and the live
 * CLI channel (live.ts, `bundle-cli.js import --live`) share one, so both
 * run the same code, with the same checks, one import at a time.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireOperator } from '@socio/foundation/http/guards';

import type { FileSink } from './file-sink.js';
import { BundleError, BundleReader } from './files.js';
import { importBundle, type ImportReport, type ImportSafety } from './import.js';

export interface BundleRouteSources {
    db: DatabaseSync;
    /** BACKUP_DIR: bundles are read from its `bundles/` directory. */
    backupDir: string;
    files: FileSink;
    /** The backup check and the copy before the first write. */
    safety: ImportSafety;
    log: (line: string) => void;
}

export const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** What starts an import, from the web or the live CLI channel. */
export const importInput = z
    .object({
        bundle: z.string().regex(BUNDLE_NAME),
        apply: z.boolean().optional(),
        spaceMap: z.record(z.string().min(1).max(200), z.string().min(1).max(200)).optional(),
        terms: z.array(z.string().min(1).max(100)).max(100).optional(),
        keepNumbersStrict: z.boolean().optional(),
    })
    .strict();
export type ImportInput = z.infer<typeof importInput>;

export interface BundleRun {
    state: 'running' | 'done' | 'failed';
    bundle: string;
    apply: boolean;
    /** The operator it runs as (from the CLI: on whose behalf). */
    by: string;
    /** How it was started: an operator's session ('web') or the live CLI channel ('cli'). */
    via: 'web' | 'cli';
    startedAt: number;
    finishedAt?: number;
    report?: ImportReport;
    error?: string;
}

/** The one-at-a-time runner of in-process imports. */
export interface BundleImports {
    /** The current or last run. */
    current(): BundleRun | undefined;
    /**
     * Starts an import in the background, as `operatorId` (whom the caller
     * checked is an operator). Undefined when one is running already.
     */
    start(
        input: ImportInput,
        operatorId: string,
        via: 'web' | 'cli',
    ): { run: BundleRun; done: Promise<void> } | undefined;
    /** Resolves when the current run (if any) ends. */
    idle(): Promise<void>;
}

export function bundleImports(sources: BundleRouteSources): BundleImports {
    let current: BundleRun | undefined;
    let running: Promise<void> | undefined;
    const root = join(sources.backupDir, 'bundles');
    return {
        current: () => current,
        idle: () => running ?? Promise.resolve(),
        start(input, operatorId, via) {
            if (current?.state === 'running') {
                return undefined;
            }
            const { bundle: name, apply = false, spaceMap, terms, keepNumbersStrict } = input;
            const dir = join(root, name);
            const run: BundleRun = {
                state: 'running',
                bundle: name,
                apply,
                by: operatorId,
                via,
                startedAt: Date.now(),
            };
            current = run;
            const who = via === 'cli' ? `the CLI, for ${operatorId}` : operatorId;
            sources.log(`Bundle import ${apply ? 'started' : 'dry run started'}: ${name}, by ${who}.`);
            running = (async () => {
                try {
                    const bundle = await BundleReader.open(dir);
                    run.report = await importBundle({
                        db: sources.db,
                        bundle,
                        apply,
                        operatorId,
                        via,
                        files: sources.files,
                        ...(spaceMap ? { spaceMap } : {}),
                        ...(terms ? { terms } : {}),
                        ...(keepNumbersStrict ? { keepNumbersStrict } : {}),
                        safety: sources.safety,
                    });
                    run.state = 'done';
                    sources.log(
                        `Bundle import ${apply ? 'applied' : 'dry run done'}: ${name}, by ${who}, ${Object.entries(
                            run.report.counts,
                        )
                            .map(([kind, actions]) => `${kind} ${JSON.stringify(actions)}`)
                            .join('; ')}.`,
                    );
                } catch (error) {
                    run.state = 'failed';
                    // Our own messages name no secrets; anything else is cut short.
                    run.error =
                        error instanceof BundleError
                            ? error.message
                            : `The import failed: ${(error instanceof Error ? error.message : 'unknown error').slice(0, 300)}`;
                    sources.log(`Bundle import failed: ${name}, by ${who}: ${run.error}`);
                } finally {
                    run.finishedAt = Date.now();
                }
            })();
            return { run, done: running };
        },
    };
}

/** The routes; `idle()` resolves when the current run (if any) ends, for tests. */
export function bundleRoutes(sources: BundleRouteSources, imports: BundleImports = bundleImports(sources)) {
    const app = new Hono<AppEnv>();
    const root = join(sources.backupDir, 'bundles');
    app.use('/operator/bundles', requireOperator);
    app.use('/operator/bundles/*', requireOperator);
    app.get('/operator/bundles', (c) => {
        const bundles = existsSync(root)
            ? readdirSync(root)
                  .filter((name) => BUNDLE_NAME.test(name) && !name.endsWith('.partial'))
                  .filter((name) => statSync(join(root, name)).isDirectory())
                  .flatMap((name) => {
                      try {
                          const manifest = JSON.parse(readFileSync(join(root, name, 'manifest.json'), 'utf8'));
                          return [
                              {
                                  name,
                                  createdAt: manifest.createdAt,
                                  source: manifest.source,
                                  counts: manifest.counts,
                              },
                          ];
                      } catch {
                          return [];
                      }
                  })
            : [];
        return c.json({ bundles });
    });
    app.get('/operator/bundles/import', (c) => c.json({ run: imports.current() ?? null }));
    app.post('/operator/bundles/import', async (c) => {
        const parsed = importInput.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: 'Name a bundle under BACKUP_DIR/bundles/ (letters, digits, . _ -).' }, 400);
        }
        const started = imports.start(parsed.data, c.get('user').id, 'web');
        if (!started) {
            return c.json({ error: 'An import is running. Wait for it to end.', run: imports.current() }, 409);
        }
        return c.json({ run: started.run }, 202);
    });
    return Object.assign(app, { idle: () => imports.idle() });
}
