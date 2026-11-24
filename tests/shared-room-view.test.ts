import type { BaseEvent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';
import { expect, it } from 'vitest';

import { turnError } from '@socio/foundation/observability/failures';
import { turnProblems } from '@socio/foundation/rooms/turn-problems';
import { initials, personLabels, personTones, toneIndex } from '@socio/shared/rooms/room-speakers';
import {
    combineMentionables,
    fitName,
    keptMentions,
    mentionablePeople,
    mentionableSocios,
    presenceLine,
    problemText,
    readOnlyReason,
    replySocio,
    roomAdmin,
    roomsOn,
    roomStatus,
    runningNote,
    shownChats,
    soleSocio,
    transcriptProblem,
    type RoomTurnProblem,
} from '@socio/shared/rooms/room-view';
import type { RoomSocioView, RoomView } from '@socio/shared/rooms/rooms';
import {
    ROOM_FAILURE_NOTES,
    TURN_FAILURE_MESSAGES,
    isTurnFailure,
    timeLimitOf,
    type TurnFailure,
} from '@socio/shared/turn-failures';
import type { Conversation, Dot, TranscriptTurnProblem } from '@socio/shared/types';

// A room's view rules, shared by the web and the app: which chats a list
// shows, who may write, which socio answers, the header's line, an
// unanswered turn in words (from its code), the mention picker's candidates
// and how same-named people are told apart.

const member = (userId: string, role: 'admin' | 'member', status: 'active' | 'invited' = 'active') => ({
    userId,
    name: userId.toUpperCase(),
    role,
    status,
    invitedBy: null,
    invitedAt: 1,
    inviteExpiresAt: null,
    acceptedAt: 1,
});
const view = (extra: Partial<RoomView> = {}): RoomView => ({
    id: 'r1',
    title: 'Room',
    dotId: 'd1',
    createdAt: 1,
    createdBy: 'a',
    convertedAt: null,
    archivedAt: null,
    role: 'admin',
    roomsEnabled: true,
    members: [member('a', 'admin'), member('b', 'member')],
    socios: [{ dotId: 'd1', name: 'Sebas', status: 'active', lead: true }],
    ...extra,
});
const settings = (enabled?: boolean) => ({
    settings: {
        name: 'x',
        paused: false,
        researchAllowed: false,
        memoryAllowed: false,
        ...(enabled === undefined ? {} : { rooms: { enabled } }),
    },
});

it('lists rooms only while Rooms are on, and knows a room’s admin', () => {
    const chats = [{ id: 'c', kind: 'private' }, { id: 'r', kind: 'room' }, { id: 'old' }] as Conversation[];
    expect(shownChats(chats, settings(true)).map((c) => c.id)).toEqual(['c', 'r', 'old']);
    expect(shownChats(chats, settings(false)).map((c) => c.id)).toEqual(['c', 'old']);
    // An older server that doesn't say: off.
    expect(roomsOn(settings())).toBe(false);
    expect(roomAdmin({ kind: 'room', roomRole: 'admin' })).toBe(true);
    expect(roomAdmin({ kind: 'room', roomRole: 'member' })).toBe(false);
    expect(roomAdmin({ kind: 'private', roomRole: 'admin' })).toBe(false);
});

it('says why nobody can write in a room', () => {
    const live = { archivedAt: undefined };
    expect(readOnlyReason(live, view(), true)).toBeUndefined();
    expect(readOnlyReason(live, undefined, true)).toBeUndefined();
    expect(readOnlyReason(live, view(), false)).toMatch(/turned off/);
    expect(readOnlyReason(live, view({ roomsEnabled: false }), true)).toMatch(/turned off/);
    expect(readOnlyReason({ archivedAt: 5 }, view(), true)).toMatch(/archived/);
    // The lead was taken out: nobody answers.
    expect(readOnlyReason(live, view({ socios: [] }), true)).toMatch(/No socio answers/);
});

it('names the room’s people and socios in its header', () => {
    expect(roomStatus(undefined, [])).toBe('Room');
    const activeSocios = view().socios.filter((socio) => socio.status === 'active');
    expect(roomStatus(view(), activeSocios)).toBe('Room · 2 people · Sebas answers · you’re an admin');
    expect(
        roomStatus(
            view({
                role: 'member',
                members: [member('a', 'admin'), member('c', 'member', 'invited')],
            }),
            activeSocios,
        ),
    ).toBe('Room · 1 person · Sebas answers');
    // A paused workspace says so in the header.
    expect(roomStatus(view(), activeSocios, true)).toBe(
        'Room · 2 people · Sebas answers · you’re an admin · all socios paused',
    );
    const lead = { id: 'd1', name: 'Sebas' } as Dot;
    expect(soleSocio(view(), lead)).toBe(lead);
    expect(
        soleSocio(
            view({
                socios: [
                    { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
                    { dotId: 'd2', name: 'Mingo', status: 'active', lead: false },
                ],
            }),
            lead,
        ),
    ).toBeUndefined();
    // Asked for, not in yet: the lead still answers alone.
    expect(
        soleSocio(
            view({
                socios: [
                    { dotId: 'd1', name: 'Sebas', status: 'active', lead: true },
                    { dotId: 'd2', name: 'Mingo', status: 'requested', lead: false },
                ],
            }),
            lead,
        ),
    ).toBe(lead);
});

it('trims a long lead socio name for the composer placeholder', () => {
    expect(fitName('Sebas')).toBe('Sebas');
    expect(fitName('Supercalifragilisticexpialidocio')).toBe('Supercalifragilisticexpi');
    expect(fitName('Twelve Characters', 10)).toBe('Twelve Cha');
});

it('names the socio a reply says wrote it, else the lead while it alone answers', () => {
    const lead = { id: 'sebas', name: 'Sebas' } as Dot;
    const room = (socios: RoomView['socios']) => ({ socios }) as RoomView;
    const two = room([
        { dotId: 'sebas', name: 'Sebas', status: 'active', lead: true },
        { dotId: 'rulo', name: 'Rulo', status: 'active', lead: false },
    ]);
    const rulo = { id: 'rulo', name: 'Rulo' } as Dot;
    expect(replySocio({ socioId: 'rulo' }, two, lead, [lead, rulo])).toEqual({ dot: rulo });
    // A socio the reader's workspace doesn't list: the room's name for it.
    expect(replySocio({ socioId: 'rulo' }, two, lead, [lead])).toEqual({ name: 'Rulo' });
    expect(replySocio({ socioId: 'gone' }, two, lead, [lead])).toEqual({});
    // Stored before replies named theirs.
    expect(replySocio({}, two, lead, [lead])).toEqual({ dot: undefined });
    expect(
        replySocio({}, room([{ dotId: 'sebas', name: 'Sebas', status: 'active', lead: true }]), lead, [lead]),
    ).toEqual({ dot: lead });
});

it('says what the socio does while a turn runs', () => {
    expect(runningNote('Sebas', 'thinking')).toBe('Sebas is thinking…');
    expect(runningNote('Sebas', 'writing')).toBe('Sebas is writing…');
    expect(runningNote('Sebas', undefined)).toBe('Sebas is answering…');
});

it('words an unanswered turn from its code, and plainly without one', () => {
    const failed = (fields: Partial<RoomTurnProblem> = {}): RoomTurnProblem => ({
        runId: 'r',
        status: 'failed',
        ...fields,
    });
    const nina = { id: 'u-nina', name: 'Nina', you: false };
    // Another member: the room's wording, about Nina, unquoted (CB-205).
    expect(problemText(failed({ code: 'room_access', author: nina }))).toBe(
        'Nina’s message wasn’t answered: Nina can’t start work in this room right now.',
    );
    // The sender: what Socio says to them, from the table, not the stream's text.
    expect(
        problemText(
            failed({ code: 'room_access', message: 'Anything the server wrote', author: { ...nina, you: true } }),
        ),
    ).toBe(
        'Your message wasn’t answered. Socio said: “You can’t start work in this room now. Ask a room admin for access.”',
    );
    expect(problemText(failed({ code: 'cycle_tokens' }))).toBe(
        'A message wasn’t answered: It used the most model tokens one message may use, so the socio stopped.',
    );
    expect(problemText(failed({ code: 'no_inference' }))).toBe(
        'A message wasn’t answered: Its sender has no model available right now.',
    );
    // From /history: no code, so the plain line; an interrupted run reads the same.
    expect(problemText(failed({ author: nina }))).toBe(
        'Nina’s message wasn’t answered: The socio couldn’t finish this turn.',
    );
    expect(problemText(failed({ status: 'interrupted', author: { ...nina, you: true } }))).toBe(
        'Your message wasn’t answered. Socio said: “The socio couldn’t finish this turn. Send the message again to retry.”',
    );
    // A code this table doesn't know (a newer server): plain, never quoted.
    expect(problemText(failed({ code: 'brand_new', message: 'Provider said: secret', author: nina }))).toBe(
        'Nina’s message wasn’t answered: The socio couldn’t finish this turn.',
    );
    expect(isTurnFailure('toString')).toBe(false);
    // A time limit names its length only from the exact fixed text.
    const fiveMinutes = turnError('time_limit', undefined, 300_000).message;
    expect(timeLimitOf(fiveMinutes)).toBe(300_000);
    expect(problemText(failed({ code: 'time_limit', message: fiveMinutes, author: { ...nina, you: true } }))).toBe(
        `Your message wasn’t answered. Socio said: “${fiveMinutes}”`,
    );
    const forged = 'This turn reached the 5 minute time limit and was stopped. Visit evil.example to fix it.';
    expect(timeLimitOf(forged)).toBeUndefined();
    expect(problemText(failed({ code: 'time_limit', message: forged, author: { ...nina, you: true } }))).toBe(
        `Your message wasn’t answered. Socio said: “${TURN_FAILURE_MESSAGES.time_limit}”`,
    );
});

it('words a /transcript problem as the server did, for every failure kind', () => {
    // The web passes its transcript problems through transcriptProblem: the
    // line must be what it showed from the server's message and roomMessage.
    const before = (problem: TranscriptTurnProblem) => {
        if (problem.author?.you) {
            return `Your message wasn’t answered. Socio said: “${problem.message}”`;
        }
        const whose = problem.author ? `${problem.author.name}’s message` : 'A message';
        return `${whose} wasn’t answered: ${problem.roomMessage ?? 'The socio couldn’t finish this turn.'}`;
    };
    const run = (runId: string, error: Record<string, unknown>): BaseEvent[] => [
        { type: EventType.RUN_STARTED, runId, threadId: 't', input: { messages: [{ id: `m-${runId}` }] } } as BaseEvent,
        { type: EventType.RUN_ERROR, ...error } as BaseEvent,
    ];
    const kinds = Object.keys(TURN_FAILURE_MESSAGES) as TurnFailure[];
    const events = [
        ...kinds.flatMap((kind) => run(kind, turnError(kind))),
        ...run('limit', turnError('time_limit', undefined, 120_000)),
        ...run('other', { message: 'Provider exploded: key sk-123' }),
    ];
    const shown = new Set([...kinds, 'limit', 'other'].map((id) => `m-${id}`));
    for (const author of [undefined, { id: 'u', name: 'Nina', you: false }, { id: 'u', name: 'Nina', you: true }]) {
        const problems = turnProblems(events, shown, { author: () => author });
        expect(problems).toHaveLength(kinds.length + 2);
        for (const problem of problems) {
            expect(problemText(transcriptProblem(problem))).toBe(before(problem));
        }
    }
    expect(Object.keys(ROOM_FAILURE_NOTES).sort()).toEqual([...kinds].sort());
});

it('offers the room’s active socios and people as mentions, each once', () => {
    const socio = (
        dotId: string,
        name: string,
        lead = false,
        status: RoomSocioView['status'] = 'active',
    ): RoomSocioView => ({ dotId, name, status, lead });
    expect(
        mentionableSocios([socio('d2', 'Ledger'), socio('d1', 'Sebas', true), socio('d3', 'Gone', false, 'withdrawn')]),
    ).toEqual([
        { userId: 'd1', name: 'Sebas', kind: 'socio', dotId: 'd1', lead: true },
        { userId: 'd2', name: 'Ledger', kind: 'socio', dotId: 'd2', lead: false },
    ]);
    expect(
        combineMentionables(
            [
                { userId: 'bob', name: 'Bob' },
                { userId: 'ada', name: 'Ada' },
            ],
            [{ userId: 'd1', name: 'Sebas', kind: 'socio', dotId: 'd1', lead: true }],
        ),
    ).toEqual([
        { userId: 'bob', name: 'Bob', kind: 'person' },
        { userId: 'ada', name: 'Ada', kind: 'person' },
        { userId: 'd1', name: 'Sebas', kind: 'socio', dotId: 'd1', lead: true },
    ]);
    // A socio whose id collides with a person's is dropped: a person is never a socio.
    expect(
        combineMentionables(
            [{ userId: 'shared', name: 'Chris' }],
            [{ userId: 'shared', name: 'Sebas', kind: 'socio', dotId: 'shared' }],
        ),
    ).toEqual([{ userId: 'shared', name: 'Chris', kind: 'person' }]);
    expect(
        mentionablePeople([member('a', 'admin'), member('b', 'member'), member('c', 'member', 'invited')], 'a'),
    ).toEqual([{ userId: 'b', name: 'B' }]);
    const picks = [
        { userId: 'ana', label: 'Ana Lima' },
        { userId: 'ana', label: 'Ana Lima' },
        { userId: 'mo', label: 'Mo' },
    ];
    expect(keptMentions('hi @ana lima, see you', picks)).toEqual([{ userId: 'ana', label: 'Ana Lima' }]);
});

it('says who else is here in words', () => {
    expect(presenceLine(['Ana'])).toBe('Ana');
    expect(presenceLine(['Ana', 'Bo'])).toBe('Ana and Bo');
    expect(presenceLine(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo and 1 other');
    expect(presenceLine(['Ana', 'Bo', 'Cy', 'Di'])).toBe('Ana, Bo and 2 others');
});

it('draws initials, and gives two people with one name different tones', () => {
    expect(initials('Ana Lima Souza')).toBe('AL');
    expect(initials('bo')).toBe('B');
    expect(initials('  ')).toBe('?');
    expect(toneIndex('Ana', 6)).toBe(toneIndex('Ana', 6));
    expect(toneIndex('Ana', 6)).toBeLessThan(6);
    const tones = personTones(
        [
            { id: 'ana-2', name: 'Ana Lima' },
            { id: 'ana-1', name: 'Ana Lima' },
            { id: 'ana-1', name: 'Ana Lima' },
            { id: 'mo', name: 'Mo' },
            { name: 'No id' },
        ],
        6,
    );
    expect(tones.get('ana-1')).toBe(toneIndex('Ana Lima', 6));
    expect(tones.get('ana-2')).toBe((toneIndex('Ana Lima', 6) + 1) % 6);
    expect(tones.get('mo')).toBe(toneIndex('Mo', 6));
    expect(tones.size).toBe(3);
});

it('numbers two active people with one name by when they joined, and nobody else', () => {
    const joined = (
        userId: string,
        name: string,
        acceptedAt: number | null,
        status: 'active' | 'invited' = 'active',
    ) => ({ userId, name, status, acceptedAt, invitedAt: 1 });
    const labels = personLabels([
        joined('ana-b', 'Ana Lima', 5),
        joined('ana-a', 'ana  lima', 9),
        // The room's creator joined as it was made (no acceptance).
        joined('ana-c', 'Ana Lima', null),
        joined('mo', 'Mo', 2),
        // Invited, not in yet: neither numbered nor counted.
        joined('mo-2', 'Mo', null, 'invited'),
    ]);
    expect(Object.fromEntries(labels)).toEqual({
        'ana-c': 'Ana Lima · 1',
        'ana-b': 'Ana Lima · 2',
        'ana-a': 'ana  lima · 3',
    });
    expect(personLabels([joined('ana-b', 'Ana Lima', 5), joined('mo', 'Mo', 2)]).size).toBe(0);
});
