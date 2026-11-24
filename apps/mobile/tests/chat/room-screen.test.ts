import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { HistoryPage, HistoryRun } from '@socio/shared/chat/chat-history';
import { type LiveTurn, NO_LIVE_TURN } from '@socio/shared/rooms/live-turn';
import type { TranscriptMention } from '@socio/shared/rooms/room-notices';
import type { RoomView } from '@socio/shared/rooms/rooms';
import { TURN_FAILURE_MESSAGES } from '@socio/shared/turn-failures';
import type { Dot } from '@socio/shared/types';

import { EMPTY_ROOM, emptyTranscriptLine } from '../../src/chat/chat-view';
import type { PendingBubble } from '../../src/chat/composer';
import { linkTarget } from '../../src/chat/markdown-links';
import { MANAGE_ON_WEB, membersView, PERSON_TONES, presenceSaid, roomHeader } from '../../src/chat/room-people';
import {
    CANCEL_ARCHIVED,
    CANCEL_DELIVERED,
    CANCEL_FAILED,
    CANCEL_NOT_DONE,
    CANCEL_REFUSED,
    CANCEL_ROOMS_OFF,
    cancelAnswer,
    MENTIONS_YOU,
    mentionsYou,
    cancelOthersQueued,
    othersBubbles,
    readRoomFailures,
    type RoomContext,
    type RoomRow,
    roomBubbles,
    roomReplier,
    roomRows,
    roomRunningNote,
    shouldMarkRead,
    unwordedRuns,
} from '../../src/chat/room-transcript';
import { messageText } from '../../src/chat/transcript';
import type { AuthedFetch } from '../../src/net/authed-fetch';

// The room screen's view models over the room seed's captured pages
// (servers.mjs --capture: the seeded room's `/history` as Ada and as Ben).
// Ada's opening turn called tools (Ben's copy has their results withheld),
// "@Sebas @Manny …" is answered by Sebas and handed to Manny (a handoff
// note), and Ben's message failed under a one-token limit.

const fixture = <T>(name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
const asAda = fixture<HistoryPage>('room-history-ada.json').runs;
const asBen = fixture<HistoryPage>('room-history-ben.json').runs;

const ADA = 'u-65f8c5f87277';
const BEN = 'u-5cb6335eda3f';
const SEBAS = '0a3db2bd-f0aa-435f-a877-0d6c97d948bb';
const MANNY = 'e447f4ee-66ed-4090-83a4-a210908ecb67';

const member = (userId: string, name: string, role: 'admin' | 'member', acceptedAt: number) => ({
    userId,
    name,
    role,
    status: 'active' as const,
    invitedBy: null,
    invitedAt: acceptedAt,
    inviteExpiresAt: null,
    acceptedAt,
});

const view = (patch: Partial<RoomView> = {}): RoomView => ({
    id: 'room-1',
    title: 'A: launch room',
    dotId: SEBAS,
    createdAt: 1,
    createdBy: ADA,
    convertedAt: null,
    archivedAt: null,
    role: 'admin',
    roomsEnabled: true,
    members: [member(ADA, 'Ada', 'admin', 1), member(BEN, 'Ben', 'member', 2)],
    socios: [
        { dotId: SEBAS, name: 'Sebas', status: 'active', lead: true },
        { dotId: MANNY, name: 'Manny', status: 'active', lead: false },
    ],
    ...patch,
});

const dots = [
    { id: SEBAS, name: 'Sebas', character: 'sebas' },
    { id: MANNY, name: 'Manny', character: 'manny' },
] as unknown as Dot[];

const context = (me: string, patch: Partial<RoomContext> = {}): RoomContext => ({
    view: view(),
    leadId: SEBAS,
    dots,
    me,
    failure: () => undefined,
    ...patch,
});

const said = (rows: readonly RoomRow[]) =>
    rows.map((row) =>
        row.kind === 'user' || row.kind === 'reply'
            ? `${row.kind} ${row.speaker?.kind}:${row.speaker?.name}`
            : row.kind === 'room-note'
              ? `${row.note} ${row.text}`
              : row.kind,
    );

describe('a room transcript from /history', () => {
    it("names who wrote each message, the reader's own as You, with handoffs and the failed turn as lines", () => {
        expect(said(roomRows(asAda, NO_LIVE_TURN, context(ADA)))).toEqual([
            'user you:You',
            'trace',
            'reply socio:Sebas',
            'user you:You',
            'reply socio:Sebas',
            'handoff Manny answers next, as Ada asked.',
            'reply socio:Manny',
            'user person:Ben',
            'problem Ben’s message wasn’t answered: The socio couldn’t finish this turn.',
        ]);
    });

    it("words Ben's own failed turn to him, from the code this device saw", () => {
        const rows = roomRows(asBen, NO_LIVE_TURN, context(BEN, { failure: () => 'cycle_tokens' }));
        const problem = rows.at(-1);
        expect(problem).toMatchObject({ kind: 'room-note', note: 'problem' });
        expect((problem as { text: string }).text).toMatch(/^Your message wasn’t answered\. Socio said: “/);
        expect(said(rows)[0]).toBe('user person:Ada');
    });

    it('words a failed turn from the code /history carries (CB-406), over the one this device saw', () => {
        const failed = (runs: readonly HistoryRun[]) =>
            runs.map((run) => (run.status === 'failed' ? { ...run, failure: 'cycle_tokens' as const } : run));
        expect(said(roomRows(failed(asAda), NO_LIVE_TURN, context(ADA))).at(-1)).toBe(
            'problem Ben’s message wasn’t answered: It used the most model tokens one message may use, so the socio stopped.',
        );
        const own = roomRows(failed(asBen), NO_LIVE_TURN, context(BEN, { failure: () => 'model_unavailable' }));
        expect((own.at(-1) as { text: string }).text).toContain('the most model tokens one message may use');
    });

    it("gives Ben the same rows with Ada's results withheld, and never a handoff as a bubble", () => {
        const rows = roomRows(asBen, NO_LIVE_TURN, context(BEN));
        expect(rows.filter((row) => row.kind === 'user')).toHaveLength(3);
        expect(rows.some((row) => row.kind === 'user' && row.text.includes('Socio wrote this note'))).toBe(false);
        // The withheld results still make the trace row: the steps, not their results.
        expect(rows.filter((row) => row.kind === 'trace')).toHaveLength(1);
    });

    it("gives each person a tone from the app's table, and numbers same-named members in words", () => {
        const twoAdas = view({
            members: [member(ADA, 'Ada', 'admin', 1), member(BEN, 'Ada', 'member', 2)],
        });
        const rows = roomRows(asAda, NO_LIVE_TURN, context('someone-else', { view: twoAdas }));
        const speakers = rows.flatMap((row) => (row.kind === 'user' && row.speaker ? [row.speaker] : []));
        expect(speakers.map((speaker) => speaker.name)).toEqual(['Ada · 1', 'Ada · 1', 'Ada · 2']);
        const tones = speakers.map((speaker) => (speaker.kind === 'person' ? speaker.tone : null));
        expect(PERSON_TONES).toContain(tones[0]);
        expect(tones[0]).not.toBe(tones[2]);
    });

    it('falls back to the stamped names offline, before the view has come', () => {
        const rows = roomRows(asAda, NO_LIVE_TURN, context(ADA, { view: null }));
        expect(said(rows)).toContain('user person:Ben');
        expect(said(rows)).toContain('handoff Manny answers next.');
    });

    it("shows another person's running turn only as the note, never its steps", () => {
        const turn: LiveTurn = {
            running: true,
            phase: 'thinking',
            messages: [
                {
                    id: 'live-1',
                    role: 'user',
                    content: 'one more thing',
                    author: { id: BEN, name: 'Ben', you: false },
                } as LiveTurn['messages'][number],
            ],
        };
        const rows = roomRows(asAda, turn, context(ADA));
        expect(rows.some((row) => row.kind === 'trace' && row.turn === null)).toBe(false);
        expect(said(rows).at(-1)).toBe('user person:Ben');
        // Two socios answer: the note can't name one until a reply streams.
        expect(roomRunningNote(turn, context(ADA))).toBe('A socio is thinking…');
        const solo = context(ADA, { view: view({ socios: [view().socios[0]!] }) });
        expect(roomRunningNote(turn, solo)).toBe('Sebas is thinking…');
        expect(roomRunningNote(NO_LIVE_TURN, solo)).toBeNull();
    });

    it('names the socio whose reply came last when the turn ends, else the lead, for a screen reader', () => {
        const reply = (id: string, content: string, socioId?: string) =>
            ({
                id,
                role: 'assistant',
                content,
                ...(socioId === undefined ? {} : { socioId }),
            }) as LiveTurn['messages'][number];
        const ended = (...messages: LiveTurn['messages']): LiveTurn => ({ running: false, messages });
        expect(roomReplier(ended(reply('a1', 'Sure.', SEBAS), reply('a2', 'Done.', MANNY)), context(ADA))).toBe(
            'Manny',
        );
        // A handoff's empty step names nobody; the last words do.
        expect(roomReplier(ended(reply('a1', 'Done.', MANNY), reply('a2', ' ', SEBAS)), context(ADA))).toBe('Manny');
        expect(roomReplier(ended(reply('a1', 'Hi.')), context(ADA))).toBe('Sebas');
    });
});

describe('the "@you" badge (CB-416, the web\'s MentionedYou)', () => {
    /** Ben's runs with `mentions` on a message, as /history carries them. */
    const mentioning = (runs: readonly HistoryRun[], text: string, mentions: TranscriptMention[]): HistoryRun[] =>
        runs.map((run) => ({
            ...run,
            messages: run.messages.map((message) =>
                message.role === 'user' && messageText(message).startsWith(text) ? { ...message, mentions } : message,
            ),
        }));
    const speakers = (rows: readonly RoomRow[]) =>
        rows.flatMap((row) => (row.kind === 'user' && row.speaker ? [row.speaker] : []));

    it("marks another person's message that mentions the reader, and only that one", () => {
        const runs = mentioning(asAda, 'A: smoke context 2', [
            { name: 'Ada', you: true },
            { name: 'Sebas', you: false },
        ]);
        const marked = speakers(roomRows(runs, NO_LIVE_TURN, context(ADA)));
        expect(marked.find((speaker) => speaker.kind === 'person')).toMatchObject({ name: 'Ben', mentionsYou: true });
        expect(marked.filter((speaker) => speaker.kind === 'person' && speaker.mentionsYou)).toHaveLength(1);
        expect(
            mentionsYou({ id: 'm', role: 'user', content: 'x', mentions: [{ name: 'Ada', you: true }] } as never),
        ).toBe(true);
    });

    it('marks nothing when the mentions name someone else, or there are none (older servers)', () => {
        const others = mentioning(asAda, 'A: smoke context 2', [{ name: 'Cy', you: false }]);
        for (const runs of [others, asAda]) {
            const rows = speakers(roomRows(runs, NO_LIVE_TURN, context(ADA)));
            expect(rows.some((speaker) => speaker.kind === 'person' && 'mentionsYou' in speaker)).toBe(false);
        }
        // The reader's own message is "You", never marked.
        const own = mentioning(asBen, 'A: smoke context 2', [{ name: 'Ben', you: true }]);
        expect(speakers(roomRows(own, NO_LIVE_TURN, context(BEN))).at(-1)).toEqual({ kind: 'you', name: 'You' });
    });

    it('shows beside the name in the speaker line, said as "mentions you"', () => {
        const parts = readFileSync(new URL('../../src/screens/room-parts.tsx', import.meta.url), 'utf8');
        expect(parts).toContain("speaker.kind === 'person' && speaker.mentionsYou === true ? <MentionedYou /> : null");
        expect(parts).toContain('accessibilityLabel={MENTIONS_YOU}');
        expect(MENTIONS_YOU).toBe('mentions you');
    });
});

describe("the room's header and Members sheet", () => {
    it('reads the title, the status and who is here as one line, the reader never among them', () => {
        const header = roomHeader({
            title: 'A: launch room',
            view: view(),
            dots,
            paused: false,
            present: [
                { userId: BEN, name: 'Ben' },
                { userId: ADA, name: 'Ada' },
            ],
            me: ADA,
        });
        expect(header.status).toBe('Room · 2 people · Sebas, Manny answer · you’re an admin');
        expect(header.socios.map((socio) => socio.name)).toEqual(['Sebas', 'Manny']);
        expect(header.presence).toBe('Ben is here');
        expect(header.here).toHaveLength(1);
        expect(header.label).toBe(
            'A: launch room. Room · 2 people · Sebas, Manny answer · you’re an admin. Ben is here',
        );
        expect(presenceSaid(['Ana', 'Bo', 'Cy', 'Di'])).toBe('Ana, Bo and 2 others are here');
        expect(presenceSaid([])).toBe('');
    });

    it('lists the people, then the socios, and manages them on the web through useOpenLink', () => {
        const members = membersView('room 1', view(), dots, ADA);
        expect(members.people.map((row) => [row.name, row.detail])).toEqual([
            ['Ada (you)', 'Admin'],
            ['Ben', null],
        ]);
        expect(members.socios.map((row) => [row.name, row.detail])).toEqual([
            ['Sebas', 'Lead'],
            ['Manny', null],
        ]);
        expect(members.manage).toEqual({ label: MANAGE_ON_WEB, href: '/chats/room%201' });
        // A workspace page: useOpenLink shows the sign-in line before the browser.
        expect(linkTarget(members.manage.href, 'https://brain.example.test')).toMatchObject({ kind: 'workspace' });
        const sheet = readFileSync(new URL('../../src/screens/room-members.tsx', import.meta.url), 'utf8');
        expect(sheet).toContain('useOpenLink()');
        expect(sheet).not.toMatch(/Linking|WebBrowser/);
    });
});

describe('pending messages and read marks in a room', () => {
    it("offers Retry and Delete for the reader's refused message", () => {
        const bubble = { actions: ['retry', 'edit'] } as unknown as PendingBubble;
        expect(roomBubbles([bubble])[0]!.actions).toEqual(['retry', 'delete']);
    });

    it("shows a room admin everyone else's waiting messages, held ones said so", () => {
        const others = othersBubbles(
            [
                { id: 'q1', text: 'hi', files: 0, author: { name: 'Ben' }, createdAt: 0, updatedAt: 0 },
                { id: 'q2', text: 'yo', files: 1, author: { name: 'Cy' }, held: true, createdAt: 0, updatedAt: 0 },
                { id: 'q3', text: 'gone', files: 0, author: { name: 'Ben' }, createdAt: 0, updatedAt: 0 },
            ],
            { stored: (id) => id === 'q3', inTurn: new Set() },
            120_000,
            true,
        );
        expect(others.map((bubble) => bubble.caption)).toEqual([
            'Ben · Queued · written 2 min ago',
            'Cy · Can’t send now',
        ]);
    });

    it("leaves out a queued message the live turn holds, delivered before the queue's next read", () => {
        const others = othersBubbles(
            [
                { id: 'q1', text: 'hi', files: 0, author: { name: 'Ben' }, createdAt: 0, updatedAt: 0 },
                { id: 'q2', text: 'yo', files: 0, author: { name: 'Cy' }, createdAt: 0, updatedAt: 0 },
            ],
            { stored: () => false, inTurn: new Set(['q1']) },
            0,
            true,
        );
        expect(others.map((bubble) => bubble.messageId)).toEqual(['q2']);
    });

    it('offers no Cancel in a read-only room, which the server refuses', () => {
        const queued = [{ id: 'q1', text: 'hi', files: 0, author: { name: 'Ben' }, createdAt: 0, updatedAt: 0 }];
        const shown = { stored: () => false, inTurn: new Set<string>() };
        expect(othersBubbles(queued, shown, 0, true).map((bubble) => bubble.cancellable)).toEqual([true]);
        expect(othersBubbles(queued, shown, 0, false).map((bubble) => bubble.cancellable)).toEqual([false]);
        const screen = readFileSync(new URL('../../src/screens/chat.tsx', import.meta.url), 'utf8');
        expect(screen).toMatch(/Date\.now\(\),\s*\/\/[^\n]*\n\s*composer\.readOnly === null,/);
        const parts = readFileSync(new URL('../../src/screens/room-parts.tsx', import.meta.url), 'utf8');
        expect(parts).toContain('{bubble.cancellable ? (');
    });

    it('cancels online only, never queued: told apart by the answer, a 404 counting as done', async () => {
        const calls: string[] = [];
        const answer = (status: number, body: unknown = null): AuthedFetch =>
            (async (path: string, init?: { method?: string }) => {
                calls.push(`${init?.method} ${path}`);
                return new Response(body === null ? null : JSON.stringify(body), { status });
            }) as unknown as AuthedFetch;
        expect(await cancelOthersQueued(answer(200), 'r 1', 'q1')).toBe('done');
        expect(calls).toEqual(['DELETE /api/conversations/r%201/steering/q1']);
        expect(await cancelOthersQueued(answer(404), 'r1', 'q1')).toBe('done');
        const conflict = (code: string) => answer(409, { error: 'x', code });
        expect(await cancelOthersQueued(conflict('delivered'), 'r1', 'q1')).toBe('delivered');
        // The server's other 409s are the room's state, never "too late".
        expect(await cancelOthersQueued(conflict('archived'), 'r1', 'q1')).toBe('archived');
        expect(await cancelOthersQueued(conflict('rooms_off'), 'r1', 'q1')).toBe('rooms-off');
        expect(await cancelOthersQueued(conflict('conflict'), 'r1', 'q1')).toBe('failed');
        expect(await cancelOthersQueued(answer(409), 'r1', 'q1')).toBe('failed');
        expect(await cancelOthersQueued(answer(403), 'r1', 'q1')).toBe('refused');
        // A status came back, so the server failed: not the connection.
        expect(await cancelOthersQueued(answer(503), 'r1', 'q1')).toBe('failed');
        expect(await cancelOthersQueued(answer(400), 'r1', 'q1')).toBe('failed');
        const away = (async () => {
            throw new TypeError('offline');
        }) as unknown as AuthedFetch;
        expect(await cancelOthersQueued(away, 'r1', 'q1')).toBe('offline');
    });

    it('reads the queue again after any answer, says why it was too late or refused, and blames the connection only for none', () => {
        expect(cancelAnswer('done')).toEqual({ notice: null, refresh: true });
        expect(cancelAnswer('delivered')).toEqual({ notice: CANCEL_DELIVERED, refresh: true });
        expect(cancelAnswer('refused')).toEqual({ notice: CANCEL_REFUSED, refresh: true });
        expect(cancelAnswer('archived')).toEqual({ notice: CANCEL_ARCHIVED, refresh: true });
        expect(cancelAnswer('rooms-off')).toEqual({ notice: CANCEL_ROOMS_OFF, refresh: true });
        // A 5xx reads the queue again and doesn't blame the connection.
        expect(cancelAnswer('failed')).toEqual({ notice: CANCEL_NOT_DONE, refresh: true });
        expect(cancelAnswer('offline')).toEqual({ notice: CANCEL_FAILED, refresh: false });
    });

    it('marks read while the newest run is on screen and the app is active, never backwards', () => {
        const base = { seq: 5, marked: null, following: true, active: true };
        expect(shouldMarkRead(base)).toBe(true);
        expect(shouldMarkRead({ ...base, following: false })).toBe(false);
        expect(shouldMarkRead({ ...base, active: false })).toBe(false);
        expect(shouldMarkRead({ ...base, marked: 5 })).toBe(false);
        expect(shouldMarkRead({ ...base, marked: 4 })).toBe(true);
        expect(shouldMarkRead({ ...base, seq: null })).toBe(false);
    });
});

describe('the room as the web shows it', () => {
    const source = (file: string) => readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8');

    it("words a failed run it never saw from the room's transcript, as the web does", async () => {
        // Ben's turn failed before this device followed the room, on a server before CB-406: /history has no code.
        const failed = asAda.filter((run) => run.status === 'failed').map((run) => run.runId);
        expect(failed).toHaveLength(1);
        expect(unwordedRuns(asAda, () => undefined)).toEqual(failed);
        expect(unwordedRuns(asAda, () => 'cycle_tokens')).toEqual([]);
        // A server since CB-406 sends the code with the run: no transcript read.
        const carried = asAda.map((run) =>
            run.status === 'failed' ? { ...run, failure: 'cycle_tokens' as const } : run,
        );
        expect(unwordedRuns(carried, () => undefined)).toEqual([]);

        const asked: string[] = [];
        const transcript = (status: number, body: unknown): AuthedFetch =>
            (async (path: string) => {
                asked.push(path);
                return new Response(JSON.stringify(body), { status });
            }) as unknown as AuthedFetch;
        const problems = {
            messages: [],
            problems: [
                { runId: failed[0], message: TURN_FAILURE_MESSAGES.cycle_tokens, author: { name: 'Ben', you: false } },
                // A text the table doesn't know (a provider's words) gives no code: never quoted.
                { runId: 'other', message: 'Upstream said 500 at proxy.internal' },
            ],
        };
        const codes = await readRoomFailures(transcript(200, problems), 'r 1');
        expect(asked).toEqual(['/api/conversations/r%201/transcript']);
        expect(codes).toEqual([[failed[0], 'cycle_tokens']]);
        expect(await readRoomFailures(transcript(404, {}), 'r1')).toBeNull();
        const offline = (async () => {
            throw new TypeError('Network request failed');
        }) as unknown as AuthedFetch;
        expect(await readRoomFailures(offline, 'r1')).toBeNull();

        const found = new Map(codes);
        const rows = roomRows(asAda, NO_LIVE_TURN, context(ADA, { failure: (runId) => found.get(runId) }));
        expect(said(rows).at(-1)).toBe(
            'problem Ben’s message wasn’t answered: It used the most model tokens one message may use, so the socio stopped.',
        );
        // The screen feeds the rows the codes it read, over the ones this device saw.
        expect(source('chat.tsx')).toContain(
            'const failure = useRoomFailures(room === undefined ? null : id, snapshot.runs);',
        );
        expect(source('chat.tsx')).toContain('roomRows(snapshot.runs, turn, { ...room.context, failure }, extras)');
        expect(source('room-parts.tsx')).toContain('runFailures.note(runId, code);');
    });

    it("marks a socio's name with the web's small socio badge", () => {
        const parts = source('room-parts.tsx');
        expect(parts).toContain("export const SOCIO_BADGE = 'socio';");
        expect(parts).toMatch(
            /speaker\.kind === 'socio' \? \(\s*<View className="rounded-sm border border-border px-1"/,
        );
    });

    it('says an empty room’s line at the top, as the web does', () => {
        expect(EMPTY_ROOM).toBe('No messages yet. Everyone in the room reads what is written here.');
        expect(emptyTranscriptLine(true)).toBe(EMPTY_ROOM);
        expect(emptyTranscriptLine(false)).toBe('No messages yet.');
        const screen = source('chat.tsx');
        expect(screen).toContain('room={room !== undefined}');
        expect(screen).toMatch(
            /if \(ready && room\) \{[\s\S]*?className="flex-1 px-4 pt-4"[\s\S]*?emptyTranscriptLine\(true\)/,
        );
    });
});
