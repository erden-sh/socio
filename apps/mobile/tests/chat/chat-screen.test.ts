import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import type { Conversation, Dot } from '@socio/shared/types';

import { chatSource, holdChat } from '../../src/chat/chat-source';
import {
    chatView,
    chatWebUrl,
    isRoom,
    MISSING_CHAT_TITLE,
    OPEN_IN_BROWSER,
    sendableChatId,
} from '../../src/chat/chat-view';
import { liveLineInView, shownPill } from '../../src/chat/composer';
import { LIVE_TRACE_ID } from '../../src/chat/transcript';
import { chatAction, inTabAction, restoreChatAction } from '../../src/navigation/tabs';
import { chatList } from '../../src/shell/chat-list';
import { chatScreen, keptChat, LAST_SCREEN_KEY, lastScreen, preloadKeptChat } from '../../src/shell/last-screen';
import type { ChatFollow, FollowState } from '../../src/sync/follow';
import type { ChatHistory, HistoryState } from '../../src/sync/history';

// The chat route: what an id shows (a private chat, the rooms placeholder,
// gone, or waiting), the id a composer may
// send to, the screen's store over one chat's history and follow stream, and
// the chat kept as the workspace's last screen for a cold start onto it.

const SRC = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

const conversation = (id: string, fields: Partial<Conversation> = {}) =>
    ({
        id,
        dotId: 'dot-1',
        ownerId: 'user-1',
        title: `Chat ${id}`,
        createdAt: 1,
        kind: 'private',
        ...fields,
    }) as Conversation;
const dots = [{ id: 'dot-1', name: 'Sebas', createdAt: 1 } as Dot];

const CHATS = [
    conversation('c1'),
    conversation('c2', { title: '  ' }),
    conversation('r1', { kind: 'room', ownerId: 'room:r1', title: 'Launch room' }),
    // A room an older server sent without its kind: its owner says so.
    conversation('r2', { kind: undefined, ownerId: 'room:r2' }),
];

describe('what the chat route shows', () => {
    it("shows a private chat's transcript, under its title and socio", () => {
        expect(chatView(CHATS, dots, 'c1', true)).toMatchObject({
            kind: 'private',
            title: 'Chat c1',
            socio: 'Sebas',
        });
        expect(chatView(CHATS, dots, 'c2', true).title).toBe('New chat');
    });

    it("shows a room's id as a room, by its kind or its owner", () => {
        expect(chatView(CHATS, dots, 'r1', true).kind).toBe('room');
        expect(chatView(CHATS, dots, 'r2', true).kind).toBe('room');
        expect(isRoom({ kind: 'private', ownerId: 'user-1' })).toBe(false);
        // The list agrees.
        const on = { settings: { rooms: { enabled: true } } } as Parameters<typeof chatList>[2];
        const rows = chatList(CHATS, dots, on);
        expect(rows.find((row) => row.id === 'r2')?.room).toBe(true);
        expect(rows.find((row) => row.id === 'r1')?.room).toBe(true);
        expect(chatList(CHATS, dots, null).some((row) => row.id === 'r2')).toBe(false);
        expect(OPEN_IN_BROWSER).toBe('Open in your browser');
        expect(chatWebUrl('https://brain.example.test', 'r 1')).toBe('https://brain.example.test/chats/r%201');
    });

    it("says a chat the workspace doesn't list is gone, once the workspace has answered", () => {
        expect(chatView(CHATS, dots, 'nope', true)).toMatchObject({ kind: 'missing', title: MISSING_CHAT_TITLE });
    });

    it('waits, rather than guess the kind, before the workspace has answered at all', () => {
        expect(chatView([], dots, 'c1', false).kind).toBe('waiting');
    });
});

describe('a room id never reaches the send path', () => {
    it('gives a composer an id only for a private chat the scope lists', () => {
        expect(sendableChatId(CHATS, 'c1')).toBe('c1');
        for (const id of ['r1', 'r2', 'nope']) {
            expect(sendableChatId(CHATS, id), id).toBeNull();
        }
        expect(sendableChatId([], 'c1')).toBeNull();
    });

    it("gives a room its own composer, never the chat's send path", () => {
        const screen = read('screens/chat.tsx');
        expect(screen).toMatch(/const composer: ChatComposer = \{\s*sendTo: null,\s*dotId: room\.context\.leadId/);
        const footer = screen.slice(screen.indexOf('if (composer.room) {'));
        const roomFooter = footer.slice(0, footer.indexOf('const view = composerView'));
        expect(roomFooter).toContain('<RoomComposer');
        expect(roomFooter).not.toContain('sendChatMessage');
        const roomComposer = read('screens/room-composer.tsx');
        expect(roomComposer).toContain('sendRoomMessage(');
        expect(roomComposer).not.toContain('sendChatMessage');
        // The tray goes to the chat's Composer, whose box is in a TextInputWrapper: pasted images reach a room's tray.
        expect(roomComposer).toContain('tray={tray}');
        expect(roomComposer).toContain('attachments: scope.attachments');
        // A row press reads a room's history from disk first, as a chat's (content in the first frame).
        expect(read('screens/shell-parts.tsx')).toContain('histories.preload(chat.id)');
    });

    it('starts a short chat at the top and a long one at its end (owner, 2026-11-18), for chats and rooms', () => {
        const screen = read('screens/chat.tsx');
        // One list draws both (Transcript); bottom alignment is gone, the end-of-chat behavior stays.
        expect(screen).not.toContain('alignItemsAtEnd');
        expect(screen).not.toContain('submissionAnchor');
        expect(screen).toContain('initialScrollAtEnd');
        expect(screen).toMatch(/maintainScrollAtEnd=\{\s*following/);
        expect(screen.match(/<KeyboardAwareLegendList/g)).toHaveLength(1);
    });

    it("keeps an opened turn's row in place, not the list's end (CB-437)", () => {
        const screen = read('screens/chat.tsx');
        // Opening or closing the steps stops following unless a reply streams; the list then holds its rows.
        expect(screen).toMatch(
            /const toggleTrace = \(traceId: string\) => \{[^]*?session\.disclosure\(running, \(\) => list\.current\?\.getState\(\)\.isAtEnd \?\? false\);[^]*?setOpenTraces\(/,
        );
        expect(screen).toContain('onToggle={toggleTrace}');
        expect(screen).toContain('onItemSizeChanged={() => session.resized()}');
        // While the row settles, T3's size-change anchor keeps it where it was on screen, and a scroll of the
        // app's own to where the list is ends LegendList's preserved initial target (the end, for 2 s).
        expect(screen).toContain('sizeChangeAnchor={keepHeldRow}');
        expect(screen).toMatch(
            /!session\.holding \? undefined : list\.current\?\.getState\(\)\.positionByKey\(held\.key\)/,
        );
        expect(screen).toMatch(
            /if \(session\.holding && state !== undefined\) \{[^}]*scrollToOffset\(\{ offset: state\.scroll, animated: false \}\)/,
        );
        expect(screen).toContain('maintainVisibleContentPosition={!following}');
        // #591's keyboard props stay.
        expect(screen).toContain('{...keyboardScroll(Platform.OS)}');
        expect(screen).toContain('keyboardOffset={insets.bottom}');
    });

    it("gives a chat and a room the web's composer: the box on top, Attach and the round send under it", () => {
        expect(read('screens/chat.tsx')).toMatch(/stacked\s+testID="chat-composer"/);
        expect(read('screens/room-composer.tsx')).toMatch(/stacked\s+testID="room-composer"/);
        const composer = read('screens/chat-composer.tsx');
        // The web's SendButton: the foreground's fill, primary-disabled while there is nothing to send.
        expect(composer).toContain("? 'bg-foreground active:opacity-90'");
        expect(composer).toContain(": 'bg-primary-disabled opacity-90'");
        expect(composer).toContain('icon="paperclip"');
    });

    it("wires the replier's name, the delivered check, Cancel's answers and who may Stop", () => {
        const screen = read('screens/chat.tsx');
        expect(screen).toContain(
            'useRepliedAnnouncement(turn, room === undefined ? socio : roomReplier(turn, room.context))',
        );
        expect(screen).toMatch(
            /othersBubbles\(\s*steering\.others,\s*\{ stored: \(messageId\) => source\.history\.has\(messageId\), inTurn \}/,
        );
        expect(screen).toContain('const answer = cancelAnswer(outcome);');
        expect(screen).toContain('roomStarted(snapshot.runs, turn, pending)');
    });
});

/** A ChatHistory and ChatFollow with only what the screen's store reads. */
function fakeChat() {
    const historyListeners = new Set<() => void>();
    const followListeners = new Set<() => void>();
    let runs: HistoryRun[] = [];
    let historyState = { ready: true } as HistoryState;
    let followState = { live: false, turn: NO_LIVE_TURN } as FollowState;
    const order: string[] = [];
    const history = {
        get state() {
            return historyState;
        },
        list: () => [...runs],
        subscribe: (listener: () => void) => {
            historyListeners.add(listener);
            return () => void historyListeners.delete(listener);
        },
        use: () => {
            order.push('history use');
            return () => order.push('history release');
        },
    } as unknown as ChatHistory;
    const follow = {
        get state() {
            return followState;
        },
        subscribe: (listener: () => void) => {
            followListeners.add(listener);
            return () => void followListeners.delete(listener);
        },
        use: () => {
            order.push('follow use');
            return () => order.push('follow release');
        },
    } as unknown as ChatFollow;
    return {
        history,
        follow,
        order,
        listeners: () => historyListeners.size + followListeners.size,
        setRuns(next: HistoryRun[]) {
            runs = next;
            historyListeners.forEach((listener) => listener());
        },
        setHistory(next: Partial<HistoryState>) {
            historyState = { ...historyState, ...next };
            historyListeners.forEach((listener) => listener());
        },
        setFollow(next: Partial<FollowState>) {
            followState = { ...followState, ...next };
            followListeners.forEach((listener) => listener());
        },
    };
}

const runOf = (seq: number) => ({ seq, messages: [] }) as unknown as HistoryRun;

describe("the screen's store over one chat", () => {
    it('hands the same snapshot back until something in it changes', () => {
        const chat = fakeChat();
        const source = chatSource(chat.history, chat.follow);
        const first = source.get();
        expect(source.get()).toBe(first);
        const run1 = runOf(1);
        chat.setRuns([run1]);
        const second = source.get();
        expect(second).not.toBe(first);
        expect(second.runs).toEqual([run1]);
        // The same runs again, in a new array: the same snapshot.
        chat.setRuns([run1]);
        expect(source.get()).toBe(second);
        chat.setFollow({ live: true });
        expect(source.get().follow.live).toBe(true);
        chat.setHistory({ loadingEarlier: true });
        expect(source.get().history.loadingEarlier).toBe(true);
    });

    it('sees a change made before it subscribed (between a render and its effect)', () => {
        const chat = fakeChat();
        const source = chatSource(chat.history, chat.follow);
        const before = source.get();
        chat.setRuns([runOf(1)]);
        const listener = vi.fn();
        source.subscribe(listener);
        expect(source.get()).not.toBe(before);
    });

    it('tells a subscriber about both, and lets go of both', () => {
        const chat = fakeChat();
        const source = chatSource(chat.history, chat.follow);
        const listener = vi.fn();
        const stop = source.subscribe(listener);
        chat.setRuns([runOf(1)]);
        chat.setFollow({ live: true });
        expect(listener).toHaveBeenCalledTimes(2);
        stop();
        expect(chat.listeners()).toBe(0);
    });

    it('holds the history and its follow stream while the screen shows, then releases both', () => {
        const chat = fakeChat();
        const release = holdChat(chat);
        expect(chat.order).toEqual(['history use', 'follow use']);
        release();
        expect(chat.order).toEqual(['history use', 'follow use', 'follow release', 'history release']);
        const screen = read('screens/chat.tsx');
        // Asked again in the effect and held in the same step, rebuilt if another chat retired it.
        expect(screen).toContain('const history = scope.histories.history(id);');
        expect(screen).toContain('if (history !== source.history) {');
        expect(screen).toContain('return holdChat(source);');
    });
});

describe('a chat kept as the last screen', () => {
    it('is kept as Chat/<id>, which opens Home first (and the chat over it), never a tab', () => {
        expect(chatScreen('c1')).toBe('Chat/c1');
        expect(keptChat(chatScreen('c1'))).toBe('c1');
        expect(lastScreen(chatScreen('c1'))).toBe('Home');
        for (const value of ['Chats', 'Chat/', 'Chat', 'chat/c1', null, undefined]) {
            expect(keptChat(value), String(value)).toBeNull();
        }
    });

    it('opens in the Chats tab, over its list, only while Home is focused, like a kept tab', () => {
        expect(restoreChatAction('c1', true)).toEqual(inTabAction('Chats', 'Chat', { id: 'c1' }));
        expect(restoreChatAction('c1', false)).toBeNull();
        expect(restoreChatAction(null, true)).toBeNull();
        expect(chatAction('c1')).toEqual({ type: 'NAVIGATE', payload: { name: 'Chat', params: { id: 'c1' } } });
    });

    it("has its history read from disk before the first frame, and a failed read doesn't stop the launch", async () => {
        const preload = vi.fn(async () => undefined);
        const values = new Map([[LAST_SCREEN_KEY, chatScreen('c1')]]);
        await preloadKeptChat({ viewState: { get: (key) => values.get(key) ?? null }, histories: { preload } });
        expect(preload).toHaveBeenCalledWith('c1');

        preload.mockClear();
        values.set(LAST_SCREEN_KEY, 'Chats');
        await preloadKeptChat({ viewState: { get: (key) => values.get(key) ?? null }, histories: { preload } });
        expect(preload).not.toHaveBeenCalled();

        const onError = vi.fn();
        values.set(LAST_SCREEN_KEY, chatScreen('c2'));
        const failing = vi.fn(async () => {
            throw new Error('disk');
        });
        await preloadKeptChat(
            { viewState: { get: (key) => values.get(key) ?? null }, histories: { preload: failing } },
            onError,
        );
        expect(onError).toHaveBeenCalledOnce();
        expect(read('platform/active-scope.ts')).toContain('await preloadKeptChat(scope');
    });

    it('is kept by a chat or a room, and Home leaves the first frame to the chat it opens', () => {
        expect(read('screens/chat.tsx')).toContain(
            "useRememberChat(view.kind === 'private' || view.kind === 'room' ? id : null);",
        );
        expect(read('screens/chat.tsx')).toContain(
            "useFirstFrameWithData('Chat', transcriptDrawn(rows.length, history));",
        );
        expect(read('screens/home.tsx')).toContain('restoreChatAction(chatKept, navigation.isFocused())');
        expect(read('screens/home.tsx')).toContain("useFirstFrameWithData('Home', chatKept === null &&");
    });
});

describe('the pills over the transcript (CB-457)', () => {
    const composer = readFileSync(join(SRC, 'screens/chat-composer.tsx'), 'utf8');
    const pills = composer.slice(composer.indexOf('export const PILL_RADIUS'), composer.indexOf('const ACTION_LABELS'));

    it('draws Jump to latest in Liquid Glass, as the running turn’s phase, and Material’s tonal surface elsewhere', () => {
        expect(pills).toContain('<GlassSurface radius={PILL_RADIUS} fallbackClassName={JUMP_FALLBACK} interactive>');
        expect(pills).toContain('<GlassSurface radius={PILL_RADIUS} fallbackClassName={PHASE_FALLBACK}>');
        expect(pills).toContain("export const JUMP_FALLBACK = 'bg-secondary';");
        // The old opaque card with its outline is gone.
        expect(pills).not.toContain('border border-border bg-card');
        expect(pills).toContain('testID="chat-jump-to-latest"');
    });

    it('shows one Working at a time: the pills drop the phase while the transcript shows its line (CB-493)', () => {
        const working = { status: 'Working', shimmer: true, jump: true };
        const following = { status: 'Thinking', shimmer: true, jump: false };
        // The line in view: Jump to latest alone, or no row at all while the list follows.
        expect(shownPill(working, true)).toEqual({ status: null, shimmer: false, jump: true });
        expect(shownPill(following, true)).toBeNull();
        // Nothing in view says it (a room, a reply being written, the line scrolled away): the phase stays.
        expect(shownPill(working, false)).toBe(working);
        expect(shownPill(following, false)).toBe(following);
        expect(shownPill(null, true)).toBeNull();
        const jump = { status: null, shimmer: false, jump: true };
        expect(shownPill(jump, true)).toBe(jump);
        // The list's viewability says whether the line shows.
        expect(liveLineInView([{ key: LIVE_TRACE_ID, isViewable: true }])).toBe(true);
        expect(liveLineInView([{ key: LIVE_TRACE_ID, isViewable: false }])).toBe(false);
        expect(liveLineInView([{ key: 'u1', isViewable: true }])).toBe(false);
        const screen = readFileSync(join(SRC, 'screens/chat.tsx'), 'utf8');
        expect(screen).toMatch(/pill=\{shownPill\(\s*roomPill\(/);
        expect(screen).toContain('onViewableItemsChanged={onViewable}');
        expect(screen).toContain('setLineInView(liveLineInView(viewableItems))');
    });

    it('floats the pills over the transcript on iOS 26 with Jump to latest, so the glass has text behind it (CB-460)', () => {
        // The footer lies under the list: in its flow the glass sees only the screen's opaque background.
        expect(pills).toContain('export const pillsFloat = (pill: StatusPill, glass: boolean) => pill.jump && glass;');
        expect(pills).toContain('if (!pillsFloat(pill, hasLiquidGlass())) {');
        // No height of its own, the row standing on the composer's top edge, touches passing through.
        expect(pills).toMatch(
            /<View pointerEvents="box-none" testID="chat-pills-floating">\s*<View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0">\s*\{row\}/,
        );
        // Jump to latest stays the button, its glass interactive.
        expect(pills).toMatch(
            /<GlassSurface radius=\{PILL_RADIUS\} fallbackClassName=\{JUMP_FALLBACK\} interactive>\s*<Pressable\s+testID="chat-jump-to-latest"/,
        );
    });
});
