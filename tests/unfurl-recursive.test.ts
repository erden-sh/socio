import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';
import { z } from 'zod';

import type { DotTurn } from '@socio/foundation/turns/turn';

import { validateUrl } from '../src/net/public-address.js';
import { webStoreOn } from '../src/server/composition/integration-stores.js';
import { WorkspacePageTools } from '../src/server/pages/page-tools.js';
import {
    RECURSIVE_APPROVAL_FLOOR,
    RECURSIVE_CAP_DEFAULT,
    RECURSIVE_CAP_MAX,
    clearRecursiveHistory,
    unfurlRecursiveTools,
} from '../src/server/skills/unfurl-recursive.js';
import { WebReads, webSettingsFromEnv, type Resolver } from '../src/server/web/web-reads.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'secret-0123456789abcdef-xyz';
const USERS = [
    { id: 'ada', name: 'Ada', role: 'admin' as const },
    { id: 'ben', name: 'Ben', role: 'member' as const },
];

const resolve: Resolver = async (url) =>
    url.hostname.endsWith('.example') ? { address: '127.0.0.1', family: 4 } : validateUrl(url.href);

let server: Server;
let port: number;
const routes = new Map<string, { type: string; body: string; status?: number }>();
const origin = (host: string) => `http://${host}:${port}`;

beforeEach(async () => {
    routes.clear();
    server = createServer((request, response) => {
        const host = (request.headers.host ?? '').split(':')[0];
        const url = request.url ?? '/';
        const route = routes.get(`${host}${url}`);
        if (!route) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('not found');
            return;
        }
        response.writeHead(route.status ?? 200, { 'Content-Type': route.type });
        response.end(route.body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
});

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    clearRecursiveHistory();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    await new Promise((done) => server.close(done));
});

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-unfurl-rec-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { workspace, platform, dispose } = await makeTestRuntime({
        config: {
            sessionSecret: SECRET,
            data: { userDataDir: dir },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const dot = workspace.dots()[0];
    const space = workspace.spaces()[0];
    workspace.bindThread('thread', dot.id, 'Links', 'ada');
    const turn = {
        dot,
        userId: 'ada',
        threadId: 'thread',
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => [],
    } as unknown as DotTurn;
    const reads = new WebReads(webStoreOn(workspace.db), webSettingsFromEnv({ APP_ORIGIN: 'https://socio.example' }), {
        resolve,
    });
    const [tool] = unfurlRecursiveTools({
        reads,
        media: platform.media,
        pages: new WorkspacePageTools(workspace),
        approvals: platform.approvals,
        turn,
        now: () => Date.parse('2026-11-02T12:00:00Z'),
    });
    const run = (args: Record<string, unknown>) =>
        tool.execute!((tool.parameters as z.ZodType).parse(args) as never) as Promise<unknown>;
    // The same socio and person, in another conversation (review round 2).
    workspace.bindThread('thread-2', dot.id, 'More links', 'ada');
    const [elsewhere] = unfurlRecursiveTools({
        reads,
        media: platform.media,
        pages: new WorkspacePageTools(workspace),
        approvals: platform.approvals,
        turn: { ...turn, threadId: 'thread-2' } as DotTurn,
        now: () => Date.parse('2026-11-02T12:00:00Z'),
    });
    const runElsewhere = (args: Record<string, unknown>) =>
        elsewhere.execute!((elsewhere.parameters as z.ZodType).parse(args) as never) as Promise<unknown>;
    return { workspace, platform, space, dot, run, runElsewhere };
}

const indexHtml = (base: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Curated links</title>
<meta property="og:title" content="Curated links">
<meta property="og:site_name" content="curate.example">
</head><body>
<main><article>
<h1>Curated links</h1>
<p>See <a href="${base}/a">first</a> and <a href="${base}/b">second</a> and <a href="${base}/c">third</a>.</p>
</article></main>
</body></html>`;

const childHtml = (title: string) => `<!doctype html>
<html lang="en"><head>
<title>${title}</title>
<meta property="og:title" content="${title}">
</head><body><main><article><h1>${title}</h1><p>Body of ${title}.</p></article></main></body></html>`;

it('unfurls a source into an index page and child pages, tagged and linked back', async () => {
    const f = await fixture();
    const base = origin('curate.example');
    routes.set(`curate.example/`, { type: 'text/html', body: indexHtml(base) });
    routes.set(`curate.example/a`, { type: 'text/html', body: childHtml('First') });
    routes.set(`curate.example/b`, { type: 'text/html', body: childHtml('Second') });
    routes.set(`curate.example/c`, { type: 'text/html', body: childHtml('Third') });

    const result = (await f.run({ url: `${base}/`, cap: 3 })) as {
        index: { id: string };
        children: Array<{ id: string; title: string }>;
        tag: string;
    };
    expect(result.index.id).toBeTruthy();
    expect(result.children).toHaveLength(3);
    expect(result.children.map((c) => c.title).sort()).toEqual(['First', 'Second', 'Third']);
    expect(result.tag).toBe('curate.example');

    // The index and each child are tagged.
    const tags = f.workspace.pages.tagsOf(f.space.id, result.index.id).map((t) => t.tag);
    expect(tags).toContain('curate.example');
    for (const child of result.children) {
        const childTags = f.workspace.pages.tagsOf(f.space.id, child.id).map((t) => t.tag);
        expect(childTags).toContain('curate.example');
    }

    // Each child links back to the index (derived_from).
    const backlinks = f.workspace.pages.linksTo(f.space.id, result.index.id);
    expect(backlinks).toHaveLength(3);
    expect(backlinks.every((l) => l.kind === 'derived_from')).toBe(true);

    // The index and children have source attribution.
    const indexPage = f.workspace.pages.get(f.space.id, result.index.id);
    expect(indexPage.sourceUrl).toBe(`${base}/`);
});

it('caps child pages at the configured cap', async () => {
    const f = await fixture();
    const base = origin('curate.example');
    routes.set(`curate.example/`, { type: 'text/html', body: indexHtml(base) });
    routes.set(`curate.example/a`, { type: 'text/html', body: childHtml('First') });
    routes.set(`curate.example/b`, { type: 'text/html', body: childHtml('Second') });
    routes.set(`curate.example/c`, { type: 'text/html', body: childHtml('Third') });

    const result = (await f.run({ url: `${base}/`, cap: 1 })) as { children: unknown[] };
    expect(result.children).toHaveLength(1);
});

it('refuses a cap above the hard ceiling at parameter parse time', async () => {
    const f = await fixture();
    // Zod's .max(RECURSIVE_CAP_MAX) rejects the call before the tool runs.
    expect(() => f.run({ url: origin('curate.example') + '/', cap: RECURSIVE_CAP_MAX + 1 })).toThrow();
});

const threeLinks = () => {
    const base = origin('curate.example');
    routes.set(`curate.example/`, { type: 'text/html', body: indexHtml(base) });
    for (const [path, title] of [
        ['a', 'A'],
        ['b', 'B'],
        ['c', 'C'],
    ] as const) {
        routes.set(`curate.example/${path}`, { type: 'text/html', body: childHtml(title) });
    }
    return base;
};

interface Pending {
    status: string;
    approval: { id: string; summary: string };
    message: string;
}

it('asks on an approval card above the threshold and imports once the person approves it (CB-492)', async () => {
    const f = await fixture();
    const base = threeLinks();
    const cap = RECURSIVE_APPROVAL_FLOOR + 1;
    const pagesBefore = f.workspace.pages.list(f.space.id).length;

    // Above the floor threshold: a structured request, never text to relay.
    const gate = (await f.run({ url: `${base}/`, cap })) as Pending;
    expect(gate.status).toBe('pending_approval');
    expect(gate.approval.summary).toBe(`Import up to ${cap} linked pages from curate.example`);
    expect(JSON.stringify(gate)).not.toMatch(/needsApproval|Approve to proceed|approved: true/);
    expect(gate.message).toMatch(/without asking them to approve in your reply/);
    // Nothing was read or saved yet.
    expect(f.workspace.pages.list(f.space.id)).toHaveLength(pagesBefore);
    const [request] = await f.platform.approvals.list('ada', { status: 'pending' });
    expect(request).toMatchObject({ id: gate.approval.id, capability: 'unfurl.recursive' });

    // Asking again while it waits: the same card, not a second one.
    const again = (await f.run({ url: `${base}/`, cap })) as Pending;
    expect(again.approval.id).toBe(gate.approval.id);
    expect(await f.platform.approvals.list('ada', { status: 'pending' })).toHaveLength(1);

    // Approved on the card: the socio carries on with the same call, and the import runs.
    expect((await f.platform.approvals.decide(gate.approval.id, 'ada', true)).status).toBe('approved');
    const result = (await f.run({ url: `${base}/`, cap })) as { children: unknown[]; cap: number };
    expect(result.children).toHaveLength(3);
    expect(result.cap).toBe(cap);
    expect((await f.platform.approvals.get(gate.approval.id, 'ada')).status).toBe('approved');

    // Each approval imports once: the same call again asks again, on a new card.
    const next = (await f.run({ url: `${base}/`, cap })) as Pending;
    expect(next.status).toBe('pending_approval');
    expect(next.approval.id).not.toBe(gate.approval.id);
});

it('uses an approval once across a restart: the use is in the approvals’ records', async () => {
    const f = await fixture();
    const base = threeLinks();
    const cap = RECURSIVE_APPROVAL_FLOOR + 1;
    const gate = (await f.run({ url: `${base}/`, cap })) as Pending;
    await f.platform.approvals.decide(gate.approval.id, 'ada', true);
    expect(((await f.run({ url: `${base}/`, cap })) as { children: unknown[] }).children).toHaveLength(3);
    // Nothing in the process remembers it: a cleared process state changes nothing.
    clearRecursiveHistory();
    const row = f.workspace.db
        .prepare('SELECT status, consumedAt FROM approval_requests WHERE id = ?')
        .get(gate.approval.id) as { status: string; consumedAt: number | null };
    expect(row.consumedAt).toEqual(expect.any(Number));
    expect(((await f.run({ url: `${base}/`, cap })) as Pending).status).toBe('pending_approval');
});

it('binds an approval to its exact import: another cap or source asks again', async () => {
    const f = await fixture();
    const base = threeLinks();
    const gate = (await f.run({ url: `${base}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as Pending;
    await f.platform.approvals.decide(gate.approval.id, 'ada', true);

    const bigger = (await f.run({ url: `${base}/`, cap: RECURSIVE_CAP_MAX })) as Pending;
    expect(bigger.status).toBe('pending_approval');
    expect(bigger.approval.summary).toBe(`Import up to ${RECURSIVE_CAP_MAX} linked pages from curate.example`);
    const other = (await f.run({ url: `${origin('other.example')}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as Pending;
    expect(other.status).toBe('pending_approval');
    // The approved one is still there for its own call.
    const result = (await f.run({ url: `${base}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as { children: unknown[] };
    expect(result.children).toHaveLength(3);
});

it('never uses an approval from another conversation, and shows each request its own card', async () => {
    const f = await fixture();
    const base = threeLinks();
    const cap = RECURSIVE_APPROVAL_FLOOR + 1;
    const here = (await f.run({ url: `${base}/`, cap })) as Pending;
    await f.platform.approvals.decide(here.approval.id, 'ada', true);

    // The same import in another chat: its own card there, not this chat's approval.
    const there = (await f.runElsewhere({ url: `${base}/`, cap })) as Pending;
    expect(there.status).toBe('pending_approval');
    expect(there.approval.id).not.toBe(here.approval.id);
    expect((await f.platform.approvals.get(there.approval.id, 'ada')).threadId).toBe('thread-2');
    // This chat's approval is still there for its own call.
    expect(((await f.run({ url: `${base}/`, cap })) as { children: unknown[] }).children).toHaveLength(3);

    // Two waiting requests that differ by tag: each call gets its own card.
    const first = (await f.run({ url: `${base}/`, cap, tag: 'reading' })) as Pending;
    const second = (await f.run({ url: `${base}/`, cap, tag: 'later' })) as Pending;
    expect(second.approval.id).not.toBe(first.approval.id);
    expect(((await f.run({ url: `${base}/`, cap, tag: 'later' })) as Pending).approval.id).toBe(second.approval.id);
    expect(((await f.run({ url: `${base}/`, cap, tag: 'reading' })) as Pending).approval.id).toBe(first.approval.id);
});

it('reports a denied import cleanly and runs nothing (CB-492)', async () => {
    const f = await fixture();
    const base = threeLinks();
    const pagesBefore = f.workspace.pages.list(f.space.id).length;
    const gate = (await f.run({ url: `${base}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as Pending;
    expect((await f.platform.approvals.decide(gate.approval.id, 'ada', false)).status).toBe('denied');
    expect(f.workspace.pages.list(f.space.id)).toHaveLength(pagesBefore);
    // Calling again doesn't run it: a new card.
    const after = (await f.run({ url: `${base}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as Pending;
    expect(after.status).toBe('pending_approval');
    expect(after.approval.id).not.toBe(gate.approval.id);
    expect(f.workspace.pages.list(f.space.id)).toHaveLength(pagesBefore);
});

it('imports at once under a bypass policy, with no card, and uses that approval', async () => {
    const f = await fixture();
    const base = threeLinks();
    await f.platform.approvals.setPolicy('ada', f.dot.id, 'unfurl.recursive', 'bypass');
    const result = (await f.run({ url: `${base}/`, cap: RECURSIVE_APPROVAL_FLOOR + 1 })) as { children: unknown[] };
    expect(result.children).toHaveLength(3);
    const rows = f.workspace.db
        .prepare("SELECT consumedAt FROM approval_requests WHERE capability = 'unfurl.recursive'")
        .all() as Array<{ consumedAt: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].consumedAt).toEqual(expect.any(Number));
});

it('keeps a long source URL whole: the approval needs no id in the note', async () => {
    const f = await fixture();
    const base = origin('curate.example');
    const path = `/${'a'.repeat(240)}`;
    routes.set(`curate.example${path}`, { type: 'text/html', body: indexHtml(base) });
    for (const [p, title] of [
        ['a', 'A'],
        ['b', 'B'],
        ['c', 'C'],
    ] as const) {
        routes.set(`curate.example/${p}`, { type: 'text/html', body: childHtml(title) });
    }
    const cap = RECURSIVE_APPROVAL_FLOOR + 1;
    const gate = (await f.run({ url: `${base}${path}`, cap })) as Pending;
    expect(gate.approval.summary).toBe(`Import up to ${cap} linked pages from curate.example`);
    await f.platform.approvals.decide(gate.approval.id, 'ada', true);
    const result = (await f.run({ url: `${base}${path}`, cap })) as { children: unknown[] };
    expect(result.children).toHaveLength(3);
});

it('skips child links that cannot be read', async () => {
    const f = await fixture();
    const base = origin('curate.example');
    routes.set(`curate.example/`, { type: 'text/html', body: indexHtml(base) });
    routes.set(`curate.example/a`, { type: 'text/html', body: childHtml('First') });
    // /b and /c are 404.
    const result = (await f.run({ url: `${base}/`, cap: 3 })) as {
        children: unknown[];
        skipped: Array<{ url: string; reason: string }>;
    };
    expect(result.children).toHaveLength(1);
    expect(result.skipped.length).toBeGreaterThanOrEqual(2);
});

it('respects the default cap', async () => {
    expect(RECURSIVE_CAP_DEFAULT).toBe(10);
});
