import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Message } from '@ag-ui/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { contextKey, verifyContextProof } from '@socio/foundation/actors/keys';
import { TOOL_ACTOR_METADATA, withPrivateResultsWithheld } from '@socio/foundation/context/room-context';
import type { DotTurn } from '@socio/foundation/turns/turn';

import { openSealed, workerKeyPair, type BrowserCommand, type WorkerKeys } from '../src/app-browser/protocol.js';
import { AppBrowserRouter, sameUserLaunch } from '../src/app-browser/router.js';
import {
    AppBrowserBroker,
    AppBrowserError,
    HttpAppBrowserClient,
    type AppBrowserClient,
    type BrokerContext,
} from '../src/server/apps/broker-client.js';
import {
    BROWSE_TOOL_NAMES,
    browseTarget,
    browseToolsWith,
    redactResult,
    type BrowseDeps,
    type TurnConversation,
} from '../src/server/apps/browse-tools.js';
import { AppsService } from '../src/server/apps/service.js';
import { screenshotResult } from '../src/server/computers/computer-tools.js';

import { fixture, grantInput, SECRET } from './support/actor-fixture.js';

// CB-232: the `app_*` tools and Socio's side of the app browser
// (broker-client.ts). The router is a fake here, except in the last test,
// which runs the real router, a real worker and Chromium against a
// loopback fake of the internal apps listener.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A router that remembers what it was asked, with one key per context. */
class FakeRouter implements AppBrowserClient {
    bootId = randomUUID();
    contexts = new Map<string, BrokerContext & { keys: WorkerKeys }>();
    delivered: Array<{ contextId: string; sealed: string }> = [];
    commands: Array<{ contextId: string; command: BrowserCommand }> = [];
    closedGrants: string[] = [];
    closed: string[] = [];
    result: Record<string, unknown> = {
        title: 'Deals',
        url: 'https://crm.apps.test/',
    };
    busy = false;
    async list() {
        return {
            bootId: this.bootId,
            contexts: [...this.contexts.values()].map(({ keys: _keys, ...entry }) => entry),
        };
    }
    async open(input: { contextId: string; grantId: string; origin: string; bootId?: string }) {
        if (input.bootId && input.bootId !== this.bootId) {
            throw new AppBrowserError('Restarted.', 409);
        }
        if (this.busy) {
            throw new AppBrowserError('The app browser is busy.', 429);
        }
        const keys = workerKeyPair();
        this.contexts.set(input.contextId, {
            id: input.contextId,
            grantId: input.grantId,
            workerKey: keys.publicKey,
            openedAt: 0,
            lastUsedAt: 0,
            keys,
        });
        return { bootId: this.bootId, workerKey: keys.publicKey };
    }
    async deliver(contextId: string, sealed: string) {
        if (!this.contexts.has(contextId)) {
            throw new AppBrowserError('No such context.', 404);
        }
        this.delivered.push({ contextId, sealed });
    }
    async command(contextId: string, command: BrowserCommand) {
        if (!this.contexts.has(contextId)) {
            throw new AppBrowserError('No such context.', 404);
        }
        this.commands.push({ contextId, command });
        return this.result;
    }
    async close(contextId: string) {
        this.closed.push(contextId);
        this.contexts.delete(contextId);
    }
    async closeGrant(grantId: string) {
        this.closedGrants.push(grantId);
        for (const [id, entry] of this.contexts) {
            if (entry.grantId === grantId) {
                this.contexts.delete(id);
            }
        }
    }
    /** What a context's worker would read from the newest sealed delivery. */
    opened(contextId: string) {
        const entry = this.contexts.get(contextId)!;
        const last = this.delivered.filter((d) => d.contextId === contextId).at(-1)!;
        return openSealed(entry.keys, contextId, last.sealed) as {
            token: string;
            key: string;
            expiresAt: number;
        };
    }
    restart() {
        this.bootId = randomUUID();
        this.contexts.clear();
    }
}

const turnFor = (
    overrides: Partial<{
        userId: string;
        dot: DotTurn['dot'];
        threadId: string;
    }> = {},
): DotTurn =>
    ({
        dot: { id: 'rulo', name: 'Rulo', ownerId: null },
        userId: 'alice',
        threadId: 'chat-1',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
        ...overrides,
    }) as DotTurn;

function setup(
    options: {
        conversation?: TurnConversation;
        limits?: { perPerson: number; perSocio: number; perInstance: number };
    } = {},
) {
    const f = fixture();
    cleanup.push(() => f.close());
    const router = new FakeRouter();
    const access = f.a.access;
    const broker = new AppBrowserBroker({
        actors: access,
        client: router,
        secret: SECRET,
        now: () => f.w.now,
        ...(options.limits ? { limits: options.limits } : {}),
    });
    cleanup.push(broker.attach());
    const saved: unknown[] = [];
    let conversation: TurnConversation = options.conversation ?? 'private';
    const deps: BrowseDeps = {
        actors: access,
        broker,
        conversation: async () => conversation,
        target: () => ({ origin: 'https://crm.apps.test' }),
        screenshots: { result: screenshotResult },
        images: () => ({
            save: async (image) => {
                saved.push(image);
                return { id: 'img-1', name: image.name, type: 'image/jpeg' } as never;
            },
        }),
    };
    const tools = (turn = turnFor()) =>
        Object.fromEntries(
            (
                browseToolsWith(deps, turn) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
    const grant = (overrides: Parameters<typeof grantInput>[0] = {}) => access.grants.create(grantInput(overrides));
    return {
        f,
        access,
        router,
        broker,
        deps,
        tools,
        grant,
        saved,
        setConversation: (value: TurnConversation) => {
            conversation = value;
        },
    };
}

describe('who may use a grant', () => {
    it('refuses another person’s, another socio’s and another conversation’s turn, alike, and opens nothing', async () => {
        const s = setup();
        const grant = await s.grant();
        for (const turn of [
            turnFor({ userId: 'bob' }),
            turnFor({
                dot: { id: 'mingo', name: 'Mingo', ownerId: null } as DotTurn['dot'],
            }),
            turnFor({ threadId: 'chat-2' }),
        ]) {
            for (const tool of ['app_open', 'app_snapshot', 'app_close']) {
                expect(await s.tools(turn)[tool]!({ grant: grant.id })).toEqual({
                    error: 'No access with that id for the person you act for in this conversation. Ask with request_app_access.',
                });
            }
        }
        // A grant id that doesn't exist reads the same.
        expect(await s.tools().app_open!({ grant: randomUUID() })).toMatchObject({
            error: expect.stringContaining('No access with that id'),
        });
        expect(s.router.contexts.size).toBe(0);
        expect(s.access.contexts.openContexts()).toEqual([]);
        const denies = s.access.audit.list({ grantId: grant.id }).filter((row) => row.decision === 'deny');
        expect(denies.length).toBeGreaterThan(0);
        expect(new Set(denies.map((row) => row.reason))).toEqual(new Set(['turn_mismatch']));
    });

    it('takes a grant id, never a context id, from the model', () => {
        const s = setup();
        const tools = browseToolsWith(s.deps, turnFor()) as unknown as Array<{
            name: string;
            parameters: { shape: Record<string, unknown> };
        }>;
        expect(tools.map((tool) => tool.name)).toEqual([...BROWSE_TOOL_NAMES]);
        for (const tool of tools) {
            expect(Object.keys(tool.parameters.shape)).toContain('grant');
            expect(Object.keys(tool.parameters.shape).join(' ')).not.toMatch(/context|origin|url|host|token/i);
        }
    });

    it('refuses in a Telegram group or topic, where results can’t stay private', async () => {
        const s = setup({ conversation: 'telegram-group' });
        const grant = await s.grant();
        expect(await s.tools().app_open!({ grant: grant.id })).toEqual({
            error: 'Ask me in a private chat: what an app shows the person can’t be kept private in a group.',
        });
        expect(s.router.contexts.size).toBe(0);
    });

    it('refuses once the grant is revoked, expired or its flag is off', async () => {
        const s = setup();
        const expired = await s.grant({ minutes: 5 });
        s.f.advance(5 * 60_000);
        expect(await s.tools().app_open!({ grant: expired.id })).toMatchObject({
            error: expect.stringContaining('This access has ended'),
        });
        const flagged = await s.grant();
        s.f.w.flagsOff.add('socio-actor-access');
        expect(await s.tools().app_open!({ grant: flagged.id })).toMatchObject({
            error: expect.stringContaining('This access has ended'),
        });
        s.f.w.flagsOff.clear();
        const stale = await s.grant();
        s.f.w.versions.set('app:crm', 'v2');
        expect(await s.tools().app_open!({ grant: stale.id })).toMatchObject({
            error: expect.stringContaining('approve again'),
        });
        expect(s.router.contexts.size).toBe(0);
    });
});

describe('opening and using a context', () => {
    it('opens one context per grant, issues its credential for that context alone and delivers it sealed', async () => {
        const s = setup();
        const grant = await s.grant();
        const opened = await s.tools().app_open!({
            grant: grant.id,
            path: '/deals',
        });
        expect(opened).toEqual({ title: 'Deals', url: 'https://crm.apps.test/' });
        const [context] = s.access.contexts.openContexts();
        expect(context).toMatchObject({
            grantId: grant.id,
            personId: 'alice',
            socioId: 'rulo',
            kind: 'browser',
            audience: 'app:crm',
            worker: s.router.bootId,
        });
        expect(s.router.commands).toEqual([{ contextId: context!.id, command: { op: 'open', path: '/deals' } }]);
        // Only the worker's key opens what was delivered: the context's own
        // `cbsa_` and the context key every runtime derives.
        const secret = s.router.opened(context!.id);
        expect(secret.key).toBe(contextKey(SECRET, context!.id).toString('base64url'));
        const resolved = s.access.credentials.resolve(secret.token, {
            kind: 'cbsa',
            audience: 'app:crm',
        });
        expect(resolved).toMatchObject({
            ok: true,
            credential: {
                contextId: context!.id,
                holderKind: 'context',
                holderId: context!.id,
            },
        });
        expect(openSealed(workerKeyPair(), context!.id, s.router.delivered[0]!.sealed)).toBeUndefined();
        // The second call reuses the context and its credential.
        await s.tools().app_snapshot!({ grant: grant.id });
        await s.tools().app_open!({ grant: grant.id, path: '/' });
        expect(s.router.contexts.size).toBe(1);
        expect(s.router.delivered).toHaveLength(1);
        // Nothing the audit holds is a token.
        expect(JSON.stringify(s.access.audit.list({ grantId: grant.id }))).not.toContain(secret.token);
    });

    it('takes Socio’s tokens and actor envelopes out of everything it returns', async () => {
        const s = setup();
        const grant = await s.grant();
        const envelope = `v1.${'a'.repeat(40)}.${'b'.repeat(43)}`;
        s.router.result = {
            snapshot: `obo cbob_v1.${'x'.repeat(60)} actor ${envelope} key cbsa_${'y'.repeat(43)}`,
            nested: [{ text: `cbdt_${'z'.repeat(43)}` }],
        };
        await s.tools().app_open!({ grant: grant.id });
        const snap = await s.tools().app_snapshot!({ grant: grant.id });
        const text = JSON.stringify(snap);
        expect(text).not.toMatch(/cbob_|cbsa_|cbdt_|v1\.a{10}/);
        expect(text.match(/\[redacted\]/g)).toHaveLength(4);
        expect(redactResult({ n: 1, ok: true })).toEqual({ n: 1, ok: true });
    });

    it('records the navigations the lock ended as counts per context, once per change, with no URL', async () => {
        const s = setup();
        const grant = await s.grant();
        const rows = () =>
            s.access.audit
                .list({ grantId: grant.id })
                .filter((row) => row.phase === 'context' && row.status !== 'open');
        // Nothing ended: no row.
        s.router.result = {
            title: 'Deals',
            url: 'https://crm.apps.test/',
            blocked: 0,
            offOriginRedirects: 0,
        };
        await s.tools().app_open!({ grant: grant.id });
        expect(rows()).toEqual([]);
        const [context] = s.access.contexts.openContexts();
        // The app sent the page off its origin: the lock ended it.
        s.router.result = {
            title: 'Deals',
            url: 'https://crm.apps.test/login',
            blocked: 2,
            offOriginRedirects: 1,
            stopped: 'The app browser stopped the app tried to send you to another site.',
        };
        await s.tools().app_open!({ grant: grant.id, path: '/login' });
        await vi.waitFor(() => expect(rows()).toHaveLength(1));
        expect(rows()[0]).toMatchObject({
            phase: 'context',
            status: 'blocked:2;off_origin:1',
            personId: 'alice',
            socioId: 'rulo',
            grantId: grant.id,
            actorBy: 'system',
            audience: 'app:crm',
            resourceKind: 'browser',
            resourceId: context!.id,
        });
        expect(rows()[0]!.correlationId).toMatch(/^app_open-/);
        // The same counts again: no new row; a change: one more.
        await s.tools().app_snapshot!({ grant: grant.id });
        expect(rows()).toHaveLength(1);
        s.router.result = { ...s.router.result, blocked: 3 };
        await s.tools().app_snapshot!({ grant: grant.id });
        await vi.waitFor(() => expect(rows()).toHaveLength(2));
        expect(rows()[0]!.status).toBe('blocked:3;off_origin:1');
        // Counts only: no URL, no page content.
        expect(JSON.stringify(rows())).not.toMatch(/crm\.apps\.test|login|another site/);
    });

    it('asks for app_open before anything else, and closes the context but not the grant on app_close', async () => {
        const s = setup();
        const grant = await s.grant();
        expect(await s.tools().app_snapshot!({ grant: grant.id })).toEqual({
            error: 'The app isn’t open: open it first with app_open.',
        });
        await s.tools().app_open!({ grant: grant.id });
        const [context] = s.access.contexts.openContexts();
        expect(await s.tools().app_close!({ grant: grant.id })).toEqual({
            closed: true,
        });
        expect(s.access.contexts.get(context!.id)).toMatchObject({
            closeReason: 'closed_by_socio',
        });
        expect(s.router.contexts.size).toBe(0);
        // Its credential ended with it.
        expect(s.access.credentials.newestExpiry('context', context!.id)).toBeFalsy();
        expect(s.access.grants.get(grant.id)?.revokedAt).toBeNull();
    });

    it('answers “busy” past the caps without evicting anyone’s context', async () => {
        const s = setup({ limits: { perPerson: 2, perSocio: 4, perInstance: 1 } });
        const first = await s.grant();
        await s.tools().app_open!({ grant: first.id });
        const second = await s.grant({ personId: 'bob' });
        expect(await s.tools(turnFor({ userId: 'bob' })).app_open!({ grant: second.id })).toEqual({
            error: 'The app browser is busy. Close an app you are done with (app_close), or try again in a few minutes.',
        });
        expect(s.access.contexts.openContexts()).toHaveLength(1);
        expect(s.router.contexts.size).toBe(1);
        // The router's own cap reads the same.
        s.router.busy = true;
        await s.tools().app_close!({ grant: first.id });
        expect(await s.tools(turnFor({ userId: 'bob' })).app_open!({ grant: second.id })).toMatchObject({
            error: expect.stringContaining('The app browser is busy'),
        });
        expect(s.access.contexts.openContexts()).toHaveLength(0);
    });

    it('refuses a screenshot in a room, and keeps one in a private chat as the turn’s image', async () => {
        const s = setup();
        const grant = await s.grant();
        await s.tools().app_open!({ grant: grant.id });
        s.router.result = {
            base64: `/9j/${'A'.repeat(400)}`,
            width: 1280,
            height: 800,
            url: 'https://crm.apps.test/',
        };
        const shot = await s.tools().app_screenshot!({ grant: grant.id });
        expect(shot).toMatchObject({
            url: 'https://crm.apps.test/',
            image: { id: 'img-1' },
        });
        expect(s.saved).toHaveLength(1);
        s.setConversation('room');
        expect(await s.tools().app_screenshot!({ grant: grant.id })).toMatchObject({
            error: expect.stringContaining('Use app_snapshot'),
        });
        expect(s.saved).toHaveLength(1);
    });
});

describe('ending contexts', () => {
    it('closes the grant’s contexts in the router when it is revoked, and refuses after', async () => {
        const s = setup();
        const grant = await s.grant();
        await s.tools().app_open!({ grant: grant.id });
        await s.access.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
        expect(s.router.closedGrants).toEqual([grant.id]);
        expect(s.router.contexts.size).toBe(0);
        expect(s.access.contexts.openContexts()).toEqual([]);
        expect(await s.tools().app_snapshot!({ grant: grant.id })).toMatchObject({
            error: expect.stringContaining('This access has ended'),
        });
    });

    it('closes the contexts of a restarted router and opens a new one under the same grant', async () => {
        const s = setup();
        const grant = await s.grant();
        await s.tools().app_open!({ grant: grant.id });
        const [before] = s.access.contexts.openContexts();
        s.router.restart();
        s.f.advance(20_000);
        expect(await s.tools().app_snapshot!({ grant: grant.id })).toEqual({
            error: 'The app isn’t open: open it first with app_open.',
        });
        expect(s.access.contexts.get(before!.id)).toMatchObject({
            closeReason: 'broker_restarted',
        });
        await s.tools().app_open!({ grant: grant.id });
        const [after] = s.access.contexts.openContexts();
        expect(after!.id).not.toBe(before!.id);
        expect(after!.worker).toBe(s.router.bootId);
    });

    it('closes a router context whose row was closed without it, and a row whose router context is gone', async () => {
        const s = setup();
        const grant = await s.grant();
        await s.tools().app_open!({ grant: grant.id });
        const [context] = s.access.contexts.openContexts();
        // The router idled it out: after the grace, the row closes too.
        s.router.contexts.delete(context!.id);
        s.f.advance(61_000);
        await s.broker.reconcile({ force: true });
        expect(s.access.contexts.get(context!.id)).toMatchObject({
            closeReason: 'broker_closed',
        });
        // A revocation no listener heard (another runtime, before any turn
        // here): the row is closed, the router still holds it.
        await s.tools().app_open!({ grant: grant.id });
        const [second] = s.access.contexts.openContexts();
        await s.access.contexts.close([second!.id], 'grant_revoked', 'c');
        await s.broker.reconcile({ force: true });
        expect(s.router.closed).toContain(second!.id);
    });

    it('renews a held context’s credential through the renewal loop, sealed to the same worker', async () => {
        const s = setup();
        const grant = await s.grant();
        await s.tools().app_open!({ grant: grant.id });
        const [context] = s.access.contexts.openContexts();
        const first = s.router.opened(context!.id);
        s.f.advance(11 * 60_000);
        expect(await s.access.renewContexts()).toEqual([context!.id]);
        const renewed = s.router.opened(context!.id);
        expect(renewed.token).not.toBe(first.token);
        expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
        expect(renewed.key).toBe(first.key);
    });
});

describe('shared conversations', () => {
    it('keeps an app_snapshot result private to the person it was for in a room', () => {
        const messages = [
            {
                id: 'a1',
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'app_snapshot', arguments: '{}' },
                    },
                ],
            },
            {
                id: 't1',
                role: 'tool',
                toolCallId: 'call-1',
                content: JSON.stringify({
                    snapshot: 'Alice’s private pipeline: 3 deals',
                }),
                metadata: { [TOOL_ACTOR_METADATA]: 'alice' },
            },
        ] as unknown as Message[];
        const forBob = withPrivateResultsWithheld(messages, 'bob');
        expect(JSON.stringify(forBob)).not.toContain('private pipeline');
        expect(JSON.stringify(forBob)).toContain('withheld');
        const forAlice = withPrivateResultsWithheld(messages, 'alice');
        expect(JSON.stringify(forAlice)).toContain('private pipeline');
    });
});

describe('which apps a socio may open', () => {
    const platform = (app: Record<string, unknown> | undefined, appSocioOwner: string | null) =>
        ({
            apps: {
                enabled: true,
                get: () => app,
                url: (a: { id: string }) => `https://${a.id}.apps.test`,
            },
            plugins: {
                origin: (id: string) => (id === 'planner' || id === 'calendar' ? `https://${id}.apps.test` : undefined),
                get: (id: string) =>
                    id === 'planner'
                        ? {
                              id,
                              enabled: true,
                              mode: 'service',
                              manifest: { name: 'Planner' },
                          }
                        : id === 'calendar'
                          ? {
                                id,
                                enabled: true,
                                mode: 'bundled',
                                manifest: { name: 'Calendar' },
                            }
                          : undefined,
            },
            workspace: {
                dot: () => ({ id: 'socio-of-app', ownerId: appSocioOwner }),
            },
        }) as never;
    const company = turnFor();
    const own = turnFor({
        dot: { id: 'mine', name: 'Mine', ownerId: 'alice' } as DotTurn['dot'],
    });
    const grant = { personId: 'alice' } as never;

    it('opens promoted apps and installed plugins on any socio', () => {
        const promoted = { id: 'crm', status: 'promoted', dotId: 'x' };
        expect(AppsService.inRuntime(promoted as never)).toBe(true);
        expect(browseTarget(platform(promoted, null), 'app:crm', company, grant)).toEqual({
            origin: 'https://crm.apps.test',
        });
        expect(browseTarget(platform(undefined, null), 'plugin:planner', company, grant)).toEqual({
            origin: 'https://planner.apps.test',
        });
        expect(browseTarget(platform(undefined, null), 'plugin:gone', company, grant)).toMatchObject({
            reason: 'audience_unavailable',
        });
        // CB-232: a bundled plugin has nothing on the apps host; its tools
        // take the grant instead.
        expect(browseTarget(platform(undefined, null), 'plugin:calendar', company, grant)).toMatchObject({
            reason: 'audience_unavailable',
            refused: expect.stringMatching(/runs inside Socio: use its tools/),
        });
    });

    it('refuses a development app on a company socio, and anyone else’s on a person’s own', () => {
        const dev = { id: 'tracker', status: 'running', dotId: 'socio-of-app' };
        expect(browseTarget(platform(dev, null), 'app:tracker', company, grant)).toEqual({
            refused:
                'Socios can open only promoted apps for people here: if it is one of yours, propose promoting it with app_promote, which shows the person an approval card.',
            reason: 'not_promoted',
        });
        // The person's own socio, their own app: allowed (scopes advisory).
        expect(browseTarget(platform(dev, 'alice'), 'app:tracker', own, grant)).toEqual({
            origin: 'https://tracker.apps.test',
        });
        // Their own socio, but the app runs on someone else's socio.
        expect(browseTarget(platform(dev, 'bob'), 'app:tracker', own, grant)).toMatchObject({
            reason: 'not_promoted',
        });
        // An unpublished or missing app.
        expect(
            browseTarget(platform({ ...dev, status: 'unpublished' }, 'alice'), 'app:tracker', own, grant),
        ).toMatchObject({ reason: 'audience_unavailable' });
        expect(browseTarget(platform(undefined, null), 'app:none', company, grant)).toMatchObject({
            reason: 'audience_unavailable',
        });
    });
});

describe('end to end with the real router and worker', { timeout: 120_000 }, () => {
    let listener: Server | undefined;
    afterEach(() => new Promise<void>((resolve) => (listener ? listener.close(() => resolve()) : resolve())));

    it('the app sees a request the access check accepts for the grant, bound to its context; nothing else does', async () => {
        const f = fixture();
        cleanup.push(() => f.close());
        f.w.now = Date.now();
        const access = f.a.access;
        const verdicts: Array<{ ok: boolean; path: string }> = [];
        // A loopback stand-in for the internal apps listener: the access
        // check with the context proof as its binding, then the app.
        listener = createServer((req, res) => {
            const token = /^Bearer (.+)$/.exec(String(req.headers.authorization))?.[1];
            void access
                .check(
                    token,
                    {
                        kind: 'cbsa',
                        audience: 'app:crm',
                        tier: 'read',
                        correlationId: randomUUID(),
                    },
                    (credential) =>
                        verifyContextProof(
                            contextKey(SECRET, credential.contextId),
                            String(req.headers['x-cb-context']),
                            {
                                method: req.method ?? 'GET',
                                host: String(req.headers.host),
                                requestTarget: req.url ?? '/',
                                bodyDigest: '',
                            },
                            f.w.now,
                        ),
                )
                .then((result) => {
                    verdicts.push({ ok: result.ok, path: req.url ?? '' });
                    res.setHeader('content-type', 'text/html');
                    if (!result.ok) {
                        res.statusCode = result.status;
                        res.end('<title>Refused</title>');
                        return;
                    }
                    res.end(`<title>Pipeline</title><p>for ${result.actor.personId}</p>`);
                });
        });
        await new Promise<void>((resolve) => listener!.listen(0, '127.0.0.1', resolve));
        const upstream = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
        const router = new AppBrowserRouter({
            secret: 'e2e-router-secret-0123456789abcdef',
            upstream,
            max: 2,
            launch: sameUserLaunch,
        });
        cleanup.push(() => router.stop());
        const port = await new Promise<number>((resolve) => {
            const server = createServer((req, res) => {
                void (async () => {
                    const chunks: Buffer[] = [];
                    for await (const chunk of req) {
                        chunks.push(chunk as Buffer);
                    }
                    const response = await router.app().request(req.url ?? '/', {
                        method: req.method,
                        headers: req.headers as Record<string, string>,
                        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
                    });
                    res.statusCode = response.status;
                    res.end(Buffer.from(await response.arrayBuffer()));
                })();
            });
            server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
            cleanup.push(() => new Promise((done) => server.close(done)));
        });
        const broker = new AppBrowserBroker({
            actors: access,
            client: new HttpAppBrowserClient({
                url: `http://127.0.0.1:${port}`,
                secret: 'e2e-router-secret-0123456789abcdef',
            }),
            secret: SECRET,
            now: () => f.w.now,
        });
        cleanup.push(broker.attach());
        const tools = Object.fromEntries(
            (
                browseToolsWith(
                    {
                        actors: access,
                        broker,
                        conversation: async () => 'private',
                        target: () => ({ origin: 'https://crm.apps.test' }),
                        screenshots: { result: screenshotResult },
                    },
                    turnFor(),
                ) as unknown as Array<{
                    name: string;
                    execute: (input: unknown) => Promise<Record<string, unknown>>;
                }>
            ).map((tool) => [tool.name, tool.execute]),
        );
        const grant = await access.grants.create(grantInput());
        expect(await tools.app_open!({ grant: grant.id })).toMatchObject({
            title: 'Pipeline',
            url: 'https://crm.apps.test/',
        });
        expect(verdicts).toEqual([{ ok: true, path: '/' }]);
        const snap = await tools.app_snapshot!({ grant: grant.id });
        expect(String(snap.snapshot)).toContain('for alice');
        // Revoked: the router's context is closed at once, and the
        // credential it held is refused by the listener anyway.
        await access.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
        await vi.waitFor(() => expect(router.list().contexts).toEqual([]));
    });
});
