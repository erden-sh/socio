import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it } from 'vitest';

import { personSeedOf } from '@socio/data/person-seed';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';

import { AppActors } from '../src/server/apps/actor.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'person-seeds-test-secret-0123456789';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

it('is the user id, or the seed a rename kept, and works without the table', () => {
    const db = testDatabase();
    db.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('admin', 'alice')").run();
    expect(personSeedOf(db, 'admin')).toBe('alice');
    expect(personSeedOf(db, 'bob')).toBe('bob');
    expect(personSeedOf(new DatabaseSync(':memory:'), 'admin')).toBe('admin');
});

it('never gives a retired id’s seed to someone who gets that id later', () => {
    const db = testDatabase();
    db.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('admin', 'alice')").run();
    // A different account linked to `alice` after the rename.
    expect(personSeedOf(db, 'alice')).toBe('reused:alice');
    expect(personSeedOf(db, 'alice')).not.toBe(personSeedOf(db, 'admin'));
});

it('keeps the ids apps, plugins and app envelopes see for a renamed person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-person-seeds-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir, apiUrl: 'http://company-brain-app:4310' },
            apps: appsSettingsFromEnv({}, 'http://localhost:4310')!,
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
            auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false },
        },
    });
    cleanup.push(dispose);
    const before = {
        app: platform.apps.personId('app-1', 'alice'),
        plugin: platform.plugins.personId('crm', 'alice'),
    };
    // As `backup rename-user alice admin` leaves it.
    workspace.db.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('admin', 'alice')").run();
    expect(platform.apps.personId('app-1', 'admin')).toBe(before.app);
    expect(platform.plugins.personId('crm', 'admin')).toBe(before.plugin);
    // Someone else still sees their own.
    expect(platform.apps.personId('app-1', 'bob')).not.toBe(before.app);
});

it('keeps the `sub` of a renamed person’s app envelopes', () => {
    const app = {
        id: 'app-1',
        dotId: 'd1',
        ownerUserId: 'admin',
        status: 'promoted' as const,
        liveVersion: 1,
        createdAt: 0,
    };
    const subOf = (db: DatabaseSync) => {
        const actors = new AppActors({
            db,
            secret: SECRET,
            workspace: { dot: () => undefined },
            app: () => app,
            access: () => 'owner',
            manifest: () => undefined,
        });
        return (personId: string) => {
            const envelope = actors.envelope(app, {
                personId,
                access: 'owner',
                sessionRef: 's',
                method: 'GET',
                target: '/',
            });
            const payload = String(envelope).split('.')[1];
            return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
        };
    };
    // Before the rename, and after it (as `backup rename-user alice admin` leaves it).
    const before = subOf(testDatabase());
    const renamed = testDatabase();
    renamed.prepare("INSERT INTO person_seeds(userId, seed) VALUES ('admin', 'alice')").run();
    const after = subOf(renamed);
    expect(after('admin')).toBe(before('alice'));
    expect(after('bob')).toBe(before('bob'));
    // Someone given the retired id later is someone else.
    expect(after('alice')).not.toBe(before('alice'));
});
