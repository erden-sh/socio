import { afterEach, expect, it } from 'vitest';

import type { Conversation, WorkspaceState } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { testWorkspaceViews } from './helpers/page-views.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// Archiving a chat (PATCH { archived }) takes it out of the owner's lists and
// keeps it theirs: by link, with its history and its tasks. Only the owner
// archives, as only they rename.
const SECRET = 'archive-chats-secret-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const { app, store, workspace, platform, dispose } = await makeTestRuntime({
        config: { baseUrl: 'https://model.invalid/v1', apiKey: 'unused', model: 'qwen-test', runtimeUrl: '' },
        app: {
            auth: {
                provider: new MockAuthProvider(DEFAULT_MOCK_USERS, SECRET),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    const signIn = async (userId: string) => {
        const response = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        return response.headers.get('set-cookie')!.split(';')[0];
    };
    const as =
        (cookie: string) =>
        (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...headers,
                    ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const alice = as(await signIn('alice'));
    const bob = as(await signIn('bob'));
    const dot = workspace.dots()[0]!;
    const create = (owner: string, id: string, title: string) => workspace.bindThread(id, dot.id, title, owner);
    const shell = async (who: typeof alice) => (await (await who('/workspace')).json()) as WorkspaceState;
    const ids = (list: Conversation[] | undefined) => (list ?? []).map((thread) => thread.id);
    return { alice, bob, dot, create, shell, ids, workspace, store, platform };
}

it('archives an owned chat: out of the list, into the archived list, still the same chat', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    f.create('alice', 'c2', 'Seed order');
    const before = Date.now();
    const response = await f.alice('/conversations/c1', 'PATCH', {
        archived: true,
    });
    expect(response.status).toBe(200);
    const archived = (await response.json()) as Conversation;
    expect(archived).toMatchObject({ id: 'c1', title: 'Garden plan' });
    expect(archived.archivedAt).toBeGreaterThanOrEqual(before);
    // Who archived it stays in the store.
    expect(archived).not.toHaveProperty('archivedBy');
    const shell = await f.shell(f.alice);
    expect(f.ids(shell.conversations)).toEqual(['c2']);
    expect(f.ids(shell.archived)).toEqual(['c1']);
    expect(shell.archived![0]!.archivedAt).toBe(archived.archivedAt);
    // A live chat carries no archive date at all.
    expect(shell.conversations[0]).not.toHaveProperty('archivedAt');
    // The row is the same row: by id it is still there, stamped.
    expect(f.workspace.thread('c1')).toMatchObject({
        archivedAt: archived.archivedAt,
    });
    expect(f.workspace.db.prepare('SELECT archivedBy, deletedAt FROM thread_bindings WHERE id=?').get('c1')).toEqual({
        archivedBy: 'alice',
        deletedAt: null,
    });
    // Archive is not a delete: no audit line.
    expect(f.workspace.auditOf('conversation', 'c1')).toEqual([]);
});

it('unarchives it back into the list, and archiving twice keeps the first date', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    const first = f.workspace.setArchived('c1', true, 'alice', 1_000)!;
    expect(first.archivedAt).toBe(1_000);
    f.workspace.setArchived('c1', true, 'alice', 2_000);
    expect(f.workspace.thread('c1')?.archivedAt).toBe(1_000);
    const response = await f.alice('/conversations/c1', 'PATCH', {
        archived: false,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('archivedAt');
    const shell = await f.shell(f.alice);
    expect(f.ids(shell.conversations)).toEqual(['c1']);
    expect(shell.archived).toEqual([]);
    expect(f.workspace.db.prepare('SELECT archivedAt, archivedBy FROM thread_bindings WHERE id=?').get('c1')).toEqual({
        archivedAt: null,
        archivedBy: null,
    });
    // Unarchiving a chat that isn't archived changes nothing.
    expect((await f.alice('/conversations/c1', 'PATCH', { archived: false })).status).toBe(200);
});

it('lists archived chats the last archived first, the owner’s only', async () => {
    const f = await fixture();
    f.create('alice', 'old', 'Old chat');
    f.create('alice', 'new', 'New chat');
    f.create('bob', 'bobs', 'Bob’s chat');
    f.workspace.setArchived('new', true, 'alice', 1_000);
    f.workspace.setArchived('old', true, 'alice', 2_000);
    f.workspace.setArchived('bobs', true, 'bob', 3_000);
    expect(f.ids(await f.workspace.archivedConversations('alice'))).toEqual(['old', 'new']);
    expect(f.ids((await f.shell(f.alice)).archived)).toEqual(['old', 'new']);
    expect(f.ids((await f.shell(f.bob)).archived)).toEqual(['bobs']);
    expect(f.ids((await f.shell(f.bob)).conversations)).toEqual([]);
});

it('answers 404 to anyone but the owner, and leaves the chat as it was', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    for (const archived of [true, false]) {
        const response = await f.bob('/conversations/c1', 'PATCH', { archived });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
            error: 'Conversation not found.',
        });
    }
    expect(f.workspace.thread('c1')).not.toHaveProperty('archivedAt');
    // Missing chats are the same 404.
    expect((await f.alice('/conversations/nope', 'PATCH', { archived: true })).status).toBe(404);
});

it('refuses to archive a team topic its members are only in', async () => {
    const f = await fixture();
    f.workspace.bindThread('team', f.dot.id, 'Team plans', 'telegram-team:chat-1');
    await f.workspace.telegram.recordMember('chat-1', 'bob');
    await f.workspace.telegram.bindThread('chat-1:7', 'team', 'topic', 'chat-1', '7');
    expect(f.ids((await f.shell(f.bob)).conversations)).toEqual(['team']);
    const response = await f.bob('/conversations/team', 'PATCH', {
        archived: true,
    });
    expect(response.status).toBe(404);
    expect(f.workspace.thread('team')).not.toHaveProperty('archivedAt');
    const shell = await f.shell(f.bob);
    expect(f.ids(shell.conversations)).toEqual(['team']);
    expect(shell.archived).toEqual([]);
});

it('treats a deleted chat as missing, archived or not', async () => {
    const f = await fixture();
    f.create('alice', 'gone', 'Gone');
    f.create('alice', 'gone-archived', 'Gone, archived');
    f.workspace.setArchived('gone-archived', true, 'alice');
    await f.workspace.deleteThread('gone', 'alice');
    // Deleted from the archived list (its Delete).
    expect((await f.alice('/conversations/gone-archived', 'DELETE')).status).toBe(200);
    for (const id of ['gone', 'gone-archived']) {
        const response = await f.alice(`/conversations/${id}`, 'PATCH', {
            archived: id === 'gone',
        });
        expect(response.status, id).toBe(404);
    }
    const shell = await f.shell(f.alice);
    expect(shell.conversations).toEqual([]);
    expect(shell.archived).toEqual([]);
    // The deleted, archived row keeps both stamps.
    expect(
        f.workspace.db.prepare('SELECT archivedBy, deletedBy FROM thread_bindings WHERE id=?').get('gone-archived'),
    ).toEqual({ archivedBy: 'alice', deletedBy: 'alice' });
    expect(f.workspace.setArchived('gone', true, 'alice')).toBeUndefined();
});

it('refuses a body that isn’t a yes or no', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    for (const body of [{ archived: 'yes' }, { archived: 1 }, { archived: null }, { archived: true, extra: 1 }]) {
        const response = await f.alice('/conversations/c1', 'PATCH', body);
        expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await (await f.alice('/conversations/c1', 'PATCH', { archived: 'yes' })).json()).toEqual({
        error: 'Say whether the chat is archived (true or false).',
    });
    expect(f.workspace.thread('c1')).not.toHaveProperty('archivedAt');
    // Renaming and archiving at once does both.
    const both = await f.alice('/conversations/c1', 'PATCH', {
        title: 'Garden, done',
        archived: true,
    });
    expect(await both.json()).toMatchObject({
        title: 'Garden, done',
        renamed: true,
        archivedAt: expect.any(Number),
    });
});

it('opens an archived chat by its link: transcript, capture, delete info and new turns', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    f.workspace.saveCapture('c1', { summary: 'kept' });
    f.workspace.setArchived('c1', true, 'alice');
    const transcript = await f.alice('/conversations/c1/transcript');
    expect(transcript.status).toBe(200);
    expect(((await transcript.json()) as { conversation: Conversation }).conversation).toMatchObject({
        id: 'c1',
        archivedAt: expect.any(Number),
    });
    expect(await (await f.alice('/conversations/c1/capture')).json()).toEqual({
        summary: 'kept',
    });
    expect((await f.alice('/conversations/c1/deletion')).status).toBe(200);
    // The runtime and tools act on it as on any chat of hers: a message
    // sent there runs, and the chat stays archived.
    expect(f.workspace.requireOwnedThread('alice', 'c1').id).toBe('c1');
    expect((await f.workspace.readableThread('alice', 'c1'))?.archivedAt).toBeDefined();
    expect(() => f.workspace.requireOwnedThread('bob', 'c1')).toThrow();
});

it('keeps an archived chat’s scheduled tasks running', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    const task = await f.store.createTask('Water the beans', 3600, 'alice');
    await f.workspace.bindTask(task.id, 'c1');
    f.workspace.setArchived('c1', true, 'alice');
    expect(await f.store.task(task.id)).toBeDefined();
    expect((await f.store.tasks('alice')).map((item) => item.id)).toEqual([task.id]);
    expect((await f.platform.deletion('c1', 'alice')).scheduledTasks).toBe(1);
    expect((await f.store.claim())?.id).toBe(task.id);
});

it('changes the polled workspace version on archive and unarchive, for the owner only', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    const tag = async (who: typeof f.alice) => (await who('/workspace')).headers.get('etag')!;
    for (const archived of [true, false]) {
        const aliceTag = await tag(f.alice);
        const bobTag = await tag(f.bob);
        expect(
            (
                await f.alice('/workspace', 'GET', undefined, {
                    'If-None-Match': aliceTag,
                })
            ).status,
        ).toBe(304);
        await f.alice('/conversations/c1', 'PATCH', { archived });
        const again = await f.alice('/workspace', 'GET', undefined, {
            'If-None-Match': aliceTag,
        });
        expect(again.status, `archived: ${archived}`).toBe(200);
        expect(f.ids(((await again.json()) as WorkspaceState).archived)).toEqual(archived ? ['c1'] : []);
        expect((await f.bob('/workspace', 'GET', undefined, { 'If-None-Match': bobTag })).status).toBe(304);
    }
});

it('serves the same lists to the page loader as to the API', async () => {
    const f = await fixture();
    f.create('alice', 'c1', 'Garden plan');
    f.create('alice', 'c2', 'Seed order');
    f.workspace.setArchived('c1', true, 'alice');
    const view = await testWorkspaceViews(f.platform).workspaceView({
        id: 'alice',
        name: 'Alice',
        role: 'admin',
    });
    expect(f.ids(view.conversations)).toEqual(['c2']);
    expect(f.ids(view.archived)).toEqual(['c1']);
    const api = await f.shell(f.alice);
    expect(f.ids(api.conversations)).toEqual(f.ids(view.conversations));
    expect(f.ids(api.archived)).toEqual(f.ids(view.archived));
});
