import { EventType, type BaseEvent } from '@ag-ui/core';

// Moved from `src/server/context/speaker-echo.ts`.

/**
 * Speaker labels are for the model only (CB-147, CB-174): a model that sees
 * `⟦Name wrote:⟧` lines may write one in its own answer. This takes any
 * such label off the start of a line of what the model says, as it streams,
 * so a bubble, the stored chat (after a reload, in a copy), a Telegram
 * reply and a transcript never show one. Text that merely mentions one
 * mid-line stays.
 */
const LEADING_LABEL = /^[ \t]*⟦[^⟦⟧\n]*wrote:⟧[ \t]*/;

/** A line of the answer without a label at its start; undefined if it was only a label. */
const unlabelled = (line: string) => {
    const rest = line.replace(LEADING_LABEL, '');
    return rest === line ? line : rest || undefined;
};

interface Pending {
    /** The current line so far, held while it may still turn out a label. */
    held: string;
    lineStart: boolean;
}

/** `delta` after `own`'s held text; what can be passed on now. */
function feed(own: Pending, delta: string): string {
    let text = own.held + delta;
    own.held = '';
    let out = '';
    for (;;) {
        const end = text.indexOf('\n');
        if (end < 0) {
            break;
        }
        const line = text.slice(0, end);
        const kept = own.lineStart ? unlabelled(line) : line;
        if (kept !== undefined) {
            out += `${kept}\n`;
        }
        own.lineStart = true;
        text = text.slice(end + 1);
    }
    if (own.lineStart && /^[ \t]*(⟦|$)/.test(text)) {
        own.held = text;
        return out;
    }
    if (text) {
        own.lineStart = false;
    }
    return out + text;
}

/** What `own` still holds, at the end of its message. */
function flush(own: Pending): string {
    const rest = own.held ? unlabelled(own.held) : undefined;
    own.held = '';
    return rest ?? '';
}

/**
 * A filter for one turn's events: give it each event, in order, and it
 * returns the events to pass on. A message's text is held back only while
 * its current line starts with a bracket that may be a label.
 */
export function speakerEchoFilter() {
    const state = new Map<string, Pending>();
    // The chunk message in progress: chunks after the first may omit its id.
    let chunk: { id: string; own: Pending } | undefined;
    const text = (type: EventType, messageId: string, delta: string) =>
        delta ? [{ type, messageId, delta } as BaseEvent] : [];
    const endChunk = () => {
        const done = chunk;
        chunk = undefined;
        return done ? text(EventType.TEXT_MESSAGE_CHUNK, done.id, flush(done.own)) : [];
    };
    return (event: BaseEvent): BaseEvent[] => {
        const { messageId, delta } = event as {
            messageId?: string;
            delta?: string;
        };
        switch (event.type) {
            case EventType.TEXT_MESSAGE_START:
                if (messageId) {
                    state.set(messageId, { held: '', lineStart: true });
                }
                return [...endChunk(), event];
            case EventType.TEXT_MESSAGE_CONTENT: {
                const own = messageId && state.get(messageId);
                if (!own) {
                    return [event];
                }
                return text(event.type, messageId, feed(own, delta ?? ''));
            }
            case EventType.TEXT_MESSAGE_END: {
                const own = messageId && state.get(messageId);
                if (!own) {
                    return [event];
                }
                state.delete(messageId);
                return [...text(EventType.TEXT_MESSAGE_CONTENT, messageId, flush(own)), event];
            }
            case EventType.TEXT_MESSAGE_CHUNK: {
                const id = messageId ?? chunk?.id;
                if (!id) {
                    return [event];
                }
                const out = chunk && chunk.id !== id ? endChunk() : [];
                chunk ??= { id, own: { held: '', lineStart: true } };
                return [
                    ...out,
                    ...(delta === undefined ? [event] : text(EventType.TEXT_MESSAGE_CHUNK, id, feed(chunk.own, delta))),
                ];
            }
            default:
                return [...endChunk(), event];
        }
    };
}
