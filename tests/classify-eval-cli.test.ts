import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { FAILURE_LABELS } from '@socio/shared/classify';

import { runEvalCli } from '../src/server/classify/eval-cli.js';
import { ClassifyService } from '../src/server/classify/service.js';
import { InferenceService } from '../src/server/inference/service.js';
import { sqliteSourceReader } from '../src/server/operations/infra/sqlite/source-reader.js';

import { categoryAnswer, completion, loopbackModel } from './fixtures/classify-fakes.js';
import { testDatabaseFile } from './helpers/test-database.js';

// `pnpm run classify:eval` (CB-198) end to end: the database's default
// shared backend (its key sealed with SESSION_SECRET) is a loopback fake;
// the golden set is admins' labels; the command prints per-label scores
// and the confusion matrix, records the evaluation and exits 0 on a pass.

const SECRET = 'classify-eval-test-secret-0123456789';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('evaluates the workspace model against the golden set and records it', async () => {
    const model = await loopbackModel((request) => {
        const user = request.body.messages?.at(-1)?.content ?? '';
        const found = /the cause is (\w+)/.exec(user)?.[1] ?? 'unclassified';
        return { json: completion(categoryAnswer(found, 0.96)) };
    });
    cleanup.push(model.close);
    const dir = mkdtempSync(join(tmpdir(), 'classify-eval-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'company-brain.sqlite');
    // A copy of the run's migrated template (tests/setup/test-template.ts):
    // migrating every module's schema here took seconds, and past 90 s on a
    // loaded host (CB-467). The CLI still checks it is on this release's schema.
    const db = new DatabaseSync(testDatabaseFile(path));
    // Seeding only: without a sync per commit. Each of the 48 seeding writes
    // below was its own fsync'd transaction, most of the test's time on a quiet
    // host and past 15 s when other work kept the disk busy. The CLI opens the
    // file itself, with its own settings.
    db.exec('PRAGMA synchronous=OFF');
    const inference = new InferenceService(db, {
        secret: SECRET,
        log: () => {},
    });
    await inference.createBackend({
        label: 'Loopback',
        baseUrl: model.url,
        model: 'tiny-model',
        apiKey: 'sk-loopback-key',
    });
    const service = new ClassifyService({
        db,
        runs: sqliteSourceReader(db),
        settings: () => ({}),
        providers: [],
    });
    const labels = FAILURE_LABELS.filter((label) => label !== 'unclassified');
    const insert = db.prepare(
        'INSERT INTO agent_runs (threadId, runId, status, events, startedAt, finishedAt, source, trace, errorDetail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 24; i++) {
        const label = labels[i % labels.length]!;
        insert.run(
            't1',
            `g-${i}`,
            'failed',
            JSON.stringify([{ type: 'RUN_ERROR', code: 'failed' }]),
            1000 + i,
            2000 + i,
            'web',
            JSON.stringify({ end: { reason: 'error' } }),
            `the cause is ${label}`,
        );
        await service.failures.relabel(service.failures.subject(`g-${i}`, 'turn')!, label, 'alice');
    }
    db.close();

    const lines: string[] = [];
    const code = await runEvalCli(
        ['--', '--use=failures', '--provider=workspace'],
        { DATABASE_PATH: path, SESSION_SECRET: SECRET },
        (line) => lines.push(line),
    );
    const output = lines.join('\n');
    expect(code, output).toBe(0);
    expect(output).toContain('workspace:tiny-model/p1');
    expect(output).toContain('Passed');
    expect(output).toMatch(/Confusion/);
    expect(model.requests).toHaveLength(24);
    expect(model.requests[0]!.headers.authorization).toBe('Bearer sk-loopback-key');

    const reopened = new DatabaseSync(path);
    cleanup.push(() => reopened.close());
    expect(reopened.prepare('SELECT provider, version, status, passed FROM classify_evals').all()).toEqual([
        {
            provider: 'workspace',
            version: 'workspace:tiny-model/p1',
            status: 'done',
            passed: 1,
        },
    ]);
    expect(reopened.prepare("SELECT count(*) AS n FROM classify_calls WHERE purpose='eval'").get()).toEqual({ n: 24 });

    // An unknown provider, or too small a golden set, exits 1 with why.
    await expect(
        runEvalCli(['--provider=jev'], { DATABASE_PATH: path, SESSION_SECRET: SECRET }, () => {}),
    ).rejects.toThrow(/no provider jev/);
});
