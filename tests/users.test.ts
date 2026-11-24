import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { User } from '@socio/shared/types';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase, testDatabaseFile } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);
function databasePath() {
    const dir = mkdtempSync(join(tmpdir(), 'company-brain-users-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'brain.sqlite'));
}

it('moves single-owner conversations to the first admin, once', async () => {
    const path = databasePath();
    const legacy = new WorkspaceStore(path);
    const dot = legacy.dots()[0];
    legacy.bindThread('one', dot.id, 'First', 'company-brain-owner');
    legacy.bindThread('two', dot.id, 'Second', 'company-brain-owner');
    legacy.close();

    const workspace = new WorkspaceStore(path);
    cleanup.push(() => workspace.close());
    expect(await workspace.conversations('alice')).toEqual([]);
    expect(workspace.migrateLegacyOwner('company-brain-owner', 'alice')).toBe(2);
    expect((await workspace.conversations('alice')).map((t) => t.id).sort()).toEqual(['one', 'two']);
    expect(workspace.migrateLegacyOwner('company-brain-owner', 'alice')).toBe(0);
    expect(workspace.migrateLegacyOwner('alice', 'alice')).toBe(0);
});

it('records users from the provider, which owns their name and role', () => {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    workspace.recordUser({ id: 'bob', name: 'Robert', role: 'admin' });
    expect(workspace.users()).toEqual([
        { id: 'alice', name: 'Alice', role: 'admin' },
        { id: 'bob', name: 'Robert', role: 'admin' },
    ]);
});

it('lets only admins through requireAdmin', async () => {
    const as = (user: User) => {
        const app = new Hono<AppEnv>();
        app.use('*', async (c, next) => {
            c.set('user', user);
            await next();
        });
        app.post('/manage', requireAdmin, (c) => c.json({ ok: true }));
        return app.request('/manage', { method: 'POST' });
    };
    expect((await as({ id: 'a', name: 'A', role: 'admin' })).status).toBe(200);
    const member = await as({ id: 'b', name: 'B', role: 'member' });
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
        error: 'Only an admin can change this.',
    });
});
