import { randomUUID } from 'node:crypto';

import { EventType, type BaseEvent, type Message } from '@ag-ui/core';

import { isApprovalNote } from '@socio/shared/approvals';
import { pageReviewTool } from '@socio/shared/pages/page-review';
import {
    SENDER_METADATA,
    SENDER_NAME_METADATA,
    SOCIO_METADATA,
    TELEGRAM_INGRESS_METADATA,
    TOOL_ACTOR_METADATA,
} from '@socio/shared/types';
import { voiceReceiptMessagePrefix } from '@socio/shared/voice/voice-receipt';

/**
 * What a stored message's metadata says that only the server writes
 * (CB-225): who sent it (CB-66's sender, CB-147's name), and where a
 * message the server wrote came from (`socioSource`: an approval's note, a
 * voice call's receipt). The model's speaker labels, the
 * admin transcript (CB-188) and the chat's rendering read them. A client
 * that sends any of them, a forged sender or speaker included, has them
 * taken off (`withSender`): the sender is always the signed-in person.
 */
export const SERVER_METADATA: readonly string[] = [
    SENDER_METADATA,
    SENDER_NAME_METADATA,
    TELEGRAM_INGRESS_METADATA,
    'socioSource',
    // Whose turn a stored tool result or approval note was (CB-210),
    // stamped by the runner.
    TOOL_ACTOR_METADATA,
    // Which socio wrote a reply (CB-212), stamped by the runner.
    SOCIO_METADATA,
];

/** The person a message is from, as the server knows them. */
export interface MessageSender {
    id: string;
    /** Their name when it came (CB-147); none when the workspace has none. */
    name?: string;
}

/** The person `id` as a message's sender: with their name now, if any. */
export const senderOf = (users: readonly { id: string; name?: string }[], id: string): MessageSender => {
    const name = users.find((user) => user.id === id)?.name;
    return name ? { id, name } : { id };
};

/** A message's metadata saying `sender` sent it (CB-228). */
export const senderMetadata = (sender: MessageSender): Record<string, string> => ({
    [SENDER_METADATA]: sender.id,
    ...(sender.name ? { [SENDER_NAME_METADATA]: sender.name } : {}),
});

/**
 * `message` without the server's metadata, whatever sent it, and from
 * `sender` when given: their id and name, never what came with it.
 */
export function withSender<T extends object>(message: T, sender?: MessageSender): T {
    const given = (message as { metadata?: unknown }).metadata;
    const metadata: Record<string, unknown> =
        given && typeof given === 'object' && !Array.isArray(given) ? { ...(given as Record<string, unknown>) } : {};
    for (const key of SERVER_METADATA) {
        delete metadata[key];
    }
    if (sender) {
        Object.assign(metadata, senderMetadata(sender));
    }
    const taken = { ...message, metadata } as T & { metadata?: unknown };
    if (!Object.keys(metadata).length) {
        delete taken.metadata;
    }
    return taken;
}

/**
 * The tool calls of the chat's own that wait for the browser's answer: a
 * page review (`review_space_page`, the one tool the browser runs) the
 * socio called with no result stored yet.
 */
export function openClientCalls(stored: readonly Message[]): Set<string> {
    const open = new Set<string>();
    for (const message of stored) {
        if (message.role === 'assistant') {
            for (const call of message.toolCalls ?? []) {
                if (call.function.name === pageReviewTool.name) {
                    open.add(call.id);
                }
            }
        }
    }
    for (const message of stored) {
        if (message.role === 'tool') {
            open.delete(message.toolCallId);
        }
    }
    return open;
}

/**
 * The page reviews stored `events` hold a call to and no result for
 * (CB-228), as `openClientCalls` finds them in messages: a call the socio
 * made (or a stored request's message carried), less the results a
 * request brought or a turn stored.
 */
export function openReviewCalls(events: readonly BaseEvent[]): Set<string> {
    const calls: string[] = [];
    const answered = new Set<string>();
    for (const event of events) {
        const fields = event as unknown as Record<string, unknown>;
        if (
            event.type === EventType.TOOL_CALL_START &&
            fields.toolCallName === pageReviewTool.name &&
            typeof fields.toolCallId === 'string'
        ) {
            calls.push(fields.toolCallId);
        } else if (event.type === EventType.TOOL_CALL_RESULT && typeof fields.toolCallId === 'string') {
            answered.add(fields.toolCallId);
        } else if (event.type === EventType.RUN_STARTED) {
            const input = fields.input as { messages?: Message[] } | undefined;
            for (const message of input?.messages ?? []) {
                if (message.role === 'tool') {
                    answered.add(message.toolCallId);
                } else if (message.role === 'assistant') {
                    for (const call of message.toolCalls ?? []) {
                        if (call.function.name === pageReviewTool.name) {
                            calls.push(call.id);
                        }
                    }
                }
            }
        }
    }
    return new Set(calls.filter((id) => !answered.has(id)));
}

/**
 * A page review's result when the person moved on without answering it
 * (CB-228): it closes the review, stored before what came next, so its
 * call is followed by its result as strict providers require. The card
 * then shows the review as ended; an answer sent later is not taken
 * (`acceptedMessages`). It says nothing of a page saved meanwhile (the
 * card's receipt shows one): the socio asks again if the person still
 * wants it.
 */
export const skippedReview = (toolCallId: string): Message =>
    ({
        id: randomUUID(),
        role: 'tool',
        toolCallId,
        content: JSON.stringify({
            skipped: true,
            message:
                'Closed without an answer: the person sent a new message instead. Do not assume the draft was saved; if they still want the page, ask or call review_space_page again.',
        }),
    }) as Message;

/**
 * A web chat's run request's messages as the server takes them (CB-225):
 * only those the conversation hasn't stored (the runner puts the stored
 * conversation before them, so a client can't rewrite what it holds), each
 * from the person who sent it. Of what is new, the person's own messages
 * are theirs, whatever sender, name or source they claim; a tool result
 * goes only to a page review waiting for it (`openCalls`, read when one
 * comes). Anything else is dropped: a client writes no answer, reasoning,
 * system message or result as the socio's. A server's note (an approval's,
 * checked before as its own) is kept as written, with no sender. Results
 * come before the person's new messages, so none is stored after one of
 * them; it follows its call directly only when that call is the newest
 * stored message. Undefined when a message claims to be a voice call's receipt, which only
 * the server writes. A message with the id of one still in the chat's
 * steering queue (`queued`, CB-223) is refused: that id becomes the queued
 * message's once delivered, and a client never sends it first.
 */
export async function acceptedMessages(
    messages: readonly unknown[],
    known: ReadonlySet<string>,
    sender: MessageSender,
    openCalls: () => Promise<ReadonlySet<string>>,
    queued: ReadonlySet<string> = new Set(),
): Promise<Message[] | undefined> {
    const results: Message[] = [];
    const said: Message[] = [];
    let open: Set<string> | undefined;
    for (const entry of messages) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const message = entry as Message;
        if (typeof message.id !== 'string' || known.has(message.id)) {
            continue;
        }
        if (queued.has(message.id)) {
            continue;
        }
        if (message.role === 'user') {
            if (message.id.startsWith(voiceReceiptMessagePrefix)) {
                return undefined;
            }
            said.push(isApprovalNote(message) ? withoutSender(message) : withSender(message, sender));
        } else if (message.role === 'tool') {
            open ??= new Set(await openCalls());
            if (!open.delete(message.toolCallId)) {
                continue;
            }
            results.push(withSender(message));
        }
    }
    return [...results, ...said];
}

/** A server's own note: its source kept, any sender taken out. */
function withoutSender(message: Message): Message {
    const given = (message as { metadata?: unknown }).metadata;
    if (!given || typeof given !== 'object') {
        return message;
    }
    const metadata = { ...(given as Record<string, unknown>) };
    delete metadata[SENDER_METADATA];
    delete metadata[SENDER_NAME_METADATA];
    delete metadata[TELEGRAM_INGRESS_METADATA];
    return { ...message, metadata } as Message;
}
