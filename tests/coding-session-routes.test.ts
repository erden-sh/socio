import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { diagnosticsToken } from '../src/coding-egress/proxy.js';
import { egressDiagnosticsToken } from '../src/server/coding/egress.js';
import { changedPaths, readOpenCode } from '../src/server/coding/opencode.js';
import { socioSlug } from '../src/server/coding/sessions.js';

import { REPO, SUPERVISOR_TOKEN, codingWorld, eventually, type CodingWorldOptions } from './support/coding-fixture.js';

// CB-239: a person's own session card (`/api/gateway/sessions`), and the
// pure pieces: OpenCode's output read as untrusted text, the branch's socio
// segment, the diagnostics token the egress proxy expects.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function setup(options: CodingWorldOptions = {}) {
    const world = await codingWorld(options);
    cleanup.push(() => world.close());
    vi.spyOn(world.turns, 'turnOutcome').mockResolvedValue({
        text: '',
    } as never);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
        const id = c.req.header('x-test-user') ?? 'alice';
        c.set('user', {
            id,
            name: 'Test',
            role: id === 'olga' ? 'admin' : 'member',
        } as never);
        await next();
    });
    app.route('/gateway', world.routes());
    const get = (path: string, user = 'alice') => app.request(`/gateway${path}`, { headers: { 'x-test-user': user } });
    const post = (path: string, body: unknown, user = 'alice') =>
        app.request(`/gateway${path}`, {
            method: 'POST',
            headers: { 'x-test-user': user, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    const put = (path: string, body: unknown, user = 'olga') =>
        app.request(`/gateway${path}`, {
            method: 'PUT',
            headers: { 'x-test-user': user, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    return { ...world, get, post, put };
}

it('shows a session only to its own person; anyone else gets the same 404 as a missing one', async () => {
    const world = await setup();
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    const own = await world.get(`/sessions/${session!.id}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
        id: session!.id,
        repository: REPO,
        branch: session!.branch,
        model: 'orion',
        modelLabel: 'Homelab (qwen38)',
        state: 'ready',
        tokens: { used: 0, budget: 2_000_000 },
        pullRequest: null,
    });
    const bob = await world.get(`/sessions/${session!.id}`, 'bob');
    const olga = await world.get(`/sessions/${session!.id}`, 'olga');
    const missing = await world.get('/sessions/nothing-here');
    for (const response of [bob, olga, missing]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'No such session.' });
    }
    expect(await (await world.get('/sessions', 'bob')).json()).toEqual({
        sessions: [],
    });
    const listed = (await (await world.get(`/sessions?thread=${encodeURIComponent(session!.threadId)}`)).json()) as {
        sessions: Array<{ id: string }>;
    };
    expect(listed.sessions.map((item) => item.id)).toEqual([session!.id]);
    expect(
        (
            (await (await world.get('/sessions?thread=other')).json()) as {
                sessions: unknown[];
            }
        ).sessions,
    ).toEqual([]);
});

it('answers 404 while the flag is off', async () => {
    const world = await setup({ flags: { 'socio-actor-access': true } });
    expect((await world.get('/sessions')).status).toBe(404);
    expect((await world.get('/sessions/x')).status).toBe(404);
});

it('reads OpenCode’s output tolerantly, as inert, redacted text', () => {
    const token = `cbgw_${'Z'.repeat(43)}`;
    const out = readOpenCode(
        [
            'not json at all',
            '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"first"}}',
            '{broken json',
            `{"type":"tool_use","part":{"tool":"bash","state":{"status":"completed","title":"echo ${token}"}}}`,
            '{"type":"error","error":{"message":"rate limited"}}',
            `{"type":"text","sessionID":"ses_2","part":{"type":"text","text":"final \\u202e answer ${token}"}}`,
            '{"type":"text","sessionID":"../../etc","part":{"type":"text","text":""}}',
        ].join('\n'),
    );
    expect(out.sessionId).toBe('ses_2');
    expect(out.errored).toBe(true);
    expect(out.summary).toBe('final [U+202E] answer [redacted]');
    expect(out.progress.join('\n')).not.toContain(token);
    expect(out.progress).toContain('bash: echo [redacted]');
    expect(out.progress).toContain('error: rate limited');
    expect(out.progress.length).toBeLessThanOrEqual(12);
    // A huge output keeps only its tail.
    const big = readOpenCode('x'.repeat(2_000_000));
    expect(big.progress.length).toBeLessThanOrEqual(12);
});

it('reads changed paths from name-status lines only', () => {
    expect(changedPaths('M\tsrc/a.ts\nR100\told.ts\tnew.ts\nwarning: junk\nD\tgone.md\n')).toEqual([
        'src/a.ts',
        'new.ts',
        'gone.md',
    ]);
});

it('names the branch segment from the socio, plain and short', () => {
    expect(socioSlug('Rulo')).toBe('rulo');
    expect(socioSlug('Señor Código!!')).toBe('senor-codigo');
    expect(socioSlug('../../main')).toBe('main');
    expect(socioSlug('🙂')).toBe('socio');
    expect(socioSlug('a'.repeat(80))).toHaveLength(24);
});

it('asks the proxy’s diagnostics with the token the egress proxy expects', () => {
    expect(egressDiagnosticsToken('some-egress-secret-0123456789')).toBe(
        diagnosticsToken('some-egress-secret-0123456789'),
    );
});

it('lets only admins see and change the sandbox settings, 404 while the flag is off', async () => {
    const world = await setup();
    expect((await world.get('/sandbox', 'alice')).status).toBe(403);
    expect((await world.put('/sandbox', { retentionDays: 3 }, 'alice')).status).toBe(403);
    const off = await setup({ flags: { 'socio-actor-access': true } });
    expect((await off.get('/sandbox', 'olga')).status).toBe(404);
    expect((await off.put('/sandbox', { retentionDays: 3 })).status).toBe(404);
});

it('lists the coding agents and their terms records to admins only, 404 while the flag is off (CB-326)', async () => {
    const world = await setup();
    expect((await world.get('/harnesses', 'alice')).status).toBe(403);
    const listed = (await (await world.get('/harnesses', 'olga')).json()) as {
        harnesses: Array<{ id: string; route: string; default: boolean; disabled: boolean; terms: { url: string } }>;
    };
    expect(listed.harnesses.map((harness) => [harness.id, harness.route, harness.default, harness.disabled])).toEqual([
        ['opencode', 'gateway', true, false],
        ['codex', 'gateway', false, false],
        ['claude-code', 'gateway', false, false],
        ['gemini-cli', 'gateway', false, false],
        ['grok', 'gateway', false, false],
    ]);
    expect(listed.harnesses.every((harness) => harness.terms.url.startsWith('https://'))).toBe(true);
    const off = await setup({ flags: { 'socio-actor-access': true } });
    expect((await off.get('/harnesses', 'olga')).status).toBe(404);
});
it('keeps the registries and workspace retention over their environment defaults, audited', async () => {
    const world = await setup();
    world.service.configure({
        registries: 'npm=registry.npmjs.org',
        retentionDays: 21,
    });
    expect(await (await world.get('/sandbox', 'olga')).json()).toEqual({
        registries: 'npm=registry.npmjs.org',
        registriesDefault: 'npm=registry.npmjs.org',
        registriesSaved: false,
        retentionDays: 21,
        retentionDaysDefault: 21,
        retentionDaysSaved: false,
    });
    // Refused: unknown fields, bad entries, internal hosts, out of range, empty.
    for (const body of [
        { other: 1 },
        { registries: 'not a registry' },
        { registries: 'evil=metadata.internal' },
        { registries: 'npm=registry.npmjs.org npm=registry.yarnpkg.com' },
        { registries: '   ' },
        { retentionDays: 0 },
        { retentionDays: 366 },
        { retentionDays: 1.5 },
        [],
    ]) {
        const response = await world.put('/sandbox', body);
        expect(response.status).toBe(400);
    }
    const saved = await world.put('/sandbox', {
        registries: 'npm=registry.npmjs.org\ncrates=index.crates.io',
        retentionDays: 3,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
        registries: 'npm=registry.npmjs.org crates=index.crates.io',
        registriesSaved: true,
        retentionDays: 3,
        retentionDaysSaved: true,
    });
    expect(world.service.settings.allowList()).toEqual(['npm=registry.npmjs.org', 'crates=index.crates.io']);
    const rows = world.platform.actors.audit
        .list({}, 500)
        .filter((row) => row.phase === 'setting' && row.action?.startsWith('sandbox.'));
    expect(rows.map((row) => [row.actorBy, row.action, row.detail]).sort()).toEqual([
        [
            'olga',
            'sandbox.registries',
            JSON.stringify({
                old: null,
                new: 'npm=registry.npmjs.org crates=index.crates.io',
            }),
        ],
        ['olga', 'sandbox.retentionDays', JSON.stringify({ old: null, new: 3 })],
    ]);
    // Back to the default.
    const reset = await world.put('/sandbox', { retentionDays: null });
    expect(await reset.json()).toMatchObject({
        retentionDays: 21,
        retentionDaysSaved: false,
        registriesSaved: true,
    });
});

it('serves a session’s thread events to its own person, paged by ordinal; anyone else 404 (CB-326 step 4)', async () => {
    const world = await setup({ hostMode: true });
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    // The host started; drive a turn so events drain into coding_thread_events.
    await eventually(() => world.supervisor.hosts.has(session!.id));
    await fetch(`${world.supervisor.url}/sandboxes/${session!.id}/host/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SUPERVISOR_TOKEN}` },
        body: JSON.stringify({ op: 'turn_start', payload: { message: 'do it' } }),
    });
    await eventually(async () => {
        const rows = world.connection
            .prepare('SELECT kind FROM coding_thread_events WHERE sessionId=?')
            .all(session!.id) as Array<{ kind: string }>;
        return rows.some((row) => row.kind === 'turn.terminal');
    });

    const own = await world.get(`/sessions/${session!.id}/events`);
    expect(own.status).toBe(200);
    const page = (await own.json()) as {
        events: Array<{ kind: string; ordinal: number; payload: string }>;
        next: number | null;
    };
    expect(page.events.length).toBeGreaterThan(0);
    const kinds = page.events.map((event) => event.kind);
    expect(kinds).toContain('provider_turn.updated');
    expect(kinds).toContain('turn.terminal');
    // Ordinals ascend; the page’s `next` is the last ordinal.
    const ordinals = page.events.map((event) => event.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(page.next).toBe(page.events.at(-1)!.ordinal);

    // A second person and a missing session read 404, as the session card does.
    expect((await world.get(`/sessions/${session!.id}/events`, 'bob')).status).toBe(404);
    expect((await world.get('/sessions/nothing/events')).status).toBe(404);
});

it('rejects bad host controls: 404 for another person, 400 for an unknown op, 409 for a malformed steer (CB-326 step 4)', async () => {
    const world = await setup({ hostMode: true });
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    // Anyone else’s control reads 404 (the session is not theirs).
    expect((await world.post(`/sessions/${session!.id}/control`, { op: 'interrupt' }, 'bob')).status).toBe(404);
    // An unknown op is 400.
    expect((await world.post(`/sessions/${session!.id}/control`, { op: 'nope' })).status).toBe(400);
    // A steer without a message is 409 (request_malformed).
    expect((await world.post(`/sessions/${session!.id}/control`, { op: 'steer' })).status).toBe(409);
});

/** Inserts one gateway_exchanges row for a session, for the viewer/export tests. */
function logExchange(world: Awaited<ReturnType<typeof setup>>, sessionId: string, seq: number) {
    world.connection
        .prepare(
            `INSERT INTO gateway_exchanges(
          id, usageId, sessionId, holderId, requesterId, harness, api, route,
          model, upstreamKind, requestAt, responseAt, status, bodyPath,
          requestBytes, responseBytes, requestHash, responseHash,
          deletedAt, deletedBy, deletedWith)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            `ex-${seq}`,
            seq,
            sessionId,
            'alice',
            null,
            'codex',
            'responses',
            '/v1/responses',
            'orion',
            'gateway',
            seq * 1000,
            seq * 1000 + 50,
            '200',
            null,
            100,
            200,
            'rqhash',
            'rshash',
            null,
            null,
            null,
        );
}

it('serves a session’s gateway exchanges to its holder, paged; anyone else 404 (CB-326 step 5)', async () => {
    const world = await setup();
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    logExchange(world, session!.id, 1);
    logExchange(world, session!.id, 2);

    const own = await world.get(`/sessions/${session!.id}/exchanges`);
    expect(own.status).toBe(200);
    const page = (await own.json()) as {
        exchanges: Array<{ api: string; requestAt: number; status: string }>;
        next: number | null;
    };
    expect(page.exchanges.length).toBe(2);
    expect(page.exchanges.map((e) => e.requestAt)).toEqual([1000, 2000]);
    expect(page.next).toBe(2000);

    // Paging: after=1000 returns only the second.
    const next = (await (await world.get(`/sessions/${session!.id}/exchanges?after=1000`)).json()) as {
        exchanges: Array<{ requestAt: number }>;
    };
    expect(next.exchanges.map((e) => e.requestAt)).toEqual([2000]);

    // Another person and a missing session read 404.
    expect((await world.get(`/sessions/${session!.id}/exchanges`, 'bob')).status).toBe(404);
    expect((await world.get('/sessions/nothing/exchanges')).status).toBe(404);
});

it('exports a session’s exchanges as JSON Lines to the holder; anyone else 404 (CB-326 step 5)', async () => {
    const world = await setup();
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    logExchange(world, session!.id, 1);
    logExchange(world, session!.id, 2);

    const exportResp = await world.get(`/sessions/${session!.id}/exchanges/export`);
    expect(exportResp.status).toBe(200);
    expect(exportResp.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await exportResp.text();
    const lines = text.split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!) as { api: string; route: string; requestHash: string };
    expect(first.api).toBe('responses');
    expect(first.route).toBe('/v1/responses');
    expect(first.requestHash).toBe('rqhash');

    // Anyone else can’t export.
    expect((await world.get(`/sessions/${session!.id}/exchanges/export`, 'bob')).status).toBe(404);
});

it('lets an admin read and export a session’s exchanges (CB-326 step 5)', async () => {
    const world = await setup();
    const { session } = await world.started();
    await eventually(() => world.service.sessions.get(session!.id)!.state === 'ready');
    logExchange(world, session!.id, 1);

    // olga is an admin in this test’s user stub.
    const adminPage = await world.get(`/sessions/${session!.id}/exchanges`, 'olga');
    expect(adminPage.status).toBe(200);
    const adminExport = await world.get(`/sessions/${session!.id}/exchanges/export`, 'olga');
    expect(adminExport.status).toBe(200);
});
