import { EventType, type BaseEvent } from '@ag-ui/core';

// Moved from `src/server/replay/replay.ts`, which re-exports it. The replay
// worker loads it, so it stays small: `@ag-ui/core` and nothing else.

/**
 * A stored run's events as a replay takes them. A stopped run stored
 * before CB-108 ends in a RUN_FINISHED without ids. The browser rejects
 * that event and silently ends the replay there, so every later turn went
 * missing on connect: give it its own. Rows stored before a run could
 * only error once may continue past their RUN_ERROR, which a replay
 * rejects; the error ends the run.
 */
export function replayableEvents(threadId: string, row: { runId: string; events: string }): BaseEvent[] {
    const events = (JSON.parse(row.events) as BaseEvent[]).map((event) =>
        event.type === EventType.RUN_FINISHED && !(event as { runId?: unknown }).runId
            ? ({ ...event, threadId, runId: row.runId } as BaseEvent)
            : event,
    );
    const end = events.findIndex((event) => event.type === EventType.RUN_ERROR);
    return end === -1 ? events : events.slice(0, end + 1);
}
