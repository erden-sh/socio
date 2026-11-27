import { describe, expect, it } from 'vitest';

import type { QueuedMessage } from '@socio/shared/chat/steering';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import type { Conversation, Dot } from '@socio/shared/types';

import type { MessageFile } from '../../src/chat/attachment-tray';
import { chatSource } from '../../src/chat/chat-source';
import { chatView, NEW_CHAT_TITLE, sendableChatId } from '../../src/chat/chat-view';
import {
    chatLiveTurn,
    composerView,
    HELD_LINE,
    JUMP_TO_LATEST,
    candidateSaid,
    missingChatBubbles,
    nextCandidate,
    NO_ACCESS,
    NOT_SENT,
    outboxStateStore,
    pendingBubbles,
    pendingChatOf,
    readOnlyLine,
    scrollAnimated,
    FILE_EXPIRED,
    FILE_FAILED,
    sendChatMessage,
    statusPill,
    steeringStore,
    TEAM_LINE,
    TELEGRAM_LINE,
    UNCONFIRMED,
    unconfirmedCandidates,
    UPLOADING_FILES,
    writtenAgo,
    composerInputHeight,
    EMPTY_INPUT_HEIGHT,
} from '../../src/chat/composer';
import { quoteOf, splitQuote, withQuote } from '../../src/chat/quote-reply';
import { deliveredInTurn, transcriptDrawn } from '../../src/chat/transcript';
import { UPDATE_TO_SEND } from '../../src/data';
import { CHAT_MESSAGE_KIND, CHAT_MESSAGE_VIEW, CHAT_WAIT, chatMessageWrite } from '../../src/sync/chat-send';
import type { ChatFollow, FollowState } from '../../src/sync/follow';
import type { ChatHistory, HistoryState } from '../../src/sync/history';
import { CONVERSATION_IDS } from '../../src/sync/local-ids';
import { NEW_CHAT_KIND } from '../../src/sync/new-chat';
import type { HoldGroup, NewOutboxWrite, OutboxRow, OutboxStatus, UnsentWrite } from '../../src/sync/outbox';
import { overlaysOf } from '../../src/sync/outbox-overlay';
import { createOwnTurns } from '../../src/sync/own-turns';

// The chat's composer and what it adds to the transcript
// (src/chat/composer.ts): the composer's button and lines, the pending bubbles
// in their words across the hand-off, the live turn of a run this device
// started, the status pill and Jump to latest under Reduce Motion, T3 Code's
// submission anchor, a new chat before the list has it, and the send through
// the outbox with the draft cleared in its transaction.

const NOW = 10 * 60 * 60_000;
const HISTORY = { list: () => [] };
const STEERING = { list: () => [], state: { running: false } };
const resolveNone = () => null;

function row(write: NewOutboxWrite, fields: Partial<OutboxRow> = {}): OutboxRow {
    return {
        ...write,
        dependsOn: write.dependsOn ?? null,
        state: 'queued',
        attempts: 0,
        createdAt: NOW - 60_000,
        lastError: null,
        revision: 1,
        ...fields,
    };
}

const message = (id: string, text: string, threadId = 'c1') =>
    chatMessageWrite({
        id,
        idempotencyKey: `key-${id}`,
        threadId,
        dotId: 'dot-1',
        text,
        history: HISTORY,
        steering: STEERING,
    });

const unsentOf = (write: NewOutboxWrite, reason: string): UnsentWrite => ({
    id: write.id,
    kind: write.kind,
    lane: write.lane,
    dependsOn: null,
    payload: write.payload,
    payloadVersion: write.payloadVersion,
    reason,
    createdAt: NOW - 30_000,
});

function bubbles(
    rows: OutboxRow[],
    options: {
        unsent?: UnsentWrite[];
        queued?: QueuedMessage[];
        stored?: string[];
        turn?: LiveTurn;
        resolve?: (kind: string, id: string) => string | null;
        held?: boolean;
        offline?: boolean;
        files?: (writeId: string) => readonly MessageFile[];
        candidates?: ReadonlyMap<string, readonly string[]>;
    } = {},
) {
    const stored = new Set(options.stored ?? []);
    return pendingBubbles({
        threadId: 'c1',
        overlays: overlaysOf({
            rows,
            unsent: options.unsent ?? [],
            kinds: [CHAT_MESSAGE_VIEW],
            scope: { resolve: options.resolve ?? resolveNone },
        }),
        queued: options.queued ?? [],
        stored: (id) => stored.has(id),
        inTurn: deliveredInTurn(options.turn ?? NO_LIVE_TURN),
        socio: 'Sebas',
        heldForSignIn: options.held ?? false,
        offline: options.offline ?? false,
        now: NOW,
        ...(options.files ? { files: options.files } : {}),
        ...(options.candidates ? { candidates: options.candidates } : {}),
    });
}

describe('the composer', () => {
    it('is Send with text, Stop while a turn runs and the box is empty, and queues text typed during a turn', () => {
        const base = { text: '', running: false, locked: false, heldForSignIn: false, busy: false };
        expect(composerView(base)).toEqual({ action: 'send', enabled: false, editable: true, line: null });
        expect(composerView({ ...base, text: 'Hi' })).toMatchObject({ action: 'send', enabled: true });
        expect(composerView({ ...base, text: '  ' })).toMatchObject({ action: 'send', enabled: false });
        expect(composerView({ ...base, running: true })).toMatchObject({ action: 'stop', enabled: true });
        expect(composerView({ ...base, running: true, text: 'More' })).toMatchObject({ action: 'send', enabled: true });
        expect(composerView({ ...base, text: 'Hi', busy: true }).enabled).toBe(false);
    });

    it('sends a box with files and no text, and never turns it into Stop', () => {
        const base = { text: '', running: false, locked: false, heldForSignIn: false, busy: false };
        expect(composerView({ ...base, files: 2 })).toMatchObject({ action: 'send', enabled: true });
        expect(composerView({ ...base, running: true, files: 1 })).toMatchObject({ action: 'send', enabled: true });
        expect(composerView({ ...base, files: 0 })).toMatchObject({ enabled: false });
        expect(composerView({ ...base, files: 1, locked: true }).enabled).toBe(false);
    });

    it('says why it waits: held for sign-in still queues; a draft it can’t change can’t send', () => {
        const base = { text: 'Hi', running: false, locked: false, heldForSignIn: true, busy: false };
        expect(composerView(base)).toMatchObject({ enabled: true, line: HELD_LINE });
        expect(HELD_LINE.startsWith('Sign in again to send')).toBe(true);
        expect(composerView({ ...base, locked: true })).toMatchObject({
            enabled: false,
            editable: false,
            line: UPDATE_TO_SEND,
        });
    });

    it('shows a line in place of the composer for a Telegram chat and a team topic', () => {
        expect(readOnlyLine({ source: 'telegram' })).toBe(TELEGRAM_LINE);
        expect(readOnlyLine({ team: true })).toBe(TEAM_LINE);
        expect(readOnlyLine({ team: true, source: 'telegram' })).toBe(TEAM_LINE);
        expect(readOnlyLine({})).toBeNull();
        expect(readOnlyLine(undefined)).toBeNull();
    });
});

describe('pending bubbles', () => {
    it('shows a message being sent, then one waiting, in its words', () => {
        const sending = row(message('m-1', 'First'), { state: 'inflight' });
        const waiting = row(message('m-2', 'Second'), { createdAt: NOW - 10_000 });
        expect(bubbles([sending, waiting])).toMatchObject([
            { id: 'pending:m-1', text: 'First', caption: 'Sending…', waiting: false, problem: false, actions: [] },
            { id: 'pending:m-2', text: 'Second', caption: 'Waiting to send', waiting: true },
        ]);
        // Held for sign-in, offline or after a failed attempt, nothing is on its way.
        expect(bubbles([sending], { held: true })[0]).toMatchObject({ caption: 'Waiting to send', waiting: true });
        expect(bubbles([sending], { offline: true })[0]).toMatchObject({ caption: 'Waiting to send', waiting: true });
        const failed = row(message('m-3', 'Third'), { state: 'unknown', lastError: 'away' });
        expect(bubbles([failed])[0]).toMatchObject({ caption: 'Waiting to send', waiting: true });
    });

    it('says "Sends when <socio> finishes" and the queue’s wait', () => {
        const long = row(message('m-1', 'x'.repeat(9000)), { lastError: CHAT_WAIT.turn });
        const full = row(message('m-2', 'Later'), { lastError: CHAT_WAIT.queue });
        expect(bubbles([long, full]).map((bubble) => bubble.caption)).toEqual([
            'Sends when Sebas finishes',
            'Waiting for Sebas to read your earlier messages',
        ]);
    });

    it('says a message waits for its files, and why one with files wasn’t sent', () => {
        const uploading = row(message('m-1', 'With a photo'), { lastError: 'uploading' });
        const file: MessageFile = {
            id: 'f-1',
            name: 'a.jpg',
            mime: 'image/jpeg',
            picture: true,
            local: 'file:///a.jpg',
            tone: 'sky',
            extension: 'JPG',
        };
        expect(bubbles([uploading], { files: (id) => (id === 'm-1' ? [file] : []) })[0]).toMatchObject({
            caption: UPLOADING_FILES,
            waiting: true,
            files: [file],
        });
        const failed = unsentOf(message('m-2', 'A'), 'attachment-failed');
        const expired = unsentOf(message('m-3', 'B'), 'attachment-expired');
        expect(bubbles([], { unsent: [failed, expired] }).map((bubble) => bubble.caption)).toEqual([
            FILE_FAILED,
            FILE_EXPIRED,
        ]);
        // No files option: none.
        expect(bubbles([uploading])[0]?.files).toEqual([]);
    });

    it('shows "Not sent" with Retry and Edit, and a lost chat as "You no longer have access"', () => {
        const refused = unsentOf(message('m-1', 'Refused'), 'content');
        const gone = unsentOf(message('m-2', 'Gone'), 'gone');
        expect(bubbles([], { unsent: [refused, gone] })).toMatchObject([
            { writeId: 'm-1', caption: NOT_SENT, problem: true, actions: ['retry', 'edit'] },
            { writeId: 'm-2', caption: NO_ACCESS, problem: true, actions: ['retry', 'edit'] },
        ]);
    });

    it('marks an unconfirmed send with Send again, and a message that asks first with its age', () => {
        const unconfirmed = row(message('m-1', 'Maybe'), { state: 'unknown', lastError: 'unconfirmed' });
        const asks = row(message('m-2', 'Old'), {
            state: 'held',
            lastError: CHAT_WAIT.ask,
            createdAt: NOW - 4 * 60 * 60_000,
        });
        // Oldest first.
        expect(bubbles([unconfirmed, asks])).toMatchObject([
            { caption: 'written 4 h ago', waiting: true, actions: ['send-now', 'edit', 'delete'] },
            { caption: UNCONFIRMED, problem: true, actions: ['send-now'] },
        ]);
    });

    it('gives "Couldn’t confirm this was sent" View for the candidates the transcript shows, in turn', () => {
        const unconfirmed = row(message('m-1', 'Maybe'), { state: 'unknown', lastError: 'unconfirmed' });
        const queued: QueuedMessage = { id: 's-2', text: 'Maybe', createdAt: 1, updatedAt: 1 };
        // s-1 is stored, s-2 still queued on the server, s-9 not in the list (not loaded): left out.
        const [bubble] = bubbles([unconfirmed], {
            stored: ['s-1'],
            queued: [queued],
            candidates: new Map([['m-1', ['s-1', 's-2', 's-9']]]),
        });
        expect(bubble).toMatchObject({
            caption: UNCONFIRMED,
            actions: ['view', 'send-now'],
            candidates: ['s-1', 'pending:s-2'],
        });
        const keys = bubble!.candidates!;
        expect(nextCandidate(keys, null)).toBe('s-1');
        expect(nextCandidate(keys, 's-1')).toBe('pending:s-2');
        expect(nextCandidate(keys, 'pending:s-2')).toBe('s-1');
        expect(nextCandidate([], null)).toBeNull();
        expect(candidateSaid(keys, 'pending:s-2')).toBe('Possible copy 2 of 2');
        expect(candidateSaid(['s-1'], 's-1')).toBe('Possible copy of your message');

        // None shown (or none found): Send again only.
        expect(bubbles([unconfirmed], { candidates: new Map([['m-1', ['s-9']]]) })[0]).toMatchObject({
            actions: ['send-now'],
        });
        expect(bubbles([unconfirmed])[0]?.candidates).toBeUndefined();
        // A chat the list dropped has no transcript to show them in.
        const missing = missingChatBubbles(
            bubbles([unconfirmed], { stored: ['s-1'], candidates: new Map([['m-1', ['s-1']]]) }),
        );
        expect(missing[0]).not.toHaveProperty('candidates');
    });

    it('reads the unconfirmed rows’ candidates from the hold groups, and a change to them is a change', () => {
        const root = (id: string, cause: 'unsent' | 'held' | 'unconfirmed', candidates?: string[]): HoldGroup => ({
            root: {
                id,
                kind: CHAT_MESSAGE_KIND,
                lane: 'chat:c1',
                cause,
                reason: null,
                ...(candidates ? { candidates } : {}),
            },
            rows: [],
        });
        const found = unconfirmedCandidates([
            root('a', 'unconfirmed', ['s-1', 's-2']),
            root('b', 'unconfirmed', []),
            root('c', 'held'),
            root('d', 'unsent'),
        ]);
        expect([...found]).toEqual([['a', ['s-1', 's-2']]]);

        let groups: HoldGroup[] = [];
        const status = { heldForSignIn: false } as OutboxStatus;
        const store = outboxStateStore({
            rows: () => [],
            unsent: () => [],
            status: () => status,
            holds: () => groups,
            subscribe: () => () => {},
            onUnsent: () => () => {},
            onStatus: () => () => {},
        });
        expect(store.get().candidates.size).toBe(0);
        // The check found candidates while nothing listened: the next subscriber hears of it.
        groups = [root('a', 'unconfirmed', ['s-1'])];
        let told = 0;
        store.subscribe(() => (told += 1));
        expect(told).toBe(1);
        expect(store.get().candidates.get('a')).toEqual(['s-1']);
    });

    it('hides a message the live turn holds (deliveredInTurn) or the history stores', () => {
        const sent = row(message('m-1', 'In the turn'), { state: 'sent' });
        const stored = row(message('m-2', 'Stored'), { state: 'sent' });
        const turn: LiveTurn = {
            running: true,
            messages: [{ id: 'm-1', role: 'user', content: 'In the turn' } as LiveTurn['messages'][number]],
        };
        expect(bubbles([sent, stored], { turn, stored: ['m-2'] })).toEqual([]);
    });

    it('shows a steering message once across the hand-off: the outbox’s until the snapshot lists it, then the queue’s', () => {
        const steered = row(message('m-1', 'Also this'), { state: 'sent' });
        const queued: QueuedMessage = { id: 'srv-1', text: 'Also this', createdAt: NOW - 120_000, updatedAt: 0 };
        const resolve = (kind: string, id: string) => (kind === 'message' && id === 'm-1' ? 'srv-1' : null);
        // Before the snapshot lists it: the outbox's bubble.
        expect(bubbles([steered], { resolve }).map((bubble) => bubble.id)).toEqual(['pending:m-1']);
        // Listed: the queue's, dashed with its age.
        expect(bubbles([steered], { resolve, queued: [queued] })).toMatchObject([
            { id: 'pending:srv-1', source: 'queued', waiting: true, caption: 'Queued · written 2 min ago' },
        ]);
        // Delivered: gone from both.
        expect(bubbles([steered], { resolve, queued: [queued], stored: ['srv-1'] })).toEqual([]);
    });

    it('shows only this chat’s messages, a new chat’s under its server id once resolved', () => {
        const other = row(message('m-9', 'Elsewhere', 'c2'));
        const local = row(message('m-3', 'Hello', 'local-1'));
        expect(bubbles([other, local])).toEqual([]);
        const resolve = (kind: string, id: string) => (kind === CONVERSATION_IDS && id === 'local-1' ? 'c1' : null);
        expect(bubbles([other, local], { resolve }).map((bubble) => bubble.id)).toEqual(['pending:m-3']);
    });

    it('words a message’s age', () => {
        expect(writtenAgo(NOW, NOW)).toBe('written just now');
        expect(writtenAgo(NOW - 5 * 60_000, NOW)).toBe('written 5 min ago');
        expect(writtenAgo(NOW - 3 * 60 * 60_000, NOW)).toBe('written 3 h ago');
        expect(writtenAgo(NOW - 50 * 60 * 60_000, NOW)).toBe('written 2 d ago');
    });
});

describe('the live turn, the pill and Reduce Motion', () => {
    const running: LiveTurn = { running: true, phase: 'thinking', messages: [] };
    const finished: LiveTurn = {
        running: false,
        messages: [{ id: 'r-1', role: 'assistant', content: 'Done' } as LiveTurn['messages'][number]],
    };

    it('draws the own run’s turn while it runs or holds what isn’t stored, else the follow stream’s', () => {
        expect(chatLiveTurn(running, NO_LIVE_TURN)).toBe(running);
        expect(chatLiveTurn(finished, NO_LIVE_TURN)).toBe(finished);
        const elsewhere: LiveTurn = { running: true, phase: 'working', messages: [] };
        expect(chatLiveTurn(finished, elsewhere)).toBe(elsewhere);
        expect(chatLiveTurn(NO_LIVE_TURN, elsewhere)).toBe(elsewhere);
    });

    it('shows the phase, shimmering unless Reduce Motion is on, and Jump to latest while not following', () => {
        expect(statusPill(NO_LIVE_TURN, true, false)).toBeNull();
        expect(statusPill(running, true, false)).toEqual({ status: 'Thinking', shimmer: true, jump: false });
        expect(statusPill(running, true, true)).toEqual({ status: 'Thinking', shimmer: false, jump: false });
        expect(statusPill({ running: true, phase: 'writing', messages: [] }, true, false)?.status).toBe('Writing');
        expect(statusPill(NO_LIVE_TURN, false, true)).toEqual({ status: null, shimmer: false, jump: true });
        expect(JUMP_TO_LATEST).toBe('Jump to latest');
    });

    it('never animates a scroll the app makes under Reduce Motion', () => {
        expect(scrollAnimated(false)).toBe(true);
        expect(scrollAnimated(true)).toBe(false);
    });

    it('lays the scope’s own turns over the follow stream in the chat’s store', () => {
        const turns = createOwnTurns();
        const listeners = new Set<() => void>();
        const state = { ready: true } as HistoryState;
        const history = {
            state,
            list: () => [],
            subscribe: (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener)),
        } as unknown as ChatHistory;
        const follow = {
            state: { turn: NO_LIVE_TURN } as FollowState,
            subscribe: () => () => {},
        } as unknown as ChatFollow;
        const source = chatSource(history, follow, {
            turn: () => turns.turn('c1'),
            subscribe: (listener) => turns.subscribe('c1', listener),
        });
        let calls = 0;
        const stop = source.subscribe(() => (calls += 1));
        const before = source.get();
        expect(before.own).toBe(NO_LIVE_TURN);
        turns.set('c2', running);
        expect(calls).toBe(0);
        turns.set('c1', running);
        expect(calls).toBe(1);
        expect(source.get().own).toBe(running);
        expect(source.get()).toBe(source.get());
        stop();
        turns.set('c1', finished);
        expect(calls).toBe(1);
    });

    it('marks the first frame for a kept chat with no runs once its history has answered or failed', () => {
        const none = { ready: false, settled: false, failed: false };
        expect(transcriptDrawn(0, none)).toBe(false);
        expect(transcriptDrawn(2, none)).toBe(true);
        expect(transcriptDrawn(0, { ...none, ready: true })).toBe(true);
        expect(transcriptDrawn(0, { ...none, settled: true })).toBe(true);
        expect(transcriptDrawn(0, { ...none, failed: true })).toBe(true);
    });
});

describe('a new chat before the list has it', () => {
    const dots = [{ id: 'dot-1', name: 'Sebas', createdAt: 1 } as Dot];
    const room = { id: 'r1', dotId: 'dot-1', kind: 'room', ownerId: 'room:r1', createdAt: 1 } as Conversation;
    const create: NewOutboxWrite = {
        id: 'local-1',
        lane: 'chat:local-1',
        kind: NEW_CHAT_KIND,
        payload: JSON.stringify({ dotId: 'dot-1', title: 'Hello', after: null }),
        payloadVersion: 1,
        idempotencyKey: 'k',
    };

    it('is the chat its outbox writes name: private, "New chat", sendable', () => {
        const pending = pendingChatOf([create], resolveNone, 'local-1');
        expect(pending).toEqual({ dotId: 'dot-1' });
        expect(chatView([], dots, 'local-1', true, pending)).toMatchObject({
            kind: 'private',
            title: NEW_CHAT_TITLE,
            socio: 'Sebas',
        });
        expect(sendableChatId([], 'local-1', pending)).toBe('local-1');
        expect(sendableChatId([], 'local-1')).toBeNull();
    });

    it('keeps it under the server id until the next pull lists it, from the create or a message', () => {
        const resolve = (kind: string, id: string) => (kind === CONVERSATION_IDS && id === 'local-1' ? 'c7' : null);
        expect(pendingChatOf([create], resolve, 'c7')).toEqual({ dotId: 'dot-1' });
        expect(pendingChatOf([message('m-1', 'Hi', 'local-1')], resolve, 'c7')).toEqual({ dotId: 'dot-1' });
        expect(pendingChatOf([message('m-1', 'Hi', 'local-1')], resolve, 'c8')).toBeNull();
        expect(pendingChatOf([{ id: 'x', kind: CHAT_MESSAGE_KIND, payload: '{' }], resolve, 'c7')).toBeNull();
    });

    it('leaves a dropped chat missing when a message to its server id is still on the phone', () => {
        // Written offline to c1; c1 was then deleted on the web, and the pull dropped it.
        const gone = unsentOf(message('m-1', 'Hi'), 'gone');
        const queued = row(message('m-2', 'Still there?'), { state: 'held' });
        const pending = pendingChatOf([queued, gone], resolveNone, 'c1');
        expect(pending).toBeNull();
        expect(chatView([], dots, 'c1', true, pending)).toMatchObject({ kind: 'missing' });
        expect(sendableChatId([], 'c1', pending)).toBeNull();
    });

    it('keeps a dropped chat’s refused messages under the missing view with Delete only', () => {
        const gone = unsentOf(message('m-1', 'Hi'), 'gone');
        const waiting = row(message('m-2', 'Still there?'));
        const shown = missingChatBubbles(bubbles([waiting], { unsent: [gone] }));
        expect(shown.map(({ writeId, caption, actions }) => ({ writeId, caption, actions }))).toEqual([
            { writeId: 'm-2', caption: 'Waiting to send', actions: [] },
            { writeId: 'm-1', caption: NO_ACCESS, actions: ['delete'] },
        ]);
    });

    it('never makes a room sendable, whatever the outbox holds', () => {
        expect(sendableChatId([room], 'r1', { dotId: 'dot-1' })).toBeNull();
        expect(chatView([room], dots, 'r1', true, { dotId: 'dot-1' }).kind).toBe('room');
    });
});

describe('sending', () => {
    it('sends the chat’s box on the lane its earlier messages wait in, with the watermark and server time', async () => {
        let built: NewOutboxWrite | null = null;
        const ids = ['m-1', 'key-1'];
        const result = await sendChatMessage({
            drafts: {
                enqueueFromDraft: async (scope, build) => {
                    expect(scope).toBe('chat:local-1');
                    built = build('Hello') as NewOutboxWrite;
                    return row(built);
                },
            },
            outbox: { rows: () => [], unsent: () => [], resolve: resolveNone },
            history: HISTORY,
            steering: { list: () => [{ id: 'q-1' } as QueuedMessage], state: { running: true } },
            threadId: 'local-1',
            dotId: 'dot-1',
            newId: () => ids.shift() as string,
            serverAt: 1234,
        });
        expect(result?.id).toBe('m-1');
        expect(built).toMatchObject({
            id: 'm-1',
            idempotencyKey: 'key-1',
            lane: 'chat:local-1',
            kind: CHAT_MESSAGE_KIND,
            // A new chat not created yet: it waits for its create.
            dependsOn: 'local-1',
        });
        expect(JSON.parse((built as unknown as NewOutboxWrite).payload)).toMatchObject({
            threadId: 'local-1',
            dotId: 'dot-1',
            text: 'Hello',
            watermark: { after: null, queued: ['q-1'], running: true, serverAt: 1234 },
        });
    });

    it('sends a quote-reply’s draft whole: the blockquote, a blank line, then the words (CB-571)', async () => {
        let built: NewOutboxWrite | null = null;
        const ids = ['m-1', 'key-1'];
        const text = withQuote(quoteOf('Archiver', 'Yes! **erden** means “to ground”.'), 'And the name?');
        await sendChatMessage({
            drafts: {
                enqueueFromDraft: async (_scope, build) => {
                    built = build(text) as NewOutboxWrite;
                    return row(built);
                },
            },
            outbox: { rows: () => [], unsent: () => [], resolve: resolveNone },
            history: HISTORY,
            steering: STEERING,
            threadId: 'c1',
            dotId: 'dot-1',
            newId: () => ids.shift() as string,
            serverAt: null,
        });
        expect(JSON.parse((built as unknown as NewOutboxWrite).payload).text).toBe(
            '> **Archiver:** Yes! erden means “to ground”.\n\nAnd the name?',
        );
    });

    it('waits for words or files: a quote alone doesn’t send', () => {
        const draft = splitQuote(withQuote(quoteOf('Archiver', 'Yes!'), ''));
        const view = composerView({
            text: draft.rest,
            running: false,
            locked: false,
            heldForSignIn: false,
            busy: false,
        });
        expect(view.enabled).toBe(false);
        expect(
            composerView({
                text: draft.rest,
                running: false,
                locked: false,
                heldForSignIn: false,
                busy: false,
                files: 1,
            }).enabled,
        ).toBe(true);
    });

    it('sends the tray’s files with the box, by local id, in the same insert', async () => {
        const ids = ['m-1', 'key-1'];
        const moved: string[] = [];
        let built: NewOutboxWrite | null = null;
        const refs = [{ id: 'local-file', name: 'a.jpg', mediaType: 'image/jpeg', size: 10, kind: 'image' as const }];
        const result = await sendChatMessage({
            drafts: {
                enqueueFromDraft: async (scope, build, options) => {
                    expect(scope).toBe('chat:c1');
                    // Files and no text still send.
                    expect(options?.allowBlank).toBe(true);
                    built = build('') as NewOutboxWrite;
                    await options?.also?.({
                        run: async (_sql: string, params: unknown[]) => void moved.push(String(params[0])),
                    } as never);
                    return row(built);
                },
            },
            outbox: { rows: () => [], unsent: () => [], resolve: resolveNone },
            history: HISTORY,
            steering: STEERING,
            threadId: 'c1',
            dotId: 'dot-1',
            newId: () => ids.shift() as string,
            serverAt: null,
            attachments: {
                forSend: () => ({
                    refs,
                    statements: (outboxId) => async (tx) => {
                        await tx.run('UPDATE files SET outboxId = ?', [outboxId()]);
                    },
                    committed: () => moved.push('committed'),
                    released: () => moved.push('released'),
                }),
            },
        });
        expect(result?.id).toBe('m-1');
        expect(JSON.parse((built as unknown as NewOutboxWrite).payload)).toMatchObject({ text: '', attachments: refs });
        expect(moved).toEqual(['m-1', 'committed', 'released']);
    });

    it('reads the outbox and a steering snapshot as stores that change only when they do', () => {
        const groups: HoldGroup[] = [];
        const listeners: (() => void)[] = [];
        let rows: OutboxRow[] = [];
        const status = { heldForSignIn: false } as OutboxStatus;
        const store = outboxStateStore({
            rows: () => rows,
            unsent: () => [],
            status: () => status,
            holds: () => groups,
            subscribe: (listener) => (listeners.push(() => listener({ type: 'remove', id: 'x' })), () => {}),
            onUnsent: () => () => {},
            onStatus: () => () => {},
        });
        store.subscribe(() => {});
        const first = store.get();
        expect(store.get()).toBe(first);
        rows = [row(message('m-1', 'Hi'))];
        listeners[0]?.();
        expect(store.get()).not.toBe(first);
        expect(store.get().rows).toHaveLength(1);

        let list: QueuedMessage[] = [];
        const chat = { state: { running: false }, list: () => list, subscribe: () => () => {} };
        const steering = steeringStore(chat as never);
        const before = steering.get();
        expect(steering.get()).toBe(before);
        list = [{ id: 'q-1', text: 'Hi', createdAt: 1, updatedAt: 1 }];
        expect(steering.get()).not.toBe(before);
        expect(steering.get().queued).toHaveLength(1);
    });

    it('tells a new subscriber of a change between the render and its subscription', () => {
        const groups: HoldGroup[] = [];
        let rows: OutboxRow[] = [];
        const status = { heldForSignIn: false } as OutboxStatus;
        const store = outboxStateStore({
            rows: () => rows,
            unsent: () => [],
            status: () => status,
            holds: () => groups,
            subscribe: () => () => {},
            onUnsent: () => () => {},
            onStatus: () => () => {},
        });
        const rendered = store.get();
        let told = 0;
        store.subscribe(() => (told += 1));
        expect(told).toBe(0);
        expect(store.get()).toBe(rendered);

        const again = outboxStateStore({
            rows: () => rows,
            unsent: () => [],
            status: () => status,
            holds: () => groups,
            subscribe: () => () => {},
            onUnsent: () => () => {},
            onStatus: () => () => {},
        });
        const old = again.get();
        rows = [row(message('m-1', 'Hi'))];
        again.subscribe(() => (told += 1));
        expect(told).toBe(1);
        expect(again.get()).not.toBe(old);
        expect(again.get().rows).toHaveLength(1);
    });
});

describe('composerInputHeight', () => {
    it('puts an emptied box back to one line on iOS, and lets it grow otherwise', () => {
        expect(composerInputHeight('ios', '')).toBe(EMPTY_INPUT_HEIGHT);
        expect(composerInputHeight('ios', 'a long message\nover two lines')).toBeUndefined();
        expect(composerInputHeight('android', '')).toBeUndefined();
    });
});
