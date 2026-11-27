import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';

import {
    bubbleLabel,
    deliveredInTurn,
    messageFullTime,
    messageText,
    messageTime,
    repliedAnnouncement,
    replyFinished,
    rowTime,
    transcriptRows,
} from '../../src/chat/transcript';

// The chat screen's transcript: stored runs, then the follow stream's
// live turn, as the person's bubbles and the socio's prose.

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

const user = (id: string, content: Message['content'] = `asks ${id}`) => ({ id, role: 'user', content }) as Message;
const reply = (id: string, content = `answers ${id}`) => ({ id, role: 'assistant', content }) as Message;

describe('transcriptRows', () => {
    it("draws the person's messages and the socio's replies, oldest first", () => {
        const rows = transcriptRows(
            [run(1, [user('u1'), reply('a1')]), run(2, [user('u2'), reply('a2')])],
            NO_LIVE_TURN,
        );
        expect(rows).toEqual([
            { kind: 'user', id: 'u1', text: 'asks u1', files: [] },
            { kind: 'reply', id: 'a1', text: 'answers a1', streaming: false, stored: true },
            { kind: 'user', id: 'u2', text: 'asks u2', files: [] },
            { kind: 'reply', id: 'a2', text: 'answers a2', streaming: false, stored: true },
        ]);
    });

    it("folds tool calls, tool results and reasoning into the turn's trace row, and leaves out empty messages", () => {
        const toolCall = {
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search_pages', arguments: '{}' } }],
        } as Message;
        const tool = { id: 't1', role: 'tool', content: '[]', toolCallId: 'c1' } as Message;
        const reasoning = { id: 'r1', role: 'reasoning', content: 'Thinking…' } as unknown as Message;
        const rows = transcriptRows(
            [run(1, [user('u1'), reasoning, toolCall, tool, reply('a2'), user('u2', '  ')])],
            NO_LIVE_TURN,
        );
        expect(rows.map((row) => row.id)).toEqual(['u1', 'trace:u1', 'a2']);
    });

    it("reads a multipart message's text parts", () => {
        const content = [
            { type: 'text', text: 'Look at this' },
            { type: 'binary', mimeType: 'image/png', url: 'https://example.test/a.png' },
            { type: 'text', text: 'and this' },
        ] as unknown as Message['content'];
        expect(messageText({ content })).toBe('Look at this\nand this');
        expect(transcriptRows([run(1, [user('u1', content)])], NO_LIVE_TURN)[0]).toMatchObject({
            text: 'Look at this\nand this',
        });
    });

    it('adds the live turn after the stored runs, its streaming reply marked', () => {
        const turn: LiveTurn = {
            running: true,
            phase: 'writing',
            streamingId: 'a2',
            messages: [user('u2'), reply('a2', 'Half a sen')],
        };
        const rows = transcriptRows([run(1, [user('u1'), reply('a1')])], turn);
        expect(rows.slice(2)).toEqual([
            { kind: 'user', id: 'u2', text: 'asks u2', files: [] },
            { kind: 'reply', id: 'a2', text: 'Half a sen', streaming: true, stored: false },
        ]);
    });

    it('shows a reply being written before its first words, so the list holds its place', () => {
        const turn: LiveTurn = { running: true, streamingId: 'a2', messages: [reply('a2', '')] };
        expect(transcriptRows([], turn)).toEqual([
            { kind: 'reply', id: 'a2', text: '', streaming: true, stored: false },
        ]);
    });

    it('never shows a message twice while the history takes the live turn over', () => {
        const turn: LiveTurn = { running: false, messages: [user('u2'), reply('a2')] };
        const stored = [run(1, [user('u1'), reply('a1')]), run(2, [user('u2'), reply('a2')])];
        expect(transcriptRows(stored, turn).map((row) => row.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    });
});

describe('deliveredInTurn', () => {
    it("names the person's messages the live turn holds (a queued message delivered mid-run)", () => {
        const turn: LiveTurn = { running: true, messages: [user('u2'), reply('a2'), user('u3')] };
        expect([...deliveredInTurn(turn)]).toEqual(['u2', 'u3']);
        expect(deliveredInTurn(NO_LIVE_TURN).size).toBe(0);
    });
});

describe('"<socio> replied"', () => {
    const running: LiveTurn = { running: true, streamingId: 'a2', messages: [user('u2'), reply('a2')] };
    const ended: LiveTurn = { running: false, messages: [user('u2'), reply('a2')] };

    it('is said once, as a turn ends with a reply', () => {
        expect(replyFinished(running, ended)).toBe(true);
        expect(replyFinished(ended, ended)).toBe(false);
        expect(replyFinished(running, running)).toBe(false);
    });

    it('is not said on opening a chat, nor for a turn that ends without words', () => {
        expect(replyFinished(NO_LIVE_TURN, ended)).toBe(false);
        expect(replyFinished(running, { running: false, messages: [user('u2'), reply('a2', ' ')] })).toBe(false);
    });

    it("names the socio, or says 'Your socio'", () => {
        expect(repliedAnnouncement('Sebas')).toBe('Sebas replied');
        expect(repliedAnnouncement(null)).toBe('Your socio replied');
    });
});

describe('message times', () => {
    // Local dates, so the words don't depend on the machine's time zone.
    const at = new Date(2026, 10, 10, 10, 1).getTime();
    const now = new Date(2026, 10, 10, 18, 30).getTime();

    it('word a time as the web’s action row does: today, this year, before', () => {
        expect(messageTime(at, now)).toBe('10:01 AM');
        expect(messageTime(new Date(2026, 9, 15, 15, 4).getTime(), now)).toBe('Oct 15, 3:04 PM');
        expect(messageTime(new Date(2025, 9, 15, 15, 4).getTime(), now)).toBe('Oct 15, 2025, 3:04 PM');
        expect(messageFullTime(at)).toBe('Tuesday, November 10, 2026 at 10:01 AM');
    });

    it('give each message row its time from the runs’ times, else none', () => {
        const stored = run(1, [user('u1'), reply('a1'), user('u2')]);
        const rows = transcriptRows(
            [
                {
                    ...stored,
                    times: {
                        messages: [
                            ['u1', at],
                            ['a1', at + 60_000],
                        ],
                        tools: [],
                        reasoning: [],
                    },
                },
            ],
            NO_LIVE_TURN,
        );
        expect(rows).toEqual([
            { kind: 'user', id: 'u1', text: 'asks u1', files: [], at },
            { kind: 'reply', id: 'a1', text: 'answers a1', streaming: false, stored: true, at: at + 60_000 },
            { kind: 'user', id: 'u2', text: 'asks u2', files: [] },
        ]);
        expect(rowTime(rows[1] as { at?: number }, now)).toBe('10:02 AM');
        expect(rowTime(rows[2] as { at?: number }, now)).toBeNull();
    });

    it('else take a message’s own time from its metadata, or the top level a message stored before AG-UI 1.0 has', () => {
        const rows = transcriptRows(
            [
                run(1, [
                    { ...user('u1'), metadata: { at } } as unknown as Message,
                    { ...reply('a1'), at: at + 60_000 } as unknown as Message,
                    // The runs' time wins over the message's own.
                    { ...user('u2'), metadata: { at: 1 } } as unknown as Message,
                ]),
            ].map((stored) => ({
                ...stored,
                times: { messages: [['u2', at + 120_000]], tools: [], reasoning: [] },
            })) as HistoryRun[],
            NO_LIVE_TURN,
        );
        expect(rows.map((row) => (row as { at?: number }).at)).toEqual([at, at + 60_000, at + 120_000]);
    });

    it('say a bubble’s time to screen readers, after its words', () => {
        expect(bubbleLabel({ text: 'Hi', at }, now)).toBe('Hi, 10:01 AM');
        expect(bubbleLabel({ text: 'Hi' }, now)).toBeUndefined();
        expect(bubbleLabel({ text: 'Hi', speaker: { kind: 'you', name: 'You' } }, now)).toBe('You: Hi');
        expect(bubbleLabel({ text: 'Hi', speaker: { kind: 'you', name: 'You' }, at }, now)).toBe('You: Hi, 10:01 AM');
    });
});

describe('the socio a reply names (CB-382)', () => {
    it('carries the runner’s socio stamp on a reply row, and nothing when there is none', () => {
        const stamped: Message = {
            id: 'a1',
            role: 'assistant',
            content: 'Hi',
            metadata: { socioDot: 'dot-b' },
        } as Message;
        const rows = transcriptRows([run(1, [stamped, { id: 'a2', role: 'assistant', content: 'Hey' }])], NO_LIVE_TURN);
        expect(rows[0]).toMatchObject({ kind: 'reply', socioId: 'dot-b' });
        expect(rows[1]).not.toHaveProperty('socioId');
    });
});
