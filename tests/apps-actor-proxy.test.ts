import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import {
    createServer,
    request as httpRequest,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
} from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { signContextProof } from '@socio/foundation/actors/keys';
import { appsSettingsFromEnv } from '@socio/foundation/apps/settings';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { ActorScope } from '@socio/shared/actor-scopes';
import { parseAppManifest, type AppDelegation, type AppManifest } from '@socio/shared/apps/app-manifest';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { APP_BROWSER_SUBNET_DEFAULT } from '../src/app-browser/deploy-spec.js';
import { actionSetHash } from '../src/server/apps/actor.js';
import {
    appsInternalConfigFromEnv,
    createAppsInternalServer,
    sourceAllowed,
} from '../src/server/apps/internal-listener.js';
import { appsUpgrade } from '../src/server/apps/proxy.js';
import { appTools } from '../src/server/apps/tools.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-232 on the real platform: the apps proxy's socio sessions
// (credential, context proof, envelope, no legacy headers), a person's
// envelope, revocation of open responses and sockets, the `app` audience
// policy, the end of an app's grants, and `/api/apps/actor/*`. Development
// apps on a person-owned socio's computer stand in for promoted ones
// (apps-promotion.test.ts covers the runtime and its ingress). Negative
// cases first.

const SECRET = 'secret-0123456789abcdef-xyz';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const DELEGATION: AppDelegation = {
    contract: 1,
    actions: {
        'dashboard.view': 'read',
        'deal.update': 'write',
        'sms.send': 'consequential',
        'settings.update': 'admin',
    },
    public: ['/healthz'],
    alwaysAsk: false,
};

/** The app's server in the computer: records what it gets; streams on /sse. */
async function upstream() {
    const seen: Array<{
        url: string;
        headers: IncomingHttpHeaders;
        body: string;
    }> = [];
    const upgrades: IncomingHttpHeaders[] = [];
    const streams = new Set<() => void>();
    const server: Server = createServer((req, res) => {
        if (req.url === '/sse') {
            seen.push({ url: req.url, headers: req.headers, body: '' });
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: 1\n\n');
            const timer = setInterval(() => res.write('data: tick\n\n'), 50);
            const stop = () => clearInterval(timer);
            streams.add(stop);
            res.on('close', stop);
            return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            seen.push({
                url: req.url!,
                headers: req.headers,
                body: Buffer.concat(chunks).toString(),
            });
            res.writeHead(200, {
                'content-type': 'application/json',
                'set-cookie': 'evil=1',
            });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    const sockets = new Set<{ destroy: () => void }>();
    server.on('upgrade', (req, socket) => {
        sockets.add(socket);
        upgrades.push(req.headers);
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', (data: Buffer) => socket.write(`echo:${data}`));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    cleanup.push(
        () =>
            new Promise<void>((ok) => {
                for (const stop of streams) {
                    stop();
                }
                for (const socket of sockets) {
                    socket.destroy();
                }
                server.closeAllConnections();
                server.close(() => ok());
            }),
    );
    return { port: (server.address() as AddressInfo).port, seen, upgrades };
}

async function fixture(
    options: {
        company?: boolean;
        flag?: boolean;
        delegation?: AppDelegation | null;
        /** `APPS_SOCIO_ON_PUBLIC_HOST`: these tests send socio sessions to the
         * public host, so on unless a test says otherwise. */
        socioOnPublicHost?: boolean;
    } = {},
) {
    vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', options.socioOnPublicHost === false ? '' : '1');
    const dir = mkdtempSync(join(tmpdir(), 'cb-actor-proxy-'));
    const apps = appsSettingsFromEnv({}, 'http://localhost:4310')!;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir, apiUrl: 'http://company-brain-app:4310' },
            apps,
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': options.flag !== false },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            origin: 'http://localhost:4310',
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of DEFAULT_MOCK_USERS) {
        workspace.recordUser(user);
    }
    const seed = workspace.dots()[0];
    const dot = options.company
        ? seed
        : workspace.createDot(
              seed.spaceId,
              'Personal',
              '',
              true,
              true,
              seed.spaceIds,
              null,
              false,
              null,
              false,
              'alice',
          );
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    const files: Array<{ path: string; contents: string }> = [];
    vi.spyOn(platform.computers, 'writeFile').mockImplementation(async (_dotId, path, contents) => {
        files.push({ path, contents });
    });
    vi.spyOn(platform.computers, 'action').mockResolvedValue({
        exitCode: 0,
    } as never);
    // The newest packaged version's manifest: its socio-access contract.
    const manifest = (): AppManifest => ({
        name: 'Tracker',
        description: '',
        entry: 'server.mjs',
        runtime: 'bun',
        datasets: [],
        egress: [],
        ...(options.delegation === null ? {} : { delegation: options.delegation ?? DELEGATION }),
    });
    let current = manifest();
    vi.spyOn(platform.apps.promotions, 'manifestOf').mockImplementation(() => current);
    const up = await upstream();
    platform.apps.useTargets(async () => ({
        state: 'running',
        host: '127.0.0.1',
        port: up.port,
    }));
    const turn: DotTurn = {
        dot,
        userId: 'alice',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    const tools = Object.fromEntries(
        (
            appTools(platform.apps, turn) as unknown as Array<{
                name: string;
                execute: (input: unknown) => Promise<Record<string, unknown>>;
            }>
        ).map((tool) => [tool.name, tool.execute]),
    );
    await platform.approvals.setPolicy('alice', dot.id, 'app.register', 'bypass');
    expect(await tools.app_register({ name: 'Tracker', port: 3000 })).toMatchObject({
        status: 'approved',
    });
    const tracker = platform.apps.all().at(-1)!;
    const host = `${tracker.id}.apps.localhost:4310`;
    const origin = `http://${host}`;
    const chat = workspace.bindThread('chat-1', dot.id, 'Pipeline', 'alice');
    const env = () => {
        const file = files.filter((entry) => entry.path.endsWith('.env')).at(-1)!.contents;
        const value = (name: string) => new RegExp(`^${name}='([^']*)'$`, 'm').exec(file)?.[1];
        return { token: value('CB_DATA_TOKEN'), key: value('CB_ACTOR_KEY'), file };
    };
    const grant = async (
        scopes: ActorScope[] = ['app:read'],
        over: { personId?: string; audience?: `app:${string}` } = {},
    ) =>
        platform.actors.grants.create({
            personId: over.personId ?? 'alice',
            socioId: dot.id,
            audiences: [over.audience ?? `app:${tracker.id}`],
            scopes,
            conversationId: chat.id,
            conversationKind: 'private',
            task: 'Check the chart',
            policyVersion: actionSetHash(current.delegation ?? DELEGATION),
            approvedBy: over.personId ?? 'alice',
            correlationId: 'test',
        });
    /** An app browser context's credential and proof key (what the app browser's worker holds). */
    const session = async (scopes: ActorScope[] = ['app:read']) => {
        const g = await grant(scopes);
        const audience = `app:${tracker.id}` as const;
        const context = await platform.actors.contexts.open({
            grant: g,
            kind: 'browser',
            audience,
            correlationId: 'test',
        });
        const { token } = await platform.actors.credentials.issue({
            grant: g,
            kind: 'cbsa',
            audiences: [audience],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId: 'test',
        });
        const key = platform.actors.contextKey(context.id);
        // A proof is the same for the same request in the same millisecond,
        // and the proxy refuses a proof it has seen (replay). Sign each one a
        // millisecond after the last, so two identical requests sent back to
        // back are never one proof sent twice.
        let lastTs = 0;
        const nextTs = () => (lastTs = Math.max(Date.now(), lastTs + 1));
        const proof = (method: string, target: string, body = '', proofHost = host, ts = nextTs()) =>
            signContextProof(
                key,
                {
                    method,
                    host: proofHost,
                    requestTarget: target,
                    bodyDigest: body ? createHash('sha256').update(body).digest('hex') : '',
                },
                ts,
            );
        const send = (
            target: string,
            init: {
                method?: string;
                body?: string;
                headers?: Record<string, string>;
                proof?: string | null;
            } = {},
        ) => {
            const method = init.method ?? 'GET';
            return app.request(`${origin}${target}`, {
                method,
                headers: {
                    authorization: `Bearer ${token}`,
                    ...(init.proof === null
                        ? {}
                        : {
                              'x-cb-context': init.proof ?? proof(method, target, init.body),
                          }),
                    ...(init.body ? { 'content-type': 'application/json' } : {}),
                    ...init.headers,
                },
                ...(init.body ? { body: init.body } : {}),
            });
        };
        return { grant: g, context, token, proof, send };
    };
    const login = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    /** A person's session on the app's origin (the launch hand-off). */
    const signIn = async (userId = 'alice') => {
        const launched = await app.request(`http://localhost:4310/api/apps/${tracker.id}/launch`, {
            method: 'POST',
            headers: {
                cookie: await login(userId),
                'content-type': 'application/json',
            },
            body: '{}',
        });
        const { url } = (await launched.json()) as { url: string };
        return (await app.request(url)).headers.get('set-cookie')!.split(';')[0];
    };
    const sdk = () =>
        socioApp({
            appId: tracker.id,
            key: env().key,
            actions: DELEGATION.actions,
            env: {},
        });
    const setManifest = (next: Partial<AppManifest>) => {
        current = { ...manifest(), ...next };
    };
    return {
        platform,
        workspace,
        dot,
        app,
        tools,
        tracker,
        host,
        origin,
        chat,
        up,
        env,
        grant,
        session,
        signIn,
        sdk,
        setManifest,
    };
}

const lastSeen = (f: Awaited<ReturnType<typeof fixture>>) => f.up.seen.at(-1)!;

describe('the manifest’s delegation block', () => {
    const base = { name: 'Tracker', entry: 'server.mjs' };
    it('refuses ownerColumn anywhere, unknown tiers and keys; takes the rest', () => {
        for (const manifest of [
            { ...base, delegation: { ...DELEGATION, ownerColumn: 'owner' } },
            {
                ...base,
                datasets: [{ id: 'scratch', access: 'write', ownerColumn: 'owner' }],
            },
        ]) {
            expect(parseAppManifest(manifest)).toMatchObject({
                ok: false,
                error: expect.stringMatching(/ownerColumn/),
            });
        }
        expect(
            parseAppManifest({
                ...base,
                delegation: { contract: 1, actions: { 'x.y': 'root' } },
            }),
        ).toMatchObject({ ok: false });
        expect(parseAppManifest({ ...base, delegation: { contract: 2, actions: {} } })).toMatchObject({ ok: false });
        expect(
            parseAppManifest({
                ...base,
                delegation: { contract: 1, actions: {}, scopes: ['app:act'] },
            }),
        ).toMatchObject({ ok: false });
        expect(
            parseAppManifest({
                ...base,
                delegation: {
                    contract: 1,
                    actions: { 'deal.update': 'write' },
                    background: { datasets: ['scratch'] },
                    spaceAccess: { scratch: 'write' },
                },
            }),
        ).toMatchObject({
            ok: true,
            manifest: {
                delegation: {
                    public: [],
                    alwaysAsk: false,
                    background: { datasets: ['scratch'], read: true },
                    spaceAccess: { scratch: 'write' },
                },
            },
        });
    });
});

describe('the app audience (CB-232)', () => {
    it('delegates a development app only on a person-owned socio, only for its person', async () => {
        const company = await fixture({ company: true });
        const policy = company.platform.actors.audiences.for(`app:${company.tracker.id}`)!;
        expect(await policy.policyVersion(`app:${company.tracker.id}`)).toBeUndefined();
        // Nothing reaches a company computer: no key, no envelope, no cbob_.
        expect(company.env().key).toBeUndefined();
        const cookie = await company.signIn();
        await company.app.request(`${company.origin}/x`, { headers: { cookie } });
        expect(lastSeen(company).headers['x-cb-actor']).toBeUndefined();

        const none = await fixture({ delegation: null });
        expect(
            await none.platform.actors.audiences.for(`app:${none.tracker.id}`)!.policyVersion(`app:${none.tracker.id}`),
        ).toBeUndefined();

        const f = await fixture();
        const audience = `app:${f.tracker.id}` as const;
        const own = f.platform.actors.audiences.for(audience)!;
        expect(await own.policyVersion(audience)).toBe(actionSetHash(DELEGATION));
        expect(await own.personMay('bob', audience, {} as never)).toBe(false);
        expect(await own.personMay('alice', audience, {} as never)).toBe(true);
        expect(await own.actionTier!(audience, 'sms.send')).toBe('consequential');
        expect(await own.actionTier!(audience, 'constructor')).toBeUndefined();
        // alwaysAsk is part of the version.
        expect(actionSetHash({ ...DELEGATION, alwaysAsk: true })).not.toBe(actionSetHash(DELEGATION));
    });
});

describe('socio sessions through the proxy', () => {
    it('refuses a socio credential on the public host without the development switch, unchecked and unaudited', async () => {
        const f = await fixture({ socioOnPublicHost: false });
        const s = await f.session();
        const check = vi.spyOn(f.platform.actors, 'check');
        const rows = () => f.platform.actors.audit.list({}).length;
        const audited = rows();
        const before = f.up.seen.length;
        const refused = await s.send('/deals');
        expect(refused.status).toBe(401);
        expect(await refused.text()).toBe('Sign in through Socio to use this app.');
        // Production ignores the switch.
        vi.stubEnv('APPS_SOCIO_ON_PUBLIC_HOST', '1');
        vi.stubEnv('NODE_ENV', 'production');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        expect((await s.send('/deals')).status).toBe(401);
        // A WebSocket upgrade alike.
        const upgrade = appsUpgrade(f.platform.apps);
        const socket = new PassThrough();
        let answer = '';
        socket.on('data', (chunk: Buffer) => (answer += chunk.toString()));
        const closed = new Promise<void>((ok) => socket.once('close', () => ok()));
        expect(
            upgrade(
                {
                    url: '/ws',
                    headers: {
                        host: f.host,
                        origin: f.origin,
                        upgrade: 'websocket',
                        authorization: `Bearer ${s.token}`,
                        'x-cb-context': s.proof('GET', '/ws'),
                    },
                } as unknown as IncomingMessage,
                socket,
                Buffer.alloc(0),
            ),
        ).toBe(true);
        await closed;
        expect(answer).toMatch(/^HTTP\/1.1 401/);
        expect(check).not.toHaveBeenCalled();
        expect(rows()).toBe(audited);
        expect(f.up.seen.length).toBe(before);
        expect(f.up.upgrades).toEqual([]);
        // With the switch, in development, the same request is served.
        vi.stubEnv('NODE_ENV', 'test');
        expect((await s.send('/deals')).status).toBe(200);
        expect(check).toHaveBeenCalled();
    });

    it('refuses a request without a valid, fresh context proof for its own context', async () => {
        const f = await fixture();
        const s = await f.session();
        const before = f.up.seen.length;
        expect((await s.send('/deals', { proof: null })).status).toBe(401);
        // Another context's key.
        const other = await f.session();
        expect((await s.send('/deals', { proof: other.proof('GET', '/deals') })).status).toBe(401);
        // Signed for another path, query, method, host or body.
        expect((await s.send('/deals?x=2', { proof: s.proof('GET', '/deals?x=1') })).status).toBe(401);
        expect(
            (
                await s.send('/deals', {
                    method: 'DELETE',
                    proof: s.proof('GET', '/deals'),
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await s.send('/deals', {
                    proof: s.proof('GET', '/deals', '', 'other.apps.localhost:4310'),
                })
            ).status,
        ).toBe(401);
        expect(
            (
                await s.send('/deals', {
                    method: 'POST',
                    body: '{"stage":"lost"}',
                    proof: s.proof('POST', '/deals', '{"stage":"won"}'),
                })
            ).status,
        ).toBe(401);
        // Older than 30 s.
        expect(
            (
                await s.send('/deals', {
                    proof: s.proof('GET', '/deals', '', f.host, Date.now() - 31_000),
                })
            ).status,
        ).toBe(401);
        // Replayed.
        const once = s.proof('GET', '/deals');
        expect((await s.send('/deals', { proof: once })).status).toBe(200);
        expect((await s.send('/deals', { proof: once })).status).toBe(401);
        expect(f.up.seen.length).toBe(before + 1);
        // Every refusal is in the audit with its reason, and no secret is.
        const rows = f.platform.actors.audit.list({ grantId: s.grant.id });
        expect(rows.filter((row) => row.decision === 'deny').length).toBeGreaterThanOrEqual(7);
        expect(JSON.stringify(rows)).not.toMatch(/cbsa_|cbob_|cbdt_|v1\./);
    });

    it('refuses a credential on another app’s host, a revoked grant, and the feature switched off', async () => {
        const f = await fixture();
        const s = await f.session();
        // Another app on the same socio.
        await f.tools.app_register({ name: 'Other', port: 3001 });
        const other = f.platform.apps.all().find((item) => item.name === 'Other')!;
        const otherHost = `${other.id}.apps.localhost:4310`;
        const crossed = await f.app.request(`http://${otherHost}/deals`, {
            headers: {
                authorization: `Bearer ${s.token}`,
                'x-cb-context': s.proof('GET', '/deals', '', otherHost),
            },
        });
        expect(crossed.status).toBe(401);
        // Recorded as a deny for that audience, without naming a grant.
        expect(
            f.platform.actors.audit
                .list({})
                .some((row) => row.reason === 'audience_mismatch' && row.audience === `app:${other.id}`),
        ).toBe(true);
        // Feature off for the person: authorization fails (403).
        vi.spyOn(f.platform.flags, 'enabled').mockReturnValue(false);
        expect((await s.send('/deals')).status).toBe(403);
        vi.mocked(f.platform.flags.enabled).mockRestore();
        // Decisions are cached for at most 5 s; a local change forgets them.
        f.platform.actors.authorizer.invalidate();
        expect((await s.send('/deals')).status).toBe(200);
        // A live runtime that enforces an older contract (a rollback): socio
        // credentials are refused at the listener, not only their issuance.
        const behind = vi.spyOn(f.platform.actors, 'issuable').mockReturnValue(false);
        expect((await s.send('/deals')).status).toBe(403);
        behind.mockRestore();
        expect((await s.send('/deals')).status).toBe(200);
        await f.platform.actors.revoke({ grantId: s.grant.id }, 'alice', 'person_revoked');
        const revoked = await s.send('/deals');
        expect(revoked.status).toBe(401);
        expect(await revoked.text()).toBe('Sign in through Socio to use this app.');
    });

    it('sends the envelope and never the legacy headers, the credential or forged identity', async () => {
        const f = await fixture();
        const s = await f.session(['app:write']);
        const answer = await s.send('/deals?stage=won', {
            method: 'POST',
            body: '{"stage":"won"}',
            headers: {
                'x-cb-user': 'forged',
                'x-cb-access': 'owner',
                'x-cb-actor': 'v1.forged.forged',
                'x-cb-obo': 'cbob_forged',
                'x-cb-approval': 'appr_123',
                cookie: 'cb_app=stolen',
            },
        });
        expect(answer.status).toBe(200);
        expect(answer.headers.get('set-cookie')).toBeNull();
        const { headers, body } = lastSeen(f);
        expect(body).toBe('{"stage":"won"}');
        for (const name of ['x-cb-user', 'x-cb-access', 'x-cb-obo', 'x-cb-context', 'authorization', 'cookie']) {
            expect(headers[name], name).toBeUndefined();
        }
        expect(headers['x-cb-approval']).toBe('appr_123');
        const verdict = f.sdk().verify({
            method: 'POST',
            target: '/deals?stage=won',
            header: headers['x-cb-actor'] as string,
        });
        expect(verdict).toMatchObject({
            ok: true,
            principal: {
                person: f.platform.apps.personId(f.tracker.id, 'alice'),
                access: 'owner',
                socio: { scopes: ['app:read', 'app:write'] },
                version: null,
            },
        });
        // The app learns nothing it could correlate across apps: opaque ids.
        const principal = (
            verdict as {
                principal: { socio: { id: string; grant: string }; obo: string };
            }
        ).principal;
        expect(principal.socio.id).not.toBe(f.dot.id);
        expect(principal.socio.grant).not.toBe(s.grant.id);
        // Its obo names the grant, for this app only.
        expect(f.platform.actors.credentials.openObo(principal.obo, f.tracker.id)).toMatchObject({
            grantId: s.grant.id,
        });
        expect(f.platform.actors.credentials.openObo(principal.obo, 'another-app')).toBeUndefined();
        // The SDK refuses the envelope for anything but this request.
        const sdk = f.sdk();
        expect(
            sdk.verify({
                method: 'POST',
                target: '/deals?stage=lost',
                header: headers['x-cb-actor'] as string,
            }),
        ).toMatchObject({ ok: false, reason: 'wrong_request' });
    });

    it('closes a streamed response and a WebSocket when the grant is revoked', async () => {
        const f = await fixture();
        const s = await f.session();
        const response = await s.send('/sse');
        expect(response.status).toBe(200);
        const reader = response.body!.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: 1');
        expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(1);
        await f.platform.actors.revoke({ grantId: s.grant.id }, 'alice', 'person_revoked');
        const ended = await (async () => {
            try {
                for (;;) {
                    if ((await reader.read()).done) {
                        return 'done';
                    }
                }
            } catch {
                return 'error';
            }
        })();
        expect(['done', 'error']).toContain(ended);
        expect(f.platform.actors.revocations.trackedCount(s.grant.id)).toBe(0);

        // A WebSocket: the same proof on the upgrade, closed on revocation.
        const w = await f.session();
        const server = serve({
            fetch: f.app.fetch,
            hostname: '127.0.0.1',
            port: 0,
        });
        const upgrade = appsUpgrade(f.platform.apps);
        server.on('upgrade', (request, socket, head) => {
            if (!upgrade(request, socket, head)) {
                socket.destroy();
            }
        });
        await new Promise<void>((ok) => (server.listening ? ok() : server.once('listening', () => ok())));
        cleanup.push(
            () =>
                new Promise<void>((ok) => {
                    if ('closeAllConnections' in server) {
                        server.closeAllConnections();
                    }
                    server.close(() => ok());
                }),
        );
        const port = (server.address() as AddressInfo).port;
        const handshake = (headers: Record<string, string>) =>
            new Promise<{ head: string; socket: ReturnType<typeof connect> }>((resolve, reject) => {
                const socket = connect({ host: '127.0.0.1', port });
                let data = '';
                socket.on('data', (chunk) => {
                    data += chunk.toString();
                    if (data.includes('\r\n\r\n')) {
                        socket.removeAllListeners('data');
                        resolve({ head: data, socket });
                    }
                });
                socket.on('error', reject);
                socket.on('close', () => resolve({ head: data, socket }));
                socket.write(
                    `GET /ws HTTP/1.1\r\n${Object.entries({
                        host: f.host,
                        origin: f.origin,
                        upgrade: 'websocket',
                        connection: 'Upgrade',
                        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
                        'sec-websocket-version': '13',
                        authorization: `Bearer ${w.token}`,
                        ...headers,
                    })
                        .map(([name, value]) => `${name}: ${value}`)
                        .join('\r\n')}\r\n\r\n`,
                );
            });
        const refused = await handshake({});
        expect(refused.head).toMatch(/^HTTP\/1.1 401/);
        const opened = await handshake({ 'x-cb-context': w.proof('GET', '/ws') });
        expect(opened.head).toMatch(/^HTTP\/1.1 101/);
        const seen = f.up.upgrades.at(-1)!;
        expect(seen['x-cb-user']).toBeUndefined();
        expect(seen.authorization).toBeUndefined();
        expect(
            f.sdk().verify({
                method: 'GET',
                target: '/ws',
                header: seen['x-cb-actor'] as string,
            }),
        ).toMatchObject({
            ok: true,
            principal: { socio: { scopes: ['app:read'] } },
        });
        const closed = new Promise<void>((ok) => opened.socket.once('close', () => ok()));
        await f.platform.actors.revoke({ grantId: w.grant.id }, 'alice', 'person_revoked');
        await closed;
    });
});

describe('a person’s envelope', () => {
    it('rides beside the legacy headers while the feature is on for them, and not at all while it is off', async () => {
        const dark = await fixture({ flag: false });
        const cookie = await dark.signIn();
        await dark.app.request(`${dark.origin}/x`, { headers: { cookie } });
        expect(lastSeen(dark).headers['x-cb-actor']).toBeUndefined();
        expect(lastSeen(dark).headers['x-cb-user']).toBe(dark.platform.apps.personId(dark.tracker.id, 'alice'));

        const f = await fixture();
        const session = await f.signIn();
        await f.app.request(`${f.origin}/deals?x=1`, {
            headers: { cookie: session, 'x-cb-actor': 'v1.forged.forged' },
        });
        const { headers } = lastSeen(f);
        expect(headers['x-cb-user']).toBe(f.platform.apps.personId(f.tracker.id, 'alice'));
        expect(headers['x-cb-access']).toBe('owner');
        const verdict = f.sdk().verify({
            method: 'GET',
            target: '/deals?x=1',
            header: headers['x-cb-actor'] as string,
        });
        expect(verdict).toMatchObject({
            ok: true,
            principal: { person: headers['x-cb-user'], access: 'owner' },
        });
        const principal = (verdict as { principal: { socio?: unknown; obo: string } }).principal;
        expect(principal.socio).toBeUndefined();
        expect(f.platform.actors.credentials.openObo(principal.obo, f.tracker.id)).toMatchObject({
            sessionHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
    });
});

describe('an app’s grants end with it', () => {
    it('on unshare and unregister', async () => {
        const f = await fixture();
        const space = f.workspace.spaces()[0];
        await f.platform.apps.share(f.tracker.id, 'alice', space.id);
        const shared = await f.grant();
        await f.platform.apps.share(f.tracker.id, 'alice', null);
        expect(f.platform.actors.grants.get(shared.id)).toMatchObject({
            revokeReason: 'access_changed',
        });
        const live = await f.grant();
        await f.platform.apps.unregister(f.tracker.id, 'alice');
        expect(f.platform.actors.grants.get(live.id)).toMatchObject({
            revokeReason: 'audience_unavailable',
            revokedBy: 'alice',
        });
    });

    it('suspends grants made under an older action set', async () => {
        const f = await fixture();
        const s = await f.session();
        expect((await s.send('/deals')).status).toBe(200);
        const policy = f.platform.actors.audiences.for(`app:${f.tracker.id}`)!;
        expect(await policy.alwaysAsk!(`app:${f.tracker.id}`)).toBe(false);
        f.setManifest({ delegation: { ...DELEGATION, alwaysAsk: true } });
        expect(await policy.alwaysAsk!(`app:${f.tracker.id}`)).toBe(true);
        expect(
            await f.platform.actors.authorizer.authorizeGrant(s.grant.id, {
                fresh: true,
            }),
        ).toEqual({ allowed: false, reason: 'policy_stale' });
    });
});

describe('/api/apps/actor (calls from the app)', () => {
    const call = (
        f: Awaited<ReturnType<typeof fixture>>,
        path: string,
        body: unknown,
        headers: Record<string, string>,
    ) =>
        f.app.request(`http://localhost:4310/api/apps/actor${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
        });
    /** The obo of the socio request the app is serving. */
    const oboOf = async (f: Awaited<ReturnType<typeof fixture>>, scopes: ActorScope[]) => {
        const s = await f.session(scopes);
        await s.send('/deals');
        const verdict = f.sdk().verify({
            method: 'GET',
            target: '/deals',
            header: lastSeen(f).headers['x-cb-actor'] as string,
        });
        return {
            s,
            obo: (verdict as { principal: { obo: string } }).principal.obo,
        };
    };

    it('refuses without the app’s own token, or with another app’s obo', async () => {
        const f = await fixture();
        const { obo } = await oboOf(f, ['app:read']);
        const token = f.env().token!;
        // A person's session, not the app's token.
        expect((await call(f, '/continuations', { minutes: 5 }, { 'x-cb-obo': obo })).status).toBe(401);
        expect((await call(f, '/continuations', { minutes: 5 }, { authorization: `Bearer ${token}` })).status).toBe(
            403,
        );
        // Another app's token can't use this app's obo.
        await f.tools.app_register({ name: 'Other', port: 3001 });
        const otherToken = f.env().token!;
        expect(otherToken).not.toBe(token);
        expect(
            (
                await call(
                    f,
                    '/continuations',
                    { minutes: 5 },
                    {
                        authorization: `Bearer ${otherToken}`,
                        'x-cb-obo': obo,
                    },
                )
            ).status,
        ).toBe(403);
    });

    it('exchanges a socio’s obo for a continuation held by its grant', async () => {
        const f = await fixture();
        const { s, obo } = await oboOf(f, ['app:read']);
        const auth = { authorization: `Bearer ${f.env().token!}`, 'x-cb-obo': obo };
        expect((await call(f, '/continuations', { minutes: 0 }, auth)).status).toBe(400);
        const answer = await call(f, '/continuations', { minutes: 30 }, auth);
        expect(answer.status).toBe(200);
        const { continuation, expiresAt } = (await answer.json()) as {
            continuation: string;
            expiresAt: number;
        };
        expect(continuation).toMatch(/^cbob_[A-Za-z0-9_-]{43}$/);
        expect(expiresAt).toBeLessThanOrEqual(s.grant.expiresAt);
        expect(
            f.platform.actors.credentials.resolve(continuation, {
                kind: 'continuation',
            }),
        ).toMatchObject({ ok: true, grant: { id: s.grant.id } });
        // A continuation can't make another continuation.
        expect((await call(f, '/continuations', { minutes: 5 }, { ...auth, 'x-cb-obo': continuation })).status).toBe(
            403,
        );
        await f.platform.actors.revoke({ grantId: s.grant.id }, 'alice', 'person_revoked');
        expect(
            f.platform.actors.credentials.resolve(continuation, {
                kind: 'continuation',
            }),
        ).toMatchObject({ ok: false });
        expect((await call(f, '/continuations', { minutes: 5 }, auth)).status).toBe(403);
    });

    it('gives a person’s request a continuation that ends with their session', async () => {
        const f = await fixture();
        const cookie = await f.signIn();
        await f.app.request(`${f.origin}/deals`, { headers: { cookie } });
        const verdict = f.sdk().verify({
            method: 'GET',
            target: '/deals',
            header: lastSeen(f).headers['x-cb-actor'] as string,
        });
        const obo = (verdict as { principal: { obo: string } }).principal.obo;
        const auth = { authorization: `Bearer ${f.env().token!}`, 'x-cb-obo': obo };
        const answer = await call(f, '/continuations', { minutes: 600 }, auth);
        expect(answer.status).toBe(400);
        const ok = (await (await call(f, '/continuations', { minutes: 60 }, auth)).json()) as {
            continuation: string;
        };
        expect(f.platform.actors.credentials.openObo(ok.continuation, f.tracker.id)).toMatchObject({
            sessionHash: expect.any(String),
        });
        await f.platform.apps.endSessions(f.tracker.id);
        expect((await call(f, '/continuations', { minutes: 5 }, auth)).status).toBe(403);
    });

    it('asks for and consumes action approvals for the grant in the obo only', async () => {
        const f = await fixture();
        const reader = await oboOf(f, ['app:read']);
        const actor = await oboOf(f, ['app:act']);
        const auth = (obo: string) => ({
            authorization: `Bearer ${f.env().token!}`,
            'x-cb-obo': obo,
        });
        const params = { to: ['dana'], body: 'Olá' };
        // Read-only grant: refused; undeclared or non-consequential: refused.
        expect((await call(f, '/approvals', { action: 'sms.send', params }, auth(reader.obo))).status).toBe(403);
        expect((await call(f, '/approvals', { action: 'deal.update', params }, auth(actor.obo))).status).toBe(400);
        expect((await call(f, '/approvals', { action: 'nope', params }, auth(actor.obo))).status).toBe(403);
        // A digest that isn't the parameters'; parameters nobody would review.
        expect(
            (await call(f, '/approvals', { action: 'sms.send', params, digest: '0'.repeat(64) }, auth(actor.obo)))
                .status,
        ).toBe(400);
        expect(
            (await call(f, '/approvals', { action: 'sms.send', params: { x: 'y'.repeat(70_000) } }, auth(actor.obo)))
                .status,
        ).toBe(413);
        // The SDK's digest for reordered keys is Socio's.
        const digest = f.sdk().intentDigest('sms.send', { body: 'Olá', to: ['dana'] });
        const made = await call(
            f,
            '/approvals',
            { action: 'sms.send', params, digest, display: { Summary: 'Text Dana' } },
            auth(actor.obo),
        );
        expect(made.status).toBe(202);
        const pending = (await made.json()) as { approval: string; status: string };
        expect(pending).toMatchObject({ status: 'pending', digest });
        // The same request again finds the same approval.
        expect(
            (await (await call(f, '/approvals', { action: 'sms.send', params }, auth(actor.obo))).json()) as {
                approval: string;
            },
        ).toMatchObject({ approval: pending.approval });
        const consume = (obo: string, d = digest) =>
            call(f, `/approvals/${pending.approval}/consume`, { digest: d }, auth(obo));
        // Not yet approved.
        expect((await consume(actor.obo)).status).toBe(409);
        await f.platform.approvals.decide(pending.approval, 'alice', true);
        // Another grant's obo, or changed parameters: refused.
        expect((await consume(reader.obo)).status).toBe(409);
        expect((await consume(actor.obo, f.sdk().intentDigest('sms.send', { to: ['all'] }))).status).toBe(409);
        // Once.
        expect((await consume(actor.obo)).status).toBe(200);
        expect((await consume(actor.obo)).status).toBe(409);
        // A person's own request asks nobody.
        const cookie = await f.signIn();
        await f.app.request(`${f.origin}/deals`, { headers: { cookie } });
        const own = (
            f.sdk().verify({
                method: 'GET',
                target: '/deals',
                header: lastSeen(f).headers['x-cb-actor'] as string,
            }) as { principal: { obo: string } }
        ).principal.obo;
        expect((await call(f, '/approvals', { action: 'sms.send', params }, auth(own))).status).toBe(400);
    });
    it('never tells the app which security check refused its approval request', async () => {
        const f = await fixture();
        const reader = await oboOf(f, ['app:read']);
        const actor = await oboOf(f, ['app:act']);
        const auth = (obo: string) => ({
            authorization: `Bearer ${f.env().token!}`,
            'x-cb-obo': obo,
        });
        const ask = (obo: string, body: unknown) => call(f, '/approvals', body, auth(obo));
        const params = { to: ['dana'] };
        // The grant's scope, then a revoked grant: 403 and no reason.
        const scoped = await ask(reader.obo, { action: 'sms.send', params });
        expect(scoped.status).toBe(403);
        const scopedBody = (await scoped.json()) as Record<string, unknown>;
        expect(scopedBody).not.toHaveProperty('reason');
        expect(JSON.stringify(scopedBody)).not.toMatch(/scope_insufficient/);
        // About the app's own request: the reason stays, so it can fix it.
        expect(await (await ask(actor.obo, { action: 'deal.update', params })).json()).toMatchObject({
            reason: 'not_consequential',
        });
        const big = await ask(actor.obo, {
            action: 'sms.send',
            params: { x: 'y'.repeat(70_000) },
        });
        expect(big.status).toBe(413);
        expect(await big.json()).toMatchObject({ reason: 'params_too_large' });
        await f.platform.actors.revoke({ grantId: actor.s.grant.id }, 'alice', 'person_revoked');
        const revoked = await ask(actor.obo, { action: 'sms.send', params });
        expect(revoked.status).toBe(403);
        const revokedBody = (await revoked.json()) as Record<string, unknown>;
        expect(revokedBody).not.toHaveProperty('reason');
        expect(JSON.stringify(revokedBody)).not.toMatch(/grant_|revoked_|person_/);
        // The audit keeps why.
        await vi.waitFor(() =>
            expect(
                f.platform.actors.audit
                    .list({})
                    .filter((row) => row.phase === 'approval' && row.decision === 'deny')
                    .map((row) => row.reason),
            ).toEqual(expect.arrayContaining(['scope_insufficient'])),
        );
    });

    it('asks for a data operation’s approval that only the data API’s call spends', async () => {
        const f = await fixture();
        const reader = await oboOf(f, ['app:write']);
        const actor = await oboOf(f, ['app:act']);
        const token = f.env().token!;
        const auth = (obo: string) => ({
            authorization: `Bearer ${token}`,
            'x-cb-obo': obo,
        });
        const performed: string[] = [];
        // The data layer refuses an app token's file delete (CB-229): record
        // the route's work instead, past the gate.
        vi.spyOn(f.platform.data, 'deleteFileAs').mockImplementation(async (_actor, path) => void performed.push(path));
        const params = { path: 'reports/old.csv' };
        const del = (obo: string, approval?: string, path = params.path) =>
            f.app.request(`http://company-brain-app:4310/api/data/files?path=${encodeURIComponent(path)}`, {
                method: 'DELETE',
                headers: {
                    ...auth(obo),
                    ...(approval ? { 'x-cb-approval': approval } : {}),
                },
            });
        // A write grant can't ask; a read op isn't consequential; the params
        // are exactly the operation's.
        expect((await call(f, '/approvals', { action: 'data:files.delete', params }, auth(reader.obo))).status).toBe(
            403,
        );
        expect((await call(f, '/approvals', { action: 'data:files.read', params }, auth(actor.obo))).status).toBe(400);
        const extra = await call(
            f,
            '/approvals',
            { action: 'data:files.delete', params: { ...params, all: true } },
            auth(actor.obo),
        );
        expect(extra.status).toBe(400);
        expect(await extra.json()).toMatchObject({ reason: 'request_malformed' });
        // The SDK's digest is Socio's.
        const digest = f.sdk().intentDigest('data:files.delete', params);
        const made = await call(f, '/approvals', { action: 'data:files.delete', params, digest }, auth(actor.obo));
        expect(made.status).toBe(202);
        const { approval } = (await made.json()) as { approval: string };
        expect((await f.platform.approvals.get(approval, 'alice')).card).toMatchObject({
            operation: { op: 'files.delete' },
        });
        // Not approved yet: the delete is refused, and doesn't run.
        expect((await del(actor.obo, approval)).status).toBe(403);
        await f.platform.approvals.decide(approval, 'alice', true);
        // The app's own consume call can't spend it.
        expect((await call(f, `/approvals/${approval}/consume`, { digest }, auth(actor.obo))).status).toBe(409);
        // Another grant's request, or another path: refused.
        expect((await del(reader.obo, approval)).status).toBe(403);
        expect((await del(actor.obo, approval, 'reports/new.csv')).status).toBe(403);
        expect(performed).toEqual([]);
        // The socio's repeated request: once.
        expect((await del(actor.obo, approval)).status).toBe(200);
        expect((await del(actor.obo, approval)).status).toBe(403);
        expect(performed).toEqual([params.path]);
    });
});

describe('the internal apps listener', () => {
    it('is configured only with the app browser, and checks the source subnet', () => {
        expect(appsInternalConfigFromEnv({})).toBeUndefined();
        expect(appsInternalConfigFromEnv({ APP_BROWSER_URL: 'http://app-browser:4360' })).toEqual({
            port: 4312,
            host: '0.0.0.0',
            subnets: [],
        });
        expect(() =>
            appsInternalConfigFromEnv({
                APP_BROWSER_URL: 'http://x',
                APPS_INTERNAL_SUBNET: '10.0.0.0/40',
            }),
        ).toThrow(/CIDR/);
        const net = ['172.31.250.0/28'];
        expect(sourceAllowed('172.31.250.5', net)).toBe(true);
        expect(sourceAllowed('::ffff:172.31.250.14', net)).toBe(true);
        expect(sourceAllowed('172.31.250.17', net)).toBe(false);
        expect(sourceAllowed('10.0.0.2', net)).toBe(false);
        expect(sourceAllowed('fd00::1', net)).toBe(false);
        expect(sourceAllowed(undefined, net)).toBe(false);
        // Without a subnet, no source at all: every
        // container on any of the app's networks is private too.
        expect(sourceAllowed('10.0.0.2', [])).toBe(false);
        expect(sourceAllowed('172.18.0.5', [])).toBe(false);
        expect(sourceAllowed('127.0.0.1', [])).toBe(false);
        expect(sourceAllowed('::1', [])).toBe(false);
        expect(sourceAllowed('fd00::1', [])).toBe(false);
        expect(sourceAllowed('8.8.8.8', [])).toBe(false);
        // Loopback only when it is named, as development on one host does.
        expect(sourceAllowed('127.0.0.1', ['127.0.0.0/8'])).toBe(true);
        expect(sourceAllowed('::1', ['127.0.0.0/8'])).toBe(false);
    });

    /** What a raw connection gets back for a request: '' when destroyed unanswered. */
    const rawAnswer = (port: number, lines: string[]) =>
        new Promise<string>((resolve) => {
            const socket = connect(port, '127.0.0.1', () => socket.write([...lines, '', ''].join('\r\n')));
            let data = '';
            socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
            socket.on('close', () => resolve(data));
            // A reset is a refusal too.
            socket.on('error', () => resolve(data));
        });

    it('refuses every connection, unanswered, without APPS_INTERNAL_SUBNET', async () => {
        const f = await fixture();
        const s = await f.session();
        const logged: string[] = [];
        const internal = createAppsInternalServer(
            f.platform.apps,
            { port: 0, host: '127.0.0.1', subnets: [] },
            (line) => logged.push(line),
        )!;
        await internal.listen();
        cleanup.push(() => internal.close());
        const port = (internal.server.address() as AddressInfo).port;
        const before = f.up.seen.length;
        const requests = vi.spyOn(internal.server, 'emit');
        // A socio's own request, credential and proof right, from loopback:
        // the socket is closed before its request is read, with no answer.
        expect(
            await rawAnswer(port, [
                'GET /deals HTTP/1.1',
                `Host: ${f.host}`,
                `Authorization: Bearer ${s.token}`,
                `x-cb-context: ${s.proof('GET', '/deals')}`,
            ]),
        ).toBe('');
        expect(requests.mock.calls.filter(([event]) => ['request', 'upgrade'].includes(String(event)))).toEqual([]);
        expect(f.up.seen.length).toBe(before);
        expect(logged).toEqual([
            'Internal apps listener: APPS_INTERNAL_SUBNET is not set, so it refuses every connection.',
        ]);
    });

    it('serves socio sessions by Host over the raw request-target, without the credential, and nothing else', async () => {
        const f = await fixture();
        const start = async (subnets: string[]) => {
            const internal = createAppsInternalServer(f.platform.apps, {
                port: 0,
                host: '127.0.0.1',
                subnets,
            })!;
            await internal.listen();
            cleanup.push(() => internal.close());
            return (internal.server.address() as AddressInfo).port;
        };
        const send = (port: number, path: string, headers: Record<string, string>) =>
            new Promise<{ status: number; body: string }>((resolve, reject) => {
                const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
                });
                req.on('error', reject);
                req.end();
            });
        // This test's client is loopback: development's explicit subnet.
        const port = await start(['127.0.0.0/8']);
        const s = await f.session();
        // A source outside the network's subnet: closed before its request is
        // read, unanswered, an upgrade too.
        // The subnet is the app_browser overlay's, as its env sets it;
        // this test's loopback client is outside it.
        const outside = await start(
            appsInternalConfigFromEnv({
                APP_BROWSER_URL: 'http://company-brain-app-browser:4360',
                APPS_INTERNAL_SUBNET: APP_BROWSER_SUBNET_DEFAULT,
            })!.subnets,
        );
        const before = f.up.seen.length;
        expect(
            await rawAnswer(outside, [
                'GET /deals HTTP/1.1',
                `Host: ${f.host}`,
                `Authorization: Bearer ${s.token}`,
                `x-cb-context: ${s.proof('GET', '/deals')}`,
            ]),
        ).toBe('');
        expect(
            await rawAnswer(outside, [
                'GET /ws HTTP/1.1',
                `Host: ${f.host}`,
                `Origin: ${f.origin}`,
                `Authorization: Bearer ${s.token}`,
                `x-cb-context: ${s.proof('GET', '/ws')}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version: 13',
            ]),
        ).toBe('');
        expect(f.up.seen.length).toBe(before);
        expect(f.up.upgrades).toEqual([]);
        // A person's cookie, another host, or no credential: refused.
        const cookie = await f.signIn();
        expect((await send(port, '/deals', { host: f.host, cookie })).status).toBe(401);
        expect(
            (
                await send(port, '/api/apps', {
                    host: 'localhost:4310',
                    authorization: `Bearer ${s.token}`,
                })
            ).status,
        ).toBe(404);
        expect(f.up.seen.length).toBe(before);
        // The proof covers the request-target as sent, not a normalized form.
        const raw = '/x/../deals?a=%7E';
        expect(
            (
                await send(port, raw, {
                    host: f.host,
                    authorization: `Bearer ${s.token}`,
                    'x-cb-context': s.proof('GET', '/deals?a=%7E'),
                })
            ).status,
        ).toBe(401);
        const ok = await send(port, raw, {
            host: f.host,
            authorization: `Bearer ${s.token}`,
            'x-cb-context': s.proof('GET', raw),
        });
        expect(ok.status).toBe(200);
        const { url, headers } = lastSeen(f);
        expect(url).toBe('/deals?a=%7E');
        expect(headers.authorization).toBeUndefined();
        expect(headers['x-cb-context']).toBeUndefined();
        expect(
            f.sdk().verify({
                method: 'GET',
                target: url,
                header: headers['x-cb-actor'] as string,
            }),
        ).toMatchObject({
            ok: true,
            principal: { socio: { scopes: ['app:read'] } },
        });
    });
});
