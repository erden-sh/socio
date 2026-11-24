// Permanent removals' backups roll off (CB-391).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { prunePurgeBackups, purgeBackupTime } from '../src/server/backup/purge-backups.js';

import { memoryTmpdir } from './helpers/memory-tmpdir.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const fn of cleanup.splice(0)) {
        fn();
    }
});
const scratch = () => {
    const dir = mkdtempSync(join(memoryTmpdir(), 'cb-purge-backups-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};
const folder = (dir: string, name: string, cleanupJson?: unknown) => {
    mkdirSync(join(dir, name, 'files'), { recursive: true });
    writeFileSync(join(dir, name, 'company-brain-20260101-000000.sqlite'), 'x');
    if (cleanupJson !== undefined) {
        writeFileSync(join(dir, name, 'cleanup.json'), JSON.stringify(cleanupJson));
    }
};

it('reads a purge backup’s time from its name, and nothing else', () => {
    expect(purgeBackupTime('purge-20261017-093000')).toBe(Date.UTC(2026, 9, 17, 9, 30, 0));
    expect(purgeBackupTime('purge-20261017-093000-2')).toBe(Date.UTC(2026, 9, 17, 9, 30, 0));
    for (const name of [
        'company-brain-20261017-093000.sqlite',
        'userdata-20261017-093000',
        'purge-2026-10-17',
        'purge-20261017-093000.partial',
        'xpurge-20261017-093000',
    ]) {
        expect(purgeBackupTime(name)).toBeUndefined();
    }
});

it('removes purge backups past their days, and keeps younger ones and every other backup', () => {
    const dir = scratch();
    const now = Date.UTC(2026, 10, 17, 12, 0, 0);
    folder(dir, 'purge-20261001-000000', { done: true }); // 47 days
    folder(dir, 'purge-20261001-000000-2'); // 47 days, no manifest (failed before the commit)
    folder(dir, 'purge-20261018-115959'); // 30 days and a second
    folder(dir, 'purge-20261018-120000'); // exactly 30 days: kept
    folder(dir, 'purge-20261110-080000', { done: true }); // the newest, 7 days
    // Other backups, as old as they come: BACKUP_KEEP's to remove, not this.
    writeFileSync(join(dir, 'company-brain-20250101-000000.sqlite'), 'x');
    mkdirSync(join(dir, 'userdata-20250101-000000'));
    mkdirSync(join(dir, 'objects'));
    writeFileSync(join(dir, 'purge-20250101-000000'), 'a file, not a backup folder');

    expect(prunePurgeBackups(dir, 30, now).sort()).toEqual([
        'purge-20261001-000000',
        'purge-20261001-000000-2',
        'purge-20261018-115959',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
        'company-brain-20250101-000000.sqlite',
        'objects',
        'purge-20250101-000000',
        'purge-20261018-120000',
        'purge-20261110-080000',
        'userdata-20250101-000000',
    ]);
    // Again: nothing more goes.
    expect(prunePurgeBackups(dir, 30, now)).toEqual([]);
    // A shorter limit takes the next; the newest stays while younger than it.
    expect(prunePurgeBackups(dir, 8, now)).toEqual(['purge-20261018-120000']);
    expect(existsSync(join(dir, 'purge-20261110-080000'))).toBe(true);
});

it('keeps an old purge backup whose cleanup still waits for --resume', () => {
    const dir = scratch();
    const now = Date.UTC(2026, 10, 17);
    folder(dir, 'purge-20260101-000000', { done: false });
    folder(dir, 'purge-20260102-000000', { done: true });
    expect(prunePurgeBackups(dir, 30, now)).toEqual(['purge-20260102-000000']);
    expect(existsSync(join(dir, 'purge-20260101-000000', 'cleanup.json'))).toBe(true);
});

it('keeps an old purge backup whose cleanup.json can’t be read, and says so', () => {
    const dir = scratch();
    const now = Date.UTC(2026, 10, 17);
    folder(dir, 'purge-20260101-000000');
    writeFileSync(join(dir, 'purge-20260101-000000', 'cleanup.json'), '{"done": fal');
    folder(dir, 'purge-20260102-000000');
    mkdirSync(join(dir, 'purge-20260102-000000', 'cleanup.json')); // EISDIR on read
    folder(dir, 'purge-20260103-000000', { files: [] }); // no done flag
    const lines: string[] = [];
    expect(prunePurgeBackups(dir, 30, now, (line) => lines.push(line))).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([
        'purge-20260101-000000',
        'purge-20260102-000000',
        'purge-20260103-000000',
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Kept the permanent removal backup purge-2026010\d-000000 past its days/);
});

it('does nothing without a backup folder, and refuses less than a day', () => {
    const dir = scratch();
    expect(prunePurgeBackups(join(dir, 'missing'), 30, Date.now())).toEqual([]);
    for (const days of [0, -1, 1.5, NaN]) {
        expect(() => prunePurgeBackups(dir, days, Date.now())).toThrow('Purge backups must be kept at least a day.');
    }
});
