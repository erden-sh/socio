import { afterEach, expect, it } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { Conversation, Memory, Task, User } from '@socio/shared/types';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { pageAccess } from '../src/server/pages/page-tools.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-64 pass 1: a deleted thing is gone from every listing and lookup for
// users and Dots, and its row is still in the database.
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
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
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
    return {
        store,
        workspace,
        platform,
        space: workspace.spaces()[0].id,
        dot: workspace.dots()[0],
        alice: await as('alice'),
        bob: await as('bob'),
    };
}
const json = async <T>(response: Response | Promise<Response>) => (await (await response).json()) as T;

it('hides a deleted conversation and its scheduled tasks everywhere, and keeps them', async () => {
    const { store, workspace, platform, dot, bob } = await fixture();
    const kept = workspace.bindThread('kept', dot.id, 'Kept', 'bob');
    const gone = workspace.bindThread('gone', dot.id, 'Gone', 'bob');
    const task = await store.createTask('Look into herons', 3600, 'bob');
    await workspace.bindTask(task.id, gone.id);
    const call = workspace.createCall(gone.id);
    workspace.setCall(call.id, 'ended', 'We talked about herons.');

    expect((await bob('/conversations/gone', 'DELETE')).status).toBe(200);

    // The sidebar poll (which also feeds the ⌘K palette) and its calls.
    const poll = await json<{
        conversations: Conversation[];
        calls: { id: string }[];
    }>(bob('/workspace'));
    expect(poll.conversations.map((item) => item.id)).toEqual([kept.id]);
    expect(poll.calls).toEqual([]);
    // By id: the same answer as a conversation that never existed.
    for (const path of ['/conversations/gone/transcript', '/conversations/gone/capture', `/voice/calls/${call.id}`]) {
        const response = await bob(path);
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual(await json(bob(path.replace(/gone|[0-9a-f-]{36}/, 'never'))));
    }
    expect((await bob('/conversations/gone', 'PATCH', { inference: null })).status).toBe(404);
    expect((await bob('/conversations/gone', 'DELETE')).status).toBe(404);
    // Its tasks: not listed, not readable, never claimed by the worker.
    const state = await json<{ tasks: Task[] }>(bob('/state'));
    expect(state.tasks).toEqual([]);
    expect((await bob(`/tasks/${task.id}`)).status).toBe(404);
    expect(await store.claim(Date.now() + 10 * 3600_000)).toBeNull();
    // Nothing can be scheduled into it, or called, either.
    await expect(workspace.bindTask('another', 'gone')).rejects.toThrow();
    expect(() => workspace.createCall('gone')).toThrow();

    // Kept: the rows, stamped, with what went with what.
    expect(workspace.withDeletedThread('gone')).toMatchObject({
        title: 'Gone',
        deletedBy: 'bob',
        deletedAt: expect.any(Number),
    });
    expect(await store.withDeletedTask(task.id)).toMatchObject({
        prompt: 'Look into herons',
        deletedBy: 'bob',
        deletedWith: 'conversation:gone',
    });
    expect(await store.detail(task.id)).toBeUndefined();
    // The call is kept, but no longer listed, even internally (voice resume).
    expect(workspace.calls()).toEqual([]);
    expect(workspace.db.prepare('SELECT id FROM calls WHERE threadId=?').all('gone')).toEqual([{ id: call.id }]);
    expect(await workspace.taskThread(task.id)).toBe('gone');
    expect(workspace.auditOf('conversation', 'gone')).toMatchObject([
        { actor: 'bob', action: 'delete', detail: 'with 1 scheduled task' },
    ]);
    expect(platform.workspace.deletedThreadIds()).toEqual(['gone']);
});

it('skips the learning evidence of a deleted conversation', async () => {
    const { workspace, platform } = await fixture();
    const dot = workspace.createDot(
        workspace.spaces()[0].id,
        'Learner',
        'Learn things.',
        false,
        false,
        undefined,
        'herons',
    );
    for (const id of ['a', 'b']) {
        workspace.bindThread(id, dot.id, id, 'bob');
        workspace.evidence.record(id, 'finished');
    }
    expect(workspace.evidence.count('herons')).toBe(2);
    await platform.deleteConversation('a', 'bob');
    expect(workspace.evidence.count('herons')).toBe(1);
    expect(workspace.evidence.pending('herons').map((item) => item.threadId)).toEqual(['b']);
});

it('hides a deleted memory from its user and their socios, and keeps it', async () => {
    const { store, workspace, bob, alice } = await fixture();
    const kept = await json<Memory>(bob('/memories', 'POST', { text: 'Tea' }));
    const gone = await json<Memory>(bob('/memories', 'POST', { text: 'Short briefs' }));
    // Only its owner can delete it.
    expect((await alice(`/memories/${gone.id}`, 'DELETE')).status).toBe(404);
    expect((await bob(`/memories/${gone.id}`, 'DELETE')).status).toBe(200);

    const state = await json<{ memories: Memory[] }>(bob('/state'));
    expect(state.memories.map((memory) => memory.id)).toEqual([kept.id]);
    // What Dots get in their prompts.
    expect((await store.memoryItems.active('bob')).map((memory) => memory.text)).toEqual(['Tea']);
    // Editing or deleting it again is a 404, as for a missing one.
    expect((await bob(`/memories/${gone.id}`, 'PUT', { text: 'Long briefs' })).status).toBe(404);
    expect((await bob(`/memories/${gone.id}`, 'DELETE')).status).toBe(404);
    expect(await store.memoryItems.update(gone.id, 'bob', { text: 'Long briefs' })).toBeUndefined();

    expect(await store.memoryItems.withDeleted(gone.id)).toMatchObject({
        text: 'Short briefs',
        deletedBy: 'bob',
        deletedAt: expect.any(Number),
    });
    expect(workspace.auditOf('memory', gone.id)).toMatchObject([{ actor: 'bob', action: 'delete' }]);
});

it('hides a deleted page and its subpages from the routes, the palette and socio tools, and keeps them', async () => {
    const { workspace, dot, space, bob } = await fixture();
    const create = (title: string, parentId: string | null = null) =>
        json<Page>(bob(`/spaces/${space}/pages`, 'POST', { title, parentId }));
    const kept = await create('Kept');
    const root = await create('Plan');
    const child = await create('Child', root.id);
    const early = await create('Early', root.id);
    // A subpage deleted on its own first keeps its own stamp.
    expect((await bob(`/spaces/${space}/pages/${early.id}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/spaces/${space}/pages/${root.id}?subpages=true`, 'DELETE')).status).toBe(200);

    // The Space's list, the ⌘K palette's titles, the sidebar's tree and by id.
    expect((await json<Page[]>(bob(`/spaces/${space}/pages`))).map((page) => page.id)).toEqual([kept.id]);
    expect((await json<Page[]>(bob('/pages/titles'))).map((page) => page.id)).toEqual([kept.id]);
    expect((await json<Page[]>(bob(`/spaces/${space}/page-tree`))).map((page) => page.id)).toEqual([kept.id]);
    for (const id of [root.id, child.id, early.id]) {
        const response = await bob(`/spaces/${space}/pages/${id}`);
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({ error: 'This page was deleted.' });
        expect(
            (
                await bob(`/spaces/${space}/pages/${id}`, 'PATCH', {
                    title: 'Back',
                    expectedRevision: 1,
                })
            ).status,
        ).toBe(410);
    }
    // A deleted parent takes no new subpages.
    expect(
        (
            await bob(`/spaces/${space}/pages`, 'POST', {
                title: 'Orphan',
                parentId: root.id,
            })
        ).status,
    ).toBe(410);
    // Dot tools: list_space_pages and read_space_page.
    workspace.bindThread('t1', dot.id, 'Chat', 'bob');
    const access = pageAccess(workspace, space, 't1', () => {});
    expect(access.list().map((page) => page.id)).toEqual([kept.id]);
    await expect(access.read(root.id)).rejects.toThrow('This page was deleted.');
    await expect(access.edit(root.id, { title: 'Back', expectedRevision: 1 })).rejects.toThrow(
        'This page was deleted.',
    );
    // Page search, through the route and search_space_pages: only the kept
    // page, whichever words or text inside words are asked for.
    const searched = async (query: string) =>
        (await json<{ results: { id: string }[] }>(bob(`/spaces/search?q=${query}`))).results.map((hit) => hit.id);
    for (const query of ['plan', 'child', 'early', 'hild', 'arl']) {
        expect(await searched(query), query).toEqual([]);
    }
    expect(await searched('kept')).toEqual([kept.id]);
    expect(access.search({ query: 'plan' }).results.map((hit) => hit.id)).toEqual([]);
    expect(access.search({ query: 'kept' }).results.map((hit) => hit.id)).toEqual([kept.id]);

    // Kept, with what went with what.
    expect(workspace.pages.withDeleted(root.id)).toMatchObject({
        title: 'Plan',
        deletedBy: 'bob',
        deletedWith: null,
    });
    expect(workspace.pages.withDeleted(child.id)).toMatchObject({
        title: 'Child',
        deletedBy: 'bob',
        deletedWith: `page:${root.id}`,
    });
    expect(workspace.pages.withDeleted(early.id)).toMatchObject({
        deletedWith: null,
    });
    expect(workspace.pages.withDeleted(early.id)!.deletedAt).toBeLessThanOrEqual(
        workspace.pages.withDeleted(root.id)!.deletedAt!,
    );
    expect(workspace.auditOf('page', root.id)).toMatchObject([
        { actor: 'bob', action: 'delete', detail: 'with 1 subpage' },
    ]);
    // New deletes leave no tombstone: the row says it.
    expect(workspace.db.prepare('SELECT COUNT(*) AS n FROM page_deletions').get()).toEqual({ n: 0 });
});

it('hides deleted socios and Spaces from the workspace and their users', async () => {
    const { workspace, platform, bob, space } = await fixture();
    const other = workspace.createSpace('Other', '');
    const dot = workspace.createDot(space, 'Gone', 'Be gone.', false, false, [space, other.id]);
    const hidden = await json<Page>(bob(`/spaces/${other.id}/pages`, 'POST', { title: 'Hidden' }));
    expect((await json<Page[]>(bob('/pages/titles'))).map((page) => page.id)).toContain(hidden.id);
    // No route deletes them yet (pass 1 adds the columns); stamp them.
    const now = Date.now();
    workspace.db.prepare("UPDATE dots SET deletedAt=?, deletedBy='alice' WHERE id=?").run(now, dot.id);
    workspace.db.prepare("UPDATE spaces SET deletedAt=?, deletedBy='alice' WHERE id=?").run(now, other.id);
    const poll = await json<{
        spaces: { id: string }[];
        dots: { id: string }[];
    }>(bob('/workspace'));
    expect(poll.spaces.map((item) => item.id)).toEqual([space]);
    expect(poll.dots.map((item) => item.id)).not.toContain(dot.id);
    expect(workspace.dot(dot.id)).toBeUndefined();
    expect((await bob(`/spaces/${other.id}/pages`)).status).toBe(404);
    expect((await bob(`/spaces/${other.id}/page-tree`)).status).toBe(404);
    expect((await json<Page[]>(bob('/pages/titles'))).map((page) => page.spaceId)).not.toContain(other.id);
    await expect(platform.createConversation(dot.id, 'Hello', 'bob')).rejects.toThrow('Socio not found.');
});

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
);
const png = (commentId?: string) => ({
    name: 'screen.png',
    mediaType: 'image/png',
    data: PNG.toString('base64'),
    ...(commentId ? { commentId } : {}),
});

it('hides deleted issues, comments and attachments from the tracker, search, export and the palette, and keeps them with their bytes', async () => {
    const { workspace, platform, alice, bob } = await fixture();
    type Detail = {
        comments: { id: string }[];
        attachments: { id: string }[];
    };
    const file = (number: number, commentId?: string) =>
        json<{ id: string }>(bob(`/issues/${number}/attachments`, 'POST', png(commentId)));
    await bob('/issues', 'POST', { title: 'Heron feeder breaks' });
    await bob('/issues', 'POST', { title: 'Heron nest moves' });
    // On issue 1: a comment with a file, and a file deleted on its own.
    const comment = await json<{ id: string }>(bob('/issues/1/comments', 'POST', { body: 'See the photo' }));
    const onComment = await file(1, comment.id);
    const loose = await file(1);
    expect((await bob(`/issue-attachments/${loose.id}`, 'DELETE')).status).toBe(200);
    expect((await bob(`/issue-attachments/${loose.id}`)).status).toBe(404);
    expect((await bob(`/issues/1/comments/${comment.id}`, 'DELETE')).status).toBe(200);
    let detail = await json<Detail>(bob('/issues/1'));
    expect(detail.comments).toEqual([]);
    expect(detail.attachments).toEqual([]);
    expect((await bob(`/issue-attachments/${onComment.id}`)).status).toBe(404);
    // A deleted comment can't be edited or take files.
    expect(
        (
            await bob(`/issues/1/comments/${comment.id}`, 'PATCH', {
                body: 'Edited',
            })
        ).status,
    ).toBe(404);
    expect((await bob('/issues/1/attachments', 'POST', png(comment.id))).status).toBe(404);

    // Issue 2: a comment and a file, then the issue goes (admins only).
    const second = await json<{ id: string }>(bob('/issues/2/comments', 'POST', { body: 'Second' }));
    const onIssue = await file(2);
    expect((await bob('/issues/2', 'DELETE')).status).toBe(403);
    expect((await alice('/issues/2', 'DELETE')).status).toBe(200);
    // The board, search (also the ⌘K palette's source), by number, export.
    const list = await json<{ issues: { number: number }[] }>(bob('/issues'));
    expect(list.issues.map((issue) => issue.number)).toEqual([1]);
    const search = await json<{ issues: { number: number }[] }>(bob('/issues?q=heron'));
    expect(search.issues.map((issue) => issue.number)).toEqual([1]);
    // The palette's issue commands read titles only.
    for (const path of ['/issues/titles', '/issues/titles?open=true']) {
        expect((await json<{ number: number }[]>(alice(path))).map((issue) => issue.number)).toEqual([1]);
    }
    const missing = await bob('/issues/2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual(await json(bob('/issues/99')));
    expect(await (await bob('/issues/export.md')).text()).not.toContain('Heron nest moves');
    expect((await bob(`/issue-attachments/${onIssue.id}`)).status).toBe(404);
    expect((await bob('/issues/2/comments', 'POST', { body: 'Late' })).status).toBe(404);
    expect((await alice('/issues/2', 'PATCH', { title: 'Back' })).status).toBe(404);
    // A new issue never takes the number.
    const next = await json<{ issue: { number: number } }>(bob('/issues', 'POST', { title: 'Next one' }));
    expect(next.issue.number).toBe(3);
    detail = await json<Detail>(bob('/issues/1'));
    expect(detail.comments).toEqual([]);

    // Kept: rows, stamps, bytes.
    const issues = platform.board.issues;
    const issueId = String((await issues.withDeleted(2))!.id);
    expect(await issues.withDeleted(2)).toMatchObject({
        title: 'Heron nest moves',
        deletedBy: 'alice',
    });
    const stamp = (table: string, id: string) => ({
        ...workspace.db.prepare(`SELECT deletedBy, deletedWith FROM ${table} WHERE id=?`).get(id),
    });
    expect(stamp('issue_comments', comment.id)).toEqual({
        deletedBy: 'bob',
        deletedWith: null,
    });
    expect(stamp('issue_attachments', onComment.id)).toEqual({
        deletedBy: 'bob',
        deletedWith: `comment:${comment.id}`,
    });
    expect(stamp('issue_attachments', loose.id)).toEqual({
        deletedBy: 'bob',
        deletedWith: null,
    });
    expect(stamp('issue_comments', second.id)).toEqual({
        deletedBy: 'alice',
        deletedWith: `issue:${issueId}`,
    });
    expect(stamp('issue_attachments', onIssue.id)).toEqual({
        deletedBy: 'alice',
        deletedWith: `issue:${issueId}`,
    });
    for (const id of [onComment.id, loose.id, onIssue.id]) {
        expect(Buffer.from((await issues.withDeletedAttachment(id))!.data as Uint8Array).equals(PNG)).toBe(true);
    }
});
