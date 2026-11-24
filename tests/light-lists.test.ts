import { afterEach, expect, it, vi } from 'vitest';

import type { IssueDetail, IssueList, IssueSearch, IssueTitle } from '@socio/shared/issues/issue-types';
import type { PageSummary, PageTreeItem } from '@socio/shared/pages/page-library';
import type { Page } from '@socio/shared/pages/page-library';
import type { CreatedServiceKey, ServiceAccountView } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { issueTitlesView } from '../src/server/issues/views.js';
import { pageTreeView } from '../src/server/pages/views.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// The sidebar's page tree and the palette's issue commands read light
// lists (GET /api/spaces/:id/page-tree, GET /api/issues/titles) instead of
// full page and issue lists with their bodies. The board's and a Space's
// own lists carry excerpts, not bodies (CB-71).
const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

async function fixture() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
            sessionSecret: 'light-lists-test-secret-0123456789',
        },
        app: {
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const call =
        (headers: Record<string, string>) =>
        (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    ...headers,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return call({ cookie: login.headers.get('set-cookie')!.split(';')[0]! });
    };
    return {
        workspace,
        platform,
        space: workspace.spaces()[0]!.id,
        alice: await as('alice'),
        bob: await as('bob'),
        withKey: (token: string) => call({ Authorization: `Bearer ${token}` }),
    };
}
type Caller = Awaited<ReturnType<typeof fixture>>['alice'];
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('gives the sidebar tree titles and parents only, the same to members and admins, without deleted pages', async () => {
    const { platform, space, alice, bob } = await fixture();
    const create = (title: string, parentId: string | null = null) =>
        json<Page>(
            bob(`/spaces/${space}/pages`, 'POST', {
                title,
                parentId,
                content: `# ${title}\n\nA long body the tree never needs.`,
            }),
        );
    const plan = await create('Plan');
    const child = await create('Child', plan.id);
    const gone = await create('Gone');
    await create('Under gone', gone.id);
    const notes = await create('Notes');
    expect((await bob(`/spaces/${space}/pages/${gone.id}?subpages=true`, 'DELETE')).status).toBe(200);

    const member = await bob(`/spaces/${space}/page-tree`);
    expect(member.status).toBe(200);
    const tree = (await member.json()) as PageTreeItem[];
    // The list's order, with exactly the fields the tree renders.
    expect(tree).toEqual([
        { id: plan.id, parentId: null, title: 'Plan' },
        { id: child.id, parentId: plan.id, title: 'Child' },
        { id: notes.id, parentId: null, title: 'Notes' },
    ]);
    // Spaces are the team's: an admin gets the same; the view is the route's.
    expect(await json(alice(`/spaces/${space}/page-tree`))).toEqual(tree);
    expect(
        pageTreeView(
            {
                spaceAccess: platform.workspace.spaceAccess,
                pages: platform.workspace.pages,
                counters: platform.workspace.counters,
            },
            'alice',
            space,
        ),
    ).toEqual(tree);
    // The same pages as the full list, in its order.
    expect(tree.map((page) => page.id)).toEqual(
        (await json<Page[]>(bob(`/spaces/${space}/pages`))).map((page) => page.id),
    );
    expect((await bob('/spaces/nope/page-tree')).status).toBe(404);
});

it('gives the palette issue titles only, open ones on request, the same to members and admins', async () => {
    const { platform, alice, bob } = await fixture();
    const file = async (title: string, status: string) => {
        const { issue } = await json<IssueDetail>(
            alice('/issues', 'POST', {
                title,
                status,
                body: 'A long description the palette never shows.',
            }),
        );
        return issue.number;
    };
    const open = await file('Login fails on Safari', 'open');
    const done = await file('Old crash', 'done');
    const triage = await file('Slow board', 'triage');
    const gone = await file('Filed twice', 'open');
    expect((await alice(`/issues/${gone}`, 'DELETE')).status).toBe(200);

    const all = await json<IssueTitle[]>(bob('/issues/titles'));
    expect(new Set(all.map((issue) => issue.number))).toEqual(new Set([open, done, triage]));
    for (const issue of all) {
        expect(Object.keys(issue).sort()).toEqual(['number', 'status', 'title']);
    }
    // The board's order, without deleted issues.
    expect(all.map((issue) => issue.number)).toEqual(
        (await json<{ issues: { number: number }[] }>(bob('/issues'))).issues.map((issue) => issue.number),
    );
    expect(await json(alice('/issues/titles'))).toEqual(all);
    expect(await issueTitlesView(platform.board)).toEqual(all);
    // Open issues only, when asked.
    const openOnly = await json<IssueTitle[]>(alice('/issues/titles?open=true'));
    expect(openOnly.map((issue) => issue.number).sort()).toEqual([open, triage].sort());
    expect(await issueTitlesView(platform.board, { open: true })).toEqual(openOnly);
    expect((await bob('/issues/titles?open=yes')).status).toBe(400);
    expect((await bob('/issues/titles?q=x')).status).toBe(400);
});

async function key(admin: Caller, scopes: string[]) {
    const made = await json<ServiceAccountView>(
        admin('/service-accounts', 'POST', {
            name: 'Claude',
            role: 'member',
            description: 'The lead agent',
        }),
    );
    const response = await admin(`/service-accounts/${made.id}/keys`, 'POST', {
        name: 'laptop',
        scopes,
        days: 90,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as CreatedServiceKey).token;
}

it('lets service-account keys read the light lists within their scopes', async () => {
    const { space, alice, withKey } = await fixture();
    const pages = withKey(await key(alice, ['pages:read']));
    const issues = withKey(await key(alice, ['issues:read']));
    for (const path of [`/spaces/${space}/page-tree`, '/pages/titles']) {
        expect([path, (await pages(path)).status]).toEqual([path, 200]);
        expect([path, (await issues(path)).status]).toEqual([path, 403]);
    }
    for (const path of ['/issues/titles', '/issues/titles?open=true', '/issues/search?q=x']) {
        expect([path, (await issues(path)).status]).toEqual([path, 200]);
        expect([path, (await pages(path)).status]).toEqual([path, 403]);
    }
});

it('gives the board excerpts, not descriptions; the detail has the description', async () => {
    const { alice, bob } = await fixture();
    const long = `${'Words before it. '.repeat(20)}The cron job fails.`;
    const { issue } = await json<IssueDetail>(bob('/issues', 'POST', { title: 'Digest is late', body: long }));
    await alice(`/issues/${issue.number}`, 'PATCH', { assigneeId: 'alice' });
    await alice(`/issues/${issue.number}/vote`, 'POST');

    for (const [as, voted] of [
        [alice, { voted: true }],
        [bob, {}],
    ] as const) {
        const list = await json<IssueList>(as('/issues'));
        const [row] = list.issues;
        // The board's fields, the caller's own vote, and no description.
        expect(row).toEqual({
            number: issue.number,
            title: 'Digest is late',
            status: 'triage',
            priority: 'medium',
            kind: 'bug',
            area: null,
            labels: [],
            components: [],
            assigneeId: 'alice',
            updatedAt: expect.any(Number),
            votes: 1,
            ...voted,
            excerpt: expect.stringMatching(/^Words before it\. .*…$/),
        });
        expect(row!.excerpt.length).toBeLessThanOrEqual(160);
        expect(JSON.stringify(list)).not.toContain('cron');
        // Names for the assignees only: the reporter's is in the detail.
        expect(list.users).toEqual({ alice: 'Alice' });
    }
    const detail = await json<IssueDetail>(bob(`/issues/${issue.number}`));
    expect(detail.issue.body).toBe(long);
    expect(detail.users).toMatchObject({ alice: 'Alice', bob: 'Bob' });
});

it('searches the board on the server: every word, in keys, titles and descriptions', async () => {
    const { alice, bob } = await fixture();
    const file = async (title: string, body = '') =>
        (await json<IssueDetail>(alice('/issues', 'POST', { title, body, status: 'open' }))).issue.number;
    const safari = await file('Login fails on Safari', 'Since **Tuesday**.');
    const dark = await file('Dark mode', 'The sidebar is too bright.');
    const cafe = await file('Café menu');
    const gone = await file('Sidebar flickers');
    await alice(`/issues/${gone}`, 'DELETE');
    const search = async (q: string) =>
        (await json<IssueSearch>(bob(`/issues/search?${new URLSearchParams({ q })}`))).numbers;
    expect(await search('sidebar')).toEqual([dark]);
    expect(await search('SAFARI tues')).toEqual([safari]);
    expect(await search('safari dark')).toEqual([]);
    expect(await search('cafe')).toEqual([cafe]);
    expect(await search(`cb-${dark}`)).toEqual([dark]);
    // No words: every live issue, in the list's order.
    const listed = (await json<IssueList>(bob('/issues'))).issues.map((issue) => issue.number);
    expect(await search(' ')).toEqual(listed);
    expect((await bob('/issues/search')).status).toBe(400);
    expect((await bob('/issues/search?q=x&status=open')).status).toBe(400);
});

it('gives an open Space every page with an excerpt, not its body', async () => {
    const { space, bob } = await fixture();
    const page = await json<Page>(
        bob(`/spaces/${space}/pages`, 'POST', {
            title: 'Runbook',
            content: '# Runbook\n\nRestart **the worker**.\n\n```sh\nsecret-ish\n```',
        }),
    );
    const pages = await json<PageSummary[]>(bob(`/spaces/${space}/pages`));
    const listed = pages.find((item) => item.id === page.id)!;
    expect(listed).toMatchObject({
        title: 'Runbook',
        // Its `# Runbook` heading only repeats the title (CB-308).
        excerpt: 'Restart the worker. Code block',
        revision: page.revision,
    });
    expect(listed).not.toHaveProperty('content');
    expect((await json<Page>(bob(`/spaces/${space}/pages/${page.id}`))).content).toBe(page.content);
});
