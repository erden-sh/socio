/**
 * Workspace bundles at the HTTP edge (CB-380): the operator's in-process
 * import (`bundle/routes.ts`), over the server's own connection, its data
 * keys and the store new files go to. Mounted by the backups' step: an
 * import belongs with them, and refuses without a recent one.
 *
 * The same runner serves the live CLI channel (`bundle/live.ts`), a Unix
 * socket the backups' boot step starts: `bundle-cli.js import --live` in
 * the container. One runner per database, so one import at a time, from
 * either.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { backupDirFromEnv, readBackupStatus } from '../../backup/backup-service.js';
import { sealedFileSink } from '../../bundle/file-sink.js';
import { adminHere, startLiveChannel } from '../../bundle/live.js';
import { bundleImports, bundleRoutes, type BundleImports, type BundleRouteSources } from '../../bundle/routes.js';
import { copyBeforeImport } from '../../bundle/safety.js';
import type { AppEdge } from '../../main.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyData } from '../dataspace.js';
import { PlatformKeys } from '../keys.js';

const runners = new WeakMap<DatabaseSync, { sources: BundleRouteSources; imports: BundleImports }>();

/** The import's sources and its one runner, for this edge's database. */
function bundleImportsFor(edge: AppEdge) {
    const { services } = edge;
    const db = Context.get(services, LegacyWorkspace).db;
    const known = runners.get(db);
    if (known) {
        return known;
    }
    const data = Context.get(services, LegacyData);
    const { keys } = Context.get(services, PlatformKeys);
    const databasePath = db.location();
    // The same BACKUP_DIR the backups use. Only the directory: the full
    // settings refuse BACKUP_S3_ENDPOINT without the data key, and that
    // check belongs to index.ts, which knows whether there is one (v0.41.1
    // crashed at startup on every site with off-site backups).
    const backupDir = backupDirFromEnv(process.env);
    const sources: BundleRouteSources = {
        db,
        backupDir,
        files: sealedFileSink({ db, keys, store: data.objects, tenantId: data.tenantId }),
        safety: {
            lastBackupAt: () => readBackupStatus(backupDir).lastSuccessAt,
            snapshot: () => {
                if (!databasePath) {
                    throw new Error('The database is in memory: there is nothing to copy.');
                }
                return copyBeforeImport(databasePath, backupDir);
            },
        },
        log: (line) => console.log(line),
    };
    const made = { sources, imports: bundleImports(sources) };
    runners.set(db, made);
    return made;
}

export function mountBundleRoutes(app: Hono<AppEnv>, edge: AppEdge) {
    const { sources, imports } = bundleImportsFor(edge);
    app.route('/api', bundleRoutes(sources, imports));
}

/**
 * The live CLI channel, for the server on a database file. It never stops
 * the start: without it, imports run from the web, or offline.
 */
export function startBundleChannel(edge: AppEdge) {
    const { sources, imports } = bundleImportsFor(edge);
    const databasePath = sources.db.location();
    if (!databasePath) {
        return;
    }
    startLiveChannel({
        databasePath,
        imports,
        isAdmin: (userId) => adminHere(sources.db, userId),
        log: sources.log,
    }).then(
        // Quiet when it listens: it starts beside the boot steps, and their log keeps its order.
        () => undefined,
        (error: unknown) =>
            console.warn(
                `Bundle imports: no live CLI channel (${error instanceof Error ? error.message : 'unknown error'}). Import from the web, or offline.`,
            ),
    );
}
