import type { Message } from '@ag-ui/core';

import type { HistoryMessage, HistoryRun } from '@socio/shared/chat/chat-history';
import type { OthersQueuedMessage } from '@socio/shared/chat/steering';
import { characterFor, characterOf } from '@socio/shared/mascot';
import type { LiveTurn, RoomMessage } from '@socio/shared/rooms/live-turn';
import { handoffLine, handoffOf, type TranscriptHandoff } from '@socio/shared/rooms/room-handoffs';
import { answeringSocios, problemText, replySocio, runningNote } from '@socio/shared/rooms/room-view';
import type { RoomView } from '@socio/shared/rooms/rooms';
import { type TurnFailure, turnFailureKind } from '@socio/shared/turn-failures';
import {
    type Dot,
    type MessageAuthor,
    SENDER_METADATA,
    SENDER_NAME_METADATA,
    SOCIO_METADATA,
} from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';
import { readJson } from '../net/read-body';

import { type BubbleAction, type PendingBubble, writtenAgo } from './composer';
import { roomPeople } from './room-people';
import { messageText, type Speaker, type TranscriptExtras, type TranscriptRow, transcriptRows } from './transcript';

// A room's transcript as the chat screen draws it: the private
// chat's rows (transcript.ts: the stored runs from `/history`, then
// the live turn, the cards, the traces), told apart by who wrote
// them (`/history` stamps each person's message with
// `socioSender`/`socioSenderName` and each reply with `socioDot`):
// - each person's message with their avatar, tone and name (shared's tone
//   indexes into the app's table, `personLabels` for same-named members, the
//   view's current names), the reader's own as "You" on the right;
// - each reply with its socio's mark and name (`replySocio`);
// - a handoff note as a line, with the socios' names from the view
//   (`handoffLine`), never as a message;
// - a failed or cut-off run as `problemText`'s line after its last message,
//   worded from the code `/history` carries (`failure`, CB-406), else the one
//   this device saw (`runFailures`), else from the room's `/transcript`
//   problems as the web words them (`readRoomFailures`, read once when such a
//   run has neither: a server before CB-406), else the plain line;
// - the running turn as `runningNote` ("Sebas is thinking…") in the status
//   pill, never its steps or reasoning: another person's turn is theirs.
// - another person's message that mentions the reader as the web's "@you"
//   badge in its speaker line (CB-416, `mentionsYou`), from the `mentions`
//   `/history` carries on people's room messages (left
//   out when there are none, and by older servers).
// No React Native here: tests/chat runs it under Node.

/** A line in the room's transcript that is no one's message: a handoff, or a turn that went unanswered. */
export interface RoomNoteRow {
    readonly kind: 'room-note';
    /** `handoff:<message id>` or `problem:<run id>`. */
    readonly id: string;
    readonly note: 'handoff' | 'problem';
    readonly text: string;
}

export type RoomRow = TranscriptRow | RoomNoteRow;

/** What a room's rows need besides its runs. */
export interface RoomContext {
    /** `GET /api/rooms/:id` as the phone holds it; null before the first answer. */
    readonly view: RoomView | null;
    /** The room's lead socio (its conversation's `dotId`). */
    readonly leadId: string;
    /** The workspace's socios. */
    readonly dots: readonly Dot[];
    /** The reader's app user id. */
    readonly me: string;
    /** The RUN_ERROR code this device saw for a run (`runFailures.codeOf`). */
    readonly failure: (runId: string) => string | undefined;
}

/** The room's transcript: the web's reader, whose `problems` say why each run failed. */
export const roomTranscriptPath = (roomId: string) => `/api/conversations/${encodeURIComponent(roomId)}/transcript`;

/**
 * The failed or cut-off runs whose code neither `/history` (`failure`, CB-406)
 * nor this device knows: their line needs the room's transcript.
 */
export function unwordedRuns(runs: readonly HistoryRun[], failure: (runId: string) => string | undefined): string[] {
    return runs
        .filter(
            (run) =>
                (run.status === 'failed' || run.status === 'interrupted') &&
                run.failure === undefined &&
                failure(run.runId) === undefined,
        )
        .map((run) => run.runId);
}

/**
 * Why the room's runs failed, as the web reads it (`GET …/transcript`'s
 * `problems`, each `message` one of shared's fixed texts read back to its code
 * by `turnFailureKind`, as `transcriptProblem` does): run id and code pairs,
 * only for a text the table knows. Never the server's text itself. Null when
 * there was no readable answer (offline, a refusal, a body that isn't one).
 */
export async function readRoomFailures(
    fetch: AuthedFetch,
    roomId: string,
): Promise<readonly (readonly [string, TurnFailure])[] | null> {
    try {
        const response = await fetch(roomTranscriptPath(roomId));
        if (!response.ok) {
            return null;
        }
        const body = (await readJson(response)) as { problems?: unknown } | null;
        const problems = Array.isArray(body?.problems) ? (body.problems as unknown[]) : [];
        return problems.flatMap((problem) => {
            const { runId, message } = (problem ?? {}) as { runId?: unknown; message?: unknown };
            const kind = typeof message === 'string' ? turnFailureKind(message) : undefined;
            return typeof runId === 'string' && runId !== '' && kind !== undefined ? [[runId, kind] as const] : [];
        });
    } catch {
        return null;
    }
}

const metadataOf = (message: Message): Record<string, unknown> => {
    const metadata = (message as { metadata?: unknown }).metadata;
    return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
};

/** A person's message's author: the live turn's (`applyRoomEvent`), else what the server stamped on the stored one. */
export function authorOf(message: Message, me: string): MessageAuthor | undefined {
    const live = (message as RoomMessage).author;
    if (live !== undefined) {
        return live;
    }
    const metadata = metadataOf(message);
    const id = metadata[SENDER_METADATA];
    if (typeof id !== 'string' || id === '') {
        return undefined;
    }
    const name = metadata[SENDER_NAME_METADATA];
    return { id, name: typeof name === 'string' && name !== '' ? name : 'Team member', you: id === me };
}

/** The socio a reply names: the live turn's, else the stored one's `socioDot`. */
function socioIdOf(message: Message): string | undefined {
    const live = (message as RoomMessage).socioId;
    if (live !== undefined) {
        return live;
    }
    const id = metadataOf(message)[SOCIO_METADATA];
    return typeof id === 'string' && id !== '' ? id : undefined;
}

/** A handoff note's ids: the live turn's, else the stored note's metadata. */
function handoffIn(message: Message): (Omit<TranscriptHandoff, 'byName'> & { readonly by?: string }) | undefined {
    const live = (message as RoomMessage).handoff;
    if (live !== undefined) {
        return live;
    }
    const meta = handoffOf(message);
    return meta === undefined
        ? undefined
        : {
              kind: meta.kind,
              from: { id: meta.from, name: '' },
              to: { id: meta.to, name: '' },
              reason: meta.reason,
              ...(meta.by === undefined ? {} : { by: meta.by }),
          };
}

/** A socio's name as the room knows it: the room's, else the workspace's, else "A socio". */
function socioName(id: string, given: string, context: RoomContext): string {
    return (
        (given !== '' ? given : undefined) ??
        context.view?.socios.find((socio) => socio.dotId === id)?.name ??
        context.dots.find((dot) => dot.id === id)?.name ??
        'A socio'
    );
}

/** The lead as a Dot-like for shared's rules, from the workspace's socios or the room's view. */
function leadOf(context: RoomContext): Pick<Dot, 'id' | 'name'> {
    return (
        context.dots.find((dot) => dot.id === context.leadId) ?? {
            id: context.leadId,
            name: socioName(context.leadId, '', context),
        }
    );
}

/** The rows of a room: its stored runs and live turn as a chat's, with who wrote each, handoffs and problems. */
export function roomRows(
    runs: readonly HistoryRun[],
    turn: LiveTurn,
    context: RoomContext,
    extras: TranscriptExtras = {},
): RoomRow[] {
    const messages = new Map<string, Message>();
    for (const message of [...runs.flatMap((run) => run.messages), ...turn.messages]) {
        messages.set(message.id, message);
    }
    const authors = [...messages.values()]
        .filter((message) => message.role === 'user')
        .flatMap((message) => {
            const author = authorOf(message, context.me);
            return author?.id === undefined ? [] : [{ id: author.id, name: author.name }];
        });
    const people = roomPeople(context.view, authors);
    const lead = leadOf(context);
    const memberName = (id: string | undefined) =>
        id === undefined ? undefined : context.view?.members.find((member) => member.userId === id)?.name;

    // A failed or cut-off run's line goes after its last message shown; one with none shown, first.
    const problems = new Map<string, RoomNoteRow[]>();
    const base = transcriptRows(runs, turn, { ...extras, socio: extras.socio ?? lead.name });
    const shown = new Set(base.filter((row) => row.kind === 'user' || row.kind === 'reply').map((row) => row.id));
    for (const run of runs) {
        if (run.status !== 'failed' && run.status !== 'interrupted') {
            continue;
        }
        const first = run.messages.find((message) => message.role === 'user' && handoffIn(message) === undefined);
        const author = first === undefined ? undefined : authorOf(first, context.me);
        const after = run.messages.findLast((message) => shown.has(message.id))?.id ?? '';
        // The code `/history` carries (CB-406), else the one this device saw.
        const code = run.failure ?? context.failure(run.runId);
        const text = problemText({
            runId: run.runId,
            status: run.status,
            ...(author === undefined ? {} : { author: { ...author, name: people.name(author.id, author.name) } }),
            ...(code === undefined ? {} : { code }),
        });
        const row: RoomNoteRow = { kind: 'room-note', id: `problem:${run.runId}`, note: 'problem', text };
        problems.set(after, [...(problems.get(after) ?? []), row]);
    }

    const rows: RoomRow[] = [...(problems.get('') ?? [])];
    for (const row of base) {
        // The running turn shows as the room's note in the pill (`roomPill`), never as steps.
        if (row.kind === 'trace' && row.turn === null) {
            continue;
        }
        const message = row.kind === 'user' || row.kind === 'reply' ? messages.get(row.id) : undefined;
        if (row.kind === 'user' && message !== undefined) {
            const handoff = handoffIn(message);
            if (handoff !== undefined) {
                rows.push({
                    kind: 'room-note',
                    id: `handoff:${row.id}`,
                    note: 'handoff',
                    text: handoffLine({
                        kind: handoff.kind,
                        from: { id: handoff.from.id, name: socioName(handoff.from.id, handoff.from.name, context) },
                        to: { id: handoff.to.id, name: socioName(handoff.to.id, handoff.to.name, context) },
                        reason: handoff.reason,
                        ...(handoff.by === undefined || memberName(handoff.by) === undefined
                            ? {}
                            : { byName: people.name(handoff.by, memberName(handoff.by)!) }),
                    }),
                });
            } else {
                rows.push({
                    ...row,
                    speaker: personSpeaker(authorOf(message, context.me), people, mentionsYou(message)),
                });
            }
        } else if (row.kind === 'reply' && message !== undefined) {
            const socioId = socioIdOf(message);
            rows.push({
                ...row,
                speaker: socioSpeaker(socioId, context, lead),
                ...(socioId === undefined ? {} : { socioId }),
            });
        } else {
            rows.push(row);
        }
        if (message !== undefined) {
            rows.push(...(problems.get(row.id) ?? []));
        }
    }
    return rows;
}

/** What a screen reader hears for the "@you" badge (the web's sr-only words). */
export const MENTIONS_YOU = 'mentions you';

/** Whether a stored message's checked mentions (CB-216, `/history`'s `mentions`) name the reader. */
export const mentionsYou = (message: Message) =>
    (message as HistoryMessage).mentions?.some((mention) => mention.you === true) === true;

function personSpeaker(
    author: MessageAuthor | undefined,
    people: ReturnType<typeof roomPeople>,
    mentioned: boolean,
): Speaker {
    if (author?.you === true) {
        return { kind: 'you', name: 'You' };
    }
    // A message stored before senders were recorded is a team member's, as on the web.
    const name = people.name(author?.id, author?.name ?? 'Team member');
    return { kind: 'person', name, ...people.mark(author?.id, name), ...(mentioned ? { mentionsYou: true } : {}) };
}

function socioSpeaker(socioId: string | undefined, context: RoomContext, lead: Pick<Dot, 'id' | 'name'>): Speaker {
    const found = replySocio<Pick<Dot, 'id' | 'name'>>(
        socioId === undefined ? {} : { socioId },
        context.view ?? undefined,
        lead,
        context.dots,
    );
    const id = found.dot?.id ?? socioId;
    const dot = id === undefined ? undefined : context.dots.find((known) => known.id === id);
    return {
        kind: 'socio',
        name: found.dot?.name ?? found.name ?? 'A socio',
        character: dot !== undefined ? characterOf(dot) : characterFor(id ?? context.leadId),
    };
}

/**
 * What the status pill says while a turn runs in the room: the socio that
 * writes now (its streaming reply's), else the lead when it alone answers,
 * else "A socio", as shared's `runningNote` words it.
 */
export function roomRunningNote(turn: LiveTurn, context: RoomContext): string | null {
    if (!turn.running) {
        return null;
    }
    const streaming = turn.messages.find((message) => message.id === turn.streamingId);
    const socioId = streaming === undefined ? undefined : socioIdOf(streaming);
    const several = answeringSocios(context.view?.socios ?? []).length > 1;
    const name =
        socioId !== undefined
            ? socioName(socioId, '', context)
            : several
              ? 'A socio'
              : socioName(context.leadId, '', context);
    return runningNote(name, turn.phase);
}

/**
 * The socio a screen reader names when the turn's reply has come: the last
 * reply's (each reply names its own in a room with several), else the lead.
 */
export function roomReplier(turn: LiveTurn, context: RoomContext): string {
    const reply = turn.messages.findLast(
        (message) => message.role === 'assistant' && messageText(message).trim() !== '',
    );
    const socioId = reply === undefined ? undefined : socioIdOf(reply);
    return socioName(socioId ?? context.leadId, '', context);
}

/**
 * The reader's pending bubbles in a read-only room, which shows no composer:
 * Edit would put the text in a box the room doesn't show, so a
 * refused message offers Retry and Delete instead.
 */
export function roomBubbles(bubbles: readonly PendingBubble[]): PendingBubble[] {
    return bubbles.map((bubble) =>
        bubble.actions.includes('edit')
            ? {
                  ...bubble,
                  actions: [
                      ...bubble.actions.filter((action): action is BubbleAction => action !== 'edit'),
                      ...(bubble.actions.includes('delete') ? [] : (['delete'] as const)),
                  ],
              }
            : bubble,
    );
}

/** Someone else's queued message, which a room admin sees and may cancel (CB-215). */
export interface OthersBubble {
    readonly kind: 'others';
    /** `others:<server id>`: the list's key. */
    readonly id: string;
    readonly messageId: string;
    /** "Ben · Queued · written 2 min ago", or "· Can't send now" for a held one. */
    readonly caption: string;
    readonly text: string;
    /** How many files it carries, said with the text. */
    readonly files: number;
    /** Whether it shows Cancel: never in a read-only room (archived, rooms off), which the server refuses. */
    readonly cancellable: boolean;
}

export const OTHERS_HELD = 'Can’t send now';

/**
 * Everyone else's waiting messages for a room admin, oldest first, none the
 * transcript already holds; with Cancel only while the room isn't read-only
 * (`cancellable`).
 */
export function othersBubbles(
    others: readonly OthersQueuedMessage[],
    shown: {
        /** Whether the stored history holds a message id. */
        readonly stored: (messageId: string) => boolean;
        /** The people's messages the live turn holds (`deliveredInTurn`): delivered, not queued. */
        readonly inTurn: ReadonlySet<string>;
    },
    now: number,
    cancellable: boolean,
): OthersBubble[] {
    return others
        .filter((message) => !shown.stored(message.id) && !shown.inTurn.has(message.id))
        .map((message) => ({
            kind: 'others',
            id: `others:${message.id}`,
            messageId: message.id,
            caption: `${message.author.name} · ${message.held === true ? OTHERS_HELD : `Queued · ${writtenAgo(message.createdAt, now)}`}`,
            text: message.text,
            files: message.files,
            cancellable,
        }));
}

export const CANCEL_QUEUED = 'Cancel';
export const CANCEL_FAILED = 'Couldn’t cancel it. Check your connection and try again.';
export const CANCEL_DELIVERED = 'Too late to cancel: it has gone to the room’s socio.';
export const CANCEL_REFUSED = 'Couldn’t cancel it: only the room’s admins can.';
export const CANCEL_ARCHIVED = 'Couldn’t cancel it: this room is archived.';
export const CANCEL_ROOMS_OFF = 'Couldn’t cancel it: rooms are off in this workspace.';
export const CANCEL_NOT_DONE = 'Couldn’t cancel it. Try again in a moment.';

/**
 * What an admin's Cancel came to: `done` (the server took it, or it was
 * already gone: 404); a 409 by its `code` (src/server/context/steering-routes.ts,
 * src/server/rooms/contract.ts): `delivered` (it went to the socio first),
 * `archived` or `rooms-off` (the room is read-only now); `refused` (403: the
 * reader is no longer an admin); `failed` (any other answer: a 5xx, another
 * 4xx, a 409 with another code); `offline` (no answer at all).
 */
export type CancelOutcome = 'done' | 'delivered' | 'archived' | 'rooms-off' | 'refused' | 'failed' | 'offline';

/** A 409's outcome by the body's `code`; only `delivered` means too late. */
async function conflictOutcome(response: Response): Promise<CancelOutcome> {
    const body = (await readJson(response).catch(() => null)) as { code?: unknown } | null;
    switch (body?.code) {
        case 'delivered':
            return 'delivered';
        case 'archived':
            return 'archived';
        case 'rooms_off':
            return 'rooms-off';
        default:
            return 'failed';
    }
}

/**
 * A room admin cancels someone else's queued message: `DELETE
 * …/steering/:id`, online only and never queued (the web's `useOthersQueued`).
 */
export async function cancelOthersQueued(
    fetch: AuthedFetch,
    roomId: string,
    messageId: string,
): Promise<CancelOutcome> {
    let response: Response;
    try {
        response = await fetch(
            `/api/conversations/${encodeURIComponent(roomId)}/steering/${encodeURIComponent(messageId)}`,
            { method: 'DELETE' },
        );
    } catch {
        return 'offline';
    }
    const { status } = response;
    if ((status >= 200 && status < 300) || status === 404) {
        return 'done';
    }
    if (status === 409) {
        return conflictOutcome(response);
    }
    return status === 403 ? 'refused' : 'failed';
}

/**
 * What Cancel's outcome says, or null when it worked, and whether the queue
 * is read again: after every answer the server gave (it changed, or the
 * reader's view of it was stale), never after no answer.
 */
export function cancelAnswer(outcome: CancelOutcome): { readonly notice: string | null; readonly refresh: boolean } {
    switch (outcome) {
        case 'done':
            return { notice: null, refresh: true };
        case 'delivered':
            return { notice: CANCEL_DELIVERED, refresh: true };
        case 'archived':
            return { notice: CANCEL_ARCHIVED, refresh: true };
        case 'rooms-off':
            return { notice: CANCEL_ROOMS_OFF, refresh: true };
        case 'refused':
            return { notice: CANCEL_REFUSED, refresh: true };
        case 'failed':
            return { notice: CANCEL_NOT_DONE, refresh: true };
        case 'offline':
            return { notice: CANCEL_FAILED, refresh: false };
    }
}

/** The newest stored run's seq: what the room is marked read up to while it shows. */
export const newestSeq = (runs: readonly HistoryRun[]): number | null => runs.at(-1)?.seq ?? null;

/**
 * Whether the room should be marked read up to `seq` now: its newest run is
 * on screen (the list follows its end), the app is active and the screen
 * focused, and `seq` is past the last mark this screen made. A room opened
 * with nothing unread starts with its newest seq as marked.
 */
export function shouldMarkRead(input: {
    readonly seq: number | null;
    readonly marked: number | null;
    readonly following: boolean;
    readonly active: boolean;
}): boolean {
    return input.seq !== null && input.following && input.active && (input.marked === null || input.seq > input.marked);
}
