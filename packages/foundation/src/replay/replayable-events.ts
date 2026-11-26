import { EventType, type BaseEvent } from '@ag-ui/core';

import { upgradeMessageAttachments } from '@socio/shared/media/refs';

// Moved from `src/server/replay/replay.ts`, which re-exports it. The replay
// worker loads it, so it stays small: `@ag-ui/core`, the attachment parts,
// and nothing else.

type Fields = Record<string, unknown>;

/** `messages` with their attachment parts upgraded; the same array when none changed. */
function upgradeMessages(messages: unknown[]): unknown[] {
    const upgraded = messages.map((message) =>
        message && typeof message === 'object' ? upgradeMessageAttachments(message as Fields) : message,
    );
    return upgraded.every((message, index) => message === messages[index]) ? messages : upgraded;
}

/**
 * A stored event as AG-UI 1.0 takes it. The 1.0 client checks every event
 * (the browser's, and the server's replay of a thread's messages) and fails
 * the replay at one that doesn't parse, so what runs stored before it hold is
 * brought up to date here, never in the stored rows:
 * - a RUN_STARTED whose `input` lacks its thread or run id (runs stored
 *   before the runner wrote them) gets them, and messages if it has none;
 * - the pre-1.0 attachment references in its input's messages, and in a
 *   MESSAGES_SNAPSHOT, become the 1.0 media parts (`@socio/shared/media/refs`),
 *   which 1.0 would otherwise drop.
 * The pre-1.0 THINKING_* events need nothing here: the 1.0 client turns them
 * into REASONING_* ones itself.
 */
function upgradeEvent(threadId: string, runId: string, event: BaseEvent): BaseEvent {
    const fields = event as unknown as Fields;
    if (event.type === EventType.RUN_STARTED && fields.input && typeof fields.input === 'object') {
        const input = fields.input as Fields;
        const messages = Array.isArray(input.messages) ? upgradeMessages(input.messages) : [];
        if (typeof input.threadId === 'string' && typeof input.runId === 'string' && messages === input.messages) {
            return event;
        }
        return {
            ...event,
            input: {
                ...input,
                threadId: typeof input.threadId === 'string' ? input.threadId : threadId,
                runId: typeof input.runId === 'string' ? input.runId : runId,
                messages,
            },
        } as BaseEvent;
    }
    if (event.type === EventType.MESSAGES_SNAPSHOT && Array.isArray(fields.messages)) {
        const messages = upgradeMessages(fields.messages);
        return messages === fields.messages ? event : ({ ...event, messages } as BaseEvent);
    }
    return event;
}

/**
 * A stored run's events as a replay takes them. A stopped run stored
 * before CB-108 ends in a RUN_FINISHED without ids. The browser rejects
 * that event and silently ends the replay there, so every later turn went
 * missing on connect: give it its own. Rows stored before a run could
 * only error once may continue past their RUN_ERROR, which a replay
 * rejects; the error ends the run. Each event is also brought up to AG-UI
 * 1.0 (`upgradeEvent`).
 */
export function replayableEvents(threadId: string, row: { runId: string; events: string }): BaseEvent[] {
    const events = (JSON.parse(row.events) as BaseEvent[]).map((event) =>
        upgradeEvent(
            threadId,
            row.runId,
            event.type === EventType.RUN_FINISHED && !(event as { runId?: unknown }).runId
                ? ({ ...event, threadId, runId: row.runId } as BaseEvent)
                : event,
        ),
    );
    const end = events.findIndex((event) => event.type === EventType.RUN_ERROR);
    return end === -1 ? events : events.slice(0, end + 1);
}
