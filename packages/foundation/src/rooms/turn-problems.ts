import type { BaseEvent } from '@ag-ui/client';
import { EventType } from '@ag-ui/core';

import {
    ROOM_FAILURE_NOTES,
    ROOM_PROBLEM_FALLBACK,
    TURN_PROBLEM_FALLBACK,
    turnFailureKind,
} from '@socio/shared/turn-failures';
import type { MessageAuthor, TranscriptTurnProblem } from '@socio/shared/types';

export { ROOM_PROBLEM_FALLBACK, TURN_PROBLEM_FALLBACK };

/**
 * The turns of a room that ended in an error (CB-212): refused (its
 * sender may not send there now, a limit was reached), failed or cut off.
 * Each after the last message `shown` that came before its end, so the
 * room sees where the socio said nothing and why: one of the fixed texts a
 * failed turn says (`TURN_FAILURE_MESSAGES`), else a plain one, never
 * other words an error brought (a provider's details stay in the run's
 * `errorDetail`, for admins). Each has its sender's wording and the
 * room's, about the sender in the third person (`ROOM_FAILURE_NOTES`,
 * CB-205). A stop is no problem: its person chose it.
 */
export function turnProblems(
    /** The conversation's stored events, compacted, oldest first. */
    events: readonly BaseEvent[],
    /** The ids of the messages the transcript shows. */
    shown: ReadonlySet<string>,
    options: { author?: (runId: string) => MessageAuthor | undefined } = {},
): TranscriptTurnProblem[] {
    const problems: TranscriptTurnProblem[] = [];
    let last: string | undefined;
    let runId = '';
    const saw = (id: unknown) => {
        if (typeof id === 'string' && shown.has(id)) {
            last = id;
        }
    };
    for (const event of events) {
        if (event.type === EventType.RUN_STARTED) {
            const started = event as {
                runId?: unknown;
                input?: { messages?: { id?: unknown }[] };
            };
            runId = typeof started.runId === 'string' ? started.runId : '';
            for (const message of started.input?.messages ?? []) {
                saw(message.id);
            }
            continue;
        }
        saw((event as { messageId?: unknown }).messageId);
        if (event.type !== EventType.RUN_ERROR) {
            continue;
        }
        const text = (event as { message?: unknown }).message;
        const kind = typeof text === 'string' ? turnFailureKind(text) : undefined;
        const author = runId ? options.author?.(runId) : undefined;
        problems.push({
            runId,
            ...(last ? { after: last } : {}),
            message: kind ? (text as string) : TURN_PROBLEM_FALLBACK,
            roomMessage: kind ? ROOM_FAILURE_NOTES[kind](author?.name || 'Its sender') : ROOM_PROBLEM_FALLBACK,
            ...(author ? { author } : {}),
            ...(event.timestamp === undefined ? {} : { at: event.timestamp }),
        });
    }
    return problems;
}
