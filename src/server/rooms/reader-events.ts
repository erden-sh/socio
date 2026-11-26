import { EventType, type BaseEvent, type Message } from '@ag-ui/client';

import {
    OWN_CHATS_TOOLS,
    noteActorKey,
    reasoningActorKey,
    withPrivateResultsWithheld,
    withheldResult,
} from '@socio/foundation/context/room-context';
import { isApprovalNote } from '@socio/shared/approvals';
import { LEGACY_THINKING_EVENT } from '@socio/shared/runs/event-types';
import { TIME_ZONE_MOVED_EVENT } from '@socio/shared/time-zone';
import { TOOL_ACTOR_METADATA } from '@socio/shared/types';

import type { ReaderEventSource, ReaderEventsShape } from './contract.js';

const metadataOf = (message: object) => {
    const metadata = (message as { metadata?: unknown }).metadata;
    return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : {};
};

/** A reasoning event with nothing but what places it: no text or title. */
const bare = (event: BaseEvent): BaseEvent => {
    const { type, timestamp } = event;
    const { messageId, role, subagentRunId } = event as {
        messageId?: unknown;
        role?: unknown;
        subagentRunId?: unknown;
    };
    return {
        type,
        ...(typeof messageId === 'string' ? { messageId } : {}),
        ...(role === 'reasoning' ? { role } : {}),
        ...(typeof subagentRunId === 'string' ? { subagentRunId } : {}),
        ...(timestamp === undefined ? {} : { timestamp }),
    } as BaseEvent;
};

/**
 * A room's AG-UI events as `reader` may see them, one at a time and in
 * order (a stream's replay of stored runs, then the run in progress). The
 * same rule as the room's history (CB-210 `withPrivateResultsWithheld`):
 * a tool's result in a turn that acted for anyone else, and an approval's
 * note quoting one, reach the reader as the withheld note, never what it
 * held (a screenshot of their computer is such a result, CB-209); a
 * result of `OWN_CHATS_TOOLS` is withheld from everyone; the acting
 * person's time zone moving (a profile fact) is theirs alone, and so is
 * the model's reasoning: anyone else gets only that it thought (`bare`
 * starts and ends, a reasoning message brought whole is emptied). Everything
 * else (people's messages, the socio's answers and its tool calls) is the
 * room's. A run nobody is known to have started counts as no one's, so
 * its results are withheld from all: the filter fails closed.
 */
export function readerFilter(reader: string, source: ReaderEventSource) {
    let actor = '';
    const names = new Map<string, string>();
    let stored: ReadonlyMap<string, string> | undefined;
    const theirs = () => actor !== '' && actor === reader;
    /** Messages a run brought (its input, a snapshot): each by whose it was. */
    const messages = (list: readonly Message[]) => {
        for (const message of list) {
            if (message.role === 'assistant') {
                for (const call of message.toolCalls ?? []) {
                    names.set(call.id, call.function.name);
                }
            }
        }
        const stamped = list.map((message) => {
            const note = message.role === 'user' && isApprovalNote(message);
            if (message.role !== 'tool' && message.role !== 'reasoning' && !note) {
                return message;
            }
            stored ??= source.toolActors();
            const key =
                message.role === 'tool'
                    ? message.toolCallId
                    : message.role === 'reasoning'
                      ? reasoningActorKey(message.id)
                      : noteActorKey(message.id);
            return {
                ...message,
                metadata: {
                    ...metadataOf(message),
                    [TOOL_ACTOR_METADATA]: stored.get(key) ?? actor,
                },
            } as Message;
        });
        const seen = withPrivateResultsWithheld(stamped, reader);
        // Withheld or not, the stamp is the server's: it never goes out.
        return seen.map((message, at) => {
            if (message === list[at]) {
                return message;
            }
            const metadata = { ...metadataOf(message) };
            delete metadata[TOOL_ACTOR_METADATA];
            const next = { ...message, metadata } as Message & { metadata?: object };
            if (!Object.keys(metadata).length) {
                delete next.metadata;
            }
            return next as Message;
        });
    };
    return (event: BaseEvent): BaseEvent | undefined => {
        switch (event.type as string) {
            case EventType.RUN_STARTED: {
                const { runId, input } = event as {
                    runId?: unknown;
                    input?: { messages?: Message[] };
                };
                actor = typeof runId === 'string' ? source.runActor(runId) : '';
                if (!input?.messages?.length) {
                    return event;
                }
                return {
                    ...event,
                    input: { ...input, messages: messages(input.messages) },
                } as BaseEvent;
            }
            case EventType.MESSAGES_SNAPSHOT: {
                const list = (event as { messages?: Message[] }).messages;
                return list ? ({ ...event, messages: messages(list) } as BaseEvent) : event;
            }
            case EventType.TOOL_CALL_START: {
                const { toolCallId, toolCallName } = event as {
                    toolCallId?: unknown;
                    toolCallName?: unknown;
                };
                if (typeof toolCallId === 'string' && typeof toolCallName === 'string') {
                    names.set(toolCallId, toolCallName);
                }
                return event;
            }
            case EventType.TOOL_CALL_RESULT: {
                const { toolCallId, content } = event as {
                    toolCallId?: unknown;
                    content?: unknown;
                };
                const name = typeof toolCallId === 'string' ? names.get(toolCallId) : undefined;
                if (theirs() && !OWN_CHATS_TOOLS.has(name ?? '')) {
                    return event;
                }
                return {
                    ...event,
                    content: withheldResult(name ?? 'tool', content),
                } as BaseEvent;
            }
            // The model's reasoning in a turn for someone else:
            // that it thinks, never what, which can retell their private
            // results. Its start and end go out bare (the reader's "thinking…");
            // its text, and any encrypted form, not at all.
            case EventType.REASONING_START:
            case EventType.REASONING_MESSAGE_START:
            case EventType.REASONING_MESSAGE_END:
            case EventType.REASONING_END:
            // The names runs stored before AG-UI 1.0 may hold.
            case LEGACY_THINKING_EVENT.THINKING_START:
            case LEGACY_THINKING_EVENT.THINKING_END:
            case LEGACY_THINKING_EVENT.THINKING_TEXT_MESSAGE_START:
            case LEGACY_THINKING_EVENT.THINKING_TEXT_MESSAGE_END:
                return theirs() ? event : bare(event);
            case EventType.REASONING_MESSAGE_CONTENT:
            case EventType.REASONING_MESSAGE_CHUNK:
            case EventType.REASONING_ENCRYPTED_VALUE:
            case LEGACY_THINKING_EVENT.THINKING_TEXT_MESSAGE_CONTENT:
                return theirs() ? event : undefined;
            case EventType.CUSTOM:
                return (event as { name?: unknown }).name === TIME_ZONE_MOVED_EVENT && !theirs() ? undefined : event;
            default:
                return event;
        }
    };
}

/** `readerFilter` behind the `ReaderEvents` tag (rooms/contract.ts). */
export const roomReaderEvents: ReaderEventsShape = { filter: readerFilter };
