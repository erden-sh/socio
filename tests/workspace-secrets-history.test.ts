import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { parseAppManifest } from '@socio/shared/apps/app-manifest';
import {
    REVOKE_GRACE_MS,
    REVOKED_READS_MIN,
    SPIKE_MIN_READS,
    STALE_IDENTITY_GRACE_MS,
    type SecretHistory,
    type WorkspaceSecretsState,
} from '@socio/shared/workspace-secrets';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { SecretApp } from '../src/server/workspace-secrets/contract.js';
import { WorkspaceSecretRepository } from '../src/server/workspace-secrets/infra/sqlite/repository.js';
import { WorkspaceSecrets } from '../src/server/workspace-secrets/service.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Socio Secrets phase 4: a
// secret's history from the audit lines (versions, grants, revokes, reads
// per workload, first reads), and conservative read flags for admins,
// deduplicated and notified once. Never a value anywhere.

const SECRET = 'workspace-secrets-phase4-secret-0123456789';
const KEY = randomBytes(32);
const VALUE = 'sk_live_FirstValue0123456789abcdef';
const NEXT = 'sk_live_SecondValue0123456789abcdef';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** The service alone, with a clock, a plugin with identity versions, and a notifier. */
function unit() {
    const clock = { now: Date.UTC(2026, 10, 10, 12) };
    const apps: SecretApp[] = [
        { id: 'bookings', name: 'Bookings', status: 'promoted' },
        { id: 'other', name: 'Other', status: 'promoted' },
    ];
    const plugins: SecretApp[] = [{ id: 'sync', name: 'Bookings sync', status: 'enabled' }];
    const identity = { version: 1, issuedAt: clock.now - 30 * 24 * HOUR };
    const notices: Array<{ trigger: string; title: string; message: string; path: string }> = [];
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const declared = () => [
        { name: 'STRIPE_API_KEY', required: true },
        { name: 'SLACK_WEBHOOK', required: false },
    ];
    const secrets = new WorkspaceSecrets(
        new WorkspaceSecretRepository(workspace.db),
        { current: KEY, legacy: SECRET },
        {
            apps: {
                list: () => apps,
                get: (id) => apps.find((app) => app.id === id),
                declared,
            },
            plugins: {
                list: () => plugins,
                get: (id) => plugins.find((plugin) => plugin.id === id),
                declared,
                identity: (id) => (id === 'sync' ? identity : undefined),
            },
            audit: (entry) => workspace.audit(entry, clock.now),
            userName: (id) => (id === 'alice' ? 'Alice' : undefined),
            notifyAdmins: async (notice) => {
                notices.push(notice);
            },
            now: () => clock.now,
        },
    );
    /** Audit lines written straight in, for read volumes the rules need. */
    const backfill = (actor: string, secretId: string, count: number, from: number, to: number) => {
        const insert = workspace.db.prepare(
            "INSERT INTO workspace_audit (actor, action, targetKind, targetId, detail, createdAt) VALUES (?, 'read', 'workspace_secret', ?, ?, ?)",
        );
        for (let i = 0; i < count; i++) {
            insert.run(
                actor,
                secretId,
                `STRIPE_API_KEY: version 1 read app=${actor.slice(4)}`,
                from + Math.floor(((to - from) * i) / count),
            );
        }
    };
    return { clock, secrets, workspace, notices, identity, backfill };
}

it('builds a secret’s history: versions, grants, revokes, reads per workload and first reads, paginated', async () => {
    const { clock, secrets } = unit();
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    clock.now += MINUTE;
    await secrets.grant('alice', id, 'bookings');
    await secrets.grant('alice', id, 'plugin:sync');
    clock.now += MINUTE;
    expect(secrets.read('bookings', 'STRIPE_API_KEY').ok).toBe(true);
    const firstBookings = clock.now;
    clock.now += MINUTE;
    expect(secrets.read('bookings', 'STRIPE_API_KEY').ok).toBe(true);
    expect(secrets.read('plugin:sync', 'STRIPE_API_KEY', undefined, 1).ok).toBe(true);
    // Not granted: refused, counted apart.
    expect(secrets.read('other', 'STRIPE_API_KEY').ok).toBe(false);
    clock.now += MINUTE;
    await secrets.replace('alice', id, { value: NEXT, overlapMinutes: 0 });
    await secrets.describe('alice', id, { description: 'Charges cards' });
    clock.now += MINUTE;
    expect(secrets.read('bookings', 'STRIPE_API_KEY').ok).toBe(true);
    const lastBookings = clock.now;
    await secrets.revoke('alice', id, 'plugin:sync');

    const history = secrets.history(id);
    expect(history.secret).toMatchObject({ id, name: 'STRIPE_API_KEY', scope: 'workspace', deletedAt: null });
    expect(history.versions.map((version) => [version.version, version.state, version.setByName])).toEqual([
        [2, 'current', 'Alice'],
        [1, 'retired', 'Alice'],
    ]);
    expect(history.reads).toEqual([
        {
            workload: 'bookings',
            kind: 'app',
            workloadName: 'Bookings',
            firstReadAt: firstBookings,
            lastReadAt: lastBookings,
            reads: 3,
            refused: 0,
            lastRefusedAt: null,
        },
        expect.objectContaining({ workload: 'plugin:sync', kind: 'plugin', workloadName: 'Bookings sync', reads: 1 }),
        expect.objectContaining({ workload: 'other', reads: 0, refused: 1, firstReadAt: null }),
    ]);
    // Newest first; reads appear once per workload, as its first read.
    expect(history.events.map((event) => [event.kind, event.workloadName, event.version])).toEqual([
        ['revoked', 'Bookings sync', null],
        ['described', null, null],
        ['replaced', null, 2],
        ['first-read', 'Bookings sync', 1],
        ['first-read', 'Bookings', 1],
        ['granted', 'Bookings sync', null],
        ['granted', 'Bookings', null],
        ['created', null, 1],
    ]);
    const first = history.events.find((event) => event.kind === 'first-read' && event.workload === 'bookings')!;
    expect(first).toMatchObject({
        actorName: 'Bookings',
        at: firstBookings,
        detail: 'first read by Bookings, version 1',
    });
    expect(history.events.find((event) => event.kind === 'granted')).toMatchObject({ actorName: 'Alice' });
    expect(history.nextBefore).toBeNull();

    // Pages: `limit`, then `before` the last one's id, until none is left.
    const pages: string[] = [];
    let before: number | undefined;
    do {
        const page = secrets.history(id, { limit: 3, ...(before ? { before } : {}) });
        pages.push(page.events.map((event) => event.kind).join(','));
        before = page.nextBefore ?? undefined;
    } while (before);
    expect(pages).toEqual(['revoked,described,replaced', 'first-read,first-read,granted', 'granted,created']);

    // Deleted secrets keep their history; nothing in it is a value.
    await secrets.remove('alice', id);
    const after = secrets.history(id);
    expect(after.secret.deletedAt).toBe(clock.now);
    expect(after.events[0]).toMatchObject({ kind: 'deleted', actorName: 'Alice' });
    const text = JSON.stringify(after);
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(NEXT);
    expect(() => secrets.history('nope')).toThrow(/not found/);
});

it('flags a read rate far above the workload’s own baseline, and not a new, steady or modest one', async () => {
    const { clock, secrets, backfill, notices } = unit();
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    const recentFrom = clock.now - HOUR;
    // Bookings: a quiet week, then a burst.
    backfill('app:bookings', id, 20, recentFrom - 6 * 24 * HOUR, recentFrom - HOUR);
    backfill('app:bookings', id, SPIKE_MIN_READS + 20, recentFrom + MINUTE, clock.now);
    // Other: a burst, but no history before it (a new workload).
    backfill('app:other', id, SPIKE_MIN_READS * 3, recentFrom + MINUTE, clock.now);
    // Sync: busy every hour of the week, so the burst is under 10× its average.
    backfill('plugin:sync', id, 168 * 30, recentFrom - 7 * 24 * HOUR, recentFrom);
    backfill('plugin:sync', id, 250, recentFrom + MINUTE, clock.now);

    const opened = await secrets.evaluateFlags();
    expect(opened.map((flag) => [flag.rule, flag.workload])).toEqual([['read-spike', 'bookings']]);
    expect(opened[0]!.explanation).toMatch(
        /Bookings read its secrets 120 times in the last hour; its hourly average over the week before was 0\.1/,
    );
    expect(notices).toHaveLength(1);

    // A modest burst stays under the floor.
    const quiet = unit();
    const quietSecret = await quiet.secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    quiet.backfill('app:bookings', quietSecret.id, 5, recentFrom - 3 * 24 * HOUR, recentFrom - 2 * 24 * HOUR);
    quiet.backfill('app:bookings', quietSecret.id, SPIKE_MIN_READS - 1, recentFrom + MINUTE, quiet.clock.now);
    expect(await quiet.secrets.evaluateFlags()).toEqual([]);
    expect(quiet.notices).toEqual([]);
});

it('flags repeated refused reads after a revoke, past the cache’s grace, and not a few, early or re-granted ones', async () => {
    const { clock, secrets } = unit();
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    await secrets.grant('alice', id, 'bookings');
    await secrets.grant('alice', id, 'other');
    await secrets.grant('alice', id, 'plugin:sync');
    clock.now += MINUTE;
    await secrets.revoke('alice', id, 'bookings');
    await secrets.revoke('alice', id, 'other');
    await secrets.revoke('alice', id, 'plugin:sync');
    // Within the grace, any number of attempts doesn't count.
    for (let i = 0; i < 10; i++) {
        secrets.read('bookings', 'STRIPE_API_KEY');
        secrets.read('plugin:sync', 'STRIPE_API_KEY');
    }
    expect(await secrets.evaluateFlags()).toEqual([]);
    clock.now += REVOKE_GRACE_MS + MINUTE;
    for (let i = 0; i < REVOKED_READS_MIN; i++) {
        expect(secrets.read('bookings', 'STRIPE_API_KEY').ok).toBe(false);
    }
    // One short of the threshold.
    for (let i = 0; i < REVOKED_READS_MIN - 1; i++) {
        secrets.read('other', 'STRIPE_API_KEY');
    }
    // Re-granted: its earlier refusals don't count against it.
    for (let i = 0; i < REVOKED_READS_MIN; i++) {
        secrets.read('plugin:sync', 'STRIPE_API_KEY');
    }
    await secrets.grant('alice', id, 'plugin:sync');

    const opened = await secrets.evaluateFlags();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
        rule: 'read-after-revoke',
        workload: 'bookings',
        workloadName: 'Bookings',
        secretId: id,
        secretName: 'STRIPE_API_KEY',
    });
    expect(opened[0]!.explanation).toMatch(/Bookings tried to read STRIPE_API_KEY 5 times after its grant was revoked/);
    // The flag shows on the secret's history too.
    expect(secrets.history(id).flags.map((flag) => flag.id)).toEqual([opened[0]!.id]);
});

it('flags a plugin reading with a stale identity after the drain, and not during it or with its current one', async () => {
    const { clock, secrets, identity } = unit();
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    await secrets.grant('alice', id, 'plugin:sync');
    // Current identity: nothing stale.
    expect(secrets.read('plugin:sync', 'STRIPE_API_KEY', undefined, 1).ok).toBe(true);
    // A rotation; old tasks drain for a while.
    identity.version = 2;
    identity.issuedAt = clock.now;
    clock.now += STALE_IDENTITY_GRACE_MS - MINUTE;
    expect(secrets.read('plugin:sync', 'STRIPE_API_KEY', undefined, 1).ok).toBe(true);
    expect(await secrets.evaluateFlags()).toEqual([]);
    expect(secrets.history(id).events.length).toBeGreaterThan(0);

    clock.now += 2 * MINUTE;
    expect(secrets.read('plugin:sync', 'STRIPE_API_KEY', undefined, 2).ok).toBe(true);
    expect(await secrets.evaluateFlags()).toEqual([]);
    expect(secrets.read('plugin:sync', 'STRIPE_API_KEY', undefined, 1).ok).toBe(true);
    const opened = await secrets.evaluateFlags();
    expect(opened.map((flag) => [flag.rule, flag.workload, flag.secretId])).toEqual([
        ['stale-identity', 'plugin:sync', null],
    ]);
    expect(opened[0]!.explanation).toMatch(/Bookings sync used identity version 1 once .* after version 2 was issued/);
});

it('audits a retired identity’s refused use as stale, at most once a minute, and flags it', async () => {
    const { clock, secrets, workspace } = unit();
    const lines = () =>
        workspace.db
            .prepare("SELECT actor, action, targetId, detail FROM workspace_audit WHERE action='deny'")
            .all()
            .map((row) => ({ ...row }));
    secrets.refuseStaleIdentity('sync', 1, 'STRIPE_API_KEY');
    secrets.refuseStaleIdentity('sync', 1, 'STRIPE_API_KEY');
    expect(lines()).toEqual([
        {
            actor: 'plugin:sync',
            action: 'deny',
            targetId: 'name:STRIPE_API_KEY',
            detail: 'STRIPE_API_KEY: read refused (identity no longer accepted) plugin=sync identity v1 stale (current v1)',
        },
    ]);
    clock.now += MINUTE;
    secrets.refuseStaleIdentity('sync', 1, 'A,B');
    expect(lines()).toHaveLength(2);
    expect((await secrets.evaluateFlags()).map((flag) => flag.rule)).toEqual(['stale-identity']);
});

it('keeps one open flag per finding, notifies once, and raises it again only on evidence newer than a dismissal', async () => {
    const { clock, secrets, notices } = unit();
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    await secrets.grant('alice', id, 'bookings');
    await secrets.revoke('alice', id, 'bookings');
    clock.now += REVOKE_GRACE_MS + MINUTE;
    for (let i = 0; i < REVOKED_READS_MIN; i++) {
        secrets.read('bookings', 'STRIPE_API_KEY');
    }
    const [flag] = await secrets.evaluateFlags();
    expect(flag).toBeDefined();
    // Again, with more evidence: the same flag, refreshed, no second notice.
    clock.now += MINUTE;
    secrets.read('bookings', 'STRIPE_API_KEY');
    expect(await secrets.evaluateFlags()).toEqual([]);
    let state = secrets.state();
    expect(state.flags).toHaveLength(1);
    expect(state.flags[0]).toMatchObject({ id: flag!.id, lastSeenAt: clock.now });
    expect(state.flags[0]!.explanation).toContain('6 times');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
        trigger: 'workspace_secret_flag',
        title: 'Secrets: unusual reads',
        path: '/settings/secrets',
    });
    expect(notices[0]!.message).toContain('Bookings tried to read STRIPE_API_KEY');
    expect(JSON.stringify(notices)).not.toContain(VALUE);

    // Dismissed: kept as the record, gone from the open list, not raised by the same evidence.
    clock.now += MINUTE;
    const dismissed = await secrets.dismissFlag('alice', flag!.id);
    expect(dismissed).toMatchObject({ dismissedAt: clock.now, dismissedByName: 'Alice' });
    expect(secrets.state().flags).toEqual([]);
    clock.now += MINUTE;
    expect(await secrets.evaluateFlags()).toEqual([]);
    expect(secrets.history(id).flags).toMatchObject([{ id: flag!.id, dismissedByName: 'Alice' }]);
    // Enough new attempts after the dismissal: a new flag and a new notice.
    for (let i = 0; i < REVOKED_READS_MIN; i++) {
        secrets.read('bookings', 'STRIPE_API_KEY');
    }
    const again = await secrets.evaluateFlags();
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(flag!.id);
    expect(notices).toHaveLength(2);
    state = secrets.state();
    expect(state.flags.map((open) => open.id)).toEqual([again[0]!.id]);
    await expect(secrets.dismissFlag('alice', 'nope')).rejects.toThrow(/not found/);

    // Runs on its own schedule from the tick.
    const ran = notices.length;
    await secrets.evaluateFlagsIfDue();
    expect(notices).toHaveLength(ran);
});

const manifest = (secrets: unknown[]) => {
    const parsed = parseAppManifest({ name: 'Bookings', entry: 'server.ts', secrets });
    if (!parsed.ok) {
        throw new Error(parsed.error);
    }
    return parsed.manifest;
};

it('serves history and dismissals to admins only, never with a value', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'socio-secrets-phase4-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const {
        app: http,
        workspace,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: { sessionSecret: SECRET, data: { userDataDir: dir } },
        app: { auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false } },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    const now = Date.now();
    workspace.db
        .prepare(
            "INSERT INTO apps(id,slug,name,description,dotId,ownerUserId,port,datasets,public,status,config,createdAt,updatedAt,liveVersion) VALUES ('bookings','bookings','Bookings','','dot1','alice',3001,'[]',0,'promoted','{}',?,?,1)",
        )
        .run(now, now);
    workspace.db
        .prepare(
            "INSERT INTO app_versions(appId,version,manifest,bundlePath,sha256,sizeBytes,files,createdAt) VALUES ('bookings',1,?,'b','x',1,1,?)",
        )
        .run(JSON.stringify(manifest([{ name: 'STRIPE_API_KEY' }])), now);
    const as = async (userId: string) => {
        const login = await http.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return async (method: string, path: string, body?: unknown) => {
            const response = await http.request(`/api${path}`, {
                method,
                headers: { cookie, 'Content-Type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: response.status, text: await response.text() };
        };
    };
    const admin = await as('alice');
    const member = DEFAULT_MOCK_USERS.find((user) => user.role === 'member')!;
    const asMember = await as(member.id);
    const created = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${created.id}/grants/bookings`);
    const token = platform.data.tokens.issue({
        userId: 'alice',
        dotId: 'dot1',
        purpose: 'app',
        session: 'app:bookings',
        appId: 'bookings',
    });
    const read = await http.request('/api/workload/secrets/STRIPE_API_KEY', {
        headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);

    const history = await admin('GET', `/workspace-secrets/${created.id}/history?limit=10`);
    expect(history.status).toBe(200);
    const body = JSON.parse(history.text) as SecretHistory;
    expect(body.reads).toMatchObject([{ workload: 'bookings', reads: 1 }]);
    expect(body.events.map((event) => event.kind)).toEqual(['first-read', 'granted', 'created']);
    expect(history.text).not.toContain(VALUE);
    expect((await admin('GET', '/workspace-secrets/nope/history')).status).toBe(404);
    const state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.flags).toEqual([]);

    // Members, data tokens and nobody are refused.
    expect((await asMember('GET', `/workspace-secrets/${created.id}/history`)).status).toBe(403);
    expect((await asMember('POST', '/workspace-secrets/flags/any/dismiss')).status).toBe(403);
    const byToken = await http.request(`/api/workspace-secrets/${created.id}/history`, {
        headers: { authorization: `Bearer ${token}` },
    });
    expect(byToken.status).not.toBe(200);
    expect(await byToken.text()).not.toContain(VALUE);
    expect((await http.request(`/api/workspace-secrets/${created.id}/history`)).status).toBe(401);
    expect((await admin('POST', '/workspace-secrets/flags/nope/dismiss')).status).toBe(404);
});
