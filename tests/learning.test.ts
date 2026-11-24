import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { migrateDatabase } from '@socio/data/migrate';

import { schemas } from '../src/server/modules/index.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: (() => void)[] = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
function fixture() {
    const ws = new WorkspaceStore(testDatabase());
    cleanup.push(() => ws.close());
    const dot = ws.dots()[0];
    return { ws, dot };
}

it('freezes container assignments, including disabled conversations, when a Dot changes', () => {
    const { ws, dot } = fixture();
    ws.bindThread('disabled', dot.id, 'Before learning', 'owner');
    ws.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    ws.bindThread('research', dot.id, 'Research', 'owner');
    ws.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'writing',
        skillDeliveryEnabled: true,
    });
    ws.bindThread('writing', dot.id, 'Writing', 'owner');
    expect(ws.requireThread('disabled').learningContainerId).toBeNull();
    expect(ws.requireThread('research').learningContainerId).toBe('research');
    expect(ws.requireThread('writing').learningContainerId).toBe('writing');
    ws.updateDot(dot.id, {
        ...dot,
        learningContainerId: null,
        skillDeliveryEnabled: false,
    });
    expect(ws.requireThread('research').learningContainerId).toBe('research');
});

it('migrates legacy threads without enrolling them and persists configuration across restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-learning-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'workspace.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    INSERT INTO thread_bindings VALUES ('old', 'dot', 'owner', 'Existing', 1);`);
    legacy.close();
    migrateDatabase(path, schemas, { backupDirectory: join(dir, 'backups') });
    const ws = new WorkspaceStore(path);
    const dot = ws.dots()[0];
    ws.updateDot(dot.id, {
        ...dot,
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
    ws.bindThread('new', dot.id, 'New', 'owner');
    ws.close();
    const reopened = new WorkspaceStore(path);
    cleanup.push(() => reopened.close());
    expect(reopened.requireThread('old').learningContainerId).toBeNull();
    expect(reopened.requireThread('new').learningContainerId).toBe('research');
    expect(reopened.dot(dot.id)).toMatchObject({
        learningContainerId: 'research',
        skillDeliveryEnabled: true,
    });
});

it('rejects invalid container IDs and delivery without a container', () => {
    const { ws, dot } = fixture();
    for (const learningContainerId of ['', 'Upper', 'two--hyphens', '-leading', 'trailing-', 'a'.repeat(65)]) {
        expect(() => ws.updateDot(dot.id, { ...dot, learningContainerId })).toThrow();
    }
    expect(() =>
        ws.updateDot(dot.id, {
            ...dot,
            learningContainerId: null,
            skillDeliveryEnabled: true,
        }),
    ).toThrow();
    expect(ws.dot(dot.id)?.learningContainerId).toBeNull();
});
