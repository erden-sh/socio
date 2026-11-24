// Moved from `src/server/operations/etl/source-reader.ts`, which re-exports it.

/** A turn as stored (`agent_runs`), with its chat's socio and owner. */
export interface SourceRun {
    seq: number;
    runId: string;
    threadId: string;
    status: string;
    startedAt: number;
    finishedAt: number | null;
    /** As recorded, or the source whose chats hold it, or the web app. */
    source: string;
    /** JSON (`RunTrace`), or null for turns from before traces. */
    trace: string | null;
    /** JSON: the turn's stored events. */
    events: string;
    /** It kept an operator detail (`errorDetail`); never the text itself. */
    detail?: number | boolean;
    /** The chat's socio and owner; null when the chat has no binding. */
    socioId: string | null;
    ownerId: string | null;
    /**
     * The chat's kind now (`private` or `room`, CB-207), who made or
     * converted a room and when a chat became one, and whether a room was
     * a Telegram topic (a source bound to it, CB-214): for turns that did
     * not record their work cycle (CB-218). Absent: a private chat.
     */
    chatKind?: string | null;
    createdBy?: string | null;
    convertedAt?: number | null;
    fromTopic?: number | boolean | null;
}
