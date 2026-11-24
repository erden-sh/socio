import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { isLocalChat } from '../../src/sync/local-ids';
import {
    createPageChats,
    type PageChatsOptions,
    pageContextPath,
    pageConversationPath,
    readPageContext,
} from '../../src/sync/page-conversation';

import { fakeNetwork, OFFLINE } from './fakes';

// The page conversation (CB-499): the web's `POST …/pages/:id/conversation`,
// online only, resolving once the chat list holds the chat, and the chat's page
// (`GET …/page-context`) for its banner, read once per chat.

interface Call {
    readonly url: string;
    readonly init: AuthedRequestInit | undefined;
}

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CHAT = { id: 'chat-9', dotId: 'd-sebas', ownerId: 'u-ada', title: 'Roadmap', createdAt: 1 };
const PAGE = { id: 'p-1', spaceId: 's-1', title: 'Roadmap' };

function setup(
    answer: (url: string, init?: AuthedRequestInit) => Response | Promise<Response>,
    options: Partial<PageChatsOptions> = {},
) {
    const calls: Call[] = [];
    const fetch: AuthedFetch = async (url, init) => {
        calls.push({ url, init });
        return answer(url, init);
    };
    const network = fakeNetwork();
    const listed = vi.fn(async (_id: string) => {});
    const chats = createPageChats({
        fetch,
        network,
        away: () => false,
        hold: () => null,
        listed,
        isLocal: isLocalChat,
        ...options,
    });
    return { chats, calls, network, listed };
}

const repo = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');

describe('opening a page’s conversation (CB-499)', () => {
    it('posts the web’s body to the web’s path, then waits for the chat list', async () => {
        const s = setup((url) => (url.endsWith('/conversation') ? json(200, CHAT) : json(200, PAGE)));
        const outcome = await s.chats.open('s-1', 'p-1', 'd-sebas');
        expect(outcome).toEqual({ kind: 'done', chat: { id: 'chat-9', dotId: 'd-sebas' } });
        expect(s.calls[0]).toMatchObject({
            url: '/api/spaces/s-1/pages/p-1/conversation',
            init: { method: 'POST', json: { dotId: 'd-sebas' } },
        });
        expect(s.listed).toHaveBeenCalledWith('chat-9');
        // The chat's page is read on the way, so its banner draws as the chat opens.
        expect(s.calls.map((call) => call.url)).toContain('/api/conversations/chat-9/page-context');
        await vi.waitFor(() => expect(s.chats.known('chat-9')).toEqual(PAGE));
        // The server's route and the web's call, so the request stays theirs.
        const routes = repo('src/server/pages/page-routes.ts');
        expect(routes).toContain("app.post('/spaces/:spaceId/pages/:id/conversation', async (c) => {");
        expect(routes).toContain('.object({ dotId: z.string().min(1) })');
        expect(routes).toContain("app.get('/conversations/:id/page-context', (c) => {");
        const web = repo('packages/client/src/modules/pages/PageConversation.tsx');
        expect(web).toContain("api<Conversation>(`/spaces/${page.spaceId}/pages/${page.id}/conversation`, 'POST', {");
        expect(repo('packages/client/src/modules/chat/Chat.tsx')).toContain(
            '`/conversations/${thread.id}/page-context`',
        );
        expect(pageConversationPath('s 1', 'p/1')).toBe('/api/spaces/s%201/pages/p%2F1/conversation');
        expect(pageContextPath('c 1')).toBe('/api/conversations/c%201/page-context');
    });

    it('sends nothing offline, while the server is away, or while writes wait', async () => {
        const offline = setup(() => json(200, CHAT));
        offline.network.set(OFFLINE);
        expect(await offline.chats.open('s-1', 'p-1', 'd-sebas')).toEqual({ kind: 'blocked', reason: 'offline' });
        const away = setup(() => json(200, CHAT), { away: () => true });
        expect(await away.chats.open('s-1', 'p-1', 'd-sebas')).toEqual({ kind: 'blocked', reason: 'away' });
        const held = setup(() => json(200, CHAT), { hold: () => 'sign-in' });
        expect(await held.chats.open('s-1', 'p-1', 'd-sebas')).toEqual({ kind: 'blocked', reason: 'sign-in' });
        expect([...offline.calls, ...away.calls, ...held.calls]).toEqual([]);
    });

    it('words a refusal by status, and a lost answer or a 5xx as no answer', async () => {
        const refused = setup(() => json(400, { error: 'Choose a specialist in this Space with access enabled.' }));
        expect(await refused.chats.open('s-1', 'p-1', 'd-x')).toEqual({ kind: 'refused', reason: 'http-400' });
        const busy = setup(() => json(409, { error: 'This page conversation is being created. Retry shortly.' }));
        expect(await busy.chats.open('s-1', 'p-1', 'd-x')).toEqual({ kind: 'refused', reason: 'http-409' });
        const failed = setup(() => json(502, {}));
        expect(await failed.chats.open('s-1', 'p-1', 'd-x')).toEqual({ kind: 'no-answer' });
        const lost = setup(() => Promise.reject(new TypeError('Network request failed')));
        expect(await lost.chats.open('s-1', 'p-1', 'd-x')).toEqual({ kind: 'no-answer' });
        const odd = setup(() => json(200, { id: 'chat-9' }));
        expect(await odd.chats.open('s-1', 'p-1', 'd-x')).toEqual({ kind: 'no-answer' });
        for (const s of [refused, busy, failed, lost, odd]) {
            expect(s.listed).not.toHaveBeenCalled();
        }
    });
});

describe('a chat’s page (CB-499)', () => {
    it('reads it once, and null for a chat about no page', async () => {
        const s = setup((url) => json(200, url.includes('chat-9') ? PAGE : null));
        expect(s.chats.known('chat-9')).toBeUndefined();
        const [one, two] = await Promise.all([s.chats.context('chat-9'), s.chats.context('chat-9')]);
        expect(one).toEqual(PAGE);
        expect(two).toEqual(PAGE);
        expect(await s.chats.context('chat-9')).toEqual(PAGE);
        expect(await s.chats.context('chat-2')).toBeNull();
        expect(s.calls.map((call) => call.url)).toEqual([
            '/api/conversations/chat-9/page-context',
            '/api/conversations/chat-2/page-context',
        ]);
        expect(s.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('asks nothing for a chat made on this phone, or offline; a failed read is asked again', async () => {
        let fail = true;
        const s = setup(() => (fail ? json(500, {}) : json(200, PAGE)));
        expect(await s.chats.context('local-0b1c2d')).toBeUndefined();
        s.network.set(OFFLINE);
        expect(await s.chats.context('chat-9')).toBeUndefined();
        expect(s.calls).toEqual([]);
        s.network.set({ connected: true, type: 'wifi' });
        expect(await s.chats.context('chat-9')).toBeUndefined();
        fail = false;
        expect(await s.chats.context('chat-9')).toEqual(PAGE);
        expect(s.calls).toHaveLength(2);
    });

    it('gives up after the web’s 10 s', async () => {
        vi.useFakeTimers();
        try {
            const s = setup(
                (_url, init) =>
                    new Promise<Response>((_resolve, reject) =>
                        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
                    ),
            );
            const read = s.chats.context('chat-9');
            await vi.advanceTimersByTimeAsync(10_000);
            expect(await read).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('takes only a page the answer names whole', () => {
        expect(readPageContext(PAGE)).toEqual(PAGE);
        expect(readPageContext(null)).toBeNull();
        expect(readPageContext({ id: 'p-1', title: 'x' })).toBeUndefined();
        expect(readPageContext('page')).toBeUndefined();
    });
});
