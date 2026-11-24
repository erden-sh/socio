import { readFileSync } from 'node:fs';

import type { Message } from '@ag-ui/core';
import { describe, expect, it, vi } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import { pageChatScope, PageChatRequests } from '../../src/chat/page-chat-requests';
import { withoutPageLine } from '../../src/chat/page-line';
import { transcriptRows } from '../../src/chat/transcript';

// The page conversation's requests (CB-499): the web's PageChatRequests, copied,
// so an open that answers after another pick, or after the person left the
// page, opens nothing; and the web's page line, never in a bubble.

const repo = (file: string) => readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
const app = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** A promise and its resolve. */
function later<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
}

const callbacks = () => ({ success: vi.fn(), failure: vi.fn(), settled: vi.fn() });

describe('the page chat’s requests (CB-499)', () => {
    it('is the web’s class, as it is', () => {
        const body = (text: string) => text.slice(text.indexOf('export class PageChatRequests'));
        const web = repo('packages/client/src/modules/pages/page-chat-requests.ts');
        const ours = app('src/chat/page-chat-requests.ts');
        expect(body(ours).slice(0, body(web).length)).toBe(body(web));
        // And the web's scope: the page, then the socio.
        expect(repo('packages/client/src/modules/pages/PageConversation.tsx')).toContain(
            "const scope = `${page.id}:${dot?.id ?? ''}`;",
        );
        expect(pageChatScope('p1', 'd1')).toBe('p1:d1');
    });

    it('hands the answer to the scope that asked', async () => {
        const requests = new PageChatRequests();
        const seen = callbacks();
        requests.select('p1:d1');
        await requests.run('p1:d1', async () => 'chat-1', seen);
        expect(seen.success).toHaveBeenCalledWith('chat-1');
        expect(seen.settled).toHaveBeenCalledOnce();
    });

    it('drops an answer after another socio was picked, or the page was left', async () => {
        const requests = new PageChatRequests();
        const first = later<string>();
        const seen = callbacks();
        requests.select('p1:d1');
        const going = requests.run('p1:d1', () => first.promise, seen);
        requests.select('p1:d2');
        first.resolve('chat-1');
        await going;
        expect(seen.success).not.toHaveBeenCalled();
        expect(seen.settled).not.toHaveBeenCalled();

        const left = later<string>();
        const after = callbacks();
        requests.select('p1:d1');
        const again = requests.run('p1:d1', () => left.promise, after);
        requests.select('');
        left.resolve('chat-1');
        await again;
        expect(after.success).not.toHaveBeenCalled();
    });

    it('keeps only the newest of two opens of one scope, and its failure', async () => {
        const requests = new PageChatRequests();
        const slow = later<string>();
        const one = callbacks();
        const two = callbacks();
        requests.select('p1:d1');
        const first = requests.run('p1:d1', () => slow.promise, one);
        const second = requests.run('p1:d1', () => Promise.reject(new Error('refused')), two);
        await second;
        slow.resolve('chat-1');
        await first;
        expect(one.success).not.toHaveBeenCalled();
        expect(two.failure).toHaveBeenCalledOnce();
        expect(two.settled).toHaveBeenCalledOnce();
        // A scope not selected never loads.
        const load = vi.fn(async () => 'x');
        await requests.run('p2:d1', load, callbacks());
        expect(load).not.toHaveBeenCalled();
    });
});

describe('the page line (CB-158, CB-499)', () => {
    const line = 'From [Roadmap](/spaces/s1/pages/p1):\n\n';

    it('is the web’s rule', () => {
        const web = repo('packages/client/src/modules/pages/page-context.ts');
        const ours = app('src/chat/page-line.ts');
        const rule = (text: string) => /const PAGE_LINE = .*;/.exec(text)?.[0];
        expect(rule(ours)).toBe(rule(web));
        expect(withoutPageLine(`${line}What does it say?`)).toBe('What does it say?');
        expect(withoutPageLine('From [Roadmap](https://x.test):\n\nhi')).toBe('From [Roadmap](https://x.test):\n\nhi');
    });

    it('leaves the person’s bubble, never a reply', () => {
        const rows = transcriptRows(
            [
                {
                    seq: 1,
                    prev: null,
                    runId: 'run-1',
                    status: 'finished',
                    startedAt: 1000,
                    finishedAt: 1500,
                    messages: [
                        { id: 'u1', role: 'user', content: `${line}Clean it up` },
                        { id: 'a1', role: 'assistant', content: `${line}Done` },
                    ] as Message[],
                    times: { messages: [], tools: [], reasoning: [] },
                    light: {},
                    size: 100,
                } as HistoryRun,
            ],
            NO_LIVE_TURN,
        );
        const texts = rows.flatMap((row) => ('text' in row ? [[row.kind, row.text]] : []));
        expect(texts).toContainEqual(['user', 'Clean it up']);
        expect(texts).toContainEqual(['reply', `${line}Done`]);
    });
});
