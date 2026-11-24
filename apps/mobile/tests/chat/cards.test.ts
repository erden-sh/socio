import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { CODING_PRIVATE_LINE } from '@socio/shared/coding/coding-sessions';
import { NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import type { CallReceipt } from '@socio/shared/types';

import {
    APPROVAL_REQUESTED,
    approvalCard,
    approvalCardIds,
    cardCalls,
    codingCard,
    CODING_WORKING,
    isInternalNote,
    receiptLabel,
    SCREENSHOT_ON_WEB,
    screenshotCard,
    SEE_IN_APPROVALS,
} from '../../src/chat/cards';
import { transcriptRows } from '../../src/chat/transcript';
import { chatTurns } from '../../src/chat/turn-trace';

// The transcript's cards: what the web's renderers match, read-only.

const call = (id: string, name: string, args = '{}') => ({
    id,
    type: 'function' as const,
    function: { name, arguments: args },
});
const assistant = (id: string, calls: ReturnType<typeof call>[], content = '') =>
    ({ id, role: 'assistant', content, toolCalls: calls }) as Message;
const tool = (callId: string, content: unknown) =>
    ({ id: `t-${callId}`, role: 'tool', toolCallId: callId, content: JSON.stringify(content) }) as Message;
const user = (id: string, extra: Partial<Message> = {}) =>
    ({ id, role: 'user', content: `asks ${id}`, ...extra }) as Message;

function run(seq: number, messages: Message[]): HistoryRun {
    return {
        seq,
        prev: seq === 1 ? null : seq - 1,
        runId: `run-${seq}`,
        status: 'finished',
        startedAt: seq * 1000,
        finishedAt: seq * 1000 + 500,
        messages,
        times: { messages: [], tools: [], reasoning: [] },
        light: {},
        size: 100,
    };
}

const PENDING = {
    status: 'pending_approval',
    id: 'ap1',
    expiresAt: 9,
    approval: { id: 'ap1', summary: 'Create dataset “Prices”', url: '/approvals/ap1' },
    message: 'Waiting for the user…',
};

describe('approval cards', () => {
    it('shows a result that asked as "Approval requested" until its status is read, opening it on the web', () => {
        expect(approvalCard(JSON.stringify(PENDING))).toEqual({
            kind: 'approval',
            id: 'ap1',
            state: 'requested',
            title: APPROVAL_REQUESTED,
            summary: 'Create dataset “Prices”',
            note: SEE_IN_APPROVALS,
            href: '/approvals/ap1',
        });
    });

    it("lists every approval card's request, in order, for the chat to read and decide", () => {
        const requested = approvalCard(PENDING)!;
        const auto = approvalCard({ status: 'approved', id: 'ap4', via: 'auto', outcome: 'Done' })!;
        expect(
            approvalCardIds([{ kind: 'card', card: requested }, { kind: 'reply' }, { kind: 'card', card: auto }]),
        ).toEqual(['ap1', 'ap4']);
    });

    it('says an auto review decided it, under `outcome` too, with its outcome', () => {
        const denied = {
            status: 'denied',
            id: 'ap2',
            via: 'auto',
            outcome: 'Denied by auto review: risky',
            message: '',
        };
        expect(approvalCard(denied)).toMatchObject({
            state: 'denied',
            title: 'Denied automatically',
            summary: denied.outcome,
        });
        const wrapped = { goal: 'x', outcome: { status: 'approved', id: 'ap3', via: 'auto', outcome: 'Done' } };
        expect(approvalCard(JSON.stringify(wrapped))).toMatchObject({ state: 'approved', href: '/approvals/ap3' });
    });

    it('is no card for any other result, or an id that would leave the path', () => {
        expect(approvalCard('{"status":"approved","id":"x","via":"bypass"}')).toBeNull();
        expect(approvalCard('not json')).toBeNull();
        expect(approvalCard({ ...PENDING, approval: { ...PENDING.approval, id: '../admin' } })).toBeNull();
    });
});

describe('coding session cards', () => {
    it("shows a session's repository, branch, state and pull request", () => {
        const result = {
            status: 'opened',
            session: { id: 's1', repository: 'acme/web', branch: 'socio/rulo/fix', state: 'ready' },
            pullRequest: { number: 12, url: 'https://github.com/acme/web/pull/12', draft: true },
        };
        expect(codingCard(JSON.stringify(result))).toEqual({
            kind: 'coding',
            title: 'Coding session',
            repository: 'acme/web · socio/rulo/fix',
            status: 'Ready',
            pullRequest: { label: 'Pull request #12', url: 'https://github.com/acme/web/pull/12' },
            web: true,
        });
    });

    it("says why an ended session ended, the refusal in the server's words, and the private line", () => {
        const ended = { status: 'ended', session: { repository: 'a/b', state: 'ended', endReason: 'expired' } };
        expect(codingCard(ended)).toMatchObject({ status: 'Reached its time limit' });
        expect(codingCard({ status: 'refused', error: 'Not in scheduled runs.' })).toMatchObject({
            status: 'Not in scheduled runs.',
        });
        expect(codingCard({ withheld: true })).toMatchObject({ status: CODING_PRIVATE_LINE, web: false });
        expect(codingCard(undefined)).toMatchObject({ status: CODING_WORKING });
    });

    it('reads a preview (a long result cut to its short fields) and never a pull request off GitHub https', () => {
        expect(codingCard('{"status":"done","agentSaid":"…"}')).toMatchObject({ status: 'Done', repository: null });
        expect(codingCard({ status: 'opened', session: { pullRequest: 'javascript:alert(1)' } })).toMatchObject({
            pullRequest: null,
        });
    });
});

describe('the computer screenshot and voice receipts', () => {
    it("names the page the screenshot showed, as text, or why there's no picture", () => {
        expect(screenshotCard('{"url":"https://example.test/a","image":{"id":"i1"}}', 'Rulo')).toMatchObject({
            title: 'Rulo’s computer',
            page: 'https://example.test/a',
        });
        expect(screenshotCard({ error: 'The computer sent no image.' }, null)).toMatchObject({
            title: 'Your socio’s computer',
            note: 'The computer sent no image.',
        });
        // The picture its result names shows in the card; a bad reference is no picture.
        const shot = `{"url":"https://example.test/b","image":{"id":"cbatt_${'A'.repeat(22)}","mediaType":"image/png","size":10}}`;
        expect(screenshotCard(shot, null)).toMatchObject({
            note: '',
            image: { id: `cbatt_${'A'.repeat(22)}`, name: 'Screenshot' },
        });
        expect(screenshotCard('{"url":"https://example.test/a","image":{"id":"i1"}}', null)).toMatchObject({
            note: SCREENSHOT_ON_WEB,
            image: null,
        });
    });

    it("words a call's receipt as the web does", () => {
        expect(receiptLabel({ status: 'ended', startedAt: 1000, endedAt: 13_400 })).toBe('12s · Call ended');
        expect(receiptLabel({ status: 'active', startedAt: 1000, endedAt: null })).toBe('Call in progress');
        expect(receiptLabel({ status: 'failed', startedAt: 1000, endedAt: 2000 })).toBe('Call failed');
    });

    it("hides the server's prompts for the socio", () => {
        expect(isInternalNote(user('socio:voice_receipt:1'))).toBe(true);
        expect(isInternalNote(user('n1', { metadata: { socioSource: 'approval_decided' } } as never))).toBe(true);
        expect(isInternalNote(user('u1'))).toBe(false);
    });
});

describe('cards in the transcript', () => {
    const receipt = (id: string, anchor: string | null, startedAt = 5000): CallReceipt => ({
        id,
        threadId: 'chat-1',
        anchorMessageId: anchor,
        startedAt,
        endedAt: startedAt + 3000,
        status: 'ended',
        transcript: '',
        error: null,
    });

    it("puts each card after its reply, receipts after their message or first, and never an internal note's bubble", () => {
        const runs = [
            run(1, [
                user('u1'),
                assistant('a1', [
                    call('c1', 'data_create'),
                    call('c2', 'coding_status'),
                    call('c3', 'computer_screenshot'),
                ]),
                tool('c1', PENDING),
                tool('c2', { status: 'ready', session: { repository: 'a/b', state: 'ready' } }),
                tool('c3', { url: 'https://example.test' }),
                assistant('a2', [], 'Done.'),
            ]),
            run(2, [user('socio:voice_receipt:9'), assistant('a3', [], 'Noted.')]),
        ];
        const rows = transcriptRows(runs, NO_LIVE_TURN, {
            calls: [receipt('k1', 'u1'), receipt('k2', null), { ...receipt('k3', 'u1'), threadId: 'other' }],
            threadId: 'chat-1',
            socio: 'Rulo',
        });
        expect(rows.map((row) => row.id)).toEqual([
            'call:k2',
            'u1',
            'call:k1',
            'trace:u1',
            'card:c1',
            'card:c2',
            'card:c3',
            'a2',
            'a3',
        ]);
    });

    it("shows only the chat's last finished screenshot as a card", () => {
        const runs = [
            run(1, [
                user('u1'),
                assistant('a1', [call('s1', 'computer_screenshot'), call('s2', 'computer_screenshot')]),
                tool('s1', { url: 'https://example.test/1' }),
                tool('s2', { url: 'https://example.test/2' }),
            ]),
            run(2, [
                user('u2'),
                assistant('a2', [call('s3', 'computer_screenshot')]),
                tool('s3', { url: 'https://example.test/3' }),
            ]),
        ];
        const cards = (turn = NO_LIVE_TURN) =>
            transcriptRows(runs, turn).flatMap((row) => (row.id.startsWith('card:') ? [row.id] : []));
        expect(cards()).toEqual(['card:s3']);
        // One still running in the live turn has no result: the stored last one stays.
        const running = {
            ...NO_LIVE_TURN,
            messages: [user('u3'), assistant('a3', [call('s4', 'computer_screenshot')])],
        };
        expect(cards(running)).toEqual(['card:s3']);
        const done = { ...running, messages: [...running.messages, tool('s4', { url: 'https://example.test/4' })] };
        expect(cards(done)).toEqual(['card:s4']);
    });

    it('waits with receipts from before the oldest run shown while older runs are still to load', () => {
        const runs = [run(3, [user('u1'), assistant('a1', [], 'Hi')])];
        const calls = [receipt('old', null, 100), receipt('new', null, 3500)];
        const ids = (earlier: boolean) =>
            transcriptRows(runs, NO_LIVE_TURN, { calls, threadId: 'chat-1', earlier }).map((row) => row.id);
        expect(ids(true)).toEqual(['call:new', 'u1', 'a1']);
        expect(ids(false)).toEqual(['call:old', 'call:new', 'u1', 'a1']);
    });

    it("keeps coding calls out of the turn's steps, as approvals and page reviews are", () => {
        const messages = [user('u1'), assistant('a1', [call('c2', 'coding_status'), call('c4', 'search_pages')])];
        expect(cardCalls(messages)(call('c2', 'coding_status'))).toBe(true);
        expect(cardCalls(messages)(call('c4', 'search_pages'))).toBe(false);
        const [turn] = chatTurns([run(1, [...messages, tool('c2', {}), tool('c4', [])])]);
        expect(turn?.steps.filter((step) => step.kind === 'tool')).toHaveLength(1);
    });
});
