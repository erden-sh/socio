import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';

import { createAdaptorServer } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { pageContentSecurityPolicy } from '@socio/foundation/http/security-headers';
import { securityHeaders } from '@socio/foundation/http/security-headers';
import { MANIFEST_PATH } from '@socio/foundation/web/guard';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../../src/server/auth/mock.js';
import { requestUserResolver } from '../../src/server/auth/request-user.js';
import { createSessionValue, SESSION_COOKIE } from '../../src/server/auth/session.js';
import { buildDocsCatalog } from '../../src/server/docs/catalog.js';
import { loadI18nCatalog } from '../../src/server/i18n/catalog.js';
import { developmentWeb } from '../../src/server/web/dev.js';
import { mountWeb } from '../../src/server/web/mount.js';
import { webServices } from '../../src/server/web/services.js';
import { testPageViews } from '../helpers/page-views.js';
import { makeTestRuntime } from '../helpers/test-runtime.js';

// The real pages, rendered by the server as `pnpm run dev` does: Vite in
// middleware mode with the React Router plugin, inside the Hono app, on a
// loopback port, with mock auth's admin alice and member bob. The first
// render compiles the app, so it takes a while.

// Canaries: none of them may ever reach a page.
/** A page's markup without its scripts (the loader data, the inlined dictionaries). */
const markup = (html: string) => html.replace(/<script\b[\s\S]*?<\/script>/g, '');

const SESSION_SECRET = 'canary-session-secret-5f1e2d';
const SECRETS = {
    apiKey: 'canary-model-key-9a8b7c',
    sessionSecret: 'canary-platform-secret-3c4d5e',
    voiceKey: 'canary-voice-key-6f7a8b',
    browserSecret: 'canary-browser-secret-1a2b3c',
};
const USERS: User[] = [
    { id: 'alice', name: 'Alice Admin', role: 'admin' },
    { id: 'bob', name: 'Bob Member', role: 'member' },
    { id: 'olga', name: 'Olga Second', role: 'admin' },
];
const config = {
    mode: 'live' as const,
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: SECRETS.apiKey,
    model: 'fake-model',
};
const auth = {
    provider: new MockAuthProvider(USERS, SESSION_SECRET),
    secureCookies: false,
};
const { store, workspace, platform, app, dispose } = await makeTestRuntime({
    config: {
        baseUrl: 'http://127.0.0.1:1/v1',
        model: 'fake-model',
        runtimeUrl: 'http://127.0.0.1:1/api/copilotkit',
        ...SECRETS,
    },
    app: { auth, config },
});
// What each user has, live and deleted (CB-64).
const dot = workspace.dots()[0]!;
for (const user of USERS) {
    workspace.recordUser(user);
}
workspace.bindThread('alice-thread', dot.id, 'Alice private plan', 'alice');
await store.memoryItems.add({
    text: 'Alice keeps the launch date quiet.',
    userId: 'alice',
    source: 'person',
});
await store.createTask('Alice researches the merger', null, 'alice');
workspace.bindThread('bob-thread', dot.id, 'Bob weekly notes', 'bob');
await store.memoryItems.add({
    text: 'Bob likes short answers.',
    userId: 'bob',
    source: 'person',
});
const gone = workspace.bindThread('bob-gone', dot.id, 'Bob old draft', 'bob');
const goneTask = await store.createTask('Bob tracks the old vendor', 3600, 'bob');
await workspace.bindTask(goneTask.id, gone.id);
await platform.deleteConversation(gone.id, 'bob');
const goneMemory = await store.memoryItems.add({
    text: 'Bob forgot this preference.',
    userId: 'bob',
    source: 'person',
});
await store.memoryItems.forget(goneMemory.id, 'bob');
// Issues are the team's: everyone signed in reads them (CB-1 is alice's).
const issue = await platform.board.issues.create(
    { title: 'Alice files the import bug', body: 'The importer drops rows.' },
    'alice',
);
await platform.board.issues.addComment(issue.number, 'Bob can reproduce it.', 'bob');
const goneComment = await platform.board.issues.addComment(issue.number, 'Bob withdrew this comment.', 'bob');
await platform.board.issues.deleteComment(issue.number, goneComment.id, 'bob');
const goneIssue = await platform.board.issues.create({ title: 'Alice deleted this issue' }, 'alice');
await platform.board.issues.remove(goneIssue.number, 'alice');
// Spaces are the team's too. The page loader carries no bodies: the
// canary sits past the card's excerpt.
const space = workspace.spaces()[0]!;
const memo = await workspace.pages.create(
    space.id,
    {
        title: 'Alice drafts the launch memo',
        content: `Launch memo opening line. ${'Filler words for the body. '.repeat(12)}BODY-CANARY-7c1d`,
        parentId: null,
    },
    null,
    'alice',
);
const gonePage = await workspace.pages.create(
    space.id,
    { title: 'Bob scraps this page', content: 'Old.', parentId: null },
    null,
    'bob',
);
await workspace.pages.delete(space.id, gonePage.id, { by: 'bob' });
// Approvals are each user's own: nobody, admins included, sees another's.
const asking = workspace.db.prepare(
    `INSERT INTO approval_requests(id, userId, dotId, capability, summary, details, payload, threadId, status, createdAt, expiresAt)
   VALUES (?, ?, ?, 'email.send', ?, '[]', '{}', ?, 'pending', ?, ?)`,
);
const asked = Date.now();
asking.run('alice-ask', 'alice', dot.id, 'Alice asks to email the board', 'alice-thread', asked, asked + 86_400_000);
asking.run('bob-ask', 'bob', dot.id, 'Bob asks to post the notes', 'bob-thread', asked, asked + 86_400_000);
// Agent runs (admins' Runs page): one on a deleted conversation, and event
// payloads that never leave the server.
const runs = (platform.runner as unknown as { db: DatabaseSync }).db.prepare(
    "INSERT INTO agent_runs(threadId, runId, status, events, startedAt, finishedAt, source) VALUES (?, ?, ?, ?, ?, ?, 'web')",
);
for (const [threadId, status] of [
    ['alice-thread', 'failed'],
    ['bob-thread', 'finished'],
    ['bob-gone', 'finished'],
] as const) {
    runs.run(
        threadId,
        `run-${threadId}`,
        status,
        JSON.stringify([
            { type: 'TEXT_MESSAGE_CONTENT', delta: 'event-payload-canary' },
            ...(status === 'failed' ? [{ type: 'RUN_ERROR', message: 'The model went away.' }] : []),
        ]),
        asked,
        asked + 1000,
    );
}
// Datasets: each user's own, unless shared with a Space.
const aliceSet = platform.data.createDataset('alice', {
    name: 'Alice salary bands',
});
const bobSet = platform.data.createDataset('bob', { name: 'Bob reading list' });
const goneSet = platform.data.createDataset('bob', { name: 'Bob old survey' });
platform.data.deleteDataset('bob', goneSet.id);
// Schedules: each user's own (bob's deleted one went with its conversation).
for (const [userId, title] of [
    ['alice', 'Alice weekly board digest'],
    ['bob', 'Bob morning brief'],
] as const) {
    await store.createSchedule({
        userId,
        title,
        prompt: `${title}, please.`,
        cadence: '0 8 * * 1',
        timezone: 'UTC',
        dotId: dot.id,
        kind: 'turn',
    });
}
// Learning (admins review proposals; members see published skills): a
// container with evidence from alice's conversation and one proposal.
workspace.db
    .prepare(
        'INSERT INTO learning_evidence(threadId, containerId, dotId, ownerId, eligible, finishedAt) VALUES (?, ?, ?, ?, 1, ?)',
    )
    .run('alice-thread', 'support', dot.id, 'alice', asked);
workspace.db
    .prepare(
        "INSERT INTO learning_proposals(id, containerId, runId, name, description, skillMd, rationale, evidenceThreadIds, status, createdAt) VALUES ('proposal-1', 'support', 'run-1', 'triage-refunds', 'Sorts refund requests.', 'SKILL-BODY-CANARY', 'Seen twice.', '[\"alice-thread\"]', 'pending', ?)",
    )
    .run(asked);
// The help center: a public guide and an admin-only one (CB-264).
const docs = await buildDocsCatalog([
    {
        audience: 'user',
        name: 'index.md',
        markdown: '---\ntitle: Help center\ndescription: Guides\n---\n\nWelcome.',
    },
    {
        audience: 'admin',
        name: 'index.md',
        markdown: '---\ntitle: Admin guide canary\ndescription: Admins\n---\n\nADMIN-DOC-CANARY',
    },
]);
const DELETED = [
    'Bob old draft',
    'Bob tracks the old vendor',
    'Bob forgot this preference',
    'Bob withdrew this comment',
    'Alice deleted this issue',
    'Bob scraps this page',
    'Bob-old-scan',
    'Bob old survey',
];

let server: Server;
let base = '';
let closeVite = async () => {};
beforeAll(async () => {
    // Media: each user's own files; a deleted one.
    const file = (userId: string, path: string) =>
        platform.data.putFile(
            { kind: 'user', userId },
            path,
            new TextEncoder().encode('file-body-canary'),
            'text/markdown',
        );
    await file('alice', 'Alice-board-deck.md');
    await file('bob', 'Bob-trip-receipts.md');
    await file('bob', 'Bob-old-scan.md');
    await platform.data.deleteFile('bob', 'Bob-old-scan.md');
    app.use('*', securityHeaders);
    app.get('/healthz', (c) => c.json({ ok: true }));
    // Its own Vite cache: pnpm run dev's would be rebuilt after every run.
    const web = await developmentWeb(undefined, 'node_modules/.vite-ssr-test', { watch: false });
    closeVite = web.close;
    mountWeb(app, {
        ...web,
        services: webServices(
            {
                store,
                config,
                platform,
                views: testPageViews(platform),
                auth,
                docs,
                // The dictionaries from source, as the server builds them without dist/i18n.
                i18n: {
                    catalog: loadI18nCatalog({
                        buildDir: 'node_modules/.no-i18n-build',
                        sourceDir: 'packages/i18n/locales',
                        release: 'test',
                    }),
                    preference: (userId) => workspace.preferences(userId).locale,
                },
            },
            requestUserResolver(auth, platform),
        ),
    });
    server = createAdaptorServer({ fetch: app.fetch }) as Server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closeVite();
    await dispose();
});

const cookie = (userId: string) => `${SESSION_COOKIE}=${createSessionValue(SESSION_SECRET, userId)}`;

/**
 * A page's HTML (without the empty comments React puts between text
 * parts), its nonce (from the CSP header) and its scripts.
 */
async function document(path: string, as?: 'alice' | 'bob' | 'olga', headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, {
        headers: { ...headers, ...(as ? { cookie: [cookie(as), headers.cookie].filter(Boolean).join('; ') } : {}) },
        redirect: 'manual',
    });
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? '';
    const html = (await response.text()).replaceAll('<!-- -->', '');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(([, attributes, body]) => ({
        attributes: attributes!,
        body: body!,
    }));
    return { response, csp, nonce, html, scripts };
}

/** Nothing secret and nothing deleted, in the markup or the data. */
function expectNoSecretsOrDeleted(html: string) {
    for (const secret of [SESSION_SECRET, ...Object.values(SECRETS)]) {
        expect(html).not.toContain(secret);
    }
    for (const deleted of DELETED) {
        expect(html).not.toContain(deleted);
    }
    expect(html).not.toContain('bob-gone');
}

it('renders the signed-in shell on the server, uncached', async () => {
    const { response, csp, nonce, html } = await document('/', 'alice');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(csp).toBe(pageContentSecurityPolicy(nonce));
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en-US" dir="ltr"/);
    expect(html).toContain('<title>Socio</title>');
    expect(html).toContain('<div id="root">');
    // The sidebar, the header and the launcher, for alice.
    expect(html).toContain('data-slot="sidebar"');
    expect(html).toContain('data-slot="app-header"');
    expect(html).toContain('aria-label="Account: Alice');
    expect(html).toContain('Alice private plan');
    expect(html).toContain('data-module="runs"');
    expect(html).toContain('href="/runs"');
    expect(html).not.toContain('Finding your dots…');
    expectNoSecretsOrDeleted(html);
    // HEAD: the same headers, no body.
    const head = await fetch(`${base}/`, {
        method: 'HEAD',
        headers: { cookie: cookie('alice') },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toMatch(/^text\/html/);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(await head.text()).toBe('');
}, 60_000);

it('gives a member only their own data: nothing of the admin’s, no secrets, nothing deleted', async () => {
    for (const path of ['/', '/memories', '/activity']) {
        const { response, html } = await document(path, 'bob');
        expect(response.status, path).toBe(200);
        // The markup and the serialized loader data (window.__reactRouterContext).
        expect(html, path).toContain('Bob weekly notes');
        expect(html, path).not.toContain('Alice private plan');
        expect(html, path).not.toContain('alice-thread');
        expect(html, path).not.toContain('Alice keeps the launch date quiet');
        expect(html, path).not.toContain('Alice researches the merger');
        // The data key and backups are for admins (CB-62, CB-63).
        expect(html, path).not.toContain('dataKey');
        // No admin items: Dots are for admins. Runs is everyone's (CB-128).
        expect(html, path).not.toContain('href="/admin/dots"');
        expect(html, path).toContain('href="/runs"');
        expectNoSecretsOrDeleted(html);
    }
    const home = await document('/', 'bob');
    expect(home.html).toContain('aria-label="Account: Bob');
    const memories = await document('/memories', 'bob');
    expect(memories.html).toContain('Bob likes short answers.');
    // The admin's page data has the admin setup; the member's never does.
    expect((await document('/', 'alice')).html).toContain('dataKey');
}, 60_000);

it('carries an open issue in the page, with its live comments only', async () => {
    for (const as of ['alice', 'bob'] as const) {
        const { response, html } = await document('/issues/CB-1', as);
        expect(response.status, as).toBe(200);
        // The loader's data, in the page: the issue and its live comment.
        expect(html, as).toContain('Alice files the import bug');
        expect(html, as).toContain('The importer drops rows.');
        expect(html, as).toContain('Bob can reproduce it.');
        expectNoSecretsOrDeleted(html);
    }
    // Bob's own page holds nothing of alice's own (her conversations).
    const bob = await document('/issues/CB-1', 'bob');
    expect(bob.html).not.toContain('Alice private plan');
    expect(bob.html).not.toContain('Alice keeps the launch date quiet');
    // A deleted issue is no issue: no data, the dialog asks and gets a 404.
    const gone = await document(`/issues/CB-${goneIssue.number}`, 'bob');
    expect(gone.response.status).toBe(200);
    expectNoSecretsOrDeleted(gone.html);
}, 60_000);

it('renders a Space’s library on the server, without page bodies', async () => {
    for (const as of ['alice', 'bob'] as const) {
        const library = await document(`/spaces/${space.id}`, as);
        expect(library.response.status, as).toBe(200);
        expect(library.html, as).toContain('Alice drafts the launch memo');
        expect(library.html, as).toContain('Launch memo opening line.');
        expect(library.html, as).not.toContain('BODY-CANARY-7c1d');
        // The card's time is UTC until the browser has hydrated.
        expect(library.html, as).toMatch(/Edited <time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
        expectNoSecretsOrDeleted(library.html);
        // An open page: its title in the header, its body still not in the page.
        const page = await document(`/spaces/${space.id}/pages/${memo.id}`, as);
        expect(page.response.status, as).toBe(200);
        expect(page.html, as).toMatch(/data-slot="breadcrumb-page"[^>]*>Alice drafts the launch memo</);
        expect(page.html, as).toContain('Loading page…');
        expect(page.html, as).not.toContain('BODY-CANARY-7c1d');
        expectNoSecretsOrDeleted(page.html);
    }
    const bob = await document(`/spaces/${space.id}`, 'bob');
    expect(bob.html).not.toContain('Alice private plan');
    // A deleted page's address: no data for it.
    const gone = await document(`/spaces/${space.id}/pages/${gonePage.id}`, 'bob');
    expect(gone.response.status).toBe(200);
    expectNoSecretsOrDeleted(gone.html);
}, 60_000);

it('renders a user’s own approvals only, the list and one request', async () => {
    const bob = await document('/approvals', 'bob');
    expect(bob.response.status).toBe(200);
    expect(bob.html).toContain('Bob asks to post the notes');
    expect(bob.html).not.toContain('Alice asks to email the board');
    expect(bob.html).not.toContain('alice-ask');
    // The expiry is UTC until the browser has hydrated.
    expect(bob.html).toMatch(/Expires <time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
    expectNoSecretsOrDeleted(bob.html);
    const alice = await document('/approvals', 'alice');
    expect(alice.html).toContain('Alice asks to email the board');
    expect(alice.html).not.toContain('Bob asks to post the notes');
    // One request: the user's own, never another's (an admin's included).
    const own = await document('/approvals/bob-ask', 'bob');
    expect(own.html).toContain('Bob asks to post the notes');
    for (const [path, as, other] of [
        ['/approvals/alice-ask', 'bob', 'Alice asks to email the board'],
        ['/approvals/bob-ask', 'alice', 'Bob asks to post the notes'],
    ] as const) {
        const page = await document(path, as);
        expect(page.response.status, path).toBe(200);
        expect(page.html, path).not.toContain(other);
        expectNoSecretsOrDeleted(page.html);
    }
}, 60_000);

it('renders a user’s own files on the Media page, and nobody else’s', async () => {
    const bob = await document('/media', 'bob');
    expect(bob.response.status).toBe(200);
    expect(bob.html).toContain('Bob-trip-receipts.md');
    expect(bob.html).not.toContain('Alice-board-deck');
    expect(bob.html).not.toContain('file-body-canary');
    expectNoSecretsOrDeleted(bob.html);
    const alice = await document('/media?view=list', 'alice');
    expect(alice.html).toContain('Alice-board-deck.md');
    expect(alice.html).not.toContain('Bob-trip-receipts');
    // The list's times are UTC until the browser has hydrated.
    expect(alice.html).toMatch(/<time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
    expectNoSecretsOrDeleted(alice.html);
}, 60_000);

it('renders a user’s own datasets on the Data page and a dataset’s page', async () => {
    const bob = await document('/data', 'bob');
    expect(bob.response.status).toBe(200);
    expect(bob.html).toContain('Bob reading list');
    expect(bob.html).not.toContain('Alice salary bands');
    // No file list in the data: Media lists files.
    expect(bob.html).not.toContain('Bob-trip-receipts');
    expect(bob.html).toMatch(/<time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
    expectNoSecretsOrDeleted(bob.html);
    const own = await document(`/data/datasets/${bobSet.id}`, 'bob');
    expect(own.html).toContain('Bob reading list');
    for (const [id, as, other] of [
        [aliceSet.id, 'bob', 'Alice salary bands'],
        [bobSet.id, 'alice', 'Bob reading list'],
        [goneSet.id, 'bob', 'Bob old survey'],
    ] as const) {
        const page = await document(`/data/datasets/${id}`, as);
        expect(page.response.status, id).toBe(200);
        expect(page.html, id).not.toContain(other);
        expectNoSecretsOrDeleted(page.html);
    }
}, 60_000);

it('renders a user’s own schedules on the server', async () => {
    const bob = await document('/schedules', 'bob');
    expect(bob.response.status).toBe(200);
    expect(bob.html).toContain('Bob morning brief');
    expect(bob.html).not.toContain('Alice weekly board digest');
    expect(bob.html).toMatch(/<time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
    expectNoSecretsOrDeleted(bob.html);
    const alice = await document('/schedules', 'alice');
    expect(alice.html).toContain('Alice weekly board digest');
    expect(alice.html).not.toContain('Bob morning brief');
}, 60_000);

it('renders Learning’s containers and proposals for admins, skills only for members', async () => {
    const admin = await document('/learning', 'alice');
    expect(admin.response.status).toBe(200);
    expect(admin.html).toContain('triage-refunds');
    expect(admin.html).toContain('Sorts refund requests.');
    // A proposal's body is its review's, not the list's.
    expect(admin.html).not.toContain('SKILL-BODY-CANARY');
    expectNoSecretsOrDeleted(admin.html);
    const member = await document('/learning', 'bob');
    expect(member.response.status).toBe(200);
    expect(member.html).toContain('No skills yet.');
    for (const text of ['triage-refunds', 'Sorts refund', 'SKILL-BODY-CANARY']) {
        expect(member.html).not.toContain(text);
    }
    expectNoSecretsOrDeleted(member.html);
}, 60_000);

it('renders the platform page for admins only (CB-390), with no backend key', async () => {
    for (const as of ['olga', 'alice'] as const) {
        const platform = await document('/settings/operator', as);
        expect(platform.response.status, as).toBe(200);
        // The backend made from the model settings, its key write-only.
        expect(platform.html).toContain('Self-hosted (fake-model)');
        expect(platform.html).toContain('key stored');
        expectNoSecretsOrDeleted(platform.html);
    }
    for (const as of ['bob'] as const) {
        const page = await document('/settings/operator', as);
        expect(page.response.status, as).toBe(302);
        expect(page.response.headers.get('location'), as).toBe('/');
    }
}, 60_000);

it('renders sign-in signed out, at the same address, with no workspace data', async () => {
    for (const path of [
        '/',
        '/issues/CB-1',
        '/memories',
        `/spaces/${space.id}`,
        '/approvals/bob-ask',
        '/media',
        `/data/datasets/${bobSet.id}`,
        '/schedules',
        '/learning',
    ]) {
        const { response, html } = await document(path);
        expect(response.status, path).toBe(200);
        // Mock auth's picker; its users load in the browser.
        expect(html, path).toContain('Who’s thinking today?');
        expect(html, path).toContain('Development sign-in');
        for (const text of [
            'Alice',
            'Bob',
            'data-slot="sidebar"',
            'importer',
            'Launch memo',
            // The approvals' asks (UI words like "asks to" are in the
            // inlined dictionaries, which every page carries).
            'email the board',
            'post the notes',
            'receipts',
            'reading list',
            'morning brief',
            'triage-refunds',
        ]) {
            expect(html, path).not.toContain(text);
        }
        expectNoSecretsOrDeleted(html);
    }
}, 60_000);

it('redirects a member away from an admin module on the server', async () => {
    const bob = await document('/admin/dots', 'bob');
    expect(bob.response.status).toBe(302);
    expect(bob.response.headers.get('location')).toBe('/');
    // A client navigation's data request is redirected too, with no data.
    const data = await fetch(`${base}/admin/dots.data`, {
        headers: { cookie: cookie('bob') },
        redirect: 'manual',
    });
    const body = await data.text();
    expect(data.headers.get('cache-control')).toBe('no-store');
    expect(body).toContain('redirect');
    expect(body).not.toContain('Alice');
    // Runs shows a member their own turns only (CB-128).
    const own = await document('/runs', 'bob');
    expect(own.response.status).toBe(200);
    expect(own.html).toContain('Bob weekly notes');
    expect(own.html).not.toContain('Alice private plan');
    expect(own.html).not.toContain('The model went away.');
    expectNoSecretsOrDeleted(own.html);
    // The admin's page: every user's turns, metadata only, none on a deleted
    // conversation.
    const admin = await document('/runs', 'alice');
    expect(admin.response.status).toBe(200);
    expect(admin.html).toContain('Alice private plan');
    expect(admin.html).toContain('Bob weekly notes');
    expect(admin.html).toContain('The model went away.');
    expect(admin.html).not.toContain('event-payload-canary');
    expect(admin.html).not.toContain('run-bob-gone');
    expect(admin.html).toMatch(/<td data-slot="table-cell"[^>]*><time dateTime="[^"]+">\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
    expectNoSecretsOrDeleted(admin.html);
    // Signed out, the gate lets the request through to sign-in.
    const out = await document('/runs');
    expect(out.response.status).toBe(200);
    expect(out.html).toContain('Who’s thinking today?');
}, 60_000);

it('answers an unknown address with a real 404, inside the shell', async () => {
    const { response, html } = await document('/no/such/page', 'bob');
    expect(response.status).toBe(404);
    expect(html).toContain('Page not found');
    expect(html).toContain('data-slot="sidebar"');
}, 60_000);

it('answers a missing or hidden help article with the same Not found page and a 404 (CB-264)', async () => {
    for (const as of [undefined, 'bob'] as const) {
        const pages = await Promise.all(['/docs/no-such-article', '/docs/admin'].map((path) => document(path, as)));
        for (const page of pages) {
            expect(page.response.status).toBe(404);
            expect(page.html).toContain('<title>Not found · Socio help</title>');
            expect(page.html).toContain('Article not found');
            expect(page.html).toContain('<a href="/docs">Back to the help center</a>');
            expect(page.html).toContain('Search the help center');
            // The markup, not the dictionaries inlined for the browser.
            expect(markup(page.html)).not.toMatch(/Something went wrong|Reloading usually fixes it/);
            expect(page.html).not.toMatch(/ADMIN-DOC-CANARY|Admin guide canary/);
        }
        // What could tell them apart (the article, the navigation and the
        // data handed to the browser) is the same; only the nonce differs.
        // Streaming order may vary with module loading, so compare the parts.
        const [missing, hidden] = pages.map(({ html, nonce }) => {
            const part = (pattern: RegExp) => html.replaceAll(nonce, 'NONCE').match(pattern)?.[0];
            return {
                article: part(/<article [^>]*id="nd-page"[\s\S]*?<\/article>/),
                sidebar: part(/<aside id="nd-sidebar"[\s\S]*?<\/aside>/),
                data: part(/streamController\.enqueue\([\s\S]*?\);<\/script>/),
            };
        });
        expect(missing!.article).toBeTruthy();
        expect(missing!.sidebar).toContain('User guides');
        expect(missing!.data).toContain('ErrorResponse');
        expect(hidden).toEqual(missing);
    }
    const admin = await document('/docs/admin', 'alice');
    expect(admin.response.status).toBe(200);
    expect(admin.html).toContain('ADMIN-DOC-CANARY');
}, 60_000);

it('sends the old Settings address, and sections a member may not open, to General (CB-95)', async () => {
    for (const [path, as] of [
        ['/settings', 'bob'],
        ['/settings/nope', 'alice'],
        ['/settings/service-accounts', 'bob'],
    ] as const) {
        const { response } = await document(path, as);
        expect(response.status, path).toBe(302);
        expect(response.headers.get('location'), path).toBe('/settings/workspace');
    }
    // Service accounts moved to a tab of People (CB-360).
    const moved = await document('/settings/service-accounts', 'alice');
    expect(moved.response.status).toBe(302);
    expect(moved.response.headers.get('location')).toBe('/settings/people?tab=service-accounts');
    const page = await document('/settings/people?tab=service-accounts', 'alice');
    expect(page.response.status).toBe(200);
    expect(page.html).toContain('data-slot="settings-nav"');
    expect(page.html).toContain('Service accounts');
}, 60_000);

it('nonces every inline script with its own response’s nonce, and loads the theme first', async () => {
    const first = await document('/', 'alice');
    const second = await document('/settings/workspace', 'bob');
    const third = await document('/');
    expect(first.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(second.nonce).not.toBe(first.nonce);
    expect(third.nonce).not.toBe(second.nonce);
    for (const { nonce, scripts, html } of [first, second, third]) {
        // The theme script is a file and runs first, in <head>, blocking, before
        // any stylesheet applies. (React puts the charset and viewport meta tags
        // and the preloads ahead of it; they don't paint.)
        expect(scripts[0]!.attributes).toBe(' src="/theme-init.js"');
        expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('</head>'));
        expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('rel="stylesheet"'));
        const inline = scripts.filter(({ body }) => body.trim());
        expect(inline.length).toBeGreaterThan(0);
        for (const { attributes } of inline) {
            // next-themes' script is a data block (never run, outside the CSP).
            if (attributes.includes('type="application/json"')) {
                continue;
            }
            expect(attributes).toContain(`nonce="${nonce}"`);
        }
        // Scripts from files come from this app.
        for (const { attributes, body } of scripts) {
            if (!body.trim()) {
                expect(attributes).toMatch(/\bsrc="\//);
            }
        }
    }
}, 60_000);

it('renders a password or sign-in link’s screen on the server, from the address', async () => {
    const reset = await document('/reset-password?token=link-token');
    expect(reset.response.status).toBe(200);
    expect(reset.html).toContain('Choose a password');
    const link = await document('/sign-in-link?token=abc-123');
    expect(link.response.status).toBe(200);
    expect(link.html).toContain('Sign in to Socio');
    // Signed in too: the link's screen, not the shell.
    const signedIn = await document('/reset-password?token=link-token', 'bob');
    expect(signedIn.html).toContain('Choose a password');
}, 60_000);

it('serves the browser modules through Vite on the same server', async () => {
    const { html } = await document('/');
    const entry = html.match(/import\("(\/[^"]+entry\.client\.tsx)"\)/)?.[1];
    expect(entry).toBeDefined();
    const module = await fetch(`${base}${entry}`);
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toMatch(/javascript/);
    // Public files too.
    const theme = await fetch(`${base}/theme-init.js`);
    expect(theme.status).toBe(200);
    expect(await theme.text()).toContain("localStorage.getItem('theme')");
    // The app's manifest and icons, linked from every page (CB-113).
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
    for (const path of ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/apple-touch-icon.png']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(200);
    }
}, 60_000);

it('renders a cold plugin deep link on its frame route, and discovers it lazily (CB-446)', async () => {
    const { response, html } = await document('/plugins/events/events/42?tab=a', 'bob');
    expect(response.status).toBe(200);
    // The frame route (not Not found), in the page's own route manifest.
    expect(html).toContain('"plugins:frame"');
    expect(markup(html)).not.toContain('Page not found');
    // A tab that navigates to a new deep path asks /__manifest; the answer is the frame route.
    const version = /__reactRouterManifest = [\s\S]*?"version":\s*"([^"]+)"/.exec(html)?.[1];
    expect(version).toBeTruthy();
    const manifest = await fetch(
        `${base}${MANIFEST_PATH}?version=${version}&paths=${encodeURIComponent('/plugins/events/a/b/c')}`,
    );
    expect(manifest.status).toBe(200);
    expect(Object.keys((await manifest.json()) as object)).toContain('plugins:frame');
}, 60_000);

it('tells a tab on an older build to load the page again', async () => {
    const response = await fetch(`${base}${MANIFEST_PATH}?version=stale&paths=%2Fissues`);
    expect(response.status).toBe(204);
    expect(response.headers.get('x-remix-reload-document')).toBe('true');
    expect(response.headers.get('cache-control')).toBe('no-store');
}, 60_000);

it('renders in the page’s locale, with only its route’s dictionaries inlined', { timeout: 60_000 }, async () => {
    // en-XA (the pseudo-locale) through the cookie: the page's own words, no flash of English.
    const pseudo = await document('/settings/account', 'alice', { cookie: 'socio_locale=en-XA' });
    expect(pseudo.html).toMatch(/^<!DOCTYPE html><html lang="en-XA" dir="ltr"/);
    expect(pseudo.html).toContain('[Šöçîö ~~]');
    expect(pseudo.html).toContain('[Ļáñĝûáĝé ~~~]');
    // en-US alone passes the coverage gate: Settings › Language isn't shown.
    expect(pseudo.html).not.toContain('data-slot="language-preference"');
    // Accept-Language with nothing to match: en-US, and a page without the settings namespace.
    const home = await document('/', 'alice', { 'accept-language': 'fr-FR, de;q=0.5' });
    expect(home.html).toMatch(/^<!DOCTYPE html><html lang="en-US" dir="ltr"/);
    expect(home.html).not.toContain('Match my device');
    // Signed out: the cookie still decides.
    const signedOut = await document('/', undefined, { cookie: 'socio_locale=en-XA' });
    expect(signedOut.html).toMatch(/^<!DOCTYPE html><html lang="en-XA"/);
    // The preference wins over the cookie.
    workspace.setPreferences('bob', { locale: 'en-US' });
    const preferred = await document('/', 'bob', { cookie: 'socio_locale=en-XA' });
    expect(preferred.html).toMatch(/^<!DOCTYPE html><html lang="en-US"/);
});
