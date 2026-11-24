import { afterEach, expect, it } from 'vitest';

import type { Conversation } from '@socio/shared/types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-66: the chat menu's routes. Rename is the title on the existing PATCH;
// GET …/deletion tells the menu what Delete would take and what stops it.
const SECRET = 'chat-menu-secret-0123456789abcdef';
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
    const dot = workspace.dots()[0];
    const create = async (as: typeof alice, title: string) =>
        (await (await as('/conversations', 'POST', { dotId: dot.id, title })).json()) as Conversation;
    return { alice, bob, dot, create, workspace, store, platform };
}
const titles = async (as: (path: string) => Response | Promise<Response>) =>
    (
        (await (await as('/workspace')).json()) as {
            conversations: Conversation[];
        }
    ).conversations.map((thread) => thread.title);

it('renames an owned chat, trimmed, and marks it renamed', async () => {
    const { alice, create, workspace } = await fixture();
    const thread = await create(alice, 'Plan the offsite');
    expect(thread.renamed).toBeUndefined();
    const renamed = await alice(`/conversations/${thread.id}`, 'PATCH', {
        title: '  Offsite agenda  ',
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
        id: thread.id,
        title: 'Offsite agenda',
        renamed: true,
    });
    expect(await titles(alice)).toEqual(['Offsite agenda']);
    expect(workspace.thread(thread.id)).toMatchObject({ renamed: true });
    // Exactly 80 characters is fine.
    const longest = 'x'.repeat(80);
    expect((await alice(`/conversations/${thread.id}`, 'PATCH', { title: longest })).status).toBe(200);
    expect(workspace.thread(thread.id)?.title).toBe(longest);
});

it('keeps a renamed title over a generated one', async () => {
    const { alice, create, workspace } = await fixture();
    const generated = await create(alice, 'First message');
    const renamed = await create(alice, 'Another first message');
    await alice(`/conversations/${renamed.id}`, 'PATCH', { title: 'Mine' });
    // A title generated after the first run, even one already in flight.
    workspace.setAutomaticTitle(generated.id, 'Generated');
    workspace.setAutomaticTitle(renamed.id, 'Generated');
    expect(workspace.thread(generated.id)?.title).toBe('Generated');
    expect(workspace.thread(generated.id)?.renamed).toBeUndefined();
    expect(workspace.thread(renamed.id)?.title).toBe('Mine');
    // Renamed counts as titled: the titler doesn't ask again.
    expect(workspace.isTitled(renamed.id)).toBe(true);
});

it('refuses bad titles and leaves the chat as it was', async () => {
    const { alice, create, workspace } = await fixture();
    const thread = await create(alice, 'Keep me');
    for (const body of [
        { title: '' },
        { title: '   ' },
        { title: 'x'.repeat(81) },
        { title: 42 },
        { title: null },
        { title: 'Fine', extra: true },
    ]) {
        const response = await alice(`/conversations/${thread.id}`, 'PATCH', body);
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect(await response.json()).toEqual({
            error: 'Enter a title of 1 to 80 characters.',
        });
    }
    // A good title with a bad model: the model's message.
    const badModel = await alice(`/conversations/${thread.id}`, 'PATCH', {
        title: 'Fine',
        inference: { backendId: 42 },
    });
    expect(badModel.status).toBe(400);
    expect(await badModel.json()).toEqual({ error: 'Pick a model.' });
    // Neither a title nor a model: the model route's message, as before.
    const empty = await alice(`/conversations/${thread.id}`, 'PATCH', {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'Pick a model.' });
    expect(workspace.thread(thread.id)).toMatchObject({ title: 'Keep me' });
    expect(workspace.thread(thread.id)?.renamed).toBeUndefined();
    // The model alone still works.
    const model = await alice(`/conversations/${thread.id}`, 'PATCH', {
        inference: null,
    });
    expect(model.status).toBe(200);
    expect(await model.json()).toMatchObject({
        title: 'Keep me',
        inference: null,
    });
});

it("refuses to rename someone else's chat or a team chat", async () => {
    const { alice, bob, create, workspace } = await fixture();
    const thread = await create(alice, 'Alice only');
    for (const [method, body] of [
        ['PATCH', { title: 'Taken' }],
        ['GET', undefined],
    ] as const) {
        const path = `/conversations/${thread.id}${method === 'GET' ? '/deletion' : ''}`;
        expect((await bob(path, method, body)).status).toBe(404);
    }
    expect(workspace.thread(thread.id)?.title).toBe('Alice only');
    // A Telegram team topic bob is in: he reads it, nobody here renames it.
    workspace.bindThread('team-thread', workspace.dots()[0].id, 'Team plans', 'telegram-team:chat-1');
    await workspace.telegram.bindThread('chat-1:7', 'team-thread', 'topic', 'chat-1', '7');
    await workspace.telegram.recordMember('chat-1', 'bob');
    expect(await titles(bob)).toContain('Team plans');
    expect((await bob('/conversations/team-thread', 'PATCH', { title: 'Ours' })).status).toBe(404);
    expect((await bob('/conversations/team-thread/deletion')).status).toBe(404);
    expect(workspace.thread('team-thread')?.title).toBe('Team plans');
    // An unknown or deleted chat is missing too.
    expect((await alice('/conversations/nope', 'PATCH', { title: 'x' })).status).toBe(404);
    await alice(`/conversations/${thread.id}`, 'DELETE');
    expect((await alice(`/conversations/${thread.id}`, 'PATCH', { title: 'Back' })).status).toBe(404);
});

it('changes the polled workspace version on a rename', async () => {
    const { alice, bob, create } = await fixture();
    const thread = await create(alice, 'Before');
    const first = await alice('/workspace');
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const bobTag = (await bob('/workspace')).headers.get('etag')!;
    expect((await alice('/workspace', 'GET', undefined, { 'If-None-Match': etag })).status).toBe(304);
    await alice(`/conversations/${thread.id}`, 'PATCH', { title: 'After' });
    const next = await alice('/workspace', 'GET', undefined, {
        'If-None-Match': etag,
    });
    expect(next.status).toBe(200);
    expect(((await next.json()) as { conversations: Conversation[] }).conversations[0]).toMatchObject({
        title: 'After',
        renamed: true,
    });
    // Nobody else's shell changes.
    expect((await bob('/workspace', 'GET', undefined, { 'If-None-Match': bobTag })).status).toBe(304);
});

it('tells the menu what Delete takes and what stops it', async () => {
    const { alice, dot, create, workspace, store } = await fixture();
    const deletion = async (id: string) => (await alice(`/conversations/${id}/deletion`)).json();
    const plain = await create(alice, 'Plain');
    expect(await deletion(plain.id)).toEqual({
        scheduledTasks: 0,
        blocked: null,
    });
    const scheduled = await create(alice, 'Scheduled');
    for (const prompt of ['Daily check', 'Weekly check']) {
        await alice('/tasks', 'POST', { prompt, threadId: scheduled.id });
    }
    expect(await deletion(scheduled.id)).toEqual({
        scheduledTasks: 2,
        blocked: null,
    });
    // A bound task running: Delete waits for it.
    expect(await store.claim()).toBeDefined();
    expect(await deletion(scheduled.id)).toEqual({
        scheduledTasks: 2,
        blocked: 'running',
    });
    const calling = await create(alice, 'Calling');
    workspace.createCall(calling.id);
    expect(await deletion(calling.id)).toMatchObject({ blocked: 'call' });
    const telegram = await create(alice, 'Telegram');
    await workspace.telegram.bindThread('dm:1', telegram.id, 'dm', '1', null);
    expect(await deletion(telegram.id)).toMatchObject({ blocked: 'telegram' });
    const page = await workspace.pages.create(dot.spaceId, { title: 'Plan' });
    const pageThread = (await (
        await alice(`/spaces/${dot.spaceId}/pages/${page.id}/conversation`, 'POST', { dotId: dot.id })
    ).json()) as Conversation;
    expect(await deletion(pageThread.id)).toMatchObject({ blocked: 'page' });
    // What it says matches what DELETE does.
    for (const id of [scheduled.id, calling.id, telegram.id, pageThread.id]) {
        expect((await alice(`/conversations/${id}`, 'DELETE')).status).toBe(409);
    }
    expect((await alice(`/conversations/${plain.id}`, 'DELETE')).status).toBe(200);
});
