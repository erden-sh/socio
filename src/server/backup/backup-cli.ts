// pnpm run backup: snapshot DATABASE_PATH and the users' data spaces
// (USER_DATA_DIR, next to the database by default, and with S3 the
// tenant's objects, mirrored incrementally) into BACKUP_DIR, keeping
// BACKUP_KEEP of each, then the off-site copy when BACKUP_S3_ENDPOINT is
// set. The app also does this on its own every BACKUP_INTERVAL_HOURS.
//
// pnpm run backup open <file.sealed> <output>: decrypts a file of the
// off-site copy (the database or a dataset) with DATA_ENCRYPTION_KEY (or
// DATA_ENCRYPTION_KEY_PREVIOUS).
//
// pnpm run backup fetch-ltx <directory> [lineage]: downloads the
// continuous copy's files from the off-site copy (BACKUP_S3_*), opens them
// and puts them in <directory> as a Litestream file replica, for
// `litestream restore -o <db> file://<directory>` (CB-112). With more than
// one lineage off-site, name the one to restore; it lists them.
//
// pnpm run backup rename-user <old> <new> [--dry-run | --apply]: renames a
// user id everywhere (CB-338), offline: stop the app and take a backup
// first. A dry run (the default) prints the counts per table and column and
// the files that would move. `rename-user --leftovers <id>` lists the text
// columns that still hold exactly <id> (rename-user.ts).
//
// pnpm run backup verify-key: the restore drill's recovery key check
// (CB-322) from the command line. Reads a data key from stdin (not echoed
// at a terminal), restores the latest point of LITESTREAM_REPLICA_DIR into
// scratch, and opens a sample of each purpose's seals with that key alone:
// credentials from the restored copy, files from USER_DATA_DIR or S3,
// backups from the off-site copy. Exits 1 unless it passes. The key is
// never stored or printed, and is wiped after use.
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { planMigrations } from '@socio/data/migrate';
import { objectKey } from '@socio/data/storage/keys';
import { storageSettingsFromEnv } from '@socio/data/storage/settings';
import { dataKeyIds, dataKeysFromEnv, parseDataKey } from '@socio/foundation/keys/data-keys';
import { readKeyFromStdin } from '@socio/foundation/keys/key-input';
import { openFile } from '@socio/foundation/keys/sealed-files';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { backupSealedValues } from '../composition/backup.js';
import { LocalObjectStore } from '../storage/local-store.js';
import { S3ObjectStore } from '../storage/s3-store.js';
import { objectStores } from '../storage/services.js';

import { fetchContinuousCopy, sampleContinuousCopy } from './backup-ltx.js';
import { BACKUP_CONTEXT } from './backup-offsite.js';
import { backupFailure, backupLine, backupSettingsFromEnv, runBackup } from './backup-service.js';
import { renameUserCommand } from './rename-user.js';
import { checkRecoveryKey } from './restore-drill.js';

const database = process.env.DATABASE_PATH ?? 'data/company-brain.sqlite';
const userData = process.env.USER_DATA_DIR?.trim() || join(dirname(database), 'userdata');
try {
    // Only the key pairs and the data keys: the backup needs no other secret.
    loadSecretFiles(process.env, undefined, [
        // The key from SESSION_SECRET opens what was sealed before the data key (rename-user).
        ...(process.argv[2] === 'rename-user' ? ['SESSION_SECRET'] : []),
        'S3_CREDENTIALS',
        'BACKUP_S3_CREDENTIALS',
        'DATA_ENCRYPTION_KEY',
        'DATA_ENCRYPTION_KEY_PREVIOUS',
    ]);
    const keys = {
        ...dataKeysFromEnv(process.env),
        // Unused for sealing: the off-site copy needs the data key.
        legacy: randomBytes(32).toString('base64url'),
    };
    const [command, input, output] = process.argv.slice(2);
    if (command === 'open') {
        if (!input || !output) {
            throw new Error('Usage: backup-cli open <file.sealed> <output>.');
        }
        if (!keys.current) {
            throw new Error('Set DATA_ENCRYPTION_KEY to open it.');
        }
        const box = new SecretBox(keys, 'backups');
        // A chunk at a time (CB-378): a database of any size opens in flat memory.
        await openFile(box, input, output, BACKUP_CONTEXT);
        console.log('Opened.');
    } else if (command === 'fetch-ltx') {
        if (!input) {
            throw new Error('Usage: backup-cli fetch-ltx <directory> [lineage].');
        }
        if (!keys.current) {
            throw new Error('Set DATA_ENCRYPTION_KEY to open it.');
        }
        const { offsite } = backupSettingsFromEnv(process.env, { dataKey: true });
        if (!offsite) {
            throw new Error('Set BACKUP_S3_ENDPOINT and the other BACKUP_S3_*.');
        }
        const result = await fetchContinuousCopy({
            target: new S3ObjectStore(offsite),
            prefix: offsite.prefix,
            box: new SecretBox(keys, 'backups'),
            directory: input,
            ...(output ? { lineage: output } : {}),
        });
        console.log(
            result.files
                ? `Fetched ${result.files} file(s) of lineage ${result.lineage}, ${result.bytes} bytes${result.newestAt ? `, the newest from ${new Date(result.newestAt).toISOString()}` : ''}. Restore with: litestream restore -o <new database file> file://${resolve(input)}`
                : 'The off-site copy has no continuous copy files.',
        );
        if (!result.files) {
            process.exitCode = 1;
        }
    } else if (command === 'verify-key') {
        const settings = backupSettingsFromEnv(process.env, { dataKey: true });
        if (!settings.continuous) {
            throw new Error('Set LITESTREAM_REPLICA_DIR: the check restores its latest point.');
        }
        const key = parseDataKey(
            await readKeyFromStdin('Recovery key (not shown as you type), then Enter: '),
            'The recovery key',
        );
        const storage = storageSettingsFromEnv(process.env);
        const local = new LocalObjectStore(userData);
        const s3 = storage.s3 ? new S3ObjectStore(storage.s3) : undefined;
        const offsite = settings.offsite;
        let result: Awaited<ReturnType<typeof checkRecoveryKey>>;
        try {
            result = await checkRecoveryKey({
                key,
                serverKeys: dataKeyIds(keys),
                replica: settings.continuous,
                // Apart from the app's own check, which may run meanwhile.
                scratch: join(settings.directory, '.restore-drill-key-cli'),
                litestream: settings.litestream ?? 'litestream',
                reason: backupFailure,
                sealed: backupSealedValues,
                files: async (row) => {
                    const driver = row.storage === 's3' ? 's3' : 'local';
                    const store = driver === 's3' ? s3 : local;
                    return store?.get(objectKey(driver, storage.tenantId, row.ownerUserId, row.id));
                },
                ...(offsite
                    ? {
                          backups: (count: number) =>
                              sampleContinuousCopy(new S3ObjectStore(offsite), offsite.prefix, count),
                      }
                    : {}),
            });
        } finally {
            key.fill(0);
        }
        console.log(
            `Key ${result.keyId}: ${result.matches === 'neither' ? 'not a key this environment uses' : `the ${result.matches} key here`}.`,
        );
        if (result.error) {
            console.log(`Couldn't check: ${result.error}`);
        }
        for (const p of result.purposes) {
            const others = [
                p.otherKey && `${p.otherKey} under another key`,
                p.legacy && `${p.legacy} legacy`,
                p.missing && `${p.missing} missing`,
            ]
                .filter(Boolean)
                .join(', ');
            console.log(
                `  ${p.purpose}: ${p.ok === null ? 'nothing under this key to try' : `${p.opened} of ${p.sampled} opened${p.failed ? `, ${p.failed} failed` : ''}`}${others ? ` (${others})` : ''}`,
            );
        }
        console.log(result.ok ? 'Passed.' : 'Failed.');
        if (!result.ok) {
            process.exitCode = 1;
        }
    } else if (command === 'rename-user') {
        // Only here: the schemas load the server's modules.
        const { schemas } = await import('../modules/index.js');
        const storage = storageSettingsFromEnv(process.env);
        process.exitCode = await renameUserCommand(process.argv.slice(3), {
            env: process.env,
            database,
            userDataDir: userData,
            local: new LocalObjectStore(userData),
            behind: (db) => planMigrations(db, schemas, { strict: true }).length > 0,
            ...(storage.s3 ? { s3: new S3ObjectStore(storage.s3) } : {}),
        });
    } else if (command) {
        throw new Error(`Unknown command ${command}.`);
    } else {
        const storage = storageSettingsFromEnv(process.env);
        const settings = backupSettingsFromEnv(process.env, {
            dataKey: !!keys.current,
        });
        const result = await runBackup({
            databasePath: database,
            userDataDir: userData,
            settings,
            objects: storage.s3 ? { store: new S3ObjectStore(storage.s3), tenantId: storage.tenantId } : undefined,
            stores: objectStores,
            keys,
        });
        console.log(`${backupLine(result)} Written to ${settings.directory}.`);
        if (result.offsiteError) {
            process.exitCode = 1;
        }
    }
} catch (error) {
    const what = process.argv[2] === 'rename-user' ? 'Rename' : 'Backup';
    console.error(`${what} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
}
