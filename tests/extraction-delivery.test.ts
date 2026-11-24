import { createHash } from 'node:crypto';

import { afterEach, expect, it, vi } from 'vitest';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { manifestChanges, parseAppManifest, type AppManifest } from '@socio/shared/apps/app-manifest';

import { socioApp } from '../packages/app-sdk/src/index.js';
import { createApp } from '../src/server/app.js';
import { actionSetHash, AppActors } from '../src/server/apps/actor.js';
import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { gatewaySourcesOf } from '../src/server/gateway/adopted.js';
import { extractTools } from '../src/server/gateway/extract-tools.js';

import { Runner } from './helpers/runners.js';
import { gitWorld } from './support/git-gateway.js';

// CB-239, CB-267: an approved extraction reaches the app
// that asked for it, through GET /api/apps/actor/extractions/:id with the
// app's own data token and the request's cbob_. Negative cases first:
// another app, another person, another socio, a development app, an app
// that no longer accepts extractions, the feature off, and reads past the
// window are refused, and each read is audited without names or contents.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'git-gateway-secret-0123456789abcdef';

const manifestOf = (accepts: boolean) => {
    const parsed = parseAppManifest({
        name: 'Repomix',
        entry: 'server.ts',
        delegation: {
            contract: 1,
            actions: { 'pack.view': 'read' },
            ...(accepts ? { accepts: ['repo-extract'] } : {}),
        },
    });
    if (!parsed.ok) {
        throw new Error(parsed.error);
    }
    return parsed.manifest;
};

async function world(flags?: Record<string, boolean>) {
    const base = await gitWorld(cleanup, flags ? { flags } : {});
    const { workspace, platform, edge, socio } = base;
    const now = Date.now();
    const add = workspace.db.prepare(
        "INSERT INTO apps(id,slug,name,description,dotId,ownerUserId,port,datasets,public,status,config,createdAt,updatedAt,liveVersion) VALUES (?,?,?,'',?,?,?,'[]',0,?,'{}',?,?,1)",
    );
    add.run('repomix', 'repomix', 'Repomix', socio.id, 'alice', 3001, 'promoted', now, now);
    add.run('other', 'other', 'Other', socio.id, 'alice', 3002, 'promoted', now, now);
    add.run('devapp', 'devapp', 'Dev App', socio.id, 'alice', 3003, 'ephemeral', now, now);
    // The real `app` audience policy (with its `accepts`), over
    // manifests this test sets per app.
    const manifests = new Map<string, AppManifest>([
        ['repomix', manifestOf(true)],
        ['other', manifestOf(false)],
        ['devapp', manifestOf(true)],
    ]);
    const actor = new AppActors({
        db: workspace.db,
        secret: SECRET,
        workspace,
        app: (id) => platform.apps.get(id),
        access: (personId, app) => platform.apps.access(personId, app as Parameters<typeof platform.apps.access>[1]),
        manifest: (appId) => manifests.get(appId),
    });
    cleanup.push(platform.actors.audiences.register('app', actor.policy()));
    const http = createApp({
        store: platform.store,
        runner: new Runner(platform.store, { mode: 'live', baseUrl: '' }),
        config: { mode: 'live', baseUrl: '' },
        edge,
        auth: {
            provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
            secureCookies: false,
        },
    });
    const token = (appId: string, promoted = true) =>
        platform.data.tokens.issue({
            userId: 'alice',
            dotId: socio.id,
            purpose: 'app',
            session: `app:${appId}`,
            ...(promoted ? { appId } : {}),
        });
    const read = (id: string, bearer: string | undefined, obo: string | undefined) =>
        http.request(`http://company-brain-app:4310/api/apps/actor/extractions/${id}`, {
            headers: {
                ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
                ...(obo ? { 'x-cb-obo': obo } : {}),
            },
        });
    const personObo = (userId: string, appId = 'repomix') => {
        const hash = createHash('sha256').update(`cookie-${userId}-${appId}-${Math.random()}`).digest('hex');
        workspace.db
            .prepare('INSERT INTO app_sessions(hash, appId, userId, createdAt, expiresAt) VALUES (?,?,?,?,?)')
            .run(hash, appId, userId, Date.now(), Date.now() + 86_400_000);
        return platform.actors.credentials.mintObo({
            appId,
            sessionHash: hash,
            requestId: `req-${Math.random()}`,
            ttlMs: 60_000,
        });
    };
    const turn: DotTurn = {
        dot: workspace.dot(socio.id)!,
        userId: 'alice',
        threadId: base.chat.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    };
    /** An extraction for `app`, approved by alice; its id. */
    const approved = async (app = 'repomix') => {
        const [tool] = extractTools(gatewaySourcesOf(platform), turn) as unknown as Array<{
            execute: (input: unknown) => Promise<Record<string, unknown>>;
        }>;
        const result = await tool.execute({
            repository: 'acme/app',
            ref: 'main',
            paths: ['src/'],
            app,
            task: 'Pack the source',
        });
        expect(result.extraction_id).toBeTypeOf('string');
        const [pending] = await platform.approvals.list('alice', {
            status: 'pending',
        });
        const decided = await platform.approvals.decide(String(pending.id), 'alice', true);
        expect(decided.status).toBe('approved');
        return String(result.extraction_id);
    };
    const appGrant = (socioId = socio.id) =>
        platform.actors.grants.create({
            personId: 'alice',
            socioId,
            audiences: ['app:repomix'],
            scopes: ['app:read'],
            conversationId: base.chat.id,
            conversationKind: 'private',
            task: 'pack',
            policyVersion: actionSetHash(manifests.get('repomix')!.delegation!),
            approvedBy: 'alice',
            correlationId: 'test',
        });
    const readAudit = () =>
        platform.actors.audit.list({ personId: 'alice' }).filter((row) => row.action === 'git:extract:read');
    return {
        ...base,
        http,
        manifests,
        actor,
        token,
        read,
        personObo,
        approved,
        appGrant,
        readAudit,
    };
}

it('takes `accepts: ["repo-extract"]` in a manifest, refuses anything else, and lists the change', () => {
    expect(manifestOf(true).delegation?.accepts).toEqual(['repo-extract']);
    const bad = parseAppManifest({
        name: 'X',
        entry: 'server.ts',
        delegation: { contract: 1, actions: {}, accepts: ['repo-push'] },
    });
    expect(bad.ok).toBe(false);
    expect(manifestChanges(manifestOf(false), manifestOf(true))).toContain('Repository extractions: accepted');
    expect(manifestChanges(manifestOf(true), manifestOf(false))).toContain(
        'Repository extractions: no longer accepted',
    );
    // Not part of the action set: accepting changes no socio's grant.
    expect(actionSetHash(manifestOf(true).delegation!)).toBe(actionSetHash(manifestOf(false).delegation!));
});

it('the app policy accepts extractions only for a promoted app that declares them', async () => {
    const w = await world();
    const policy = w.actor.policy();
    expect(policy.accepts?.('app:repomix', 'repo-extract')).toBe(true);
    expect(policy.accepts?.('app:other', 'repo-extract')).toBe(false);
    // A development app never, whatever its manifest says.
    expect(policy.accepts?.('app:devapp', 'repo-extract')).toBe(false);
    expect(policy.accepts?.('app:missing', 'repo-extract')).toBe(false);
    expect(policy.accepts?.('plugin:repomix', 'repo-extract')).toBe(false);
});

it('refuses a read without the app’s own promoted-app data token, before any lookup', async () => {
    const w = await world();
    const id = await w.approved();
    const obo = w.personObo('alice');
    // No token: the person-session path, refused (host and sign-in checks).
    expect([401, 403]).toContain((await w.read(id, undefined, obo)).status);
    // A development app's token (no appId) and a computer's token.
    expect((await w.read(id, w.token('devapp', false), obo)).status).toBe(403);
    const computer = w.platform.data.tokens.forCommand('alice', w.socio.id, 60_000, 'person').token;
    expect((await w.read(id, computer, obo)).status).toBe(403);
    // Another promoted app's token: no such extraction for it.
    expect((await w.read(id, w.token('other'), w.personObo('alice', 'other'))).status).toBe(404);
    // A malformed id never reaches the store.
    expect((await w.read('../x', w.token('repomix'), obo)).status).toBe(404);
    expect(w.readAudit().every((row) => row.decision === 'deny')).toBe(true);
});

it('refuses without the request’s obo, with another person’s, and with another socio’s grant', async () => {
    const w = await world();
    const id = await w.approved();
    const token = w.token('repomix');
    expect((await w.read(id, token, undefined)).status).toBe(401);
    // A cbob_ of another app doesn't open for this one.
    expect((await w.read(id, token, w.personObo('alice', 'other'))).status).toBe(401);
    // Bob may open the app (shared), but the extraction is alice's.
    w.workspace.db.prepare("UPDATE apps SET sharedSpaceId=? WHERE id='repomix'").run(w.workspace.spaces()[0]!.id);
    expect((await w.read(id, token, w.personObo('bob'))).status).toBe(403);
    // Another socio of alice's, with its own grant for the app.
    const other = w.workspace.createDot(w.workspace.spaces()[0]!.id, 'Second', '', false, false);
    const foreign = await w.appGrant(other.id);
    const viaForeign = w.platform.actors.credentials.mintObo({
        appId: 'repomix',
        grantId: foreign.id,
        requestId: 'r-foreign',
        ttlMs: 60_000,
    });
    expect((await w.read(id, token, viaForeign)).status).toBe(403);
    const reasons = w.readAudit().map((row) => row.reason);
    expect(reasons).toEqual(expect.arrayContaining(['credential_invalid', 'person_no_access', 'turn_mismatch']));
    // Nothing was read: the window hasn't started.
    expect(w.gateway.extractions.get(id)?.firstReadAt).toBeNull();
});

it('delivers once to the app, through the socio’s grant or the person’s session, with retries for 10 minutes only', async () => {
    const w = await world();
    const id = await w.approved();
    const token = w.token('repomix');
    const grant = await w.appGrant();
    const viaGrant = w.platform.actors.credentials.mintObo({
        appId: 'repomix',
        grantId: grant.id,
        requestId: 'r1',
        ttlMs: 60_000,
    });
    const first = await w.read(id, token, viaGrant);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const document = (await first.json()) as {
        format: string;
        commit: string;
        files: Array<{ path: string; content: string; encoding: string }>;
    };
    expect(document.format).toBe('socio-repo-extract/1');
    expect(document.commit).toBe(w.seed.head());
    expect(document.files.map((file) => file.path)).toEqual(['src/index.ts']);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    expect((await w.read(id, token, w.personObo('alice'))).status).toBe(200);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect((await w.read(id, token, w.personObo('alice'))).status).toBe(410);
    // Audited per read: counts only, never names or contents.
    const rows = w.readAudit();
    expect(rows.filter((row) => row.decision === 'allow')).toHaveLength(2);
    expect(rows.find((row) => row.reason === 'read_window_over')?.status).toBe('410');
    const text = JSON.stringify(rows);
    expect(text).not.toContain('src/index.ts');
    expect(text).not.toContain('answer');
});

it('re-checks at delivery: an app that stopped accepting, or the feature switched off, reads nothing', async () => {
    const w = await world();
    const id = await w.approved();
    const token = w.token('repomix');
    // A new live version without `accepts`.
    w.manifests.set('repomix', manifestOf(false));
    expect((await w.read(id, token, w.personObo('alice'))).status).toBe(403);
    w.manifests.set('repomix', manifestOf(true));
    // The flag off for alice.
    const enabled = w.platform.flags.enabled.bind(w.platform.flags);
    vi.spyOn(w.platform.flags, 'enabled').mockImplementation(
        (key, ...rest) => key !== 'repo-extraction' && enabled(key, ...rest),
    );
    expect((await w.read(id, token, w.personObo('alice'))).status).toBe(403);
    const reasons = w.readAudit().map((row) => row.reason);
    expect(reasons).toEqual(expect.arrayContaining(['app_ineligible', 'feature_off']));
    expect(w.gateway.extractions.get(id)?.firstReadAt).toBeNull();
});

it('a revoked grant reads nothing, and an unapproved extraction never reaches an app', async () => {
    const w = await world();
    const token = w.token('repomix');
    // Asked, not approved: not ready.
    const [tool] = extractTools(gatewaySourcesOf(w.platform), {
        dot: w.workspace.dot(w.socio.id)!,
        userId: 'alice',
        threadId: w.chat.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    }) as unknown as Array<{
        execute: (input: unknown) => Promise<Record<string, unknown>>;
    }>;
    const pending = await tool.execute({
        repository: 'acme/app',
        ref: 'main',
        paths: ['src/'],
        app: 'repomix',
        task: 'Pack',
    });
    expect((await w.read(String(pending.extraction_id), token, w.personObo('alice'))).status).toBe(404);
    const id = await w.approved();
    const grant = await w.appGrant();
    const viaGrant = w.platform.actors.credentials.mintObo({
        appId: 'repomix',
        grantId: grant.id,
        requestId: 'r2',
        ttlMs: 60_000,
    });
    await w.platform.actors.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    expect((await w.read(id, token, viaGrant)).status).toBe(403);
});

it('the SDK reads an extraction with the app’s token and the principal’s obo, and refuses for plugins', async () => {
    const w = await world();
    const id = await w.approved();
    const token = w.token('repomix');
    const obo = w.personObo('alice');
    const sdk = socioApp({
        appId: 'repomix',
        apiUrl: 'http://company-brain-app:4310/api',
        dataToken: () => token,
        fetch: async (url, init) => w.http.request(String(url), init),
    });
    const principal = {
        person: 'p',
        access: 'owner' as const,
        obo,
        sessionId: 's',
        version: 1,
    };
    const read = await sdk.extraction(principal, id);
    expect(read.ok).toBe(true);
    if (read.ok) {
        expect(read.extraction.files[0]?.path).toBe('src/index.ts');
    }
    await expect(sdk.extraction(principal, 'not-an-id')).rejects.toThrow();
    const plugin = socioApp({ appId: 'plugin:packer', apiUrl: 'http://x/api' });
    await expect(plugin.extraction(principal, id)).rejects.toThrow(/mini apps only/);
});

it('reads nothing while a live runtime enforces an older actor-access contract', async () => {
    const w = await world();
    const id = await w.approved();
    vi.spyOn(w.platform.actors, 'issuable').mockReturnValue(false);
    const answer = await w.read(id, w.token('repomix'), w.personObo('alice'));
    expect(answer.status).toBe(403);
    expect(w.gateway.extractions.get(id)?.firstReadAt).toBeNull();
});
