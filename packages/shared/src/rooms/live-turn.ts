import type { BaseEvent, Message } from '@ag-ui/core';

import { AG_UI_EVENT, LEGACY_THINKING_EVENT } from '../runs/event-types.js';
import { SENDER_METADATA, SENDER_NAME_METADATA, SOCIO_METADATA, type MessageAuthor } from '../types.js';

import { handoffOf, type TranscriptHandoff } from './room-handoffs.js';

/*
 * A room's running turn as its live stream tells it (CB-212), the pure
 * part the web's room feed and the app share. The event types are
 * AG_UI_EVENT's strings: this package imports `@ag-ui/core` for types only.
 */

/**
 * A room message as the transcript route gives it: its author, time and,
 * for a reply, the socio that wrote it (CB-212); or the handoff between
 * socios it records (CB-206). For a socio turn, its reasoning and tool
 * messages are the trace's parts (CB-283): a tool message carries its
 * call id, an assistant message the calls it made.
 */
export type RoomMessage = Message & {
    author?: MessageAuthor;
    at?: number;
    socioId?: string;
    /** A handoff between the room's socios, shown as a line (CB-206). */
    handoff?: TranscriptHandoff;
};

/** What the socio is doing in the running turn, as far as the room may see. */
export type RoomPhase = 'thinking' | 'working' | 'writing';

/** The running turn as the room's live stream told it. */
export interface LiveTurn {
    running: boolean;
    phase?: RoomPhase;
    streamingId?: string;
    /** Its messages the transcript doesn't have yet, in order. */
    messages: RoomMessage[];
}

export const NO_LIVE_TURN: LiveTurn = { running: false, messages: [] };

const metadataOf = (value: unknown) => {
    const metadata = (value as { metadata?: unknown } | undefined)?.metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
};

/** A person's message's author, from what the server stamped on it. */
function authorOf(value: unknown, me: string | undefined): MessageAuthor | undefined {
    const metadata = metadataOf(value);
    const id = metadata[SENDER_METADATA];
    if (typeof id !== 'string' || !id) {
        return undefined;
    }
    const name = metadata[SENDER_NAME_METADATA];
    return {
        name: typeof name === 'string' && name ? name : 'Team member',
        you: id === me,
        id,
    };
}

const socioOf = (value: unknown) => {
    const id = metadataOf(value)[SOCIO_METADATA];
    return typeof id === 'string' && id ? { socioId: id } : {};
};

/** `messages` with `message` added, or put in place of the one with its id. */
const upsert = (messages: RoomMessage[], message: RoomMessage) => {
    const at = messages.findIndex((known) => known.id === message.id);
    return at === -1 ? [...messages, message] : messages.map((known, index) => (index === at ? message : known));
};

/**
 * One event of the room's live stream (`/api/conversations/:id/stream`,
 * AG-UI as the server filtered it for the reader) applied to the running
 * turn: its people's messages, the reply as it is written and what the
 * socio does. Replaying a turn gives the same result: a message comes
 * once, a reply starts over. Pure, for tests.
 */
export function applyRoomEvent(turn: LiveTurn, event: BaseEvent, me: string | undefined): LiveTurn {
    switch (event.type as string) {
        case AG_UI_EVENT.RUN_STARTED: {
            const input = (event as { input?: { messages?: Message[] } }).input;
            let messages = turn.messages;
            for (const message of input?.messages ?? []) {
                if (message.role === 'user' && !messages.some((known) => known.id === message.id)) {
                    // A handoff's note (CB-206): the line the room reads, its
                    // socios' names filled in by the room.
                    const handedOff = handoffOf(message);
                    if (handedOff) {
                        messages = [
                            ...messages,
                            {
                                id: message.id,
                                role: 'user',
                                content: '',
                                handoff: {
                                    kind: handedOff.kind,
                                    from: { id: handedOff.from, name: '' },
                                    to: { id: handedOff.to, name: '' },
                                    reason: handedOff.reason,
                                },
                            } as RoomMessage,
                        ];
                        continue;
                    }
                    const author = authorOf(message, me);
                    messages = [
                        ...messages,
                        {
                            id: message.id,
                            role: 'user',
                            content: message.content,
                            ...(author ? { author } : {}),
                            ...(event.timestamp === undefined ? {} : { at: event.timestamp }),
                        } as RoomMessage,
                    ];
                }
            }
            return { running: true, messages };
        }
        case AG_UI_EVENT.TEXT_MESSAGE_START: {
            const { messageId, role } = event as {
                messageId?: unknown;
                role?: unknown;
            };
            if (typeof messageId !== 'string') {
                return turn;
            }
            const user = role === 'user';
            const author = user ? authorOf(event, me) : undefined;
            return {
                ...turn,
                running: true,
                phase: user ? turn.phase : 'writing',
                streamingId: user ? turn.streamingId : messageId,
                messages: upsert(turn.messages, {
                    id: messageId,
                    role: user ? 'user' : 'assistant',
                    content: '',
                    ...(author ? { author } : {}),
                    ...(user ? {} : socioOf(event)),
                    ...(event.timestamp === undefined ? {} : { at: event.timestamp }),
                } as RoomMessage),
            };
        }
        case AG_UI_EVENT.TEXT_MESSAGE_CONTENT: {
            const { messageId, delta } = event as {
                messageId?: unknown;
                delta?: unknown;
            };
            if (typeof delta !== 'string') {
                return turn;
            }
            return {
                ...turn,
                messages: turn.messages.map((message) =>
                    message.id === messageId
                        ? ({
                              ...message,
                              content: `${typeof message.content === 'string' ? message.content : ''}${delta}`,
                          } as RoomMessage)
                        : message,
                ),
            };
        }
        case AG_UI_EVENT.TEXT_MESSAGE_END:
            return (event as { messageId?: unknown }).messageId === turn.streamingId
                ? { ...turn, streamingId: undefined }
                : turn;
        case AG_UI_EVENT.REASONING_START:
        case AG_UI_EVENT.REASONING_MESSAGE_START:
        case LEGACY_THINKING_EVENT.THINKING_START:
            return { ...turn, running: true, phase: 'thinking' };
        case AG_UI_EVENT.REASONING_END:
        case LEGACY_THINKING_EVENT.THINKING_END:
        case AG_UI_EVENT.TOOL_CALL_START:
            return { ...turn, running: true, phase: 'working' };
        case AG_UI_EVENT.RUN_FINISHED:
        case AG_UI_EVENT.RUN_ERROR:
            return {
                ...turn,
                running: false,
                phase: undefined,
                streamingId: undefined,
            };
        default:
            return turn;
    }
}

/** The live turn's messages the transcript doesn't have yet. */
export function stillLive(turn: LiveTurn, transcript: readonly RoomMessage[] | undefined): LiveTurn {
    if (!transcript) {
        return turn;
    }
    const stored = new Set(transcript.map((message) => message.id));
    const messages = turn.messages.filter((message) => !stored.has(message.id));
    return messages.length === turn.messages.length
        ? turn
        : {
              ...turn,
              messages,
              ...(turn.streamingId && stored.has(turn.streamingId) ? { streamingId: undefined } : {}),
          };
}
