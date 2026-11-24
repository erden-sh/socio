import { afterEach, expect, it } from 'vitest';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';

import { makeTestRuntime } from './helpers/test-runtime.js';

const SECRET = 'isolation-secret-0123456789abcdef';
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function fixture() {
    const { app, store, workspace, dispose } = await makeTestRuntime({
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
        (path: string, method = 'GET', body?: unknown) =>
            app.request(path, {
                method,
                headers: {
                    cookie,
                    ...(['GET', 'HEAD'].includes(method) ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    const alice = as(await signIn('alice'));
    const bob = as(await signIn('bob'));
    const dot = workspace.dots()[0];
    const created = await alice('/api/conversations', 'POST', {
        dotId: dot.id,
        title: 'Alice only',
    });
    const thread = (await created.json()) as { id: string };
    const call = workspace.createCall(thread.id);
    return { alice, bob, dot, thread, call, workspace, store };
}

it("hides a user's conversations and calls from everyone else", async () => {
    const { alice, bob, thread, call } = await fixture();
    const aliceView = await (await alice('/api/workspace')).json();
    const bobView = await (await bob('/api/workspace')).json();
    expect(aliceView.user).toMatchObject({ id: 'alice' });
    expect(aliceView.conversations.map((t: { id: string }) => t.id)).toEqual([thread.id]);
    expect(aliceView.calls.map((c: { id: string }) => c.id)).toEqual([call.id]);
    expect(bobView.user).toMatchObject({ id: 'bob' });
    expect(bobView.conversations).toEqual([]);
    expect(bobView.calls).toEqual([]);
});

it("refuses every route that takes another user's thread or call", async () => {
    const { alice, bob, dot, thread, call } = await fixture();
    const id = thread.id;
    const run = (threadId: string) => ({
        threadId,
        runId: 'run',
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
    });
    const attempts: Array<[string, string, unknown?]> = [
        ['GET', `/api/conversations/${id}/capture`],
        ['GET', `/api/conversations/${id}/page-context`],
        ['GET', `/api/conversations/${id}/reviewed-page/tool-1`],
        [
            'POST',
            `/api/conversations/${id}/reviewed-page`,
            {
                toolCallId: 'tool-1',
                spaceId: dot.spaceId,
                title: 'Draft',
                content: '# Draft',
            },
        ],
        ['POST', `/api/conversations/${id}/page`, { title: 'Saved' }],
        ['POST', '/api/voice/calls', { threadId: id, sdp: 'v=0' }],
        ['GET', `/api/voice/calls/${call.id}`],
        ['POST', `/api/voice/calls/${call.id}/active`, {}],
        ['POST', `/api/voice/calls/${call.id}/compute`, { toolCallId: 't', request: 'hello' }],
        ['POST', `/api/voice/calls/${call.id}/end`, { transcript: '' }],
        ['POST', '/api/tasks', { prompt: 'Daily check', threadId: id }],
        ['POST', `/api/copilotkit/agent/${dot.id}/run`, run(id)],
        ['POST', `/api/copilotkit/agent/${dot.id}/connect`, run(id)],
        ['POST', `/api/copilotkit/agent/${dot.id}/suggest`, run(id)],
        ['POST', `/api/copilotkit/agent/${dot.id}/stop/${id}`, {}],
        ['DELETE', `/api/conversations/${id}`],
    ];
    for (const [method, path, body] of attempts) {
        const response = await bob(path, method, body);
        expect([403, 404], `${method} ${path}`).toContain(response.status);
    }
    // The owner still reaches the same thread.
    expect((await alice(`/api/conversations/${id}/capture`)).status).toBe(200);
    expect((await alice(`/api/conversations/${id}/page-context`)).status).toBe(200);
});

it('gives each user their own conversation about the same page', async () => {
    const { alice, bob, dot, workspace } = await fixture();
    const page = await workspace.pages.create(dot.spaceId, { title: 'Plan' });
    const path = `/api/spaces/${dot.spaceId}/pages/${page.id}/conversation`;
    const first = await (await alice(path, 'POST', { dotId: dot.id })).json();
    const again = await (await alice(path, 'POST', { dotId: dot.id })).json();
    const other = await (await bob(path, 'POST', { dotId: dot.id })).json();
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(workspace.thread(first.id)?.ownerId).toBe('alice');
    expect(workspace.thread(other.id)?.ownerId).toBe('bob');
});

it("keeps each user's tasks and memories private", async () => {
    const { alice, bob, thread, store } = await fixture();
    const task = await (
        await alice('/api/tasks', 'POST', {
            prompt: 'Weekly summary',
            threadId: thread.id,
        })
    ).json();
    const memory = await (await alice('/api/memories', 'POST', { text: 'Prefers bullet points' })).json();
    const bobState = await (await bob('/api/state')).json();
    expect(bobState.tasks).toEqual([]);
    expect(bobState.memories).toEqual([]);
    for (const [method, path, body] of [
        ['GET', `/api/tasks/${task.id}`],
        ['POST', `/api/tasks/${task.id}/actions`, { action: 'pause' }],
        ['PUT', `/api/tasks/${task.id}/schedule`, { intervalSeconds: 3600 }],
        ['PUT', `/api/memories/${memory.id}`, { text: 'Overwritten' }],
        ['DELETE', `/api/memories/${memory.id}`],
    ] as Array<[string, string, unknown?]>) {
        expect((await bob(path, method, body)).status, `${method} ${path}`).toBe(404);
    }
    // Even the repository, given another user's id, cannot take it over.
    expect(await store.memoryItems.update(memory.id, 'bob', { text: 'Hijack' })).toBeUndefined();
    expect(await store.memoryItems.forget(memory.id, 'bob')).toBe(false);
    const aliceState = await (await alice('/api/state')).json();
    expect(aliceState.tasks.map((t: { id: string }) => t.id)).toEqual([task.id]);
    expect(aliceState.memories).toEqual([expect.objectContaining({ id: memory.id, text: 'Prefers bullet points' })]);
});

it('lets an owner delete a conversation with its tasks, and nothing else', async () => {
    const { alice, bob, dot, workspace, store } = await fixture();
    const create = async (as: typeof alice, title: string) =>
        (await (await as('/api/conversations', 'POST', { dotId: dot.id, title })).json()) as { id: string };
    const doomed = await create(alice, 'Exit test schedule');
    const kept = await create(alice, 'Keep me');
    const bobs = await create(bob, 'Bob only');
    const task = await (
        await alice('/api/tasks', 'POST', {
            prompt: 'Reply with osprey',
            threadId: doomed.id,
        })
    ).json();
    const keptTask = await (await alice('/api/tasks', 'POST', { prompt: 'Keep', threadId: kept.id })).json();
    workspace.saveCapture(doomed.id, { draft: 'x' });
    const ended = workspace.createCall(doomed.id);
    workspace.setCall(ended.id, 'ended', 'Bye');

    const deleted = await alice(`/api/conversations/${doomed.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(workspace.thread(doomed.id)).toBeUndefined();
    // CB-64: hidden, not lost; what went with it stays bound to it.
    expect(await workspace.threadTasks(doomed.id)).toEqual([task.id]);
    // Its calls are kept, but not listed (CB-64 review).
    expect(workspace.calls().map((c) => c.threadId)).not.toContain(doomed.id);
    expect(workspace.db.prepare('SELECT id FROM calls WHERE id=?').get(ended.id)).toEqual({ id: ended.id });
    expect(() => workspace.call(ended.id)).toThrow();
    expect(await store.task(task.id)).toBeUndefined();
    expect(await store.detail(task.id)).toBeUndefined();
    const state = await (await alice('/api/state')).json();
    expect(state.tasks.map((t: { id: string }) => t.id)).toEqual([keptTask.id]);
    const view = await (await alice('/api/workspace')).json();
    expect(view.conversations.map((t: { id: string }) => t.id)).toContain(kept.id);
    expect(workspace.thread(bobs.id)?.ownerId).toBe('bob');
    // Gone for its owner: a second delete is a 404.
    expect((await alice(`/api/conversations/${doomed.id}`, 'DELETE')).status).toBe(404);
    // Nobody deletes someone else's conversation, admins included.
    expect((await alice(`/api/conversations/${bobs.id}`, 'DELETE')).status).toBe(404);
    expect(workspace.thread(bobs.id)).toBeDefined();
});

it('refuses to delete a busy, Telegram or page conversation', async () => {
    const { alice, dot, thread, workspace, store } = await fixture();
    const remove = (id: string) => alice(`/api/conversations/${id}`, 'DELETE');
    // The fixture's call is still connecting.
    const calling = await remove(thread.id);
    expect(calling.status).toBe(409);
    expect((await calling.json()).error).toMatch(/End the current call/);

    const busy = await (await alice('/api/conversations', 'POST', { dotId: dot.id, title: 'Busy' })).json();
    const task = await (await alice('/api/tasks', 'POST', { prompt: 'Long one', threadId: busy.id })).json();
    expect((await store.claim())?.id).toBe(task.id);
    const running = await remove(busy.id);
    expect(running.status).toBe(409);
    expect((await running.json()).error).toMatch(/Stop the current run/);
    expect((await store.task(task.id))?.status).toBe('running');

    const telegram = await (await alice('/api/conversations', 'POST', { dotId: dot.id, title: 'TG' })).json();
    await workspace.telegram.bindThread('dm:1', telegram.id, 'dm', '1', null);
    expect((await remove(telegram.id)).status).toBe(409);

    const page = await workspace.pages.create(dot.spaceId, { title: 'Plan' });
    const pageThread = await (
        await alice(`/api/spaces/${dot.spaceId}/pages/${page.id}/conversation`, 'POST', {
            dotId: dot.id,
        })
    ).json();
    expect((await remove(pageThread.id)).status).toBe(409);
    for (const id of [thread.id, busy.id, telegram.id, pageThread.id]) {
        expect(workspace.thread(id)).toBeDefined();
    }
});

it('lets only admins manage Spaces, company Dots, permissions and global settings', async () => {
    const { alice, bob, dot } = await fixture();
    const dotBody = {
        name: 'Researcher',
        instructions: 'Find primary sources.',
        researchAllowed: true,
        memoryAllowed: false,
        spaceId: dot.spaceId,
    };
    // A member's POST /api/dots makes a Dot of their own (personal-dots.test.ts).
    // A Space for everyone is an admin's; a member's own is private (CB-181,
    // spaces-access-matrix.test.ts).
    const manage: Array<[string, string, unknown]> = [
        ['PUT', `/api/dots/${dot.id}`, { ...dotBody, name: 'Renamed', spaceId: undefined }],
        ['PATCH', `/api/dots/${dot.id}/computer/permissions`, { browser: true, files: false, shell: false }],
        ['PATCH', '/api/settings', { paused: true }],
    ];
    const open = await bob('/api/spaces', 'POST', {
        name: 'Launch',
        private: false,
    });
    expect(open.status).toBe(403);
    expect((await bob('/api/spaces', 'POST', { name: 'Mine', private: true })).status).toBe(201);
    for (const [method, path, body] of manage) {
        const member = await bob(path, method, body);
        expect(member.status, `member ${method} ${path}`).toBe(403);
        expect(await member.json()).toEqual({
            error: 'Only an admin can change this.',
        });
    }
    for (const [method, path, body] of manage) {
        const admin = await alice(path, method, body);
        expect(admin.status, `admin ${method} ${path}`).not.toBe(403);
        expect(admin.status, `admin ${method} ${path}`).not.toBe(401);
    }
    // An admin explicitly shares a company Dot: members see it.
    expect((await alice('/api/dots', 'POST', { ...dotBody, personal: false })).status).toBe(201);
    // Members still read the shared workspace and edit pages.
    const view = await (await bob('/api/workspace')).json();
    expect(view.spaces.length).toBeGreaterThan(1);
    expect(view.dots.length).toBeGreaterThan(1);
    const created = await bob(`/api/spaces/${dot.spaceId}/pages`, 'POST', {
        title: 'Member notes',
    });
    expect(created.status).toBe(201);
});
