import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { RunAgentInput } from '@ag-ui/core';
import { afterEach, expect, it } from 'vitest';

import { ALL_PAGES, backupDatabase, tightenBackups } from '@socio/data/backup';
import { migrateDatabase } from '@socio/data/migrate';

import { ScriptAgent } from './fixtures/script-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-backup-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

it('backs up a live database mid-stream, and the copy restores', async () => {
    const dir = scratch();
    const live = testDatabaseFile(join(dir, 'live.sqlite'));
    const workspace = new WorkspaceStore(live);
    const runner = new LocalAgentRunner(live, { flushIntervalMs: 5 });
    cleanup.push(() => {
        runner.close();
        workspace.close();
    });
    const dot = workspace.dots()[0];
    workspace.bindThread('t1', dot.id, 'Mid-stream', 'alice');
    const agent = new ScriptAgent('partial answer', true);
    const input: RunAgentInput = {
        threadId: 't1',
        runId: 'r1',
        messages: [{ id: 'u1', role: 'user', content: 'back me up' }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
    };
    agent.threadId = 't1';
    agent.setMessages(input.messages);
    runner.run({ threadId: 't1', agent, input }).subscribe();
    // Wait until the partial answer is on disk while the run is still open.
    const disk = new DatabaseSync(live, { readOnly: true });
    await expect
        .poll(() =>
            (
                disk.prepare("SELECT events FROM agent_runs WHERE status='running'").all() as Array<{ events: string }>
            ).some((row) => row.events.includes('partial answer')),
        )
        .toBe(true);
    disk.close();
    expect(runner.activeRunId('t1')).toBe('r1');

    const { path } = backupDatabase(live, join(dir, 'backups'));
    agent.abortRun();

    // Restore: open the copy as the server would after a restart.
    const restoredWorkspace = new WorkspaceStore(path);
    const restoredRunner = new LocalAgentRunner(path);
    cleanup.push(() => {
        restoredRunner.close();
        restoredWorkspace.close();
    });
    expect(restoredWorkspace.thread('t1')?.title).toBe('Mid-stream');
    const messages = await restoredRunner.messages('t1');
    expect(messages.map((m) => [m.role, m.content])).toEqual([
        ['user', 'back me up'],
        ['assistant', 'partial answer'],
    ]);
});

it('names backups by time and keeps only the newest', () => {
    const dir = scratch();
    const live = testDatabaseFile(join(dir, 'live.sqlite'));
    new WorkspaceStore(live).close();
    const out = join(dir, 'backups');
    for (let day = 1; day <= 4; day++) {
        backupDatabase(live, out, 2, new Date(Date.UTC(2026, 9, day, 3, 0, 0)));
    }
    backupDatabase(live, out, 2, new Date(Date.UTC(2026, 9, 4, 3, 0, 0)));
    backupDatabase(live, out, 2, new Date(Date.UTC(2026, 9, 4, 3, 0, 0)));
    // Two same-second backups are newer than the first of that second.
    expect(readdirSync(out).sort()).toEqual([
        'company-brain-20261004-030000-1.sqlite',
        'company-brain-20261004-030000-2.sqlite',
    ]);
    expect(() => backupDatabase(live, out, 0)).toThrow('Keep at least one');
});

// Node 24.21 refuses a negative backup rate ("must be a positive integer"),
// which made every scheduled backup fail on the deployed image while older
// local Nodes accepted -1. Pin what newer Nodes accept.
it('copies with a page count every Node 24 accepts', () => {
    expect(Number.isInteger(ALL_PAGES)).toBe(true);
    expect(ALL_PAGES).toBeGreaterThan(0);
    expect(ALL_PAGES).toBeLessThanOrEqual(2 ** 31 - 1);
});

const mode = (path: string) => statSync(path).mode & 0o777;

it('writes the backup before migrations as 0600, leaving no partial file', () => {
    const dir = scratch();
    const live = testDatabaseFile(join(dir, 'live.sqlite'));
    new WorkspaceStore(live).close();
    const out = join(dir, 'backups');
    const { path } = backupDatabase(live, out);
    expect(mode(path)).toBe(0o600);
    expect(readdirSync(out)).toEqual([path.split('/').at(-1)]);

    // The boot path: a populated database with a migration pending.
    const db = join(dir, 'boot.sqlite');
    const sets = [
        {
            id: 'probe',
            migrations: [{ version: 1, name: 'a', up: 'CREATE TABLE probe_a (id INTEGER)' }],
        },
    ];
    migrateDatabase(db, sets, { backupDirectory: out });
    const more = [
        {
            id: 'probe',
            migrations: [...sets[0].migrations, { version: 2, name: 'b', up: 'CREATE TABLE probe_b (id INTEGER)' }],
        },
    ];
    const { backup } = migrateDatabase(db, more, {
        backupDirectory: out,
    });
    expect(backup).toBeDefined();
    expect(mode(backup!)).toBe(0o600);
});

it('tightens loose backups at boot, skips symlinks and other files', () => {
    const dir = scratch();
    const out = join(dir, 'backups');
    mkdirSync(out);
    const loose = join(out, 'company-brain-20261001-030000.sqlite');
    const other = join(out, 'notes.txt');
    const secret = join(dir, 'secret.txt');
    const link = join(out, 'company-brain-20261002-030000.sqlite');
    writeFileSync(loose, 'x');
    writeFileSync(other, 'x');
    writeFileSync(secret, 'x');
    chmodSync(loose, 0o644);
    chmodSync(other, 0o644);
    chmodSync(secret, 0o644);
    symlinkSync(secret, link);
    const lines: string[] = [];
    expect(tightenBackups(out)).toBe(1);
    expect(mode(loose)).toBe(0o600);
    expect(mode(other)).toBe(0o644);
    expect(mode(secret)).toBe(0o644);
    expect(tightenBackups(out)).toBe(0);
    expect(tightenBackups(join(dir, 'missing'))).toBe(0);

    // At boot, through migrateDatabase, with a one-line count.
    chmodSync(loose, 0o644);
    migrateDatabase(join(dir, 'a.sqlite'), [], {
        backupDirectory: out,
        log: (line) => lines.push(line),
    });
    expect(mode(loose)).toBe(0o600);
    expect(lines).toEqual(['Made 1 existing backup(s) private (0600).']);
});
