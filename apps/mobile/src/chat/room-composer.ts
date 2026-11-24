import type { Message } from '@ag-ui/core';

import { STEERING_MAX_CHARS } from '@socio/shared/chat/steering';
import { characterFor, characterOf, type LocalId } from '@socio/shared/mascot';
import { parseRoomMentions } from '@socio/shared/rooms/room-mentions';
import {
    insertMention,
    matchingPeople,
    mentionQuery,
    PERSON_MENTIONS_MAX,
    type PersonMention,
} from '@socio/shared/rooms/room-people-mentions';
import {
    answeringSocios,
    combineMentionables,
    fitName,
    keptMentions,
    type MentionCandidate,
    mentionablePeople,
    mentionableSocios,
} from '@socio/shared/rooms/room-view';
import type { RoomSocioView, RoomView } from '@socio/shared/rooms/rooms';
import type { Dot } from '@socio/shared/types';

import { type Attachments, enqueueWithAttachments } from '../sync/attachments';
import { chatDraft, type Drafts } from '../sync/chat-drafts';
import type { ChatHistory } from '../sync/history';
import type { OutboxRow } from '../sync/outbox';
import { roomMessageWrite } from '../sync/room-send';
import type { ChatSteering } from '../sync/steering';

import type { PendingBubble } from './composer';
import { type PersonMark, roomPeople } from './room-people';
import { authorOf } from './room-transcript';

// The room's composer, the web's RoomChat composer and
// PeopleMentions picker on a phone, over shared's rules (room-view.ts,
// room-people-mentions.ts):
// - The box says whom it talks to ("Message the room and Sebas…", `fitName`).
//   No line under it says who answers (CB-491, the owner: it read as noise);
//   the server routes by the text's `@Name`s.
// - Typing `@` lists the room's people (never the writer) and its answering
//   socios above the box. A person's pick goes in `mentions` by id (the server
//   checks it again); a socio's routes by its `@Name` in the text (`withMention`'s
//   token), so it carries none. The count is said once per change. Picks live
//   in memory, but the draft outlives the screen (user.db), so at send the
//   people the text names without doubt join them (`sentMentions`).
// - Over STEERING_MAX_CHARS the box says so and won't send (the `room-message`
//   kind would refuse it as `too-large`).
// - Stop is the running cycle's initiator's or an admin's, as the server's.
// No React Native here: tests/chat runs it under Node.

/** The box's accessibility label. */
export const ROOM_INPUT_LABEL = 'Message the room';
/** The picker's accessibility label. */
export const MENTION_LIST_LABEL = 'People and socios in the room';
/** How many characters before the limit the count shows. */
export const LENGTH_SHOWN_WITHIN = 500;
/** Stop pressed offline: it is never queued. */
export const STOP_NEEDS_CONNECTION = 'Needs a connection to stop the answer.';

/** "Message the room and Sebas…", or with several socios answering, the `@` hint. */
export function roomPlaceholder(socios: readonly Pick<RoomSocioView, 'status' | 'lead'>[], lead: string): string {
    return answeringSocios(socios).length > 1
        ? 'Message the room, or @ a socio…'
        : `Message the room and ${fitName(lead)}…`;
}

const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Whether the box holds more than a room message may. */
export const tooLong = (text: string) => text.length > STEERING_MAX_CHARS;

/** The length, said once it nears the limit, and why Send is off past it; null well under it. */
export function lengthNotice(text: string): string | null {
    const count = text.length;
    if (count <= STEERING_MAX_CHARS - LENGTH_SHOWN_WITHIN) {
        return null;
    }
    const said = `${grouped(count)} of ${grouped(STEERING_MAX_CHARS)} characters`;
    return count > STEERING_MAX_CHARS ? `${said}. Shorten it to send.` : said;
}

/** A row of the `@` picker. */
export interface MentionRow {
    readonly key: string;
    readonly candidate: MentionCandidate;
    /** The name shown: "Ana Lima · 2" for same-named people (`personLabels`). */
    readonly label: string;
    /** "socio · lead", "socio", or null for a person. */
    readonly badge: string | null;
    /** A person's avatar, or null for a socio. */
    readonly mark: PersonMark | null;
    /** A socio's character, or null for a person. */
    readonly character: LocalId | null;
    /** "Mention Ana Lima", "Mention Sebas, socio, lead". */
    readonly accessibilityLabel: string;
}

/** The picker as the box stands: open while an `@query` fits someone and wasn't dismissed. */
export interface MentionPicker {
    readonly query: { readonly start: number; readonly query: string } | null;
    readonly rows: readonly MentionRow[];
    /** "2 people and 1 socio to mention", or empty while closed: said once per change. */
    readonly said: string;
}

export interface MentionPickerInput {
    readonly text: string;
    /** The caret, or null before the box reported one. */
    readonly caret: number | null;
    /** The `@`'s position a pick or Escape closed the list for, or null. */
    readonly dismissed: number | null;
    readonly view: Pick<RoomView, 'members' | 'socios'> | null;
    readonly me: string;
    readonly dots: readonly Dot[];
}

/** The candidates the room offers: its active people but the writer, then its answering socios. */
export function roomMentionables(view: Pick<RoomView, 'members' | 'socios'> | null, me: string): MentionCandidate[] {
    return combineMentionables(mentionablePeople(view?.members ?? [], me), mentionableSocios(view?.socios ?? []));
}

export function mentionPicker(input: MentionPickerInput): MentionPicker {
    const { text, caret, view } = input;
    const query = caret === null ? undefined : mentionQuery(text, Math.min(caret, text.length));
    if (query === undefined || query.start === input.dismissed) {
        return { query: query ?? null, rows: [], said: '' };
    }
    const candidates = matchingPeople(roomMentionables(view, input.me), query.query);
    const people = roomPeople(view);
    const rows = candidates.map((candidate): MentionRow => {
        const socio = candidate.kind === 'socio';
        const label = socio ? candidate.name : people.name(candidate.userId, candidate.name);
        const badge = socio ? (candidate.lead ? 'socio · lead' : 'socio') : null;
        const dot = socio ? input.dots.find((known) => known.id === candidate.dotId) : undefined;
        return {
            key: `${candidate.kind}:${candidate.userId}`,
            candidate,
            label,
            badge,
            mark: socio ? null : people.mark(candidate.userId, candidate.name),
            character: socio ? (dot === undefined ? characterFor(candidate.dotId!) : characterOf(dot)) : null,
            accessibilityLabel: `Mention ${label}${socio ? `, socio${candidate.lead ? ', lead' : ''}` : ''}`,
        };
    });
    return { query, rows, said: mentionsSaid(candidates) };
}

/** "1 person to mention", "2 people and 1 socio to mention"; empty for none. */
export function mentionsSaid(candidates: readonly Pick<MentionCandidate, 'kind'>[]): string {
    const people = candidates.filter((candidate) => candidate.kind === 'person').length;
    const socios = candidates.length - people;
    const parts = [
        ...(people ? [`${people} ${people === 1 ? 'person' : 'people'}`] : []),
        ...(socios ? [`${socios} ${socios === 1 ? 'socio' : 'socios'}`] : []),
    ];
    return parts.length ? `${parts.join(' and ')} to mention` : '';
}

/** What a pick does: `@Name ` in place of the query, the caret after it, a person recorded by id. */
export function pickMention(
    input: { text: string; caret: number; query: { start: number }; picked: readonly PersonMention[] },
    candidate: MentionCandidate,
): { text: string; caret: number; picked: PersonMention[]; dismissed: number } {
    const next = insertMention(input.text, input.query.start, input.caret, candidate.name);
    const picked =
        candidate.kind === 'person'
            ? [
                  ...input.picked.filter((mention) => mention.userId !== candidate.userId),
                  { userId: candidate.userId, label: candidate.name },
              ]
            : [...input.picked];
    return { ...next, picked, dismissed: input.query.start };
}

/** Who started a room's running turn, as far as the phone knows: for {@link mayStopRoom}. */
export interface RoomStarter {
    /** The running run's messages, stored then live; null while no run is known (sent, before RUN_STARTED). */
    readonly running: readonly Message[] | null;
    /** Every stored message before the running run. */
    readonly before: readonly Message[];
    /** The reader has a message of their own on its way or queued (`ownWaiting`). */
    readonly mine: boolean;
}

/** Whether the reader has a message on its way or queued, not refused: the turn about to start may be theirs. */
export const ownWaiting = (bubbles: readonly Pick<PendingBubble, 'problem'>[]): boolean =>
    bubbles.some((bubble) => !bubble.problem);

/**
 * Whether the reader may stop the running turn: a room admin, or the person
 * whose message started it (the server's `mayStop`, which answers 403
 * `not_initiator` otherwise). With a run known but none of a person's
 * messages in it (a handoff's run), the newest one before started it. With
 * no run known yet (sent, before RUN_STARTED) it is the reader's only while
 * a message of theirs is on its way or queued (`mine`): never the previous
 * writer's.
 */
export function mayStopRoom(input: { admin: boolean; me: string } & RoomStarter): boolean {
    if (input.admin) {
        return true;
    }
    if (input.running === null) {
        return input.mine;
    }
    const person = (message: Message) => message.role === 'user' && authorOf(message, input.me) !== undefined;
    const starter = input.running.find(person) ?? input.before.findLast(person);
    return starter !== undefined && authorOf(starter, input.me)?.you === true;
}

/**
 * The people a room message mentions: the picks whose `@Name` is still in the
 * text (`keptMentions`), then anyone else of the room's people the picker
 * offers whose `@Name` the text holds unambiguously (shared's
 * `parseRoomMentions`: a name two people share, or a socio has, is nobody's).
 * The picks live in memory while the draft is stored, so a draft left and
 * reopened (the screen popped, the app killed, a pending message edited back)
 * still notifies the people it reads as naming. The server checks ids again.
 */
export function sentMentions(input: {
    text: string;
    picked: readonly PersonMention[];
    view: Pick<RoomView, 'members' | 'socios'> | null;
    me: string;
}): PersonMention[] {
    const kept = keptMentions(input.text, input.picked);
    if (input.view === null) {
        return kept;
    }
    const people = mentionablePeople(input.view.members, input.me);
    const found = parseRoomMentions(input.text, {
        socios: input.view.socios.map((socio) => ({ id: socio.dotId, name: socio.name })),
        people: people.map((person) => ({ id: person.userId, name: person.name })),
    }).people;
    const taken = new Set(kept.map((mention) => mention.userId));
    const named = found
        .filter((userId) => !taken.has(userId))
        .map((userId) => ({ userId, label: people.find((person) => person.userId === userId)!.name }));
    return [...kept, ...named].slice(0, PERSON_MENTIONS_MAX);
}

export interface RoomSendInput {
    readonly drafts: Pick<Drafts, 'enqueueFromDraft'>;
    readonly history: Pick<ChatHistory, 'list'>;
    readonly steering: Pick<ChatSteering, 'list'> & { readonly state: Pick<ChatSteering['state'], 'running'> };
    readonly roomId: string;
    /** The picker's picks this draft: only those still in the text go (`sentMentions`). */
    readonly picked: readonly PersonMention[];
    /** The room's people and socios, so a draft whose picks were lost still mentions whom it names. */
    readonly view: Pick<RoomView, 'members' | 'socios'> | null;
    /** The writer, never mentioned. */
    readonly me: string;
    readonly newId: () => string;
    /** The scope's `serverClock.lastDate()`. */
    readonly serverAt: number | null;
    /** The scope's attachments: the room's tray goes with the message, in the draft's transaction. */
    readonly attachments?: Pick<Attachments, 'forSend'>;
}

/**
 * Sends the room's box through the outbox as a `room-message`, so it
 * queues offline like a chat's: the draft cleared in the row's insert
 * transaction, the mentions read from the text sent. The row once durable, or
 * null for a blank box; rejects with the box as it was.
 */
export function sendRoomMessage(input: RoomSendInput): Promise<OutboxRow | null> {
    const write = (text: string, attachments?: Parameters<typeof roomMessageWrite>[0]['attachments']) =>
        roomMessageWrite({
            id: input.newId(),
            idempotencyKey: input.newId(),
            roomId: input.roomId,
            text,
            ...(attachments?.length ? { attachments } : {}),
            mentions: sentMentions({ text, picked: input.picked, view: input.view, me: input.me }),
            history: input.history,
            steering: input.steering,
            serverAt: input.serverAt,
        });
    const box = chatDraft(input.roomId);
    return input.attachments
        ? enqueueWithAttachments(input.drafts, input.attachments, box, write)
        : input.drafts.enqueueFromDraft(box, (text) => write(text));
}

/** The lead socio's name: the room's, else the workspace's, else "the socio". */
export function leadName(input: {
    view: Pick<RoomView, 'socios'> | null;
    leadId: string;
    dots: readonly Pick<Dot, 'id' | 'name'>[];
}): string {
    return (
        input.view?.socios.find((socio) => socio.lead)?.name ??
        input.view?.socios.find((socio) => socio.dotId === input.leadId)?.name ??
        input.dots.find((dot) => dot.id === input.leadId)?.name ??
        'the socio'
    );
}
