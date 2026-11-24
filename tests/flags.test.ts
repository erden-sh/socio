import { Context, Effect, Layer } from 'effect';
import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import { requireFlag } from '@socio/foundation/flags/guard';
import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    FLAGS,
    FLAG_KEY,
    RESERVED_FLAG_KEYS,
    earlyAccessForIssue,
    type FlagDefinition,
    type FlagKey,
    type FlagsAdminState,
} from '@socio/shared/flags';
import type { User, WorkspaceState } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { LegacyWorkspace } from '../src/server/composition/base.js';
import { FlagAdmin, Flags } from '../src/server/flags/contract.js';
import { deploymentKindFromEnv, flagDefaultsFromEnv } from '../src/server/flags/env.js';
import { evaluateFlag, workspaceBlocked } from '../src/server/flags/evaluate.js';
import { FlagService } from '../src/server/flags/service.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// Feature flags (CB-169) and plans (CB-182).

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const TEST_FLAGS: readonly FlagDefinition[] = [
    {
        key: 'web-reads',
        title: 'Socios read web pages',
        description: 'Reads.',
        stage: 'ga',
        default: true,
        owner: 'server',
        removeBy: '2099-01-01',
        tools: ['http_get', 'http_json'],
    },
    {
        key: 'beta-board',
        title: 'New board',
        description: 'A new board.',
        stage: 'early-access',
        default: false,
        owner: 'client',
        removeBy: '2099-01-01',
        issue: 'CB-999',
    },
    {
        key: 'beta-only',
        title: 'Unfinished',
        description: 'Not ready.',
        stage: 'dev',
        default: false,
        owner: 'server',
        removeBy: '2000-01-01',
        tools: ['lab_tool'],
    },
];

const alice = { userId: 'alice', role: 'admin' as const };
const carol = { userId: 'carol', role: 'admin' as const };
const bob = { userId: 'bob', role: 'member' as const };
const ga = TEST_FLAGS[0]!;
const early = TEST_FLAGS[1]!;
const dev = TEST_FLAGS[2]!;
const everyone = { enabled: true, roles: [], people: [] };
const nobody = { enabled: false, roles: [], people: [] };

it('declares every flag in code with a key, owner, removal date and safe tools', () => {
    const keys = FLAGS.map((flag) => flag.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const flag of FLAGS as readonly FlagDefinition[]) {
        expect(flag.key).toMatch(FLAG_KEY);
        expect(RESERVED_FLAG_KEYS).not.toContain(flag.key);
        expect(flag.owner.trim()).not.toBe('');
        expect(flag.title.trim()).not.toBe('');
        expect(flag.removeBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Number.isNaN(Date.parse(flag.removeBy))).toBe(false);
        // Unfinished work never defaults on.
        if (flag.stage === 'dev') {
            expect(flag.default).toBe(false);
        }
        if (flag.issue) {
            expect(flag.issue).toMatch(/^CB-\d+$/);
        }
    }
    // A tool belongs to one flag only.
    const tools = FLAGS.flatMap((flag) => [...((flag as FlagDefinition).tools ?? [])]);
    expect(new Set(tools).size).toBe(tools.length);
});

it('layers default, env, instance, plan and workspace, most specific last', () => {
    expect(evaluateFlag(ga, {}, bob, false)).toEqual({ enabled: true, source: 'default' });
    expect(evaluateFlag(ga, { env: false }, bob, false)).toEqual({ enabled: false, source: 'env' });
    expect(evaluateFlag(ga, { env: false, instance: everyone }, bob, false)).toEqual({
        enabled: true,
        source: 'instance',
    });
    // The plan includes it; the workspace narrows it to admins and Bob.
    const narrowed = {
        tier: true,
        workspace: { enabled: false, roles: ['admin' as const], people: ['bob'] },
    };
    expect(evaluateFlag(ga, { instance: nobody, ...narrowed }, bob, false)).toEqual({
        enabled: true,
        source: 'workspace',
    });
    expect(evaluateFlag(ga, narrowed, carol, false).enabled).toBe(true);
    expect(evaluateFlag(ga, narrowed, alice, false).enabled).toBe(true); // An admin too since the operator role was retired (CB-390).
    expect(evaluateFlag(ga, narrowed, { userId: 'dan' }, false).enabled).toBe(false);
});

it('stops at a locked instance rule and a plan that leaves a flag out', () => {
    const locked = { ...nobody, locked: true };
    expect(evaluateFlag(ga, { instance: locked, tier: true, workspace: everyone }, bob, false)).toEqual({
        enabled: false,
        source: 'instance',
    });
    expect(evaluateFlag(ga, { instance: everyone, tier: false, workspace: everyone }, bob, false)).toEqual({
        enabled: false,
        source: 'tier',
    });
    expect(workspaceBlocked(ga, { instance: locked }, false)).toBe(
        'Set by this server’s configuration: admins can’t change it.',
    );
    expect(workspaceBlocked(ga, { tier: false }, false)).toMatch(/plan/);
    expect(workspaceBlocked(early, { instance: everyone, tier: true }, false)).toBeNull();
    // Nothing names a role above the admins'.
    for (const layers of [{ instance: locked }, { tier: false }]) {
        expect(workspaceBlocked(ga, layers, false)).not.toMatch(/operator/i);
    }
});

it('never has a dev flag on in a customer deployment, whatever any layer says (CB-503)', () => {
    const all = { env: true, instance: { ...everyone, locked: true }, tier: true, workspace: everyone };
    for (const layers of [{}, { env: true }, { instance: everyone }, { tier: true }, { workspace: everyone }, all]) {
        for (const who of [alice, carol, bob]) {
            expect(evaluateFlag(dev, layers, who, false)).toEqual({ enabled: false, source: 'deployment' });
        }
    }
    expect(workspaceBlocked(dev, {}, false)).toBe('Not available in this deployment.');
    // An internal deployment: a dev flag layers like any other, and admins switch it.
    expect(evaluateFlag(dev, {}, bob, true)).toEqual({ enabled: false, source: 'default' });
    expect(evaluateFlag(dev, { env: true }, bob, true)).toEqual({ enabled: true, source: 'env' });
    expect(evaluateFlag(dev, { workspace: { ...nobody, people: ['bob'] } }, bob, true)).toEqual({
        enabled: true,
        source: 'workspace',
    });
    expect(workspaceBlocked(dev, {}, true)).toBeNull();
});

it('lets no stage and no stored data turn a flag on for one person alone (CB-503)', () => {
    // The layers a person could once set (an opted-in rule, their own
    // choice), as old rows and old clients still carry them: none counts.
    const legacy = { ...nobody, optIn: true } as typeof nobody;
    const stray = { choice: true, person: true, optIn: true } as Record<string, unknown>;
    for (const flag of [ga, early, dev]) {
        for (const internal of [false, true]) {
            for (const layers of [
                { workspace: legacy, ...stray },
                { instance: legacy, ...stray },
                { instance: legacy, workspace: legacy, ...stray },
                { ...stray },
            ]) {
                const value = evaluateFlag({ ...flag, default: false }, layers, bob, internal);
                expect(value.enabled, `${flag.key} ${internal}`).toBe(false);
                expect(Object.keys(value).sort()).toEqual(['enabled', 'source']);
            }
        }
    }
});

it('reads SOCIO_DEPLOYMENT_KIND: internal only when it says so', () => {
    expect(deploymentKindFromEnv({})).toBe('customer');
    expect(deploymentKindFromEnv({ SOCIO_DEPLOYMENT_KIND: ' Internal ' })).toBe('internal');
    for (const value of ['', 'dev', 'customer', 'internals', 'true']) {
        expect(deploymentKindFromEnv({ SOCIO_DEPLOYMENT_KIND: value })).toBe('customer');
    }
});

it('reads FEATURE_FLAGS, refusing a malformed list and skipping unknown flags', () => {
    const warn = vi.fn();
    expect(flagDefaultsFromEnv({}, warn, TEST_FLAGS)).toEqual({});
    expect(flagDefaultsFromEnv({ FEATURE_FLAGS: ' web-reads=off, beta-board=ON ,gone=on,' }, warn, TEST_FLAGS)).toEqual(
        { 'web-reads': false, 'beta-board': true },
    );
    expect(warn).toHaveBeenCalledWith('FEATURE_FLAGS: no flag "gone" in this version; ignored.');
    for (const bad of ['web-reads', 'web-reads=maybe', 'Web=on', 'a=on=off']) {
        expect(() => flagDefaultsFromEnv({ FEATURE_FLAGS: bad }, warn, TEST_FLAGS)).toThrow(/FEATURE_FLAGS/);
    }
});

it('finds the early-access flags a release highlight names', () => {
    expect(earlyAccessForIssue('CB-999', TEST_FLAGS).map((f) => f.key)).toEqual(['beta-board']);
    expect(earlyAccessForIssue('CB-1', TEST_FLAGS)).toEqual([]);
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'carol', name: 'Carol', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'dan', name: 'Dan', role: 'member' },
];

async function api(env: Record<string, boolean> = {}, internal = false) {
    let flags!: FlagService;
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            baseUrl: 'http://model.test/v1',
            apiKey: 'k',
            model: 'qwen',
            featureFlags: env,
            deploymentKind: internal ? 'internal' : 'customer',
        },
        // The test's own flags, as the app's services offer them to the
        // routes (`Flags`, `FlagAdmin`), before the routes are built.
        // The graph's own steps (a socio's turn) keep the graph's `Flags`.
        layers: Layer.effectContext(
            Effect.gen(function* () {
                const workspace = yield* LegacyWorkspace;
                flags = new FlagService(workspace.db, {
                    registry: TEST_FLAGS,
                    env,
                    internal,
                    tenantId: 'main',
                    role: (id) => workspace.users().find((user) => user.id === id)?.role,
                });
                return Context.make(Flags, flags).pipe(Context.add(FlagAdmin, flags));
            }),
        ),
        beforeApp: () => {
            vi.spyOn(console, 'log').mockImplementation(() => {});
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...headers,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const callers = {
        alice: await as('alice'),
        carol: await as('carol'),
        bob: await as('bob'),
        dan: await as('dan'),
    };
    // Everyone has signed in once, so the workspace knows them.
    for (const call of Object.values(callers)) {
        await call('/workspace');
    }
    return { platform, workspace, flags, ...callers };
}

const shellFlags = async (call: Awaited<ReturnType<typeof api>>['bob']) =>
    ((await (await call('/workspace')).json()) as WorkspaceState).flags;

it('lets only admins read the flags, and only operators set instance rules and plans', async () => {
    const { alice, carol, bob } = await api();
    expect((await bob('/flags')).status).toBe(403);
    expect((await bob('/flags/web-reads/workspace', 'PUT', nobody)).status).toBe(403);
    expect((await bob('/flags/web-reads/workspace', 'DELETE')).status).toBe(403);
    // CB-390: the operator checks are the admin checks for now.
    expect((await bob('/flags/web-reads/instance', 'PUT', nobody)).status).toBe(403);
    expect((await bob('/flags/tiers/pro', 'PUT', { name: 'Pro' })).status).toBe(403);
    expect((await bob('/flags/tier', 'PUT', { tierId: null })).status).toBe(403);
    const state = (await (await carol('/flags')).json()) as FlagsAdminState;
    // A customer deployment: no dev flag, and nothing about anyone's role above admin.
    expect(state.flags.map((flag) => flag.key)).toEqual(['web-reads', 'beta-board']);
    expect(state).not.toHaveProperty('operator');
    expect(state.people.map((person) => person.id).sort()).toEqual(['alice', 'bob', 'carol', 'dan']);
    expect(((await (await alice('/flags')).json()) as FlagsAdminState).flags).toHaveLength(2);
    // Unknown flags and malformed rules.
    expect((await carol('/flags/nope/workspace', 'PUT', nobody)).status).toBe(404);
    expect((await carol('/flags/web-reads/workspace', 'PUT', { enabled: 'yes' })).status).toBe(400);
    expect(
        (
            await carol('/flags/web-reads/workspace', 'PUT', {
                ...nobody,
                people: ['stranger'],
            })
        ).status,
    ).toBe(400);
    expect(
        (
            await carol('/flags/web-reads/workspace', 'PUT', {
                ...nobody,
                optIn: true,
            })
        ).status,
    ).toBe(400);
});

it('keeps admins inside what the server’s configuration allows: locks and the plan', async () => {
    const { alice, carol, bob } = await api();
    // A locked instance rule: admins can't change or clear it.
    expect(
        (
            await alice('/flags/web-reads/instance', 'PUT', {
                ...everyone,
                locked: true,
            })
        ).status,
    ).toBe(200);
    expect((await carol('/flags/web-reads/workspace', 'PUT', nobody)).status).toBe(403);
    expect((await carol('/flags/web-reads/workspace', 'DELETE')).status).toBe(403);
    expect(
        (
            await carol('/flags/web-reads/workspace', 'PUT', {
                ...nobody,
                locked: true,
            })
        ).status,
    ).toBe(403);
    expect((await alice('/flags/web-reads/instance', 'DELETE')).status).toBe(200);
    // A plan that leaves it out: off for everyone, and admins can't turn it on.
    expect(
        (
            await alice('/flags/tiers/starter', 'PUT', {
                name: 'Starter',
                flags: { 'web-reads': false, 'beta-board': true },
            })
        ).status,
    ).toBe(200);
    // A customer deployment knows no dev flag, in a plan either.
    expect((await alice('/flags/tiers/dev', 'PUT', { name: 'Dev', flags: { 'beta-only': true } })).status).toBe(400);
    expect(
        (
            await alice('/flags/tiers/bad', 'PUT', {
                name: 'Bad',
                flags: { nope: true },
            })
        ).status,
    ).toBe(400);
    expect((await alice('/flags/tiers/Bad_Id', 'PUT', { name: 'X' })).status).toBe(400);
    expect((await alice('/flags/tier', 'PUT', { tierId: 'missing' })).status).toBe(404);
    expect((await alice('/flags/tier', 'PUT', { tierId: 'starter' })).status).toBe(200);
    expect((await carol('/flags/web-reads/workspace', 'PUT', everyone)).status).toBe(403);
    expect((await shellFlags(bob))!.on).toEqual(['beta-board']);
    // A plan in use can't be deleted.
    expect((await alice('/flags/tiers/starter', 'DELETE')).status).toBe(409);
    expect((await alice('/flags/tier', 'PUT', { tierId: null })).status).toBe(200);
    expect((await alice('/flags/tiers/starter', 'DELETE')).status).toBe(200);
    expect((await alice('/flags/tiers/starter', 'DELETE')).status).toBe(404);
    expect((await shellFlags(bob))!.on).toEqual(['web-reads']);
});

it('targets the workspace rule by role and person, and shows each person only their own values', async () => {
    const { carol, bob, dan, alice } = await api({ 'web-reads': false });
    expect((await shellFlags(bob))!.on).toEqual([]);
    expect(
        (
            await carol('/flags/web-reads/workspace', 'PUT', {
                enabled: false,
                roles: ['admin'],
                people: ['bob'],
            })
        ).status,
    ).toBe(200);
    expect((await shellFlags(bob))!.on).toEqual(['web-reads']);
    expect((await shellFlags(carol))!.on).toEqual(['web-reads']);
    expect((await shellFlags(dan))!.on).toEqual([]);
    expect((await shellFlags(alice))!.on).toEqual(['web-reads']);
    const state = (await (await carol('/flags')).json()) as FlagsAdminState;
    const reads = state.flags.find((flag) => flag.key === 'web-reads')!;
    expect(reads).toMatchObject({
        env: false,
        workspace: { enabled: false, roles: ['admin'], people: ['bob'] },
        you: { enabled: true, source: 'workspace' },
        everyone: { enabled: false, source: 'workspace' },
    });
    // The shell's poll sees the change (its version moves).
    const first = await dan('/workspace');
    const tag = first.headers.get('etag')!;
    expect(tag).toBeTruthy();
    expect((await dan('/workspace', 'GET', undefined, { 'If-None-Match': tag })).status).toBe(304);
    await carol('/flags/web-reads/workspace', 'PUT', everyone);
    const after = await dan('/workspace', 'GET', undefined, {
        'If-None-Match': tag,
    });
    expect(after.status).toBe(200);
    expect(((await after.json()) as WorkspaceState).flags!.on).toEqual(['web-reads']);
});

it('has no route for a person’s own choice, and refuses opt-in on rules (CB-503)', async () => {
    const { alice, carol, bob, workspace } = await api();
    for (const call of [bob, carol, alice]) {
        expect((await call('/flags/early-access')).status).toBe(404);
        for (const enabled of [true, false, null]) {
            expect((await call('/flags/beta-board/choice', 'PUT', { enabled })).status).toBe(404);
            expect((await call('/flags/web-reads/choice', 'PUT', { enabled })).status).toBe(404);
        }
    }
    for (const optIn of [true, false]) {
        expect((await carol('/flags/beta-board/workspace', 'PUT', { ...nobody, optIn })).status).toBe(400);
        expect((await alice('/flags/beta-board/instance', 'PUT', { ...nobody, optIn })).status).toBe(400);
    }
    expect(workspace.auditOf('feature_flag', 'beta-board')).toEqual([]);
    // /api/workspace carries only what is on: nothing to opt into.
    expect(await shellFlags(bob)).toEqual({ on: ['web-reads'] });
});

it('lets no stored opt-in or choice turn a flag on, even one an older release writes (CB-503)', async () => {
    const { carol, bob, dan, workspace } = await api();
    const db = workspace.db;
    // What a release from before CB-503 still writes while both run.
    await carol('/flags/beta-board/workspace', 'PUT', nobody);
    db.prepare("UPDATE flag_rules SET optIn = 1 WHERE flag = 'beta-board'").run();
    db.prepare(
        "INSERT INTO flag_rules (scope, scopeId, flag, enabled, roles, people, locked, optIn, updatedBy, updatedAt) VALUES ('instance', '', 'beta-board', 0, '[]', '[]', 0, 1, 'x', 1)",
    ).run();
    db.prepare("INSERT INTO flag_choices (userId, flag, enabled, updatedAt) VALUES ('bob', 'beta-board', 1, 1)").run();
    db.prepare(
        "INSERT INTO flag_choices (userId, flag, enabled, updatedAt) VALUES ('bob', 'beta-board', 1, 2) ON CONFLICT (userId, flag) DO UPDATE SET enabled = 1",
    ).run();
    expect(db.prepare('SELECT flag, optIn FROM flag_rules ORDER BY scope').all()).toEqual([
        { flag: 'beta-board', optIn: 0 },
        { flag: 'beta-board', optIn: 0 },
    ]);
    expect(db.prepare('SELECT * FROM flag_choices').all()).toEqual([]);
    expect((await shellFlags(bob))!.on).toEqual(['web-reads']);
    // Only an admin's rule turns it on for some people.
    await carol('/flags/beta-board/workspace', 'PUT', { ...nobody, people: ['bob'] });
    expect((await shellFlags(bob))!.on).toEqual(['web-reads', 'beta-board']);
    expect((await shellFlags(dan))!.on).toEqual(['web-reads']);
});

it('never lists or turns on a dev flag in a customer deployment, through any route (CB-503)', async () => {
    const { alice, carol, bob, flags, platform } = await api({ 'beta-only': true, 'socio-actor-access': true });
    expect(flags.ignoredEnv()).toEqual(['beta-only']);
    expect(flags.definition('beta-only')).toBeUndefined();
    // Every flag route answers as if it didn't exist.
    for (const call of [alice, carol]) {
        expect((await call('/flags/beta-only/workspace', 'PUT', everyone)).status).toBe(404);
        expect((await call('/flags/beta-only/workspace', 'DELETE')).status).toBe(404);
    }
    // The server-rule routes (operator role; no UI) don't know it either.
    expect((await alice('/flags/beta-only/instance', 'PUT', everyone)).status).toBe(404);
    expect((await alice('/flags/beta-only/instance', 'DELETE')).status).toBe(404);
    // Stored rules and a plan that name it, from before, or written around the routes.
    await flags.setRule('instance', 'beta-only', { ...everyone, locked: true }, 'x');
    await flags.setRule('tenant', 'beta-only', everyone, 'x');
    await flags.saveTier({ id: 'all', name: 'All', description: '', flags: { 'beta-only': true } }, 'x');
    await flags.setTenantTier('all', 'x');
    for (const call of [alice, carol, bob]) {
        const shell = (await shellFlags(call))!;
        expect(shell.on).not.toContain('beta-only');
        expect(shell).not.toHaveProperty('internal');
    }
    expect(flags.enabled('beta-only' as FlagKey, 'alice')).toBe(false);
    expect(flags.toolsOff('alice').has('lab_tool')).toBe(true);
    const state = (await (await alice('/flags')).json()) as FlagsAdminState;
    expect(state.flags.map((flag) => flag.key)).not.toContain('beta-only');
    // A socio's turn (the server's own flags): a dev flag's tools stay off, FEATURE_FLAGS or not.
    const off = platform.dotExtensions.toolsOff!({ userId: 'alice' } as Parameters<
        NonNullable<typeof platform.dotExtensions.toolsOff>
    >[0]);
    expect(off.has('request_app_access')).toBe(true);
});

it('lists dev flags for admins to switch in an internal deployment, with no operator controls', async () => {
    const { carol, bob, dan, flags } = await api({}, true);
    expect(flags.ignoredEnv()).toEqual([]);
    const state = (await (await carol('/flags')).json()) as FlagsAdminState;
    expect(state.flags.map((flag) => [flag.key, flag.workspaceBlocked])).toEqual([
        ['web-reads', null],
        ['beta-board', null],
        ['beta-only', null],
    ]);
    expect((await carol('/flags/beta-only/workspace', 'PUT', { ...nobody, people: ['bob'] })).status).toBe(200);
    expect(await shellFlags(bob)).toEqual({ on: ['web-reads', 'beta-only'], internal: true });
    expect((await shellFlags(dan))!.on).toEqual(['web-reads']);
});

it('audits instance rules and plans, and guards flagged routes on the server', async () => {
    const { alice, bob, carol, workspace, flags } = await api();
    await alice('/flags/web-reads/instance', 'PUT', nobody);
    await alice('/flags/web-reads/instance', 'DELETE');
    await alice('/flags/tiers/pro', 'PUT', { name: 'Pro', flags: {} });
    await alice('/flags/tier', 'PUT', { tierId: 'pro' });
    expect(
        workspace.auditOf('feature_flag', 'web-reads').map((line) => [line.action, JSON.parse(line.detail).scope]),
    ).toEqual([
        ['update', 'instance'],
        ['remove', 'instance'],
    ]);
    expect(workspace.auditOf('flag_tier', 'pro')).toHaveLength(1);
    // A plan id that is also a flag route's name still means the plan.
    expect((await alice('/flags/tiers/workspace', 'PUT', { name: 'W' })).status).toBe(200);
    expect((await alice('/flags/tiers/workspace', 'DELETE')).status).toBe(200);
    expect(workspace.auditOf('flag_tier', 'main')).toMatchObject([{ actor: 'alice', action: 'update' }]);
    // A route behind a flag answers 404 to whoever has it off.
    await carol('/flags/beta-board/workspace', 'PUT', {
        ...nobody,
        people: ['bob'],
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        c.set('user', { id: c.req.header('x-user')!, name: 'x', role: 'member' });
        await next();
    });
    app.get('/board', requireFlag(flags, 'beta-board' as FlagKey), (c) => c.json({ ok: true }));
    const asUser = (id: string) => app.request('/board', { headers: { 'x-user': id } });
    expect((await asUser('bob')).status).toBe(200);
    expect((await asUser('dan')).status).toBe(404);
    // A member can't widen a flag for themselves through the admin routes.
    expect((await bob('/flags/beta-board/workspace', 'PUT', everyone)).status).toBe(403);
    expect(flags.overdue('2026-10-27').map((flag) => flag.key)).toEqual(['beta-only']);
});

it('gives each person the tools of flags that are on for them only', async () => {
    const { platform, carol } = await api();
    // A socio's turn reads the graph's own flags (`Flags`, over the server's
    // registry), on the same rules the flag routes write.
    const turn = (userId: string) => ({ userId }) as Parameters<NonNullable<typeof platform.dotExtensions.toolsOff>>[0];
    const off = (userId: string) => platform.dotExtensions.toolsOff!(turn(userId));
    const before = off('bob');
    expect(before.has('http_get')).toBe(false);
    expect(before.has('http_json')).toBe(false);
    await carol('/flags/web-reads/workspace', 'PUT', {
        ...nobody,
        people: ['dan'],
    });
    expect([...off('bob')].filter((tool) => !before.has(tool)).sort()).toEqual(['http_get', 'http_json']);
    expect(off('dan').has('http_get')).toBe(false);
    expect(off('dan').has('http_json')).toBe(false);
});
