import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import type { DomainOp, DomainOpStarted, DomainsStatus } from '@socio/shared/domains';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { domainsRepositories } from '../src/server/composition/domains.js';
import { RECORD_COMMENT } from '../src/server/domains/cloudflare-client.js';
import { DomainsError } from '../src/server/domains/contract.js';
import { Redactor } from '../src/server/domains/http.js';
import { NpmClient } from '../src/server/domains/npm-client.js';
import { DomainsService, type DomainsServiceOptions } from '../src/server/domains/service.js';
import { domainsSettingsFromEnv } from '../src/server/domains/settings.js';
import { DomainsStore } from '../src/server/domains/store.js';

import { startFakeCloudflare } from './fixtures/fake-cloudflare.js';
import { startFakeNpm } from './fixtures/fake-npm.js';
import { Runner } from './helpers/runners.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const ZONE = 'example.test';
const BASE = 'brain.example.test';
const WILDCARD = '*.brain.example.test';
const IP = '10.0.0.10';
const ACME = 'acme@example.test';
const NPM_PASSWORD = 'npm-password-0123';
/** Workspace people: nothing about them may reach NPM or Cloudflare. */
const USERS: (User & { email: string })[] = [
    {
        id: 'olga',
        name: 'Olga Operator',
        role: 'admin',
        email: 'olga@people.test',
    },
    {
        id: 'alice',
        name: 'Alice Admin',
        role: 'admin',
        email: 'alice@people.test',
    },
    { id: 'bob', name: 'Bob Member', role: 'member', email: 'bob@people.test' },
];

async function fakes() {
    const npm = await startFakeNpm();
    const cf = await startFakeCloudflare({ zone: ZONE });
    cleanup.push(
        () => npm.close(),
        () => cf.close(),
    );
    const env: Record<string, string | undefined> = {
        DOMAINS_ZONE: ZONE,
        DOMAINS_BASE: BASE,
        DOMAINS_TARGET_IP: IP,
        DOMAINS_UPSTREAM: 'http://company-brain_app:4310',
        DOMAINS_ACME_EMAIL: ACME,
        NPM_API_URL: npm.url,
        NPM_CREDENTIALS: JSON.stringify({ email: ACME, password: NPM_PASSWORD }),
        CLOUDFLARE_DNS_TOKEN: cf.token,
        CLOUDFLARE_API_URL: cf.url,
    };
    return { npm, cf, env };
}

/** The service on `db`, as the composition builds it. */
const domainsService = (db: DatabaseSync, options: DomainsServiceOptions) =>
    new DomainsService(new DomainsStore(domainsRepositories(db)), options);

async function setup(overrides: Record<string, string | undefined> = {}) {
    const { npm, cf, env } = await fakes();
    Object.assign(env, overrides);
    const logs: string[] = [];
    const db = testDatabase();
    const service = domainsService(db, {
        config: domainsSettingsFromEnv(env),
        log: (line) => logs.push(line),
    });
    cleanup.push(() => db.close());
    return { npm, cf, env, service, logs, db };
}

/** Everything sent to either fake, as one string. */
const sent = (
    ...fakes: {
        state: { requests: { path: string; headers: object; body: string }[] };
    }[]
) =>
    fakes
        .flatMap((fake) =>
            fake.state.requests.map(
                (request) => `${request.path}\n${JSON.stringify(request.headers)}\n${request.body}`,
            ),
        )
        .join('\n');

const steps = (op: DomainOp) => op.steps.map((step) => `${step.item}:${step.name}:${step.action}`);

it('is off until NPM and Cloudflare are configured, naming what is missing', () => {
    expect(domainsSettingsFromEnv({})).toEqual({
        missing: [
            'DOMAINS_ZONE',
            'DOMAINS_BASE',
            'DOMAINS_TARGET_IP',
            'DOMAINS_UPSTREAM',
            'NPM_API_URL',
            'NPM_CREDENTIALS_FILE',
            'CLOUDFLARE_DNS_TOKEN_FILE',
        ],
    });
    // The placeholder secret `none` counts as missing.
    const placeholder = domainsSettingsFromEnv({
        DOMAINS_ZONE: ZONE,
        DOMAINS_BASE: BASE,
        DOMAINS_TARGET_IP: IP,
        DOMAINS_UPSTREAM: 'http://company-brain_app:4310',
        NPM_API_URL: 'http://ingress_proxy:81/api',
        NPM_CREDENTIALS: 'none',
        CLOUDFLARE_DNS_TOKEN: 'none',
    });
    expect(placeholder).toEqual({
        missing: ['NPM_CREDENTIALS_FILE', 'CLOUDFLARE_DNS_TOKEN_FILE'],
    });
    // The files are read like the other secrets, `none` included.
    const env: Record<string, string | undefined> = {
        NPM_CREDENTIALS_FILE: '/run/secrets/npm',
        CLOUDFLARE_DNS_TOKEN_FILE: '/run/secrets/cf',
    };
    loadSecretFiles(env, (path) => (path === '/run/secrets/npm' ? '{"email":"a@b.c","password":"p"}\n' : 'none\n'));
    expect(env.NPM_CREDENTIALS).toBe('{"email":"a@b.c","password":"p"}');
    expect(env.CLOUDFLARE_DNS_TOKEN).toBe('none');
});

it('refuses malformed settings without echoing secrets', () => {
    const good = {
        DOMAINS_ZONE: ZONE,
        DOMAINS_BASE: BASE,
        DOMAINS_TARGET_IP: IP,
        DOMAINS_UPSTREAM: 'http://company-brain_app:4310',
        NPM_API_URL: 'http://ingress_proxy:81/api',
        NPM_CREDENTIALS: JSON.stringify({ email: ACME, password: NPM_PASSWORD }),
        CLOUDFLARE_DNS_TOKEN: 'cf-secret-token-value',
    };
    const settings = domainsSettingsFromEnv(good).settings!;
    expect(settings.upstream).toEqual({
        scheme: 'http',
        host: 'company-brain_app',
        port: 4310,
    });
    expect(settings.acmeEmail).toBeUndefined();
    expect(settings.cloudflare.url).toBe('https://api.cloudflare.com/client/v4');
    for (const [name, value, message] of [
        ['DOMAINS_BASE', 'brain.elsewhere.dev', /under DOMAINS_ZONE/],
        ['DOMAINS_TARGET_IP', '10.0.0', /IPv4/],
        ['DOMAINS_UPSTREAM', 'ftp://app', /http\(s\) origin/],
        ['NPM_CREDENTIALS', `{"email":"x","password":"${NPM_PASSWORD}"`, /must hold JSON/],
        ['NPM_CREDENTIALS', JSON.stringify({ email: 'nobody', password: NPM_PASSWORD }), /must hold JSON/],
        ['DOMAINS_ACME_EMAIL', 'not-an-address', /email address/],
    ] as const) {
        let error: unknown;
        try {
            domainsSettingsFromEnv({ ...good, [name]: value });
        } catch (cause) {
            error = cause;
        }
        expect(error, name).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(message);
        expect((error as Error).message).not.toContain(NPM_PASSWORD);
    }
});

it('logs in to NPM once, reuses the token, refreshes it near expiry and logs in again on a 401', async () => {
    const { npm, env } = await fakes();
    let clock = Date.now();
    const settings = domainsSettingsFromEnv(env).settings!;
    const client = new NpmClient(settings.npm, new Redactor(), fetch, () => clock);
    await client.proxyHosts();
    await client.certificates();
    expect(client.stats).toEqual({ logins: 1, refreshes: 0 });
    const logins = () => npm.state.requests.filter((r) => r.method === 'POST' && r.path === '/api/tokens');
    expect(logins()).toHaveLength(1);
    expect(JSON.parse(logins()[0].body)).toEqual({
        identity: ACME,
        secret: NPM_PASSWORD,
    });
    // Half a day on: still fresh.
    clock += 12 * 3_600_000;
    await client.proxyHosts();
    expect(client.stats).toEqual({ logins: 1, refreshes: 0 });
    // Within the last hour: renewed with GET /tokens, then used.
    clock += 11.5 * 3_600_000;
    await client.proxyHosts();
    expect(client.stats).toEqual({ logins: 1, refreshes: 1 });
    const refresh = npm.state.requests.find((r) => r.method === 'GET' && r.path === '/api/tokens');
    expect(refresh?.headers.authorization).toMatch(/^Bearer eyJ/);
    // Revoked behind its back: one fresh login and the call goes through.
    npm.revokeTokens();
    await expect(client.proxyHosts()).resolves.toEqual([]);
    expect(client.stats).toEqual({ logins: 2, refreshes: 1 });
    // Past its expiry: a login, not a refresh.
    clock += 26 * 3_600_000;
    await client.proxyHosts();
    expect(client.stats).toEqual({ logins: 3, refreshes: 1 });
    // A wrong password is a typed error that doesn't repeat it.
    const wrong = new NpmClient({ ...settings.npm, password: 'wrong-password-xyz' }, new Redactor());
    const error = await wrong.proxyHosts().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DomainsError);
    expect((error as DomainsError).code).toBe('unauthorized');
    expect((error as Error).message).not.toContain('wrong-password-xyz');
});

it('times out a silent NPM with a typed error', async () => {
    const silent = createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanup.push(
        () =>
            new Promise<void>((resolve) => {
                silent.closeAllConnections();
                silent.close(() => resolve());
            }),
    );
    const { port } = silent.address() as AddressInfo;
    const { env } = await fakes();
    const settings = domainsSettingsFromEnv({
        ...env,
        NPM_API_URL: `http://127.0.0.1:${port}/api`,
        NPM_TIMEOUT_SECONDS: '1',
    }).settings!;
    const client = new NpmClient(settings.npm, new Redactor());
    const error = await client.proxyHosts().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DomainsError);
    expect((error as DomainsError).code).toBe('unavailable');
    expect((error as Error).message).toBe('Nginx Proxy Manager did not answer within 1 s.');
});

it('sets up the base from nothing: two A records, one DNS-01 certificate, two proxy hosts', async () => {
    const { npm, cf, service, logs } = await setup();
    const op = await service.ensureBase('olga');
    expect(op.error).toBeUndefined();
    expect(op.status).toBe('ok');
    expect(steps(op)).toEqual([
        `dns:${BASE}:created`,
        `dns:${WILDCARD}:created`,
        `certificate:${BASE}, ${WILDCARD}:created`,
        `proxy_host:${BASE}:created`,
        `proxy_host:${WILDCARD}:created`,
    ]);
    // DNS only, TTL auto, marked as this module's.
    expect(
        cf.state.records.map(({ type, name, content, proxied, ttl, comment }) => ({
            type,
            name,
            content,
            proxied,
            ttl,
            comment,
        })),
    ).toEqual([
        {
            type: 'A',
            name: BASE,
            content: IP,
            proxied: false,
            ttl: 1,
            comment: RECORD_COMMENT,
        },
        {
            type: 'A',
            name: WILDCARD,
            content: IP,
            proxied: false,
            ttl: 1,
            comment: RECORD_COMMENT,
        },
    ]);
    // One certificate for both names, by DNS-01 through Cloudflare, with
    // the Cloudflare token as NPM's credentials and no address in the
    // request: Let's Encrypt gets the NPM user's (DOMAINS_ACME_EMAIL).
    expect(npm.state.certificates).toHaveLength(1);
    const [cert] = npm.state.certificates;
    expect(cert).toMatchObject({
        provider: 'letsencrypt',
        domain_names: [BASE, WILDCARD],
        meta: { dns_challenge: true, dns_provider: 'cloudflare' },
        letsencrypt_email: ACME,
    });
    expect(npm.state.dnsCredentials).toEqual([`dns_cloudflare_api_token = ${cf.token}`]);
    const certRequest = npm.state.requests.find((r) => r.method === 'POST' && r.path === '/api/nginx/certificates')!;
    expect(certRequest.body).not.toContain('@');
    // Both proxy hosts: the upstream, the certificate, the flags.
    expect(npm.state.proxyHosts).toHaveLength(2);
    for (const [i, name] of [BASE, WILDCARD].entries()) {
        expect(npm.state.proxyHosts[i]).toMatchObject({
            domain_names: [name],
            forward_scheme: 'http',
            forward_host: 'company-brain_app',
            forward_port: 4310,
            certificate_id: cert.id,
            ssl_forced: true,
            http2_support: true,
            hsts_enabled: true,
            block_exploits: true,
            allow_websocket_upgrade: true,
            caching_enabled: false,
            enabled: true,
        });
    }
    const status = await service.status();
    expect(status.base?.ok).toBe(true);
    expect(status.base?.certificate?.domains).toEqual([BASE, WILDCARD]);
    expect(status.base?.certificate?.expiresOn).toBeTruthy();
    expect(status.base?.hostnames.map((h) => [h.hostname, h.dnsContent, h.proxyHostOk])).toEqual([
        [BASE, IP, true],
        [WILDCARD, IP, true],
    ]);
    expect(status.ops[0]).toMatchObject({
        kind: 'ensure_base',
        status: 'ok',
        actor: 'olga',
    });
    expect(logs).toEqual([`Domains: ensure_base ${BASE} ok (5 created) by olga`]);
});

it('re-runs without changing anything', async () => {
    const { npm, cf, service } = await setup();
    await service.ensureBase('olga');
    const npmWrites = npm.writes().length;
    const cfWrites = cf.writes().length;
    const again = await service.ensureBase('olga');
    expect(again.status).toBe('ok');
    expect(again.steps.every((step) => step.action === 'kept')).toBe(true);
    expect(npm.writes()).toHaveLength(npmWrites);
    expect(cf.writes()).toHaveLength(cfWrites);
    expect(npm.state.certificates).toHaveLength(1);
    expect(npm.state.proxyHosts).toHaveLength(2);
});

it('repairs drift: a wrong or proxied record, an extra record, a missing or changed proxy host', async () => {
    const { npm, cf, service } = await setup();
    await service.ensureBase('olga');
    const [base, wildcard] = cf.state.records;
    base.content = '203.0.113.9';
    base.proxied = true;
    cf.seed({
        type: 'A',
        name: WILDCARD,
        content: '198.51.100.4',
        proxied: false,
        ttl: 300,
    });
    npm.state.proxyHosts.splice(1, 1);
    npm.state.proxyHosts[0].forward_port = 8080;
    npm.state.proxyHosts[0].allow_websocket_upgrade = false;
    expect((await service.status()).base?.ok).toBe(false);

    const op = await service.ensureBase('olga');
    expect(op.status).toBe('ok');
    expect(op.steps).toEqual([
        {
            item: 'dns',
            name: BASE,
            action: 'updated',
            detail: `address 203.0.113.9 → ${IP}; proxied → DNS only`,
        },
        {
            item: 'dns',
            name: WILDCARD,
            action: 'updated',
            detail: 'extra A 198.51.100.4 deleted',
        },
        expect.objectContaining({ item: 'certificate', action: 'kept' }),
        {
            item: 'proxy_host',
            name: BASE,
            action: 'updated',
            detail: 'fixed forward_port, allow_websocket_upgrade',
        },
        expect.objectContaining({
            item: 'proxy_host',
            name: WILDCARD,
            action: 'created',
        }),
    ]);
    expect(cf.state.records.map((r) => [r.id, r.name, r.content, r.proxied])).toEqual([
        [base.id, BASE, IP, false],
        [wildcard.id, WILDCARD, IP, false],
    ]);
    expect(npm.state.proxyHosts[0]).toMatchObject({
        forward_port: 4310,
        allow_websocket_upgrade: true,
    });
    expect((await service.status()).base?.ok).toBe(true);
});

it('provisions a hostname under the zone and refuses the others', async () => {
    const { npm, cf, service } = await setup();
    await service.ensureBase('olga');
    const writes = npm.writes().length + cf.writes().length;
    for (const [hostname, code] of [
        ['shop.example.com', 'outside_zone'],
        ['evilexample.test', 'outside_zone'],
        [BASE, 'covered'],
        ['app-notes--dot-1.brain.example.test', 'covered'],
        ['*.example.test', 'invalid_hostname'],
        ['bad_name.example.test', 'invalid_hostname'],
    ] as const) {
        let error: unknown;
        try {
            await service.provision(hostname, { actor: 'olga' });
        } catch (cause) {
            error = cause;
        }
        expect(error, hostname).toBeInstanceOf(DomainsError);
        expect((error as DomainsError).code, hostname).toBe(code);
    }
    // Refused before anything was sent.
    expect(npm.writes().length + cf.writes().length).toBe(writes);

    const result = await service.provision('Shop.EXAMPLE.test.', {
        actor: 'app:abc',
    });
    expect(result.op).toMatchObject({
        kind: 'provision',
        hostname: 'shop.example.test',
        status: 'ok',
        actor: 'app:abc',
    });
    expect(steps(result.op)).toEqual([
        'dns:shop.example.test:created',
        'certificate:shop.example.test:created',
        'proxy_host:shop.example.test:created',
    ]);
    expect(result.host).toMatchObject({
        hostname: 'shop.example.test',
        kind: 'custom',
        dnsContent: IP,
        proxyHostOk: true,
        certificate: { domains: ['shop.example.test'] },
    });
    // Deeper names under the base aren't covered by the wildcard: allowed.
    const deep = await service.provision('a.b.brain.example.test', {
        actor: 'olga',
    });
    expect(deep.op.status).toBe('ok');
    // Provisioning again changes nothing.
    const before = npm.writes().length + cf.writes().length;
    const again = await service.provision('shop.example.test', {
        actor: 'olga',
    });
    expect(again.op.steps.every((step) => step.action === 'kept')).toBe(true);
    expect(npm.writes().length + cf.writes().length).toBe(before);
    expect((await service.status()).hosts.map((h) => h.hostname)).toEqual([
        'a.b.brain.example.test',
        'shop.example.test',
    ]);
});

it('never changes a DNS record it didn’t create, and removes only what it created', async () => {
    const { npm, cf, service } = await setup();
    // Someone else's record, pointing elsewhere: refused, nothing changed.
    cf.seed({
        type: 'A',
        name: 'mail.example.test',
        content: '192.0.2.10',
        proxied: true,
        ttl: 1,
    });
    const refused = await service.provision('mail.example.test', {
        actor: 'olga',
    });
    expect(refused.op.status).toBe('failed');
    expect(refused.op.error).toBe(
        "mail.example.test already has an A record this module didn't create; not changing it.",
    );
    expect(cf.state.records[0]).toMatchObject({
        content: '192.0.2.10',
        proxied: true,
    });
    // Someone else's record that already points here: used, never deleted.
    const foreign = cf.seed({
        type: 'A',
        name: 'wiki.example.test',
        content: IP,
        proxied: false,
        ttl: 1,
    });
    expect((await service.provision('wiki.example.test', { actor: 'olga' })).op.status).toBe('ok');
    const removed = await service.remove('wiki.example.test', 'olga');
    expect(removed.status).toBe('ok');
    expect(removed.steps).toEqual([
        { item: 'proxy_host', name: 'wiki.example.test', action: 'deleted' },
        { item: 'certificate', name: 'wiki.example.test', action: 'deleted' },
        {
            item: 'dns',
            name: 'wiki.example.test',
            action: 'skipped',
            detail: 'not created by this module',
        },
    ]);
    expect(cf.state.records.map((r) => r.id)).toContain(foreign.id);
    // A hostname of its own goes entirely.
    await service.provision('shop.example.test', { actor: 'olga' });
    const records = cf.state.records.length;
    expect((await service.remove('shop.example.test', 'olga')).status).toBe('ok');
    expect(cf.state.records).toHaveLength(records - 1);
    expect(npm.state.proxyHosts).toHaveLength(0);
    expect(npm.state.certificates).toHaveLength(0);
    // Unknown hostnames, and the base, can't be removed this way.
    await service.ensureBase('olga');
    for (const hostname of ['shop.example.test', 'mail.example.test', BASE, WILDCARD]) {
        await expect(service.startRemove(hostname, 'olga')).rejects.toThrow(
            'Only host names this module provisioned can be removed.',
        );
    }
    // Items of another NPM user are invisible to it, so never touched.
    const theirs = npm.seed('proxyHosts', {
        owner_user_id: 99,
        domain_names: ['other.example.test'],
    });
    const status = await service.status();
    expect(status.hosts).toEqual([]);
    expect(npm.state.proxyHosts).toContain(theirs);
});

it('refuses to request certificates without DOMAINS_ACME_EMAIL, or when NPM would register another address', async () => {
    const missing = await setup({ DOMAINS_ACME_EMAIL: undefined });
    const op = await missing.service.ensureBase('olga');
    expect(op.status).toBe('failed');
    expect(op.error).toMatch(/^DOMAINS_ACME_EMAIL is not set: refusing to request a certificate/);
    // Refused before any change.
    expect(missing.npm.writes()).toEqual([]);
    expect(missing.cf.writes()).toEqual([]);
    expect((await missing.service.status()).settings?.acmeEmail).toBe(false);
    await expect(missing.service.provision('shop.example.test', { actor: 'olga' })).resolves.toMatchObject({
        op: { status: 'failed' },
    });
    expect(missing.npm.writes()).toEqual([]);

    // The NPM user's own address is what Let's Encrypt would get: it must be
    // the configured one (never a person's by accident).
    const other = await setup({ DOMAINS_ACME_EMAIL: 'certs@example.test' });
    const mismatch = await other.service.ensureBase('olga');
    expect(mismatch.status).toBe('failed');
    expect(mismatch.error).toMatch(/not DOMAINS_ACME_EMAIL/);
    expect(mismatch.error).not.toContain(ACME);
    expect(other.npm.writes()).toEqual([]);
    expect(other.cf.writes()).toEqual([]);

    // With a certificate already there, nothing is requested: no address needed.
    const done = await setup();
    await done.service.ensureBase('olga');
    const without = domainsService(done.db, {
        config: domainsSettingsFromEnv({
            ...done.env,
            DOMAINS_ACME_EMAIL: undefined,
        }),
        log: () => {},
    });
    expect((await without.ensureBase('olga')).status).toBe('ok');
});

it('keeps secrets out of errors, the audit and logs', async () => {
    const { npm, cf, service, logs, db } = await setup();
    await service.ensureBase('olga');
    const token = npm.state.requests
        .map((r) => r.headers.authorization)
        .find((value) => typeof value === 'string' && value.startsWith('Bearer '))!
        .toString()
        .slice(7);
    // NPM's error echoes everything it got.
    npm.state.failWith = {
        status: 500,
        message: `boom: Authorization Bearer ${token}; dns_cloudflare_api_token = ${cf.token}; password ${NPM_PASSWORD}`,
    };
    const failed = await service.ensureBase('olga');
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Nginx Proxy Manager answered 500: boom');
    const status = await service.status();
    expect(status.error).toContain('[redacted]');
    const audit = JSON.stringify(db.prepare('SELECT * FROM domain_ops').all());
    const everything = [failed.error, status.error, audit, ...logs, JSON.stringify(status)].join('\n');
    for (const secret of [token, cf.token, NPM_PASSWORD]) {
        expect(everything).not.toContain(secret);
    }
    expect(everything).toContain('[redacted]');
    // Cloudflare refusing the token: typed, without it.
    npm.state.failWith = undefined;
    const wrongToken = domainsService(testDatabase(), {
        config: domainsSettingsFromEnv({
            ...(await fakes()).env,
            CLOUDFLARE_API_URL: cf.url,
            CLOUDFLARE_DNS_TOKEN: 'cf-wrong-token-abcdef',
        }),
        log: (line) => logs.push(line),
    });
    const refused = await wrongToken.provision('x.example.test', {
        actor: 'olga',
    });
    expect(refused.op.status).toBe('failed');
    expect(refused.op.error).toBe('Cloudflare answered 403: Authentication error');
    expect(logs.join('\n')).not.toContain('cf-wrong-token-abcdef');
});

it('runs one operation at a time and marks an interrupted one failed after a restart', async () => {
    const { npm, service, db } = await setup();
    npm.state.delayMs = 50;
    const first = await service.startEnsureBase('olga');
    await expect(service.startProvision('x.example.test', 'olga')).rejects.toThrow(
        expect.objectContaining({ code: 'busy' }),
    );
    expect((await service.status()).running?.id).toBe(first.op.id);
    await first.done;
    expect((await service.status()).running).toBeUndefined();
    // A process that died mid-operation left it running.
    db.prepare("UPDATE domain_ops SET status = 'running', finishedAt = NULL").run();
    expect(await service.recover()).toBe(1);
    expect(await service.store.op(first.op.id)).toMatchObject({
        status: 'failed',
        error: 'Interrupted by a restart.',
    });
});

it('sends nothing about the workspace’s people to NPM or Cloudflare', async () => {
    const { npm, cf, service } = await setup();
    await service.ensureBase('olga');
    await service.provision('shop.example.test', { actor: 'alice' });
    await service.remove('shop.example.test', 'alice');
    const all = sent(npm, cf);
    for (const user of USERS) {
        for (const value of [user.id, user.name, user.email]) {
            expect(all).not.toContain(value);
        }
    }
    // Cloudflare gets names, an address and the module's comment only.
    expect(sent(cf)).not.toContain('@');
    // NPM gets an address once: its own user's login.
    expect(npm.state.requests.filter((r) => r.body.includes('@')).map((r) => r.path)).toEqual(['/api/tokens']);
});

// Routes, through the app.

async function appFixture(configured = true) {
    const { npm, cf, env } = await fakes();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let scheduler!: Runner;
    const { platform, app, dispose } = await makeTestRuntime({
        config: configured ? { domains: domainsSettingsFromEnv(env) } : {},
        beforeApp: ({ workspace }) => {
            for (const user of USERS) {
                workspace.recordUser(user);
            }
        },
        app: {
            // A runner over the runtime's store, held here to stop it.
            runner: (store) =>
                (scheduler = new Runner(store, { mode: 'live', baseUrl: '' }, async () => ({
                    text: '',
                    sources: [],
                    sample: false,
                }))),
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    cleanup.push(async () => {
        await platform.domains.idle();
        scheduler.stop();
    });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return { npm, cf, platform, as };
}

it('lets only admins see and change domains (CB-390: no operator tier)', async () => {
    const { npm, cf, platform, as } = await appFixture();
    for (const id of ['bob']) {
        const call = await as(id);
        for (const [path, method, body] of [
            ['/domains', 'GET'],
            ['/domains/base', 'POST', {}],
            ['/domains/hosts', 'POST', { hostname: 'x.example.test' }],
            ['/domains/hosts/x.example.test', 'DELETE'],
        ] as const) {
            expect((await call(path, method, body)).status, `${id} ${method} ${path}`).toBe(403);
        }
    }
    expect(npm.state.requests).toEqual([]);
    expect(cf.state.requests).toEqual([]);

    const olga = await as('olga');
    const started = await olga('/domains/base', 'POST', {});
    expect(started.status).toBe(202);
    const { op } = (await started.json()) as DomainOpStarted;
    expect(op).toMatchObject({
        kind: 'ensure_base',
        status: 'running',
        actor: 'olga',
    });
    // While it runs, another is refused.
    const busy = await olga('/domains/hosts', 'POST', {
        hostname: 'x.example.test',
    });
    expect(busy.status).toBe(409);
    await platform.domains.idle();
    const status = (await (await olga('/domains')).json()) as DomainsStatus;
    expect(status.enabled).toBe(true);
    expect(status.base?.ok).toBe(true);
    expect(status.ops[0]).toMatchObject({ id: op.id, status: 'ok' });
    expect(status.settings).toEqual({
        zone: ZONE,
        base: BASE,
        targetIp: IP,
        upstream: 'http://company-brain_app:4310',
        npmApiUrl: npm.url,
        acmeEmail: true,
    });
    expect(JSON.stringify(status)).not.toContain(ACME);

    const outside = await olga('/domains/hosts', 'POST', {
        hostname: 'x.example.com',
    });
    expect(outside.status).toBe(400);
    expect(await outside.json()).toEqual({
        error: `Only host names under ${ZONE} can be provisioned.`,
        code: 'outside_zone',
    });
    expect((await olga('/domains/hosts', 'POST', { name: 'x' })).status).toBe(400);
    const provisioned = await olga('/domains/hosts', 'POST', {
        hostname: 'x.example.test',
    });
    expect(provisioned.status).toBe(202);
    await platform.domains.idle();
    const after = (await (await olga('/domains')).json()) as DomainsStatus;
    expect(after.hosts.map((h) => [h.hostname, h.createdBy, h.proxyHostOk])).toEqual([
        ['x.example.test', 'olga', true],
    ]);
    expect((await olga('/domains/hosts/y.example.test', 'DELETE')).status).toBe(404);
    expect((await olga('/domains/hosts/x.example.test', 'DELETE')).status).toBe(202);
    await platform.domains.idle();
    expect(((await (await olga('/domains')).json()) as DomainsStatus).hosts).toEqual([]);
});

it('is off without settings: the status says what is missing and operations answer 503', async () => {
    const { npm, cf, platform, as } = await appFixture(false);
    expect(platform.domains.enabled).toBe(false);
    const olga = await as('olga');
    const status = (await (await olga('/domains')).json()) as DomainsStatus;
    expect(status).toMatchObject({ enabled: false, hosts: [], ops: [] });
    expect(status.missing).toContain('NPM_CREDENTIALS_FILE');
    expect(status.missing).toContain('CLOUDFLARE_DNS_TOKEN_FILE');
    const refused = await olga('/domains/base', 'POST', {});
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { code: string }).code).toBe('not_configured');
    expect((await olga('/domains/hosts', 'POST', { hostname: 'x.example.test' })).status).toBe(503);
    await expect(platform.domains.provision('x.example.test')).rejects.toThrow(/Domains are off/);
    expect(npm.state.requests).toEqual([]);
    expect(cf.state.requests).toEqual([]);
});
