// pnpm run bundle (in the container: node dist/server/server/bundle/bundle-cli.js):
// workspace bundles (CB-380), a selection of issues and Spaces copied from
// one Socio to another. Run on the server by whoever runs it (--as an admin), with the server's
// environment (DATABASE_PATH, USER_DATA_DIR, BACKUP_DIR, S3_*, the data keys).
//
//   bundle export --out DIR --label Acme [--origin https://host]
//                 [--issues all|12,15-18|@file] [--spaces ID,...|@file] [--pages ID,...|@file]
//                 (--deny-space ID ... | BUNDLE_DENY_SPACES=ID,... | --no-deny-list)
//                 [--from SNAPSHOT.sqlite]
//     Reads a snapshot: --from an opened backup, else a VACUUM INTO copy of
//     DATABASE_PATH made under BACKUP_DIR and removed after. Never reads a
//     Space on the deny-list: a selection that reaches one refuses.
//
//   bundle import DIR --as OPERATOR_USER_ID [--live] [--apply] [--space-map SRC=DST ...]
//                 [--term WORD ...] [--keep-numbers-strict] [--json REPORT.json]
//     A dry run by default. --apply refuses without a full backup in the
//     last 15 minutes and copies the database to BACKUP_DIR/import-<time>/
//     first. A bundle issue whose number a live issue filed here holds takes
//     the next free number; --keep-numbers-strict leaves it out instead.
//     Offline, it refuses while a server holds the database. --live hands it
//     to that server instead (live.ts: a private Unix socket in this
//     container), which runs it as the web import does and answers with
//     the report; DIR must then be directly under BACKUP_DIR/bundles/.
import '@socio/foundation/no-vendor-telemetry';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import { objectKey } from '@socio/data/storage/keys';
import { storageSettingsFromEnv } from '@socio/data/storage/settings';
import { dataKeysFromEnv } from '@socio/foundation/keys/data-keys';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { backupDirFromEnv, readBackupStatus } from '../backup/backup-service.js';
import { LocalObjectStore } from '../storage/local-store.js';
import { S3ObjectStore } from '../storage/s3-store.js';
import { loadReleaseData } from '../updates/releases.js';

import { exportBundle } from './export.js';
import { sealedFileSink } from './file-sink.js';
import { BundleError, BundleReader } from './files.js';
import { importBundle, reportLines, type ImportReport } from './import.js';
import { adminHere, liveImportFromCli } from './live.js';
import { copyBeforeImport, serverRunning, snapshotForExport } from './safety.js';
import { denyList, originOf, parseIdList, parseIssueList } from './selection.js';

const USAGE = `Use:
  bundle export --out DIR --label LABEL [--origin URL] [--issues LIST] [--spaces LIST] [--pages LIST]
                (--deny-space ID ... | BUNDLE_DENY_SPACES | --no-deny-list) [--from SNAPSHOT]
  bundle import DIR --as OPERATOR_ID [--live] [--apply] [--space-map SRC=DST ...] [--term WORD ...]
                [--keep-numbers-strict] [--json OUT]`;

function environment(env: Record<string, string | undefined>) {
    loadSecretFiles(env, undefined, [
        'SESSION_SECRET',
        'S3_CREDENTIALS',
        'DATA_ENCRYPTION_KEY',
        'DATA_ENCRYPTION_KEY_PREVIOUS',
    ]);
    const database = env.DATABASE_PATH ?? 'data/company-brain.sqlite';
    const userData = env.USER_DATA_DIR?.trim() || join(dirname(database), 'userdata');
    // The server's own rule (the web import, the live channel and backups read the same directory).
    const backupDir = backupDirFromEnv(env);
    const storage = storageSettingsFromEnv(env);
    // Files sealed before the data key opened with the key from SESSION_SECRET.
    const keys = {
        ...dataKeysFromEnv(env),
        legacy: env.SESSION_SECRET?.trim() || randomBytes(32).toString('base64url'),
    };
    const local = new LocalObjectStore(userData);
    const s3 = storage.s3 ? new S3ObjectStore(storage.s3) : undefined;
    return { database, userData, backupDir, storage, keys, local, s3 };
}

async function exportCommand(argv: string[], env: Record<string, string | undefined>) {
    const { values } = parseArgs({
        args: argv,
        options: {
            out: { type: 'string' },
            label: { type: 'string' },
            origin: { type: 'string' },
            issues: { type: 'string' },
            spaces: { type: 'string', multiple: true },
            pages: { type: 'string', multiple: true },
            'deny-space': { type: 'string', multiple: true },
            'no-deny-list': { type: 'boolean', default: false },
            from: { type: 'string' },
        },
    });
    if (!values.out || !values.label) {
        throw new BundleError(USAGE);
    }
    const deny = denyList(values['deny-space'], env.BUNDLE_DENY_SPACES, values['no-deny-list']);
    const selection = {
        issues: parseIssueList(values.issues),
        spaces: parseIdList(values.spaces),
        pages: parseIdList(values.pages),
    };
    const origin = originOf(values.origin ?? env.APP_ORIGIN);
    const setup = environment(env);
    const snapshot = values.from
        ? { path: resolve(values.from), dispose: () => undefined }
        : snapshotForExport(setup.database, setup.backupDir);
    try {
        const db = new DatabaseSync(snapshot.path, { readOnly: true });
        try {
            const box = new SecretBox(setup.keys, 'data-files');
            const { manifest, warnings } = await exportBundle({
                db,
                out: resolve(values.out),
                selection,
                deny,
                source: { origin, label: values.label, issuePrefix: 'CB' },
                appVersion: loadReleaseData(() => undefined).version,
                readFile: async (file) => {
                    const driver = file.storage === 's3' ? 's3' : 'local';
                    const store = driver === 's3' ? setup.s3 : setup.local;
                    if (!store) {
                        throw new BundleError('A page image is in S3, and S3 isn’t set up here.');
                    }
                    const sealed = await store.get(
                        objectKey(driver, setup.storage.tenantId, file.ownerUserId, file.id),
                    );
                    return sealed && box.openBytes(sealed, `${file.ownerUserId}/${file.id}`);
                },
            });
            for (const warning of warnings) {
                console.log(`Warning: ${warning}`);
            }
            console.log(
                `Wrote ${resolve(values.out)}: ${Object.entries(manifest.counts)
                    .map(([kind, n]) => `${n} ${kind}`)
                    .join(', ')}. It is unsealed: keep it on this host, and delete it after the import.`,
            );
        } finally {
            db.close();
        }
    } finally {
        snapshot.dispose();
    }
}

async function importCommand(argv: string[], env: Record<string, string | undefined>) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            as: { type: 'string' },
            apply: { type: 'boolean', default: false },
            'space-map': { type: 'string', multiple: true },
            term: { type: 'string', multiple: true },
            json: { type: 'string' },
            live: { type: 'boolean', default: false },
            'keep-numbers-strict': { type: 'boolean', default: false },
        },
    });
    const dir = positionals[0];
    if (!dir || !values.as) {
        throw new BundleError(USAGE);
    }
    const spaceMap: Record<string, string> = {};
    for (const pair of values['space-map'] ?? []) {
        const [from, to] = pair.split('=');
        if (!from || !to) {
            throw new BundleError(`--space-map takes SOURCE_SPACE_ID=TARGET_SPACE_ID, not ${pair}.`);
        }
        spaceMap[from] = to;
    }
    const keepNumbersStrict = values['keep-numbers-strict'];
    const print = (report: ImportReport) => {
        for (const line of reportLines(report)) {
            console.log(line);
        }
        if (values.json) {
            writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        }
    };
    const setup = environment(env);
    if (values.live) {
        const answer = await liveImportFromCli(dir, setup, {
            as: values.as,
            apply: values.apply,
            ...(Object.keys(spaceMap).length ? { spaceMap } : {}),
            ...(values.term?.length ? { terms: values.term } : {}),
            ...(keepNumbersStrict ? { keepNumbersStrict } : {}),
        });
        if (answer.error || !answer.run) {
            throw new BundleError(answer.error ?? 'The server gave no answer.');
        }
        if (answer.run.state !== 'done' || !answer.run.report) {
            throw new BundleError(answer.run.error ?? 'The import failed.');
        }
        print(answer.run.report);
        return;
    }
    const db = new DatabaseSync(setup.database);
    applyConnectionPragmas(db, env);
    try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_map'").get()) {
            throw new BundleError(
                'This database has no import tables yet: start this release’s server once to migrate it.',
            );
        }
        if (serverRunning(db)) {
            throw new BundleError(
                'A server is running on this database. Hand the import to it with --live (or POST /api/operator/bundles/import), or stop it first.',
            );
        }
        if (!adminHere(db, values.as)) {
            throw new BundleError('--as must name an admin’s user id.');
        }
        const bundle = await BundleReader.open(resolve(dir));
        const report = await importBundle({
            db,
            bundle,
            apply: values.apply,
            operatorId: values.as,
            via: 'offline',
            keepNumbersStrict,
            files: sealedFileSink({
                db,
                keys: setup.keys,
                store: setup.s3 ?? setup.local,
                tenantId: setup.storage.tenantId,
            }),
            spaceMap,
            terms: values.term ?? [],
            safety: {
                lastBackupAt: () => readBackupStatus(setup.backupDir).lastSuccessAt,
                snapshot: () => copyBeforeImport(setup.database, setup.backupDir),
            },
        });
        print(report);
    } finally {
        db.close();
    }
}

async function main(argv: string[], env: Record<string, string | undefined>) {
    const [command, ...rest] = argv;
    if (command === 'export') {
        await exportCommand(rest, env);
    } else if (command === 'import') {
        await importCommand(rest, env);
    } else {
        throw new BundleError(USAGE);
    }
}

main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Failed.');
    process.exit(1);
});
