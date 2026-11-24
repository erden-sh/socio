import { describe, expect, it } from 'vitest';

import type { AuthedFetch, AuthedRequestInit } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { SAVE_CHAT_PAGE_COPY, saveChatAsPage, savedPageTitle, saveChatPagePath } from '../../src/sync/save-chat-page';

// Save as page (the chat header's "…"): the web's `POST /api/conversations/:id/page
// {title}`, sent once, online only, never again by itself; the page it answers opens.

const json = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fake(answer: () => Response | Promise<Response>) {
    const calls: { path: string; init: AuthedRequestInit }[] = [];
    const fetch: AuthedFetch = async (path, init = {}) => {
        calls.push({ path, init });
        return answer();
    };
    return { fetch, calls };
}

describe('save as page', () => {
    it("posts the trimmed title to the web's route and hands back the page to open", async () => {
        const server = fake(() => json(201, { id: 'page-9', spaceId: 'space-1', title: 'Plans' }));
        const result = await saveChatAsPage(
            { fetch: server.fetch, connected: true },
            { threadId: 'c 1', title: ' Plans ' },
        );
        expect(result).toEqual({ outcome: 'done', spaceId: 'space-1', pageId: 'page-9' });
        expect(server.calls).toEqual([
            { path: '/api/conversations/c%201/page', init: { method: 'POST', json: { title: 'Plans' } } },
        ]);
        expect(saveChatPagePath('c 1')).toBe('/api/conversations/c%201/page');
    });

    it('sends nothing offline or for a title out of range', async () => {
        const server = fake(() => json(201, {}));
        expect(await saveChatAsPage({ fetch: server.fetch, connected: false }, { threadId: 'c', title: 'x' })).toEqual({
            outcome: 'offline',
        });
        expect(await saveChatAsPage({ fetch: server.fetch, connected: true }, { threadId: 'c', title: '  ' })).toEqual({
            outcome: 'invalid',
        });
        expect(savedPageTitle('x'.repeat(161))).toBeNull();
        expect(savedPageTitle(` ${'x'.repeat(160)} `)).toBe('x'.repeat(160));
        expect(server.calls).toHaveLength(0);
    });

    it('words each answer by its status, and never sends again after no answer', async () => {
        const cases: [Response | 'drop', string][] = [
            [json(400, { error: 'server words' }), 'invalid'],
            [json(404, { error: 'server words' }), 'refused'],
            [json(503, { error: 'server words' }), 'failed'],
            [json(201, { nope: true }), 'failed'],
            ['drop', 'no-answer'],
        ];
        for (const [answer, outcome] of cases) {
            const server = fake(() => {
                if (answer === 'drop') {
                    throw new NetworkError('/api/conversations/c/page');
                }
                return answer;
            });
            const result = await saveChatAsPage(
                { fetch: server.fetch, connected: null },
                { threadId: 'c', title: 'T' },
            );
            expect(result.outcome).toBe(outcome);
            expect(server.calls).toHaveLength(1);
        }
        expect(Object.values(SAVE_CHAT_PAGE_COPY).join(' ')).not.toContain('server words');
    });
});
