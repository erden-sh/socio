import { afterEach, expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { movePage } from '../src/server/pages/page-moves.js';
import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
];

async function fixture() {
    const { app, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            baseUrl: '',
            apiKey: '',
            model: '',
            voiceName: 'marin',
            runtimeUrl: '',
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
    const send =
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
        return send({ cookie: login.headers.get('set-cookie')!.split(';')[0] });
    };
    const from = workspace.spaces()[0].id;
    const to = workspace.createSpace('Workshop', '').id;
    return {
        platform,
        workspace,
        from,
        to,
        send,
        bob: await as('bob'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('moves a page with its subpages to another Space, keeping ids, history, search and receipts', async () => {
    const { workspace, from, to, bob } = await fixture();
    const create = (title: string, parentId: string | null = null) =>
        json<Page>(
            bob(`/spaces/${from}/pages`, 'POST', {
                title,
                content: `${title} text with marigolds`,
                parentId,
            }),
        );
    const plan = await create('Garden plan');
    const beds = await create('Beds', plan.id);
    const path = await create('Path', beds.id);
    const other = await create('Other');
    // Two saves by two people: two kept revisions.
    for (const [as, content] of [
        ['bob', 'second'],
        ['alice', 'third'],
    ] as const) {
        await workspace.pages.update(
            from,
            plan.id,
            {
                content,
                expectedRevision: workspace.pages.get(from, plan.id).revision,
            },
            { by: as },
        );
    }
    const history = workspace.pages.revisionsOf(plan.id);
    expect(history).toHaveLength(2);
    // A review receipt for it, as a Dot's reviewed draft leaves.
    workspace.db
        .prepare('INSERT INTO page_reviews (threadId,toolCallId,pageId,spaceId,draft) VALUES (?,?,?,?,NULL)')
        .run('t1', 'call-1', plan.id, from);

    const response = await bob(`/spaces/${from}/pages/${plan.id}/move`, 'POST', {
        spaceId: to,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
        page: Page;
        from: string;
        moved: string[];
    };
    expect(result.from).toBe(from);
    expect(result.moved).toEqual([plan.id, beds.id, path.id]);
    // Same id and text, at the top of the new Space; subpages keep their places.
    expect(result.page).toMatchObject({
        id: plan.id,
        spaceId: to,
        parentId: null,
        title: 'Garden plan',
        content: 'third',
        createdBy: 'bob',
    });
    expect(workspace.pages.tree(to)).toEqual([
        { id: plan.id, parentId: null, title: 'Garden plan', folder: false },
        { id: beds.id, parentId: plan.id, title: 'Beds', folder: false },
        { id: path.id, parentId: beds.id, title: 'Path', folder: false },
    ]);
    expect(workspace.pages.list(from).map((page) => page.id)).toEqual([other.id]);
    // History stays with the page; a move keeps no revision of its own.
    expect(workspace.pages.revisionsOf(plan.id)).toEqual(history);
    // Search finds it in its new Space only.
    const found = (spaces: string[]) =>
        workspace.pages
            .search({ query: 'marigolds', spaces })
            .results.map((hit) => hit.id)
            .sort();
    expect(found([from])).toEqual([other.id]);
    expect(found([to])).toEqual([beds.id, path.id].sort());
    // The receipt opens it where it is now.
    expect(workspace.pages.reviewReceipt('t1', 'call-1')?.spaceId).toBe(to);
    // Recorded as Bob's.
    expect(workspace.auditOf('page', plan.id)).toMatchObject([
        {
            actor: 'bob',
            action: 'move',
            detail: `from ${from} to ${to} with 2 subpages`,
        },
    ]);
});

it('finds a moved page from its old link, and its new one works', async () => {
    const { from, to, bob } = await fixture();
    const page = await json<Page>(bob(`/spaces/${from}/pages`, 'POST', { title: 'Notes' }));
    expect(
        (
            await bob(`/spaces/${from}/pages/${page.id}/move`, 'POST', {
                spaceId: to,
            })
        ).status,
    ).toBe(200);
    expect((await bob(`/spaces/${from}/pages/${page.id}`)).status).toBe(404);
    expect((await json<Page>(bob(`/spaces/${to}/pages/${page.id}`))).title).toBe('Notes');
    expect(await json(bob(`/pages/${page.id}/location`))).toEqual({
        spaceId: to,
    });
    const missing = await bob('/pages/nope/location');
    expect(missing.status).toBe(404);
    // A deleted page is nowhere.
    await bob(`/spaces/${to}/pages/${page.id}`, 'DELETE');
    expect((await bob(`/pages/${page.id}/location`)).status).toBe(404);
});

it('puts a page under a parent in the new Space, and refuses moves that cannot be', async () => {
    const { workspace, from, to, bob } = await fixture();
    const page = await workspace.pages.create(from, { title: 'Notes' }, null, 'bob');
    const home = await workspace.pages.create(to, { title: 'Home' });
    const move = (body: unknown) => bob(`/spaces/${from}/pages/${page.id}/move`, 'POST', body);
    const error = async (body: unknown) => {
        const response = await move(body);
        return [response.status, ((await response.json()) as { error: string }).error];
    };
    expect(await error({ spaceId: 'nope' })).toEqual([404, 'Space not found.']);
    expect(await error({ spaceId: from })).toEqual([400, 'This page is already in that Space.']);
    expect(await error({})).toEqual([400, 'Choose the Space to move the page to.']);
    // The parent must be a page of the destination.
    const sibling = await workspace.pages.create(from, { title: 'Sibling' });
    expect((await error({ spaceId: to, parentId: sibling.id }))[0]).toBe(404);
    expect(await error({ spaceId: to, expectedRevision: 7 })).toEqual([
        409,
        'This page changed. Reload the latest revision before moving it.',
    ]);
    // Nothing moved so far.
    expect(workspace.pages.get(from, page.id).revision).toBe(1);
    const moved = await json<{ page: Page }>(move({ spaceId: to, parentId: home.id, expectedRevision: 1 }));
    expect(moved.page).toMatchObject({
        spaceId: to,
        parentId: home.id,
        revision: 2,
    });
});

it('refuses a move by someone who cannot edit pages: a service account', async () => {
    const { platform, workspace, from, to, send } = await fixture();
    const page = await workspace.pages.create(from, { title: 'Notes' });
    const account = platform.serviceAccounts.create({ name: 'Reader', role: 'admin' }, 'alice');
    const { token } = platform.serviceAccounts.createKey(
        account.id,
        { name: 'k', scopes: ['pages:read'], days: 30 },
        'alice',
    );
    const reader = send({ Authorization: `Bearer ${token}` });
    // Its key may read where a page is, not move one.
    expect(await json(reader(`/pages/${page.id}/location`))).toEqual({
        spaceId: from,
    });
    expect(
        (
            await reader(`/spaces/${from}/pages/${page.id}/move`, 'POST', {
                spaceId: to,
            })
        ).status,
    ).toBe(403);
    // Nor through the store's checks, whatever reaches them.
    await expect(
        movePage(
            workspace,
            platform.pageMoves,
            platform.media,
            { userId: account.id },
            {
                spaceId: from,
                id: page.id,
                to,
            },
        ),
    ).rejects.toMatchObject({
        status: 403,
        message: 'You can’t edit pages in that Space.',
    });
    expect(workspace.pages.get(from, page.id).spaceId).toBe(from);
});

it('lets a socio move a page only between Spaces it was granted, for its person', async () => {
    const { platform, workspace, from, to } = await fixture();
    const dot = workspace.dots()[0];
    expect(dot.spaceIds).toEqual([from]);
    workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    const access = pageAccess(
        workspace,
        from,
        't1',
        () => {},
        undefined,
        undefined,
        platform.pageMoves,
        platform.media,
    );
    const tool = pageTools(access).find((entry) => entry.name === 'move_space_page')!;
    expect(tool).toBeDefined();
    const page = await workspace.pages.create(from, { title: 'Notes' }, null, 'bob');
    const run = (input: Record<string, unknown>) => tool.execute!(input as never) as Promise<Record<string, unknown>>;

    // Not granted the destination: refused, and nothing moves.
    expect(await run({ id: page.id, toSpaceId: to })).toEqual({
        error: 'This socio may not use that Space. An admin grants Spaces in the socio’s settings.',
        code: 'http_403',
    });
    expect(workspace.pages.get(from, page.id).spaceId).toBe(from);

    workspace.updateDot(dot.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceIds: [from, to],
    });
    expect(await run({ id: page.id, toSpaceId: to })).toEqual({
        id: page.id,
        spaceId: to,
        title: 'Notes',
        parentId: null,
        revision: 2,
        folder: false,
        url: `/spaces/${to}/pages/${page.id}`,
        from,
        subpagesMoved: 0,
    });
    expect(workspace.auditOf('page', page.id)).toMatchObject([
        {
            actor: `dot:${dot.id}`,
            action: 'move',
            detail: `from ${from} to ${to} for bob`,
        },
    ]);
    // Its page tools find it in its new Space; an old Space id doesn't.
    expect((await access.read(page.id, to)).title).toBe('Notes');
    await expect(access.read(page.id, from)).rejects.toThrow('Page not found in this Space.');
});

it('refuses a socio’s move for a person who may not edit pages', async () => {
    const { platform, workspace, from, to } = await fixture();
    const account = platform.serviceAccounts.create({ name: 'Bot', role: 'member' }, 'alice');
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        spaceIds: [from, to],
    });
    workspace.bindThread('t2', dot.id, 'Chat', account.id);
    const page = await workspace.pages.create(from, { title: 'Notes' });
    const tool = pageTools(
        pageAccess(workspace, from, 't2', () => {}, undefined, undefined, platform.pageMoves, platform.media),
    ).find((entry) => entry.name === 'move_space_page')!;
    expect(await tool.execute!({ id: page.id, toSpaceId: to } as never)).toEqual({
        error: 'You can’t edit pages in that Space.',
        code: 'http_403',
    });
});
