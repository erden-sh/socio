import {
    ROOM_FAILURE_NOTES,
    ROOM_PROBLEM_FALLBACK,
    TURN_FAILURE_MESSAGES,
    TURN_PROBLEM_FALLBACK,
    isTurnFailure,
    timeLimitMessage,
    timeLimitOf,
    turnFailureKind,
} from '../turn-failures.js';
import type { Conversation, Dot, MessageAuthor, State, TranscriptTurnProblem } from '../types.js';

import type { RoomMessage, RoomPhase } from './live-turn.js';
import { mentionToken, parseRoomMentions } from './room-mentions.js';
import { foldedName, tokenCounts, type MentionablePerson, type PersonMention } from './room-people-mentions.js';
import type { RoomMemberView, RoomSocioView, RoomView } from './rooms.js';

/**
 * A room's view rules (CB-212), shared by the web and the app: who
 * may write, which socio answers or wrote a reply, the header's line, an
 * unanswered turn in words, who a message goes to, the mention picker's
 * candidates and which chats a list shows. Pure; each client draws them.
 */

/** Settings → General → Rooms in force (`GET /api/state` always says). */
export const roomsOn = (state: Pick<State, 'settings'>) => state.settings.rooms?.enabled === true;

/** A shared room, not a person's chat or a Telegram topic. */
export const isRoom = (thread: Pick<Conversation, 'kind'>) => thread.kind === 'room';

/** The reader is one of the room's admins (`Conversation.roomRole`). */
export const roomAdmin = (thread: Pick<Conversation, 'kind' | 'roomRole'>) =>
    isRoom(thread) && thread.roomRole === 'admin';

/**
 * The chats a list shows: every one, rooms only while Rooms are on
 * (Settings → General → Rooms). With Rooms off nothing room-shaped is in
 * the app's lists; a room's link still opens it, read-only.
 */
export const shownChats = <T extends Pick<Conversation, 'kind'>>(
    conversations: readonly T[],
    state: Pick<State, 'settings'>,
) => conversations.filter((thread) => !isRoom(thread) || roomsOn(state));

/** Why nobody can write in the room now, or undefined when they can. */
export function readOnlyReason(
    thread: Pick<Conversation, 'archivedAt'>,
    room: Pick<RoomView, 'roomsEnabled' | 'socios'> | undefined,
    roomsEnabled: boolean,
): string | undefined {
    if (!roomsEnabled || room?.roomsEnabled === false) {
        return 'Rooms are turned off in Settings, so this room is read-only. You can still read it and leave.';
    }
    if (thread.archivedAt) {
        return 'This room is archived: it is kept as it was, and nothing new runs in it.';
    }
    if (room && !room.socios.some((socio) => socio.lead && socio.status === 'active')) {
        return 'No socio answers in this room now. A room admin can pick another lead in Members.';
    }
    return undefined;
}

/**
 * The socio a reply is from, when the room can only have had one answer
 * now: its lead while it is the room's one active socio. With several,
 * a reply shows the socio the server says wrote it (CB-206); one it
 * doesn't know (stored before) gets no name that may be another's.
 */
export function soleSocio<D extends Pick<Dot, 'id'>>(room: Pick<RoomView, 'socios'> | undefined, lead: D) {
    if (!room) {
        return lead;
    }
    const active = room.socios.filter((socio) => socio.status === 'active');
    return active.length <= 1 ? lead : undefined;
}

/**
 * The socio that wrote a reply: the one the reply names (CB-212), by the
 * reader's socios or, failing that, the room's name for it; a reply stored
 * before replies named theirs is the lead's while it alone answers
 * (`soleSocio`).
 */
export function replySocio<D extends Pick<Dot, 'id'>>(
    message: Pick<RoomMessage, 'socioId'>,
    room: Pick<RoomView, 'socios'> | undefined,
    lead: D,
    dots: readonly D[],
): { dot?: D; name?: string } {
    if (!message.socioId) {
        return { dot: soleSocio(room, lead) };
    }
    const dot = message.socioId === lead.id ? lead : dots.find((known) => known.id === message.socioId);
    if (dot) {
        return { dot };
    }
    const name = room?.socios.find((socio) => socio.dotId === message.socioId)?.name;
    return name ? { name } : {};
}

/** What the room says while a turn runs: what its socio does now. */
export function runningNote(name: string, phase: RoomPhase | undefined) {
    return phase === 'thinking'
        ? `${name} is thinking…`
        : phase === 'writing'
          ? `${name} is writing…`
          : `${name} is answering…`;
}

/** "3 people · Sebas, Manny answering · you're an admin": the header status. */
export function roomStatus(
    room: Pick<RoomView, 'members' | 'role'> | undefined,
    socios: readonly Pick<RoomSocioView, 'name'>[],
    paused?: boolean,
) {
    if (!room) {
        return 'Room';
    }
    const people = room.members.filter((member) => member.status === 'active');
    const count = `${people.length} ${people.length === 1 ? 'person' : 'people'}`;
    const names = socios.length
        ? `${socios.map((socio) => socio.name).join(', ')} ${socios.length === 1 ? 'answers' : 'answer'}`
        : undefined;
    const admin = room.role === 'admin' ? ' · you’re an admin' : '';
    const pause = paused ? ' · all socios paused' : '';
    return `Room · ${count}${names ? ` · ${names}` : ''}${admin}${pause}`;
}

/**
 * A socio name short enough for the composer's one-line placeholder: cut
 * when the lead socio's name is long, so "Message the room and <name>…"
 * doesn't wrap on a phone (Rooms follow-ups). The placeholder's own
 * trailing "…" follows this, so a truncated name needs no ellipsis here.
 */
export function fitName(name: string, max = 24) {
    return name.length > max ? name.slice(0, max).trimEnd() : name;
}

/**
 * A room turn that went unanswered, as a client knows it: from a run's
 * status in `/history`, with the RUN_ERROR's `code` and
 * `message` only when the live stream saw them. A run paged in from
 * `/history` never has a code.
 */
export interface RoomTurnProblem {
    runId: string;
    status: 'failed' | 'interrupted';
    /** The last message shown before it; none when it comes first. */
    after?: string;
    /** Who sent the turn's message, when it was a person's. */
    author?: MessageAuthor;
    /** The RUN_ERROR's `code` (a `TurnFailure`), from the stream only. */
    code?: string;
    /** The RUN_ERROR's `message`, from the stream only: never shown as it is. */
    message?: string;
}

/**
 * A turn's problem in words: whose message went unanswered, and why,
 * worded from its `code` with the shared table, never from text a server
 * sent. Its sender reads what Socio says to them; everyone else the room's
 * wording, about the sender (CB-205). With no code (or one this table
 * doesn't know), the plain line.
 */
export function problemText(problem: RoomTurnProblem) {
    const kind = isTurnFailure(problem.code) ? problem.code : undefined;
    if (problem.author?.you) {
        // A time limit names its length only when `message` is exactly the
        // fixed text for one (`timeLimitOf`), so nothing else is quoted.
        const limit = kind === 'time_limit' ? timeLimitOf(problem.message) : undefined;
        const said = !kind
            ? TURN_PROBLEM_FALLBACK
            : limit === undefined
              ? TURN_FAILURE_MESSAGES[kind]
              : timeLimitMessage(limit);
        return `Your message wasn’t answered. Socio said: “${said}”`;
    }
    const whose = problem.author ? `${problem.author.name}’s message` : 'A message';
    const why = kind ? ROOM_FAILURE_NOTES[kind](problem.author?.name || 'Its sender') : ROOM_PROBLEM_FALLBACK;
    return `${whose} wasn’t answered: ${why}`;
}

/**
 * A `/transcript` problem as a `RoomTurnProblem`: its code read back from
 * its fixed text (the server sends one of `TURN_FAILURE_MESSAGES` or the
 * plain line), so the web words it with the same table as the app.
 */
export function transcriptProblem(problem: TranscriptTurnProblem): RoomTurnProblem {
    const code = turnFailureKind(problem.message);
    return {
        runId: problem.runId,
        status: 'failed',
        ...(problem.after ? { after: problem.after } : {}),
        ...(problem.author ? { author: problem.author } : {}),
        ...(code ? { code } : {}),
        message: problem.message,
    };
}

/** The socios that answer in the room now, the lead first. */
export const answeringSocios = <S extends Pick<RoomSocioView, 'status' | 'lead'>>(socios: readonly S[] = []) =>
    socios.filter((socio) => socio.status === 'active').sort((a, b) => Number(b.lead) - Number(a.lead));

/**
 * Who a message goes to, as the server routes it (CB-206): the active
 * socios it names (`@Name`), in order, else the lead. People it names
 * are not socios and route nothing (CB-216 notifies them).
 */
export function messageTargets<S extends RoomSocioView>(text: string, socios: readonly S[]): S[] {
    const active = answeringSocios(socios);
    const named = parseRoomMentions(text, {
        socios: active.map((socio) => ({ id: socio.dotId, name: socio.name })),
    }).socios;
    if (named.length) {
        return named.flatMap((id) => active.filter((socio) => socio.dotId === id));
    }
    return active.filter((socio) => socio.lead);
}

/** "Mo", "Mo, then Ada", "Mo, then Ada and Sebas". */
export function targetsLine(targets: readonly Pick<RoomSocioView, 'name'>[]) {
    const names = targets.map((socio) => socio.name);
    if (names.length <= 1) {
        return names[0] ?? '';
    }
    const [first, ...rest] = names;
    return `${first}, then ${rest.length === 1 ? rest[0] : `${rest.slice(0, -1).join(', ')} and ${rest.at(-1)}`}`;
}

/**
 * The text with a mention of `name` added where the caret is (at the
 * end when there is none), spaced from what is around it; and where the
 * caret goes after it.
 */
export function withMention(text: string, name: string, caret: number = text.length): { text: string; caret: number } {
    const at = Math.max(0, Math.min(caret, text.length));
    const before = text.slice(0, at);
    const after = text.slice(at);
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const token = `${lead}${mentionToken(name)} `;
    const rest = after.replace(/^\s+/, '');
    return {
        text: `${before}${token}${rest}`,
        caret: before.length + token.length,
    };
}

/**
 * A candidate the `@` picker may offer (CB-284): a room member, or an
 * active socio named alongside them. Both insert `@Name`; a person's pick
 * is recorded by id for notification, a socio's routes by the text the
 * server parses (`parseRoomMentions`), so it carries no people-mention.
 */
export type MentionCandidate = MentionablePerson & {
    /** 'person' or 'socio', for the label the list shows beside the name. */
    kind: 'person' | 'socio';
    /** A socio's dot id (CB-206); undefined for a person. */
    dotId?: string;
    /** Whether this socio is the room's lead. */
    lead?: boolean;
};

/**
 * The room's active socios as mention candidates (CB-284): each can be
 * `@`-mentioned to route the message to it, the lead first as the picker
 * shows it.
 */
export function mentionableSocios(socios: readonly RoomSocioView[]): MentionCandidate[] {
    return answeringSocios(socios).map((socio) => ({
        userId: socio.dotId,
        name: socio.name,
        kind: 'socio' as const,
        dotId: socio.dotId,
        lead: socio.lead,
    }));
}

/** People and socios together, people first then socios, each once by id. */
export function combineMentionables(
    people: readonly MentionablePerson[],
    socios: readonly MentionCandidate[],
): MentionCandidate[] {
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    for (const person of people) {
        if (seen.has(person.userId)) {
            continue;
        }
        seen.add(person.userId);
        out.push({ ...person, kind: 'person' });
    }
    for (const socio of socios) {
        if (seen.has(socio.userId)) {
            continue;
        }
        seen.add(socio.userId);
        out.push(socio);
    }
    return out;
}

/** The room's people the picker offers: its active members, never the writer. */
export const mentionablePeople = (
    members: readonly Pick<RoomMemberView, 'userId' | 'name' | 'status'>[],
    selfId: string | undefined,
): MentionablePerson[] =>
    members
        .filter((member) => member.status === 'active' && member.userId !== selfId)
        .map(({ userId, name }) => ({ userId, name }));

/**
 * The picks a message still carries: those whose `@Name` is still in the
 * text, each person once. The server checks them again.
 */
export function keptMentions(text: string, picked: readonly PersonMention[]) {
    const counts = tokenCounts(
        text,
        picked.map((mention) => mention.label),
    );
    const seen = new Set<string>();
    return picked.filter((mention) => {
        if (seen.has(mention.userId)) {
            return false;
        }
        seen.add(mention.userId);
        return (counts.get(foldedName(mention.label)) ?? 0) > 0;
    });
}

/** "Ana", "Ana and Bo", "Ana, Bo and 2 others". */
export function presenceLine(names: readonly string[]) {
    if (names.length <= 2) {
        return names.join(' and ');
    }
    const rest = names.length - 2;
    return `${names.slice(0, 2).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}
