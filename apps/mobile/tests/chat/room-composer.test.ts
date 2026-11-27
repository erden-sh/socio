import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import type { RoomView } from '@socio/shared/rooms/rooms';
import type { Dot } from '@socio/shared/types';

import { quoteOf, withQuote } from '../../src/chat/quote-reply';
import {
    leadName,
    lengthNotice,
    mayStopRoom,
    mentionPicker,
    mentionsSaid,
    ownWaiting,
    pickMention,
    roomPlaceholder,
    sendRoomMessage,
    sentMentions,
    tooLong,
} from '../../src/chat/room-composer';
import type { NewOutboxWrite, OutboxRow } from '../../src/sync/outbox';
import { ROOM_MESSAGE_KIND } from '../../src/sync/room-send';

// The room composer's view models. The `@` picker over the seeded room's
// people and socios (servers.mjs's ids), its accessibility labels and count, the
// mention payload a send carries, who answers, the length limit, and who may
// stop a running turn.

const fixture = <T>(name: string) =>
    JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
const asAda = fixture<HistoryPage>('room-history-ada.json').runs;

const ADA = 'u-65f8c5f87277';
const BEN = 'u-5cb6335eda3f';
const CY = 'u-cy';
const SEBAS = '0a3db2bd-f0aa-435f-a877-0d6c97d948bb';
const MANNY = 'e447f4ee-66ed-4090-83a4-a210908ecb67';

const member = (userId: string, name: string, status: 'active' | 'invited' = 'active') => ({
    userId,
    name,
    role: 'member' as const,
    status,
    invitedBy: null,
    invitedAt: 1,
    inviteExpiresAt: null,
    acceptedAt: 1,
});

const view: Pick<RoomView, 'members' | 'socios'> = {
    members: [member(ADA, 'Ada'), member(BEN, 'Ben'), member(CY, 'Cy', 'invited')],
    socios: [
        { dotId: SEBAS, name: 'Sebas', status: 'active', lead: true },
        { dotId: MANNY, name: 'Manny', status: 'active', lead: false },
    ],
};
const one = { ...view, socios: [view.socios[0]!] };
const dots = [
    { id: SEBAS, name: 'Sebas', character: 'sebas' },
    { id: MANNY, name: 'Manny', character: 'manny' },
] as unknown as Dot[];

const picker = (text: string, caret = text.length, dismissed: number | null = null) =>
    mentionPicker({ text, caret, dismissed, view, me: ADA, dots });

describe('the room box', () => {
    it('says whom it talks to, the lead cut to fit, or the @ hint with several socios', () => {
        expect(roomPlaceholder(one.socios, 'Sebas')).toBe('Message the room and Sebas…');
        expect(roomPlaceholder(one.socios, 'A socio with a name far too long for one line')).toBe(
            'Message the room and A socio with a name far…',
        );
        expect(roomPlaceholder(view.socios, 'Sebas')).toBe('Message the room, or @ a socio…');
        expect(leadName({ view, leadId: SEBAS, dots })).toBe('Sebas');
        expect(leadName({ view: null, leadId: MANNY, dots })).toBe('Manny');
    });

    it('says nothing under the box about who answers or a send that waits (CB-491)', () => {
        // The owner: the line always read as noise. Only the held or update line shows there.
        const screen = readFileSync(new URL('../../src/screens/room-composer.tsx', import.meta.url), 'utf8');
        expect(screen).toContain('line: base.line,');
        const logic = readFileSync(new URL('../../src/chat/room-composer.ts', import.meta.url), 'utf8');
        for (const gone of ['roomTargetsLine', 'everyone in the room reads it', 'the current step', 'targetsLine']) {
            expect(screen, gone).not.toContain(gone);
            expect(logic, gone).not.toContain(gone);
        }
    });

    it('shows the length near the limit and refuses past it, before sending', () => {
        expect(lengthNotice('x'.repeat(STEERING_MAX_CHARS - 500))).toBeNull();
        expect(lengthNotice('x'.repeat(7600))).toBe('7,600 of 8,000 characters');
        expect(lengthNotice('x'.repeat(8001))).toBe('8,001 of 8,000 characters. Shorten it to send.');
        expect(tooLong('x'.repeat(STEERING_MAX_CHARS))).toBe(false);
        expect(tooLong('x'.repeat(STEERING_MAX_CHARS + 1))).toBe(true);
    });
});

describe('the @ picker', () => {
    it('lists the active people but the writer, then the answering socios, as buttons with labels', () => {
        const open = picker('hello @');
        expect(open.query).toEqual({ start: 6, query: '' });
        expect(open.rows.map((row) => row.accessibilityLabel)).toEqual([
            'Mention Ben',
            'Mention Manny, socio',
            'Mention Sebas, socio, lead',
        ]);
        expect(open.rows.map((row) => row.badge)).toEqual([null, 'socio', 'socio · lead']);
        expect(open.rows[0]!.mark?.initials).toBe('B');
        expect(open.rows[2]!.character).toBe('sebas');
        expect(open.said).toBe('1 person and 2 socios to mention');
    });

    it('narrows by any word of a name, and stays shut where no mention starts', () => {
        expect(picker('@se').rows.map((row) => row.label)).toEqual(['Sebas']);
        expect(picker('ada@be').rows).toEqual([]);
        expect(picker('@zz').said).toBe('');
        expect(picker('no at sign').query).toBeNull();
        // Read at the caret, not the text's end.
        expect(picker('@be and more', 3).rows.map((row) => row.label)).toEqual(['Ben']);
    });

    it('closes for the @ a pick or dismissal was for, and opens for the next', () => {
        expect(picker('@Ben ', 5, 0).rows).toEqual([]);
        expect(picker('@Ben @', 6, 0).rows).toHaveLength(3);
    });

    it('numbers same-named people in words', () => {
        const twins = { ...view, members: [member(ADA, 'Ada'), member(BEN, 'Bo'), member(CY, 'Bo')] };
        const rows = mentionPicker({ text: '@bo', caret: 3, dismissed: null, view: twins, me: ADA, dots }).rows;
        expect(rows.map((row) => row.label)).toEqual(['Bo · 1', 'Bo · 2']);
        expect(rows.map((row) => row.accessibilityLabel)).toEqual(['Mention Bo · 1', 'Mention Bo · 2']);
    });

    it('counts in words', () => {
        expect(mentionsSaid([{ kind: 'person' }, { kind: 'person' }])).toBe('2 people to mention');
        expect(mentionsSaid([{ kind: 'socio' }])).toBe('1 socio to mention');
        expect(mentionsSaid([])).toBe('');
    });

    it('puts @Name in place of the query; a person is recorded by id, a socio routes by its text', () => {
        const open = picker('hi @be');
        const ben = pickMention({ text: 'hi @be', caret: 6, query: open.query!, picked: [] }, open.rows[0]!.candidate);
        expect(ben).toEqual({ text: 'hi @Ben ', caret: 8, picked: [{ userId: BEN, label: 'Ben' }], dismissed: 3 });
        const socio = picker(`${ben.text}@ma`);
        const manny = pickMention(
            { text: `${ben.text}@ma`, caret: 11, query: socio.query!, picked: ben.picked },
            socio.rows[0]!.candidate,
        );
        expect(manny.text).toBe('hi @Ben @Manny ');
        expect(manny.picked).toEqual([{ userId: BEN, label: 'Ben' }]);
    });
});

describe('sending to the room', () => {
    const send = async (
        text: string,
        picked: { userId: string; label: string }[],
        room: Pick<RoomView, 'members' | 'socios'> | null = view,
    ) => {
        let built: NewOutboxWrite | null = null;
        const ids = ['m-1', 'key-1'];
        const row = await sendRoomMessage({
            drafts: {
                enqueueFromDraft: async (scope, build) => {
                    expect(scope).toBe('chat:room-1');
                    built = build(text) as NewOutboxWrite;
                    return { ...built, state: 'queued' } as unknown as OutboxRow;
                },
            },
            history: { list: () => [] },
            steering: { list: () => [], state: { running: true } },
            roomId: 'room-1',
            picked,
            view: room,
            me: ADA,
            newId: () => ids.shift() as string,
            serverAt: 42,
        });
        expect(row?.id).toBe('m-1');
        return built as unknown as NewOutboxWrite;
    };

    it('queues a room-message on the room’s lane with the picks still in the text', async () => {
        const write = await send('@Ben and @Manny look', [
            { userId: BEN, label: 'Ben' },
            { userId: CY, label: 'Cy' },
        ]);
        expect(write).toMatchObject({
            id: 'm-1',
            idempotencyKey: 'key-1',
            lane: 'chat:room-1',
            kind: ROOM_MESSAGE_KIND,
        });
        expect(JSON.parse(write.payload)).toEqual({
            threadId: 'room-1',
            text: '@Ben and @Manny look',
            mentions: [{ userId: BEN, label: 'Ben' }],
            watermark: { after: null, queued: [], running: true, serverAt: 42 },
        });
    });

    it('carries no mentions when the text dropped them', async () => {
        const write = await send('never mind', [{ userId: BEN, label: 'Ben' }]);
        expect(JSON.parse(write.payload)).not.toHaveProperty('mentions');
    });

    it('still mentions a picked person after the screen remounted and the picks were lost', async () => {
        // Ada picked Ben, backed out of the room and came back: the draft
        // survived in user.db, the picks (in memory) did not.
        const write = await send('@Ben please look', []);
        expect(JSON.parse(write.payload).mentions).toEqual([{ userId: BEN, label: 'Ben' }]);
    });

    it('sends a quote-reply as one text, the quote’s @names mentioning and routing nobody (CB-571)', async () => {
        const quote = quoteOf('Ben', 'Ask @Manny and @Ben about it');
        const write = await send(withQuote(quote, 'Will do'), []);
        const payload = JSON.parse(write.payload);
        expect(payload.text).toBe(`> **Ben:** Ask @\u2060Manny and @\u2060Ben about it\n\nWill do`);
        expect(payload).not.toHaveProperty('mentions');
        // Only the words typed after the quote name people.
        const typed = await send(withQuote(quote, '@Ben will do'), []);
        expect(JSON.parse(typed.payload).mentions).toEqual([{ userId: BEN, label: 'Ben' }]);
    });

    it('keeps only the picks without the room view', async () => {
        const write = await send('@Ben please look', [], null);
        expect(JSON.parse(write.payload)).not.toHaveProperty('mentions');
    });
});

describe('sentMentions', () => {
    const ana = (userId: string) => member(userId, 'Ana Lima');
    const twins = { ...view, members: [...view.members, ana('u-ana-1'), ana('u-ana-2')] };

    it('puts the picks first, then whom the text names, each once', () => {
        const picked = [{ userId: 'u-ana-1', label: 'Ana Lima' }];
        expect(sentMentions({ text: '@Ben and @Ana Lima', picked, view: twins, me: ADA })).toEqual([
            { userId: 'u-ana-1', label: 'Ana Lima' },
            { userId: BEN, label: 'Ben' },
        ]);
    });

    it('never adds a shared name, a socio, an invited person or the writer', () => {
        expect(sentMentions({ text: '@Ana Lima @Manny @Cy @Ada', picked: [], view: twins, me: ADA })).toEqual([]);
        const ben = { dotId: 'd-ben', name: 'Ben', status: 'active' as const, lead: false };
        expect(
            sentMentions({ text: '@Ben', picked: [], view: { ...view, socios: [...view.socios, ben] }, me: ADA }),
        ).toEqual([]);
    });
});

describe('Stop in a room', () => {
    const last = asAda.at(-1)!.messages;
    const before = asAda.slice(0, -1).flatMap((run) => run.messages);

    it('is the initiator’s or an admin’s', () => {
        // Ben's message started the last run.
        expect(mayStopRoom({ admin: false, me: BEN, running: last, before, mine: false })).toBe(true);
        expect(mayStopRoom({ admin: false, me: ADA, running: last, before, mine: false })).toBe(false);
        expect(mayStopRoom({ admin: true, me: ADA, running: last, before, mine: false })).toBe(true);
    });

    it('looks back past a run no person started (a handoff), and says no when nobody is known', () => {
        const replies = last.filter((message) => message.role !== 'user');
        expect(
            mayStopRoom({ admin: false, me: BEN, running: replies, before: [...before, ...last], mine: false }),
        ).toBe(true);
        expect(mayStopRoom({ admin: false, me: BEN, running: [], before: [], mine: false })).toBe(false);
    });

    it('between a send and RUN_STARTED is the reader’s only while their own message waits, never the last writer’s', () => {
        // Ben wrote last; Ada has just sent, and the run isn't known yet.
        const stored = [...before, ...last];
        expect(mayStopRoom({ admin: false, me: BEN, running: null, before: stored, mine: false })).toBe(false);
        expect(mayStopRoom({ admin: false, me: ADA, running: null, before: stored, mine: true })).toBe(true);
        expect(mayStopRoom({ admin: true, me: BEN, running: null, before: stored, mine: false })).toBe(true);
    });

    it('counts the reader’s message as waiting while it goes or is queued, not once refused', () => {
        expect(ownWaiting([])).toBe(false);
        expect(ownWaiting([{ problem: true }])).toBe(false);
        expect(ownWaiting([{ problem: true }, { problem: false }])).toBe(true);
    });
});

describe('the notification ask after a room message', () => {
    it('asks once a message sent from the room’s composer has its turn running', () => {
        const screen = readFileSync(new URL('../../src/screens/room-composer.tsx', import.meta.url), 'utf8');
        // The send's `.then` marks the ask; it waits for the turn to run (one joined, or RUN_STARTED).
        expect(screen).toMatch(/if \(row !== null\) \{[^}]*setAskOnTurn\(true\);/);
        expect(screen).toMatch(
            /if \(askOnTurn && props\.running\) \{\s*setAskOnTurn\(false\);\s*void askForNotifications\('room-turn'\);/,
        );
        expect(screen).toContain('}, [askOnTurn, props.running]);');
    });
});
