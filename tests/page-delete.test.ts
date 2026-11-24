import { afterEach, expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { pageAccess, pageTools } from '../src/server/pages/page-tools.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS: User[] = [
    { id: 'olga', name: 'Olga', role: 'admin' },
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'dave', name: 'Dave', role: 'member' },
];

async function fixture() {
    const { app, workspace, dispose } = await makeTestRuntime({
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
    const space = workspace.spaces()[0].id;
    return {
        workspace,
        space,
        olga: await as('olga'),
        alice: await as('alice'),
        bob: await as('bob'),
        dave: await as('dave'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('lets admins and operators delete any page, members only the pages they created', async () => {
    const { space, olga, alice, bob, dave, workspace } = await fixture();
    const create = async (as: typeof bob, title: string, parentId: string | null = null) =>
        json<Page>(as(`/spaces/${space}/pages`, 'POST', { title, parentId }));
    const bobs = await create(bob, 'Bob’s notes');
    expect(bobs.createdBy).toBe('bob');
    const path = (page: Page) => `/spaces/${space}/pages/${page.id}`;

    // Another member may edit it (pages are team-shared) but not delete it.
    const refused = await dave(path(bobs), 'DELETE');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
        error: 'Only an admin or the person who created this page can delete it.',
    });
    expect(workspace.pages.get(space, bobs.id).title).toBe('Bob’s notes');

    // Its creator may.
    expect(await json(bob(path(bobs), 'DELETE'))).toEqual({
        deleted: [bobs.id],
    });
    expect((await bob(path(bobs))).status).toBe(410);

    // Admins and operators delete anyone's page, also one with no creator
    // recorded (from before creators were).
    const daves = await create(dave, 'Dave’s plan');
    expect((await alice(path(daves), 'DELETE')).status).toBe(200);
    const legacy = await workspace.pages.create(space, { title: 'Old page' });
    expect(legacy.createdBy).toBeNull();
    expect((await bob(path(legacy), 'DELETE')).status).toBe(403);
    expect((await olga(path(legacy), 'DELETE')).status).toBe(200);

    // Unknown pages and Spaces are 404; a deleted page again is 410.
    expect((await alice(`/spaces/${space}/pages/nope`, 'DELETE')).status).toBe(404);
    expect((await alice(`/spaces/nope/pages/${daves.id}`, 'DELETE')).status).toBe(404);
    expect(await json(alice(path(daves), 'DELETE'))).toEqual({
        error: 'This page was deleted.',
    });
});

it('refuses a page with subpages unless asked, then deletes the whole subtree', async () => {
    const { space, alice, bob, workspace } = await fixture();
    const root = await workspace.pages.create(space, { title: 'Root' }, null, 'bob');
    const child = await workspace.pages.create(space, { title: 'Child', parentId: root.id }, null, 'bob');
    const grandchild = await workspace.pages.create(space, { title: 'Grandchild', parentId: child.id }, null, 'alice');
    const sibling = await workspace.pages.create(space, { title: 'Sibling' });
    const path = `/spaces/${space}/pages/${root.id}`;

    const refused = await bob(path, 'DELETE');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
        error: 'This page has 2 subpages. Delete them with it, or move them first.',
    });
    // Bob created the root and the child, not the grandchild: nothing goes.
    const partly = await bob(`${path}?subpages=true`, 'DELETE');
    expect(partly.status).toBe(403);
    expect(await partly.json()).toEqual({
        error: 'Only an admin can delete subpages someone else created.',
    });
    expect(workspace.pages.list(space)).toHaveLength(4);

    expect(await json(alice(`${path}?subpages=true`, 'DELETE'))).toEqual({
        deleted: [root.id, child.id, grandchild.id],
    });
    expect(workspace.pages.list(space).map((page) => page.id)).toEqual([sibling.id]);
    for (const page of [root, child, grandchild]) {
        expect(() => workspace.pages.get(space, page.id)).toThrow('This page was deleted.');
    }
    // A deleted parent takes no new subpages.
    await expect(workspace.pages.create(space, { title: 'Late', parentId: child.id })).rejects.toThrow(
        'This page was deleted.',
    );
});

it('keeps conversations about a deleted page as ordinary ones and its review receipts', async () => {
    const { space, bob, workspace } = await fixture();
    const dot = workspace.dots()[0];
    const page = await workspace.pages.create(space, { title: 'Discussed' }, null, 'bob');
    await workspace.pages.reserveThread(page.id, dot.id, 'bob', 'page-thread');
    workspace.bindThread('page-thread', dot.id, 'Discussed', 'bob');
    await workspace.pages.finishThread(page.id, dot.id, 'bob');
    workspace.bindThread('review-thread', dot.id, 'Review', 'bob');
    const reviewed = await workspace.pages.createReviewed(
        space,
        { title: 'Reviewed', content: 'Body' },
        'review-thread',
        'call-1',
        'bob',
    );
    expect(reviewed.createdBy).toBe('bob');
    expect(workspace.pages.forThread('page-thread')?.id).toBe(page.id);
    // A page conversation can't be deleted while it belongs to a page.
    await expect(workspace.deleteThread('page-thread', 'bob')).rejects.toThrow('Conversation belongs to a page.');

    for (const id of [page.id, reviewed.id]) {
        expect((await bob(`/spaces/${space}/pages/${id}`, 'DELETE')).status).toBe(200);
    }
    // The conversation is detached, and stays the owner's.
    expect(workspace.pages.thread(page.id, dot.id, 'bob')).toBeUndefined();
    expect(workspace.pages.forThread('page-thread')).toBeUndefined();
    expect(workspace.thread('page-thread')?.ownerId).toBe('bob');
    expect((await bob('/conversations/page-thread/page-context')).status).toBe(200);
    expect(await json(bob('/conversations/page-thread/page-context'))).toBeNull();
    await workspace.deleteThread('page-thread', 'bob');
    // The review card learns the saved page was deleted; the same review
    // can't be saved again as a new page.
    const receipt = await bob('/conversations/review-thread/reviewed-page/call-1');
    expect(receipt.status).toBe(410);
    expect(await receipt.json()).toEqual({ error: 'This page was deleted.' });
    await expect(
        workspace.pages.createReviewed(space, { title: 'Reviewed', content: 'Body' }, 'review-thread', 'call-1', 'bob'),
    ).rejects.toThrow('This page was deleted.');
    expect(workspace.pages.list(space)).toEqual([]);
});

it('records the conversation owner as creator of pages Dots write, and gives Dots a delete tool for pages they created', async () => {
    const { space, workspace } = await fixture();
    const dot = workspace.dots()[0];
    const thread = workspace.bindThread('t1', dot.id, 'Chat', 'dave');
    const access = pageAccess(workspace, space, thread.id, () => {});
    expect((await access.create({ title: 'From Dot' })).createdBy).toBe('dave');
    // CB-328: the socio has a delete_space_page tool for pages the person it
    // acts for created (or in a Space they may edit), soft-delete only.
    expect('delete' in access).toBe(true);
    expect(
        pageTools(access)
            .map((tool) => tool.name)
            .filter((name) => /delete|remove/.test(name)),
    ).toEqual(['delete_space_page']);
});
