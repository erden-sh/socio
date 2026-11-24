// Backups' contract: what moved there keeps its values, the classes implement
// the shapes, and the tag carries its `socio/backup/Backups` key.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import { BackupService } from '../src/server/backup/backup-service.js';
import {
    BACKUP_INTERVAL_MAX_HOURS,
    Backups,
    DEFAULT_DRILL_INTERVAL_DAYS,
    DEFAULT_LTX_INTERVAL_SECONDS,
    DRILL_INTERVAL_MAX_DAYS,
    LTX_INTERVAL_MAX_SECONDS,
    LTX_INTERVAL_MIN_SECONDS,
    type BackupsShape,
    type RestoreDrillShape,
} from '../src/server/backup/contract.js';
import { RestoreDrill } from '../src/server/backup/restore-drill.js';

const dirs: string[] = [];
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'backup-contract-'));
    dirs.push(dir);
    return dir;
};
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

it('keeps the moved values', () => {
    expect([BACKUP_INTERVAL_MAX_HOURS, DEFAULT_LTX_INTERVAL_SECONDS, DEFAULT_DRILL_INTERVAL_DAYS]).toEqual([
        720, 60, 30,
    ]);
    expect(LTX_INTERVAL_MIN_SECONDS).toBeLessThanOrEqual(DEFAULT_LTX_INTERVAL_SECONDS);
    expect(LTX_INTERVAL_MAX_SECONDS).toBeGreaterThanOrEqual(DEFAULT_LTX_INTERVAL_SECONDS);
    expect(DRILL_INTERVAL_MAX_DAYS).toBeGreaterThanOrEqual(DEFAULT_DRILL_INTERVAL_DAYS);
});

it('the tag carries its key', () => {
    expect(Backups.key).toBe('socio/backup/Backups');
});

it('a BackupService and its drill serve the shapes', async () => {
    const backups: BackupsShape = new BackupService({
        databasePath: join(scratch(), 'brain.sqlite'),
        userDataDir: scratch(),
        settings: { directory: scratch(), keep: 1, intervalHours: 6, continuous: scratch() },
        log: () => {},
    });
    const restoreDrill: RestoreDrillShape | undefined = backups.drill;
    expect(restoreDrill).toBeInstanceOf(RestoreDrill);
    const schedule = await Effect.runPromise(
        Backups.use((tag) => Effect.sync(() => tag.schedule())).pipe(Effect.provide(Layer.succeed(Backups, backups))),
    );
    expect(schedule).toEqual(backups.schedule());
    expect(schedule.intervalHours).toBe(6);
});
