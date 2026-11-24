// pnpm run purge (in the container: node dist/server/server/purge/purge-cli.js):
// removes test and leftover records for good, with everything that belongs
// to them (purge.ts, references.ts). Operators only, on the server, with the
// server's environment (DATABASE_PATH, USER_DATA_DIR, BACKUP_DIR, S3_*).
//
//   purge --list LIST.json [--protect PROTECT.txt] [--json OUT.json]      dry run
//   purge --list LIST.json [--protect PROTECT.txt] --apply                 removes it
//
// LIST.json names the ids by kind, and the kinds it may cascade to:
//   {"users": [...], "socios": [...], "spaces": [...], "pages": [...],
//    "datasets": [...], "apps": [...], "jobs": [...], "rooms": [...],
//    "conversations": [...], "cascade": false | true | ["conversations", ...]}
// PROTECT.txt: ids that must never go, one per line (# starts a comment).
//
// The dry run is the default and changes nothing. --apply backs up the
// database and every file and object it will delete into
// BACKUP_DIR/purge-<time>/, checks that the copy plans the same purge, then
// in one write transaction checks that every row, file and object that goes
// is as backed up, deletes the rows and records one workspace audit line as
// `cli`. The files and objects go after the commit; their list is saved
// first as cleanup.json, and `purge --resume BACKUP_DIR` finishes a cleanup
// that failed part way.
import '@socio/foundation/no-vendor-telemetry';
import '@socio/foundation/keys/load-secret-files';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { storageSettingsFromEnv } from '@socio/data/storage/settings';

import { S3ObjectStore } from '../storage/s3-store.js';

import { planLines, readProtectFile, readPurgeList } from './list.js';
import { applyPlannedPurge, cleanUp, planOnce, type PurgeStore } from './run.js';
import { planComputers, purgeSupervisor, type PurgeSupervisor } from './supervisor.js';

const USAGE =
    'Use: purge --list LIST.json [--protect PROTECT.txt] [--json OUT.json] [--keep-computers] [--apply] | purge --resume BACKUP_DIR';

/** Removes a committed purge's files and objects, and says so; repeatable (`--resume BACKUP`). */
async function finish(manifest: string, store: PurgeStore | undefined, supervisor: PurgeSupervisor | undefined) {
    const done = await cleanUp(manifest, store, supervisor);
    console.log(
        `Removed ${done.files} file(s) (${done.bytes} bytes), ${done.objects} object(s), and ${done.containers} computer(s) with ${done.volumes} volume(s). Backup: ${dirname(manifest)}`,
    );
}

async function main(argv: string[], env: Record<string, string | undefined>) {
    const { values } = parseArgs({
        args: argv,
        options: {
            list: { type: 'string' },
            protect: { type: 'string' },
            json: { type: 'string' },
            apply: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            resume: { type: 'string' },
            'keep-computers': { type: 'boolean', default: false },
        },
    });
    const storage = storageSettingsFromEnv(env);
    if (values.resume) {
        await finish(
            join(values.resume, 'cleanup.json'),
            storage.s3 ? new S3ObjectStore(storage.s3) : undefined,
            purgeSupervisor(env),
        );
        return;
    }
    if (!values.list || (values.apply && values['dry-run'])) {
        throw new Error(USAGE);
    }
    const list = readPurgeList(values.list);
    const protect = values.protect ? readProtectFile(values.protect) : [];
    const database = env.DATABASE_PATH ?? 'data/company-brain.sqlite';
    const userDataDir = env.USER_DATA_DIR?.trim() || join(dirname(database), 'userdata');
    const options = { protect, userDataDir, tenantId: storage.tenantId };

    const db = new DatabaseSync(database);
    applyConnectionPragmas(db, env);
    try {
        const plan = planOnce(db, list, options);
        for (const line of planLines(plan, values.apply)) {
            console.log(line);
        }
        // The purged socios' computers: the supervisor removes each container and its volumes.
        const supervisor = purgeSupervisor(env);
        const computers = await planComputers(supervisor, plan.targets.socios, values['keep-computers']);
        console.log(
            !supervisor
                ? 'Computers: none (no COMPUTER_SUPERVISOR_URL).'
                : values['keep-computers']
                  ? 'Computers: kept (--keep-computers).'
                  : `Computers removed (container and volumes, by the supervisor): ${computers.found.length}${computers.found.map((c) => `\n  computer\t${c.botId}\t${c.status}`).join('')}; any volumes a purged socio's computer left are removed too.`,
        );
        if (computers.refusal) {
            plan.refusals.push(computers.refusal);
            console.log(`Refused:\n  ${computers.refusal}`);
        }
        if (values.json) {
            writeFileSync(values.json, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
        }
        if (plan.refusals.length) {
            process.exitCode = 1;
            return;
        }
        if (!values.apply) {
            return;
        }

        const store = storage.s3 ? new S3ObjectStore(storage.s3) : undefined;
        const { deleted, manifest } = await applyPlannedPurge({
            db,
            database,
            list,
            options,
            plan,
            computers: computers.destroy,
            store,
            backupDir: env.BACKUP_DIR ?? join(dirname(database), 'backups'),
            actor: 'cli',
            log: (line) => console.log(line),
        });
        console.log(
            `Purged ${deleted.reduce((sum, entry) => sum + entry.rows, 0)} rows from ${deleted.length} tables.`,
        );
        await finish(manifest, store, supervisor);
    } finally {
        db.close();
    }
}

main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed.');
    process.exit(1);
});
