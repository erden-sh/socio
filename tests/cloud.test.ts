// The cloud connection (docs/specs/CLOUD-SERVICES-PROTOCOL.md §2, §3.1; CB-559): a
// deployment enrolls with provisioning's token, keeps its key sealed, signs
// for access tokens and syncs, against a fake issuer. Off by default: with
// nothing set, nothing is sent.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SecretBox } from '@socio/foundation/keys/secret-box';
import { loadSecretFiles } from '@socio/foundation/keys/secret-files';

import { CLOUD_IDENTITY_SETTING } from '../src/server/cloud/contract.js';
import { cloudService } from '../src/server/cloud/layer.js';
import type { CloudService } from '../src/server/cloud/service.js';
import { cloudFromEnv } from '../src/server/cloud/settings.js';

import { fakeIssuer, ISSUER, PUSH, type FakeIssuer } from './fixtures/fake-cloud-issuer.js';
import { Store } from './helpers/stores.js';
import { testDatabaseFile } from './helpers/test-database.js';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const SECRET = 'cloud-test-session-secret-0123456789';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return testDatabaseFile(join(dir, 'workspace.db'));
}

interface Setup {
    env?: Record<string, string>;
    issuer?: FakeIssuer;
    path?: string;
    key?: Uint8Array;
    origin?: string;
    now?: () => number;
}

function setup(options: Setup = {}) {
    const issuer = options.issuer ?? fakeIssuer();
    const path = options.path ?? database();
    const store = new Store(path);
    cleanup.push(() => store.close());
    const notices: Array<{ trigger: string }> = [];
    const logs: string[] = [];
    const box = new SecretBox({ current: options.key ?? KEY, legacy: SECRET }, 'settings-secrets');
    const cloud: CloudService = cloudService({
        config: { cloud: cloudFromEnv({ SOCIO_CLOUD_ISSUER: ISSUER, ...options.env }) },
        settings: store,
        secrets: store,
        releases: { data: () => ({ version: '0.55.0', commit: 'abc', releases: [] }) },
        host: {
            box,
            origin: options.origin ?? 'https://brain.example.test',
            notifyAdmins: async (notice) => void notices.push(notice),
        },
        transport: issuer.fetch,
        now: options.now,
    });
    // Logs are kept to check that no token or key is ever written to one.
    const log = console.log;
    console.log = (line: string) => void logs.push(line);
    cleanup.push(() => (console.log = log));
    return { cloud, issuer, store, path, notices, logs, box };
}

/** Enrolls a deployment with a new provisioning token. */
async function enrolled(options: Setup = {}) {
    const issuer = options.issuer ?? fakeIssuer();
    const { token, deploymentId } = issuer.provision();
    const parts = setup({ ...options, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token, ...options.env } });
    await parts.cloud.work();
    return { ...parts, token, deploymentId };
}

describe('the settings', () => {
    it('defaults to the production issuer, on, with no token', () => {
        expect(cloudFromEnv({})).toEqual({ off: false, issuer: 'https://cloud.socio.sh' });
        expect(cloudFromEnv({ SOCIO_CLOUD: 'off' }).off).toBe(true);
        expect(cloudFromEnv({ SOCIO_CLOUD_ENROLLMENT_TOKEN: 'none' }).enrollmentToken).toBeUndefined();
    });

    it('takes an https origin only, http on loopback for a local issuer', () => {
        expect(cloudFromEnv({ SOCIO_CLOUD_ISSUER: 'https://cloud-staging.socio.sh/' }).issuer).toBe(
            'https://cloud-staging.socio.sh',
        );
        expect(cloudFromEnv({ SOCIO_CLOUD_ISSUER: 'http://127.0.0.1:8787' }).issuer).toBe('http://127.0.0.1:8787');
        for (const bad of [
            'http://cloud.example.test',
            'https://cloud.example.test/v1',
            'https://u:p@cloud.example.test',
            'cloud',
        ]) {
            expect(() => cloudFromEnv({ SOCIO_CLOUD_ISSUER: bad })).toThrow(/SOCIO_CLOUD_ISSUER/);
        }
        expect(() => cloudFromEnv({ SOCIO_CLOUD: 'maybe' })).toThrow(/SOCIO_CLOUD must be on or off/);
        expect(() => cloudFromEnv({ SOCIO_CLOUD_REPLACE_LOST: 'yes' })).toThrow(/SOCIO_CLOUD_REPLACE_LOST/);
        expect(cloudFromEnv({ SOCIO_CLOUD_REPLACE_LOST: 'true' }).replaceLost).toBe(true);
    });

    it('reads the token from a secret file, and never echoes a bad one', () => {
        const env: Record<string, string | undefined> = { SOCIO_CLOUD_ENROLLMENT_TOKEN_FILE: '/run/secrets/cloud' };
        loadSecretFiles(env, () => 'iat_0123456789abcdefghij\n');
        expect(cloudFromEnv(env).enrollmentToken).toBe('iat_0123456789abcdefghij');
        const bad = 'has a space in it 0123456789';
        expect(() => cloudFromEnv({ SOCIO_CLOUD_ENROLLMENT_TOKEN: bad })).toThrow(
            expect.objectContaining({ message: expect.not.stringContaining(bad) }),
        );
    });
});

describe('a deployment without the settings', () => {
    it('sends nothing and stores nothing: it runs as before', async () => {
        const { cloud, issuer, store } = setup();
        await cloud.work();
        expect(await cloud.token(PUSH)).toBeUndefined();
        expect(issuer.requests).toEqual([]);
        expect(store.secretSetting(CLOUD_IDENTITY_SETTING)).toBeUndefined();
        expect(cloud.status()).toMatchObject({ connection: 'not-connected', scopes: [] });
    });

    it('sends nothing with SOCIO_CLOUD=off, even with a token or an identity', async () => {
        const { path, issuer } = await enrolled();
        const before = issuer.requests.length;
        const { token } = issuer.provision();
        const { cloud } = setup({ path, issuer, env: { SOCIO_CLOUD: 'off', SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await cloud.work();
        expect(await cloud.token(PUSH)).toBeUndefined();
        expect(issuer.requests.length).toBe(before);
        expect(cloud.status().connection).toBe('off');
    });
});

describe('enrollment', () => {
    it('registers a new Ed25519 key with the token and keeps the identity sealed', async () => {
        const { cloud, issuer, store, deploymentId, token, logs } = await enrolled();
        expect(cloud.status()).toMatchObject({
            connection: 'connected',
            deploymentId,
            deploymentMode: 'hosted',
            scopes: ['reports:write', 'push:send', 'updates:read'],
        });
        const registration = issuer.requests.find((request) => request.path === '/oauth2/register')!;
        expect(registration.headers.authorization).toBe(`Bearer ${token}`);
        const sent = JSON.parse(registration.body) as { jwks: { keys: Array<Record<string, string>> } };
        // The public half only: never `d`.
        expect(Object.keys(sent.jwks.keys[0]!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
        expect(sent).toMatchObject({ token_endpoint_auth_method: 'private_key_jwt', software_version: '0.55.0' });

        const sealed = store.secretSetting(CLOUD_IDENTITY_SETTING)!.value;
        expect(sealed.startsWith('v2.')).toBe(true);
        expect(sealed).not.toContain(deploymentId);
        // No token, key or answer in the logs.
        expect(logs.join('\n')).not.toMatch(new RegExp(`${token}|"d"|at_`));
    });

    it('syncs at once after enrolling: version, origin and a fingerprint, nothing else', async () => {
        const { issuer } = await enrolled();
        expect(issuer.synced).toHaveLength(1);
        const body = issuer.synced[0] as { v: number; deployment: Record<string, string>; sections: object };
        expect(body.v).toBe(1);
        expect(body.sections).toEqual({});
        expect(Object.keys(body.deployment).sort()).toEqual(['fingerprint', 'origin', 'version']);
        expect(body.deployment).toMatchObject({ version: '0.55.0', origin: 'https://brain.example.test' });
        // The sync token was for the issuer itself.
        expect(issuer.issued.map((token) => token.audience)).toEqual([ISSUER]);
    });

    it('uses a token once: a restart with the token still set does not enroll again', async () => {
        const { path, issuer, token, deploymentId } = await enrolled();
        const registrations = () => issuer.requests.filter((request) => request.path === '/oauth2/register').length;
        const again = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await again.cloud.work();
        expect(registrations()).toBe(1);
        expect(again.cloud.status()).toMatchObject({ connection: 'connected', deploymentId });
    });

    it('stops trying a refused token, and keeps that across a restart', async () => {
        const issuer = fakeIssuer();
        const { cloud, path, logs } = setup({
            issuer,
            env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: 'iat_never-issued-0123456789' },
        });
        await cloud.work();
        await cloud.work();
        expect(issuer.requests.filter((request) => request.path === '/oauth2/register')).toHaveLength(1);
        expect(cloud.status().connection).toBe('not-connected');
        expect(logs.join('\n')).toContain('refused (invalid_token)');
        expect(logs.join('\n')).not.toContain('iat_never-issued');
        const again = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: 'iat_never-issued-0123456789' } });
        await again.cloud.work();
        expect(issuer.requests.filter((request) => request.path === '/oauth2/register')).toHaveLength(1);
    });

    it('tries again later when the issuer is down, without holding anything up', async () => {
        let now = Date.now();
        const issuer = fakeIssuer();
        const { token } = issuer.provision();
        issuer.down = 'network';
        const { cloud } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token }, now: () => now });
        await cloud.work();
        expect(cloud.status().connection).toBe('not-connected');
        const tries = issuer.requests.length;
        // Not before the backoff's minute.
        await cloud.work();
        expect(issuer.requests.length).toBe(tries);
        issuer.down = false;
        now += 61_000;
        await cloud.work();
        expect(cloud.status().connection).toBe('connected');
    });

    it('does not count a refused discovery against the token', async () => {
        const issuer = fakeIssuer();
        const { token } = issuer.provision();
        issuer.metadataStatus = 401;
        const { cloud, path } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await cloud.work();
        expect(issuer.requests.some((request) => request.path === '/oauth2/register')).toBe(false);
        issuer.metadataStatus = undefined;
        // A restart (no backoff) enrolls with the same token.
        const again = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await again.cloud.work();
        expect(again.cloud.status().connection).toBe('connected');
    });

    it('enrolls again with a new token for the same deployment: the new key replaces the old', async () => {
        const { path, issuer, deploymentId, store } = await enrolled();
        const firstKid = issuer.clients.get(deploymentId)!.jwk.kid;
        const sealedBefore = store.secretSetting(CLOUD_IDENTITY_SETTING)!.value;
        const { token } = issuer.provision(deploymentId);
        const again = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await again.cloud.work();
        expect(issuer.clients.get(deploymentId)!.jwk.kid).not.toBe(firstKid);
        expect(again.cloud.status()).toMatchObject({ connection: 'connected', deploymentId });
        expect(again.store.secretSetting(CLOUD_IDENTITY_SETTING)!.value).not.toBe(sealedBefore);
        // The new key works.
        expect(await again.cloud.token(PUSH)).toMatch(/^at_/);
    });

    it('accepts endpoints only on the issuer’s own origin', async () => {
        const issuer = fakeIssuer();
        issuer.metadataOverride = { registration_endpoint: 'https://elsewhere.example.test/register' };
        const { token } = issuer.provision();
        const { cloud } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await cloud.work();
        expect(issuer.requests.map((request) => request.path)).toEqual(['/.well-known/oauth-authorization-server']);
        expect(cloud.status().connection).toBe('not-connected');
    });

    it('refuses metadata that names another issuer', async () => {
        const issuer = fakeIssuer();
        issuer.metadataOverride = { issuer: 'https://other.socio.test' };
        const { token } = issuer.provision();
        const { cloud } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await cloud.work();
        expect(issuer.requests.some((request) => request.path === '/oauth2/register')).toBe(false);
    });
});

describe('access tokens', () => {
    it('signs for a token per audience, caches it, and renews at 80% of its life', async () => {
        let now = Date.now();
        const { cloud, issuer } = await enrolled({ now: () => now });
        const first = await cloud.token(PUSH);
        expect(first).toMatch(/^at_/);
        expect(await cloud.token(`${PUSH}/`)).toBe(first);
        const request = issuer.requests.filter((r) => r.path === '/oauth2/token').at(-1)!;
        const form = new URLSearchParams(request.body);
        expect(form.get('resource')).toBe(PUSH);
        // Never a client secret: a signed assertion only.
        expect(form.has('client_secret')).toBe(false);
        now += 0.81 * 3600_000;
        const renewed = await cloud.token(PUSH);
        expect(renewed).not.toBe(first);
    });

    it('asks once for many callers at the same moment', async () => {
        const { cloud, issuer } = await enrolled();
        const before = issuer.issued.length;
        const tokens = await Promise.all(Array.from({ length: 5 }, () => cloud.token(PUSH)));
        expect(new Set(tokens).size).toBe(1);
        expect(issuer.issued.length).toBe(before + 1);
    });

    it('stops calling once the issuer refuses the key, and tells admins once', async () => {
        const { cloud, issuer, deploymentId, notices, path } = await enrolled();
        issuer.revoke(deploymentId);
        expect(await cloud.token(PUSH)).toBeUndefined();
        expect(cloud.status()).toMatchObject({ connection: 'revoked', scopes: [] });
        const after = issuer.requests.length;
        expect(await cloud.token(PUSH)).toBeUndefined();
        await cloud.work();
        expect(issuer.requests.length).toBe(after);
        expect(notices.map((notice) => notice.trigger)).toEqual(['cloud_revoked']);
        // Written down: a restart doesn't call either.
        const again = setup({ path, issuer });
        await again.cloud.work();
        expect(await again.cloud.token(PUSH)).toBeUndefined();
        expect(issuer.requests.length).toBe(after);
    });

    it('holds back while the issuer pauses tokens, and says so in the status', async () => {
        let now = Date.now();
        const { cloud, issuer } = await enrolled({ now: () => now });
        issuer.paused = true;
        expect(await cloud.token(PUSH)).toBeUndefined();
        expect(cloud.status().connection).toBe('paused');
        const after = issuer.requests.length;
        expect(await cloud.token(PUSH)).toBeUndefined();
        expect(issuer.requests.length).toBe(after);
        issuer.paused = false;
        now += 5 * 60_000 + 1;
        expect(await cloud.token(PUSH)).toMatch(/^at_/);
        expect(cloud.status().connection).toBe('connected');
    });

    it('keeps a still-good token while the issuer is unreachable', async () => {
        let now = Date.now();
        const { cloud, issuer } = await enrolled({ now: () => now });
        const token = await cloud.token(PUSH);
        now += 0.85 * 3600_000;
        issuer.down = 503;
        expect(await cloud.token(PUSH)).toBe(token);
        now += 0.2 * 3600_000;
        expect(await cloud.token(PUSH)).toBeUndefined();
    });

    it('names an audience by its origin only', async () => {
        const { cloud } = await enrolled();
        expect(await cloud.token('http://push.socio.test')).toBeUndefined();
        expect(await cloud.token('https://push.socio.test/v1/send')).toBeUndefined();
        expect(await cloud.token('not a url')).toBeUndefined();
    });
});

describe('sync', () => {
    it('runs once a day, and keeps the issuer’s word on scopes for the display', async () => {
        let now = Date.now();
        const { cloud, issuer } = await enrolled({ now: () => now });
        expect(issuer.synced).toHaveLength(1);
        await cloud.work();
        expect(issuer.synced).toHaveLength(1);
        issuer.clients.forEach((client) => (client.scopes = 'push:send'));
        now += 24 * 3600_000 + 1;
        await cloud.work();
        expect(issuer.synced).toHaveLength(2);
        expect(cloud.status().scopes).toEqual(['push:send']);
    });

    it('reports the same fingerprint every time, and another one for a copy on another origin', async () => {
        let now = Date.now();
        const { cloud, issuer, path } = await enrolled({ now: () => now });
        now += 24 * 3600_000 + 1;
        await cloud.work();
        const fingerprints = issuer.synced.map(
            (body) => (body as { deployment: { fingerprint: string } }).deployment.fingerprint,
        );
        expect(new Set(fingerprints).size).toBe(1);
        const copy = setup({ path, issuer, origin: 'https://copy.example.test' });
        await copy.cloud.work();
        const last = issuer.synced.at(-1) as { deployment: { fingerprint: string; origin: string } };
        expect(last.deployment.origin).toBe('https://copy.example.test');
        expect(last.deployment.fingerprint).not.toBe(fingerprints[0]);
    });
});

describe('the data key', () => {
    it('reseals the identity under a new data key, and it still works', async () => {
        const { path, issuer, deploymentId } = await enrolled();
        const rotating = setup({ path, issuer });
        // The current key becomes the previous one.
        const store = rotating.store;
        const box = new SecretBox({ current: OTHER_KEY, previous: KEY, legacy: SECRET }, 'settings-secrets');
        const next = cloudService({
            config: { cloud: cloudFromEnv({ SOCIO_CLOUD_ISSUER: ISSUER }) },
            settings: store,
            secrets: store,
            releases: { data: () => ({ version: '0.55.0', commit: 'abc', releases: [] }) },
            host: { box, origin: undefined, notifyAdmins: async () => {} },
            transport: issuer.fetch,
        });
        expect(next.sealStates()).toMatchObject({ previous: 1, current: 0 });
        expect(await next.reseal()).toEqual({ resealed: 1, unreadable: 0 });
        expect(next.sealStates()).toMatchObject({ previous: 0, current: 1 });
        expect(next.status()).toMatchObject({ connection: 'connected', deploymentId });
        expect(await next.token(PUSH)).toMatch(/^at_/);
    });

    it('shows the connection lost when the data key is gone, and sends nothing', async () => {
        const { path, issuer } = await enrolled();
        const before = issuer.requests.length;
        const lost = setup({ path, issuer, key: OTHER_KEY });
        expect(lost.cloud.status().connection).toBe('lost');
        expect(await lost.cloud.token(PUSH)).toBeUndefined();
        await lost.cloud.work();
        expect(issuer.requests.length).toBe(before);
        expect(lost.cloud.sealStates().unknown).toBe(1);
        expect(lost.logs.join('\n')).toContain('Cloud connection lost');
    });

    it('never spends the token still mounted over a lost identity', async () => {
        const { path, issuer, token } = await enrolled();
        const before = issuer.requests.length;
        // Provisioning leaves the used token in place; the record that it was used is what was lost.
        for (let restart = 0; restart < 2; restart++) {
            const lost = setup({ path, issuer, key: OTHER_KEY, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
            await lost.cloud.work();
            expect(lost.cloud.status().connection).toBe('lost');
            expect(lost.logs.join('\n')).toContain('SOCIO_CLOUD_REPLACE_LOST=true');
        }
        expect(issuer.requests.length).toBe(before);
    });

    it('enrolls again over a lost identity with a new token when told to replace it', async () => {
        const { path, issuer, deploymentId } = await enrolled();
        const { token } = issuer.provision(deploymentId);
        const recovered = setup({
            path,
            issuer,
            key: OTHER_KEY,
            env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token, SOCIO_CLOUD_REPLACE_LOST: 'true' },
        });
        await recovered.cloud.work();
        expect(recovered.cloud.status()).toMatchObject({ connection: 'connected', deploymentId });
        expect(recovered.cloud.sealStates()).toMatchObject({ current: 1, unknown: 0 });
    });
});

describe('shutting down', () => {
    it('waits for an enrollment in flight, so the spent token’s identity is stored', async () => {
        const issuer = fakeIssuer();
        const { token, deploymentId } = issuer.provision();
        let answer!: () => void;
        const held = new Promise<void>((resolve) => (answer = resolve));
        let registering!: () => void;
        const started = new Promise<void>((resolve) => (registering = resolve));
        issuer.onRegister = () => {
            registering();
            return held;
        };
        const { cloud, store } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        void cloud.work();
        await started;
        // The token is spent at the issuer; the answer hasn't come back.
        let drained = false;
        const drain = cloud.drain().then(() => (drained = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(drained).toBe(false);
        answer();
        await drain;
        expect(store.secretSetting(CLOUD_IDENTITY_SETTING)).toBeDefined();
        expect(cloud.status()).toMatchObject({ connection: 'connected', deploymentId });
    });

    it('waits for the record that a token was refused before it lets the database close', async () => {
        const issuer = fakeIssuer();
        const token = 'iat_never-issued-0123456789';
        const { cloud, store, path } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const update = store.updateSettings.bind(store);
        let writing = false;
        store.updateSettings = async (...args: Parameters<typeof update>) => {
            writing = true;
            await held;
            return update(...args);
        };
        void cloud.work();
        while (!writing) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        let drained = false;
        const drain = cloud.drain().then(() => (drained = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(drained).toBe(false);
        release();
        await drain;
        // Written down: a restart doesn't try the token again.
        const before = issuer.requests.filter((request) => request.path === '/oauth2/register').length;
        const again = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await again.cloud.work();
        expect(issuer.requests.filter((request) => request.path === '/oauth2/register').length).toBe(before);
    });

    it('starts no work while drained, and again once resumed', async () => {
        const issuer = fakeIssuer();
        const { token } = issuer.provision();
        const { cloud } = setup({ issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        await cloud.drain();
        await cloud.work();
        expect(issuer.requests).toEqual([]);
        cloud.resume();
        await cloud.work();
        expect(cloud.status().connection).toBe('connected');
    });
});

describe('two runtimes on one database', () => {
    /** Holds the next request to `path` until the returned release is called. */
    function holdNext(issuer: FakeIssuer, path: string) {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const arrived = new Promise<void>((resolve) => (reached = resolve));
        let armed = true;
        issuer.before = async (requested) => {
            if (armed && requested === path) {
                armed = false;
                reached();
                await gate;
            }
        };
        return { arrived, release };
    }

    it('does not mark a newer enrollment revoked when an older key is refused', async () => {
        const issuer = fakeIssuer();
        const path = database();
        const first = issuer.provision();
        const a = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: first.token } });
        await a.cloud.work();
        // B asks for a token with the first key, and its request waits.
        const b = setup({ path, issuer });
        const hold = holdNext(issuer, '/oauth2/token');
        const pending = b.cloud.token(PUSH);
        await hold.arrived;
        // Meanwhile A enrolls again: the issuer now knows only the new key.
        const second = issuer.provision(first.deploymentId);
        const a2 = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: second.token } });
        await a2.cloud.work();
        hold.release();
        // The old key is refused, but the record now holds the new one: nothing is marked revoked.
        expect(await pending).toBeUndefined();
        expect(b.notices).toEqual([]);
        const fresh = setup({ path, issuer });
        expect(fresh.cloud.status().connection).toBe('connected');
        expect(await fresh.cloud.token(PUSH)).toMatch(/^at_/);
    });

    it('does not write a sync’s answer for an older key over a newer enrollment', async () => {
        let now = Date.now();
        const issuer = fakeIssuer();
        const path = database();
        const first = issuer.provision();
        const a = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: first.token }, now: () => now });
        await a.cloud.work();
        now += 24 * 3600_000 + 1;
        // A's next sync waits at the issuer, its token already taken with the first key.
        const hold = holdNext(issuer, '/v1/sync');
        const syncing = a.cloud.work();
        await hold.arrived;
        const second = issuer.provision(first.deploymentId);
        const b = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: second.token } });
        await b.cloud.work();
        // The answer A is waiting for will carry scopes B's record doesn't have.
        issuer.clients.get(first.deploymentId)!.scopes = 'push:send';
        const sealed = b.store.secretSetting(CLOUD_IDENTITY_SETTING)!.value;
        hold.release();
        await syncing;
        // A's answer was for the first key: the newer record stays as B wrote it.
        expect(issuer.synced.length).toBeGreaterThanOrEqual(3);
        expect(a.store.secretSetting(CLOUD_IDENTITY_SETTING)!.value).toBe(sealed);
    });

    it('does not reseal over a record another runtime changed meanwhile', async () => {
        const { path, issuer, store } = await enrolled();
        const stale = store.secretSetting(CLOUD_IDENTITY_SETTING)!.value;
        const { token } = issuer.provision();
        const b = setup({
            path,
            issuer,
            env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token, SOCIO_CLOUD_REPLACE_LOST: 'true' },
        });
        await b.cloud.work();
        const newer = b.store.secretSetting(CLOUD_IDENTITY_SETTING)!.value;
        expect(newer).not.toBe(stale);
        // A compare-and-set from the stale value changes nothing.
        expect(await store.replaceSecretSetting(CLOUD_IDENTITY_SETTING, stale, 'v2.x.y')).toBe(false);
        expect(store.secretSetting(CLOUD_IDENTITY_SETTING)!.value).toBe(newer);
    });

    it('does not write over an enrollment the other stored meanwhile', async () => {
        const issuer = fakeIssuer();
        const path = database();
        const { token } = issuer.provision();
        const a = setup({ path, issuer, env: { SOCIO_CLOUD_ENROLLMENT_TOKEN: token } });
        const b = setup({ path, issuer });
        await a.cloud.work();
        // B sees A's identity and uses it.
        expect(b.cloud.status().connection).toBe('connected');
        expect(await b.cloud.token(PUSH)).toMatch(/^at_/);
    });
});
