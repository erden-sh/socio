import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { redactAppLog } from '@socio/foundation/apps/log-redact';
import { SecretBox } from '@socio/foundation/keys/secret-box';
import { parseAppManifest, manifestChanges, type AppManifest } from '@socio/shared/apps/app-manifest';
import { SECRET_CACHE_MS, type WorkspaceSecretsState } from '@socio/shared/workspace-secrets';

import { SecretReadError, socioApp } from '../packages/app-sdk/src/index.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { SecretApp } from '../src/server/workspace-secrets/contract.js';
import { WorkspaceSecretRepository } from '../src/server/workspace-secrets/infra/sqlite/repository.js';
import { WorkspaceSecrets } from '../src/server/workspace-secrets/service.js';
import type { WorkspaceAuditEntry } from '../src/server/workspace/contract.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Socio Secrets, phase 1: admins
// write secrets and never read them back; workspace apps read the ones
// granted to them with their data token; every change, read and refusal
// is audited without the value; versions overlap during a rotation; the
// data key's counts and re-seal include the new purpose.

const SECRET = 'workspace-secrets-test-secret-0123456789';
const KEY = randomBytes(32);
const VALUE = 'sk_live_FirstValue0123456789abcdef';
const NEXT = 'sk_live_SecondValue0123456789abcdef';
const OWN = 'whsec_OwnValue0123456789abcdefgh';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const manifest = (secrets: unknown[]) => {
    const parsed = parseAppManifest({ name: 'Bookings', entry: 'server.ts', secrets });
    if (!parsed.ok) {
        throw new Error(parsed.error);
    }
    return parsed.manifest;
};

async function world(dataKeys?: { current?: Buffer }) {
    const dir = mkdtempSync(join(tmpdir(), 'socio-secrets-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const {
        app: http,
        workspace,
        platform,
        dispose,
    } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir },
            ...(dataKeys ? { dataKeys } : {}),
        },
        app: { auth: { provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET), secureCookies: false } },
    });
    cleanup.push(dispose);
    platform.context.log = () => {};
    const now = Date.now();
    const addApp = (id: string, status: string, secrets: unknown[]) => {
        workspace.db
            .prepare(
                "INSERT INTO apps(id,slug,name,description,dotId,ownerUserId,port,datasets,public,status,config,createdAt,updatedAt,liveVersion) VALUES (?,?,?,'','dot1','alice',3001,'[]',0,?,'{}',?,?,1)",
            )
            .run(id, id, id, status, now, now);
        workspace.db
            .prepare(
                "INSERT INTO app_versions(appId,version,manifest,bundlePath,sha256,sizeBytes,files,createdAt) VALUES (?,1,?,'b','x',1,1,?)",
            )
            .run(id, JSON.stringify(manifest(secrets)), now);
    };
    addApp('bookings', 'promoted', [
        { name: 'STRIPE_API_KEY', required: true, description: 'Charges cards' },
        { name: 'SLACK_WEBHOOK', required: false },
        { name: 'MISSING_KEY', required: true },
    ]);
    addApp('other', 'promoted', [{ name: 'STRIPE_API_KEY' }]);
    addApp('devapp', 'ephemeral', [{ name: 'STRIPE_API_KEY' }]);
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
            return { status: response.status, text: await response.text(), headers: response.headers };
        };
    };
    const token = (appId: string, promoted = true) =>
        platform.data.tokens.issue({
            userId: 'alice',
            dotId: 'dot1',
            purpose: 'app',
            session: `app:${appId}`,
            ...(promoted ? { appId } : {}),
        });
    const read = async (bearer: string | undefined, path: string) => {
        const response = await http.request(`/api/workload/secrets${path}`, {
            headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
        });
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
            headers: response.headers,
        };
    };
    const audit = () =>
        workspace.db
            .prepare(
                "SELECT actor, action, targetId, detail FROM workspace_audit WHERE targetKind='workspace_secret' ORDER BY id",
            )
            .all()
            .map((row) => ({ ...row })) as Array<{ actor: string; action: string; targetId: string; detail: string }>;
    return { platform, workspace, http, as, token, read, audit };
}

it('is write-only for admins: no response ever carries a value, and members and tokens are refused', async () => {
    const { as, token, http, audit } = await world();
    const admin = await as('alice');
    const member = await as('bob');
    const created = await admin('POST', '/workspace-secrets', {
        name: 'STRIPE_API_KEY',
        description: 'Charges cards',
        value: VALUE,
    });
    expect(created.status).toBe(201);
    const view = JSON.parse(created.text);
    expect(view).toMatchObject({
        name: 'STRIPE_API_KEY',
        scope: 'workspace',
        versions: [{ version: 1, state: 'current' }],
    });
    const replaced = await admin('POST', `/workspace-secrets/${view.id}/versions`, { value: NEXT });
    const granted = await admin('PUT', `/workspace-secrets/${view.id}/grants/bookings`);
    const listed = await admin('GET', '/workspace-secrets');
    const one = await admin('GET', `/workspace-secrets/${view.id}`);
    const described = await admin('PATCH', `/workspace-secrets/${view.id}`, { description: 'Stripe' });
    for (const response of [created, replaced, granted, listed, one, described]) {
        expect(response.status).toBeLessThan(300);
        expect(response.headers.get('cache-control')).toBe('no-store');
        for (const value of [VALUE, NEXT]) {
            expect(response.text).not.toContain(value);
            expect(response.text).not.toContain(Buffer.from(value).toString('base64'));
        }
    }
    const state = JSON.parse(listed.text) as WorkspaceSecretsState;
    expect(state.secrets[0]).toMatchObject({
        versions: [
            { version: 2, state: 'current', setByName: 'Alice' },
            { version: 1, state: 'previous', setByName: 'Alice' },
        ],
        grants: [{ appId: 'bookings', grantedByName: 'Alice' }],
        lastReadAt: null,
    });
    // Workspace apps only: the development app isn't listed.
    expect(state.apps.map((app) => app.appId).sort()).toEqual(['bookings', 'other']);

    // Members, a data token and no session at all are refused.
    expect((await member('GET', '/workspace-secrets')).status).toBe(403);
    expect((await member('POST', '/workspace-secrets', { name: 'X_KEY', value: 'whatever-value' })).status).toBe(403);
    const withToken = await http.request('/api/workspace-secrets', {
        headers: { authorization: `Bearer ${token('bookings')}` },
    });
    // A data token isn't a session here: refused like no session.
    expect(withToken.status).toBe(401);
    expect((await http.request('/api/workspace-secrets')).status).toBe(401);
    // Bad input.
    expect((await admin('POST', '/workspace-secrets', { name: 'lower', value: 'x' })).status).toBe(400);
    expect((await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: 'again' })).status).toBe(409);
    expect((await admin('POST', '/workspace-secrets', { name: 'BIG_KEY', value: 'x'.repeat(17 * 1024) })).status).toBe(
        400,
    );
    // Every change is audited, by name and version only.
    expect(audit().map((entry) => [entry.actor, entry.action])).toEqual([
        ['alice', 'create'],
        ['alice', 'update'],
        ['alice', 'grant'],
        ['alice', 'update'],
    ]);
});

it('serves granted secrets to workspace apps only, and refuses (and audits) everything else with 403', async () => {
    const { platform, as, token, read, audit } = await world();
    const admin = await as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    ) as { id: string };
    const bookings = token('bookings');

    // Declared but not granted.
    expect((await read(bookings, '/STRIPE_API_KEY')).status).toBe(403);
    // Undeclared names can't be granted or read.
    const undeclared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'GITHUB_TOKEN', value: 'ghp_x' })).text,
    );
    expect((await admin('PUT', `/workspace-secrets/${undeclared.id}/grants/bookings`)).status).toBe(400);
    expect((await read(bookings, '/GITHUB_TOKEN')).status).toBe(403);
    // A development app can't be granted, and its token reads nothing.
    expect((await admin('PUT', `/workspace-secrets/${shared.id}/grants/devapp`)).status).toBe(404);
    expect((await read(token('devapp', false), '/STRIPE_API_KEY')).status).toBe(401);
    expect((await read(undefined, '/STRIPE_API_KEY')).status).toBe(401);

    expect((await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`)).status).toBe(200);
    const ok = await read(bookings, '/STRIPE_API_KEY');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.body).toEqual({ value: VALUE, version: 1, expiresAt: expect.any(Number) });
    expect(ok.body.expiresAt as number).toBeLessThanOrEqual(Date.now() + SECRET_CACHE_MS);
    // Granted to one app is not granted to another.
    expect((await read(token('other'), '/STRIPE_API_KEY')).status).toBe(403);

    // A workload secret is its own app's, implicitly, and nobody else's.
    const own = await admin('POST', '/workspace-secrets', {
        name: 'SLACK_WEBHOOK',
        scope: 'workload',
        appId: 'bookings',
        value: OWN,
    });
    expect(own.status).toBe(201);
    expect((await read(bookings, '/SLACK_WEBHOOK')).body).toMatchObject({ value: OWN, version: 1 });
    expect(
        (
            await admin('POST', '/workspace-secrets', {
                name: 'NOT_DECLARED',
                scope: 'workload',
                appId: 'bookings',
                value: 'v',
            })
        ).status,
    ).toBe(400);

    // Several at once: all or nothing, and a refusal names names only.
    const both = await read(bookings, '?names=STRIPE_API_KEY,SLACK_WEBHOOK');
    expect(both.body).toEqual({
        secrets: {
            STRIPE_API_KEY: { value: VALUE, version: 1, expiresAt: expect.any(Number) },
            SLACK_WEBHOOK: { value: OWN, version: 1, expiresAt: expect.any(Number) },
        },
    });
    const mixed = await read(bookings, '?names=STRIPE_API_KEY,MISSING_KEY');
    expect(mixed.status).toBe(403);
    expect(mixed.body).toMatchObject({ denied: ['MISSING_KEY'] });
    expect(JSON.stringify(mixed.body)).not.toContain(VALUE);

    // Revoked: refused again at once.
    expect((await admin('DELETE', `/workspace-secrets/${shared.id}/grants/bookings`)).status).toBe(200);
    expect((await read(bookings, '/STRIPE_API_KEY')).status).toBe(403);

    // Required secrets nothing serves mark the app as needing setup.
    expect(platform.apps.workloadSecrets?.needsSetup('bookings')).toEqual(['STRIPE_API_KEY', 'MISSING_KEY']);
    const state = JSON.parse((await admin('GET', '/workspace-secrets')).text) as WorkspaceSecretsState;
    expect(state.apps.find((app) => app.appId === 'bookings')?.declared).toEqual([
        { name: 'STRIPE_API_KEY', required: true, description: 'Charges cards', servedBy: null },
        {
            name: 'SLACK_WEBHOOK',
            required: false,
            description: '',
            servedBy: { id: expect.any(String), scope: 'workload' },
        },
        { name: 'MISSING_KEY', required: true, description: '', servedBy: null },
    ]);
    expect(state.secrets.find((secret) => secret.name === 'SLACK_WEBHOOK')).toMatchObject({
        lastReadByName: 'bookings',
        lastReadAt: expect.any(Number),
    });

    // Reads and refusals are audited with names, versions and apps: never a value.
    const lines = audit();
    expect(lines.filter((line) => line.action === 'read').map((line) => line.detail)).toContain(
        'STRIPE_API_KEY: version 1 read app=bookings',
    );
    expect(lines.filter((line) => line.action === 'deny').map((line) => [line.actor, line.detail])).toEqual(
        expect.arrayContaining([
            ['app:bookings', 'STRIPE_API_KEY: read refused (not granted or not set) app=bookings'],
            ['app:bookings', 'GITHUB_TOKEN: read refused (undeclared) app=bookings'],
            ['app:other', 'STRIPE_API_KEY: read refused (not granted or not set) app=other'],
            ['app:bookings', 'MISSING_KEY: read refused (not granted or not set) app=bookings'],
        ]),
    );
    const everything = JSON.stringify(lines);
    for (const value of [VALUE, OWN, 'ghp_x']) {
        expect(everything).not.toContain(value);
    }
});

it('redacts what an app may read from its logs and its socio’s computer output', async () => {
    const { platform, as, token, read } = await world();
    const admin = await as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`);
    expect((await read(token('bookings'), '/STRIPE_API_KEY')).status).toBe(200);
    const values = platform.apps.secretsFor('dot1');
    expect(values).toContain(VALUE);
    expect(redactAppLog(`charging with ${VALUE} now`, values)).toBe('charging with [redacted] now');
    // After a rotation both versions stay redacted: the old one was read.
    await admin('POST', `/workspace-secrets/${shared.id}/versions`, { value: NEXT });
    expect(platform.apps.secretsFor('dot1')).toEqual(expect.arrayContaining([VALUE, NEXT]));
});

it('serves the app SDK end to end', async () => {
    const { as, token, http } = await world();
    const admin = await as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`);
    const bearer = token('bookings');
    const sdk = socioApp({
        appId: 'bookings',
        apiUrl: 'http://localhost/api',
        dataToken: () => bearer,
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
            http.request(String(input), init)) as typeof fetch,
        env: {},
    });
    expect(await sdk.secrets.get('STRIPE_API_KEY')).toBe(VALUE);
    await expect(sdk.secrets.require(['STRIPE_API_KEY', 'MISSING_KEY'])).rejects.toMatchObject({
        names: ['MISSING_KEY'],
        status: 403,
    });
    await expect(sdk.secrets.get('MISSING_KEY')).rejects.toBeInstanceOf(SecretReadError);
});

it('rate-limits reads per app', async () => {
    const { as, token, read } = await world();
    const admin = await as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`);
    const bookings = token('bookings');
    let status = 200;
    for (let i = 0; i < 121 && status === 200; i++) {
        status = (await read(bookings, '/STRIPE_API_KEY')).status;
    }
    expect(status).toBe(429);
    // Another app has its own allowance.
    expect((await read(token('other'), '/STRIPE_API_KEY')).status).toBe(403);
});

it('deletes softly: never served again, grants gone, versions kept sealed', async () => {
    const { platform, as, token, read, audit } = await world();
    const admin = await as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`);
    expect((await admin('DELETE', `/workspace-secrets/${shared.id}`)).status).toBe(200);
    expect((await read(token('bookings'), '/STRIPE_API_KEY')).status).toBe(403);
    expect((await admin('GET', `/workspace-secrets/${shared.id}`)).status).toBe(404);
    const repository = platform.workspaceSecrets.repository;
    expect(repository.withDeleted(shared.id)).toMatchObject({ deletedBy: 'alice', deletedAt: expect.any(Number) });
    expect(repository.grants(shared.id)).toEqual([]);
    expect(repository.versions(shared.id)).toMatchObject([{ version: 1, state: 'retired' }]);
    expect(repository.versions(shared.id)[0]!.sealed).not.toContain(VALUE);
    expect(audit().map((line) => line.action)).toEqual(['create', 'grant', 'revoke', 'delete', 'deny']);
    // The name is free again.
    expect((await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: NEXT })).status).toBe(201);
});

it('removes a removed app’s workload secrets and grants', async () => {
    const { platform, workspace, as, audit } = await world();
    const admin = await as('alice');
    const own = JSON.parse(
        (
            await admin('POST', '/workspace-secrets', {
                name: 'SLACK_WEBHOOK',
                scope: 'workload',
                appId: 'bookings',
                value: OWN,
            })
        ).text,
    );
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    await admin('PUT', `/workspace-secrets/${shared.id}/grants/bookings`);
    workspace.db.prepare("UPDATE apps SET deletedAt=1, deletedBy='alice' WHERE id='bookings'").run();
    await platform.workspaceSecrets.sweep();
    expect(platform.workspaceSecrets.repository.withDeleted(own.id)).toMatchObject({
        deletedBy: 'system',
        deletedWith: 'app:bookings',
    });
    expect(platform.workspaceSecrets.repository.grants(shared.id)).toEqual([]);
    expect(
        audit()
            .slice(-2)
            .map((line) => [line.actor, line.action]),
    ).toEqual([
        ['system', 'delete'],
        ['system', 'revoke'],
    ]);
});

it('keeps the previous version readable during the overlap window, then retires it', async () => {
    let now = Date.UTC(2026, 10, 1, 12);
    const apps: SecretApp[] = [{ id: 'bookings', name: 'Bookings', status: 'promoted' }];
    const lines: WorkspaceAuditEntry[] = [];
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const secrets = new WorkspaceSecrets(
        new WorkspaceSecretRepository(workspace.db),
        { current: KEY, legacy: SECRET },
        {
            apps: {
                list: () => apps,
                get: (id) => apps.find((app) => app.id === id),
                declared: () => [{ name: 'STRIPE_API_KEY', required: true }],
            },
            audit: (entry) => lines.push(entry),
            userName: () => 'Alice',
            now: () => now,
        },
    );
    const { id } = await secrets.create('alice', { name: 'STRIPE_API_KEY', value: VALUE });
    await secrets.grant('alice', id, 'bookings');
    await secrets.replace('alice', id, { value: NEXT, overlapMinutes: 30 });
    expect(secrets.read('bookings', 'STRIPE_API_KEY')).toEqual({
        ok: true,
        secret: { value: NEXT, version: 2, expiresAt: now + SECRET_CACHE_MS },
    });
    // The previous version, named, until its window ends; cached no longer than that.
    now += 28 * 60_000;
    expect(secrets.read('bookings', 'STRIPE_API_KEY', 1)).toEqual({
        ok: true,
        secret: { value: VALUE, version: 1, expiresAt: Date.UTC(2026, 10, 1, 12, 30) },
    });
    now += 3 * 60_000;
    expect(secrets.read('bookings', 'STRIPE_API_KEY', 1)).toMatchObject({ ok: false, status: 404 });
    expect(secrets.get(id).versions.map((v) => [v.version, v.state])).toEqual([
        [2, 'current'],
        [1, 'retired'],
    ]);
    await secrets.sweep();
    expect(secrets.repository.versions(id).map((v) => v.state)).toEqual(['current', 'retired']);
    // A third version retires the second at once with no overlap; a retired one is never served.
    await secrets.replace('alice', id, { value: 'third-value-0123456789', overlapMinutes: 0 });
    expect(secrets.read('bookings', 'STRIPE_API_KEY', 2)).toMatchObject({ ok: false, status: 404 });
    expect(secrets.read('bookings', 'STRIPE_API_KEY')).toMatchObject({ ok: true, secret: { version: 3 } });
    expect(lines.find((line) => line.action === 'update')?.detail).toBe(
        'STRIPE_API_KEY (workspace): version 2 set; version 1 readable until 2026-11-01T12:30:00.000Z',
    );
    expect(JSON.stringify(lines)).not.toMatch(/sk_live_|third-value/);
    // A sealed version can't be moved to another secret or version.
    const [third, second] = secrets.repository.versions(id);
    workspace.db
        .prepare('UPDATE workspace_secret_versions SET sealed=? WHERE secretId=? AND version=3')
        .run(second!.sealed, id);
    expect(secrets.read('bookings', 'STRIPE_API_KEY')).toMatchObject({ ok: false, status: 404 });
    expect(third!.sealed).not.toBe(second!.sealed);
});

it('counts its seals in the data key status and re-seals them under a new key', async () => {
    const legacy = await world();
    const admin = await legacy.as('alice');
    const shared = JSON.parse(
        (await admin('POST', '/workspace-secrets', { name: 'STRIPE_API_KEY', value: VALUE })).text,
    );
    expect((await legacy.platform.dataKeyStatus()).legacyByPurpose).toMatchObject({ 'workspace-secrets': 1 });
    const sealed = legacy.platform.workspaceSecrets.repository.versions(shared.id)[0]!.sealed;
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(new SecretBox(SECRET, 'workspace-secrets').open(sealed)).toEqual({
        secretId: shared.id,
        version: 1,
        value: VALUE,
    });
    // Another purpose's keys don't open it.
    expect(() => new SecretBox(SECRET, 'settings-secrets').open(sealed)).toThrow();

    // The same database under a data key: legacy until the re-seal.
    const keyed = new WorkspaceSecrets(
        legacy.platform.workspaceSecrets.repository,
        { current: KEY, legacy: SECRET },
        {
            apps: { list: () => [], get: () => undefined, declared: () => [] },
            audit: () => {},
            userName: () => undefined,
        },
    );
    expect(keyed.sealStates()).toEqual({ current: 0, previous: 0, legacy: 1, unknown: 0 });
    expect(await keyed.reseal()).toEqual({ resealed: 1, unreadable: 0 });
    expect(keyed.sealStates()).toEqual({ current: 1, previous: 0, legacy: 0, unknown: 0 });
    const resealed = keyed.repository.versions(shared.id)[0]!.sealed;
    expect(resealed.startsWith('v2.')).toBe(true);
    expect(new SecretBox({ current: KEY, legacy: SECRET }, 'workspace-secrets').open(resealed)).toMatchObject({
        value: VALUE,
    });
    expect(await keyed.reseal()).toEqual({ resealed: 0, unreadable: 0 });
});

it('takes secrets in app manifests: names, uniqueness, and what changed', () => {
    expect(manifest([{ name: 'STRIPE_API_KEY' }]).secrets).toEqual([{ name: 'STRIPE_API_KEY', required: true }]);
    const bad = (secrets: unknown[], env?: Record<string, string>) =>
        parseAppManifest({ name: 'A', entry: 'server.ts', secrets, ...(env ? { env } : {}) });
    expect(bad([{ name: 'lower' }]).ok).toBe(false);
    expect(bad([{ name: 'A_KEY' }, { name: 'A_KEY' }])).toMatchObject({
        ok: false,
        error: expect.stringMatching(/once/),
    });
    expect(bad([{ name: 'A_KEY' }], { A_KEY: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/env/) });
    expect(bad([{ name: 'A_KEY', value: 'no values here' }]).ok).toBe(false);
    const before: AppManifest = manifest([{ name: 'A_KEY' }, { name: 'B_KEY', required: false }]);
    const after: AppManifest = manifest([{ name: 'B_KEY' }, { name: 'C_KEY', required: false }]);
    expect(manifestChanges(before, after)).toEqual([
        'Secret B_KEY: now required',
        'New secret: C_KEY',
        'Secret removed: A_KEY',
    ]);
});
