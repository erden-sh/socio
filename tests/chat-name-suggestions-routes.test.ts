import { Hono } from 'hono';
import { afterEach, expect, it } from 'vitest';

import type { AppEnv } from '@socio/foundation/http/app-env';

import { sqliteChatNameSuggestionRepository } from '../src/server/chat-name-suggestions/repository.js';
import { chatNameRoutes } from '../src/server/chat-name-suggestions/routes.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((fn) => fn()),
);

function app(repo = makeRepo()) {
    const hono = new Hono<AppEnv>();
    const applied: Array<{ threadId: string; name: string; by: string }> = [];
    const deps = {
        repo,
        applyName: (threadId: string, name: string, by: string) => {
            applied.push({ threadId, name, by });
            return name;
        },
        mayReview: (threadId: string, userId: string) => {
            // Rooms: only admin. Private: only owner. Tests pass ids like
            // 'room-admin'/'room-member'/'owner' to encode the case.
            if (threadId.startsWith('room')) {
                return userId === 'room-admin';
            }
            return userId === 'owner';
        },
        messageCount: async () => 42,
        now: () => 1000,
    };
    hono.use('*', async (c, next) => {
        c.set('user', { id: c.req.header('x-user') ?? 'owner' } as never);
        await next();
    });
    hono.route('/', chatNameRoutes(deps));
    return { hono, applied, repo };
}

function makeRepo() {
    const workspace = new WorkspaceStore(testDatabase());
    const repo = sqliteChatNameSuggestionRepository(workspace.db);
    cleanup.push(() => workspace.close());
    return repo;
}

function pending(repo: ReturnType<typeof makeRepo>, threadId: string, name = 'Suggested Name') {
    repo.insert({
        threadId,
        suggestedName: name,
        trigger: 'unnamed',
        status: 'pending',
        suggestedAtMessageIndex: 6,
        rejectedAtMessageIndex: -1,
        createdAt: 1,
        settledAt: null,
    });
}

it('returns the pending suggestion for an authorized reviewer', async () => {
    const { hono, repo } = app();
    pending(repo, 'chat1');
    const res = await hono.request('/chats/chat1/name-suggestion', {
        headers: { 'x-user': 'owner' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestion.suggestedName).toBe('Suggested Name');
    expect(body.suggestion.status).toBe('pending');
});

it('returns 404 for a non-reviewer (another user on a private chat)', async () => {
    const { hono, repo } = app();
    pending(repo, 'chat1');
    const res = await hono.request('/chats/chat1/name-suggestion', {
        headers: { 'x-user': 'someone-else' },
    });
    expect(res.status).toBe(404);
});

it('room admin can read the suggestion; a room member cannot', async () => {
    const { hono, repo } = app();
    pending(repo, 'room1');
    const adminRes = await hono.request('/chats/room1/name-suggestion', {
        headers: { 'x-user': 'room-admin' },
    });
    expect(adminRes.status).toBe(200);
    const memberRes = await hono.request('/chats/room1/name-suggestion', {
        headers: { 'x-user': 'room-member' },
    });
    expect(memberRes.status).toBe(404);
});

it('accept applies the suggested name for an authorized reviewer', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'chat1', 'Q4 Budget');
    const res = await hono.request('/chats/chat1/name-suggestion/accept', {
        method: 'POST',
        headers: { 'x-user': 'owner' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('Q4 Budget');
    expect(applied).toEqual([{ threadId: 'chat1', name: 'Q4 Budget', by: 'owner' }]);
    expect(repo.get('chat1')?.status).toBe('accepted');
});

it('accept is refused for a non-reviewer', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'chat1');
    const res = await hono.request('/chats/chat1/name-suggestion/accept', {
        method: 'POST',
        headers: { 'x-user': 'intruder' },
    });
    expect(res.status).toBe(404);
    expect(applied).toEqual([]);
    expect(repo.get('chat1')?.status).toBe('pending');
});

it('reject enforces cooldown and leaves the name unchanged', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'chat1');
    const res = await hono.request('/chats/chat1/name-suggestion/reject', {
        method: 'POST',
        headers: { 'x-user': 'owner' },
    });
    expect(res.status).toBe(200);
    expect(applied).toEqual([]);
    const row = repo.get('chat1');
    expect(row?.status).toBe('rejected');
    expect(row?.rejectedAtMessageIndex).toBe(42);
});

it('customize applies the reviewer-edited name', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'chat1', 'Original');
    const res = await hono.request('/chats/chat1/name-suggestion/customize', {
        method: 'POST',
        headers: { 'x-user': 'owner', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My Custom Name' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe('My Custom Name');
    expect(applied).toEqual([{ threadId: 'chat1', name: 'My Custom Name', by: 'owner' }]);
    expect(repo.get('chat1')?.status).toBe('customized');
});

it('customize validates the name length', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'chat1');
    const res = await hono.request('/chats/chat1/name-suggestion/customize', {
        method: 'POST',
        headers: { 'x-user': 'owner', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
    expect(applied).toEqual([]);
    expect(repo.get('chat1')?.status).toBe('pending');
});

it('accept returns 404 when no suggestion is pending', async () => {
    const { hono } = app();
    const res = await hono.request('/chats/chat1/name-suggestion/accept', {
        method: 'POST',
        headers: { 'x-user': 'owner' },
    });
    expect(res.status).toBe(404);
});

it('room admin can accept; a member cannot', async () => {
    const { hono, repo, applied } = app();
    pending(repo, 'room1', 'Room Name');
    const adminRes = await hono.request('/chats/room1/name-suggestion/accept', {
        method: 'POST',
        headers: { 'x-user': 'room-admin' },
    });
    expect(adminRes.status).toBe(200);
    expect(applied).toEqual([{ threadId: 'room1', name: 'Room Name', by: 'room-admin' }]);
    pending(repo, 'room2', 'Room 2 Name');
    const memberRes = await hono.request('/chats/room2/name-suggestion/accept', {
        method: 'POST',
        headers: { 'x-user': 'room-member' },
    });
    expect(memberRes.status).toBe(404);
});
