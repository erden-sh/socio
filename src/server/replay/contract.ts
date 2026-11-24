/**
 * What other features may know of the replay worker (CB-318): its tag, the
 * slice of the replayer they call, its error and its plain types and
 * constants. It imports only `effect`, `@socio/*` and `import type` from `@ag-ui/*`,
 * and holds no logic.
 *
 * The old paths (`replay/replay.ts`, `replay/pool.ts`) re-export what moved
 * here, so importers keep compiling until they switch. `replayableEvents`
 * moved to `@socio/foundation/replay/replayable-events`, the limits to
 * `@socio/foundation/replay/limits`: the worker loads those, not this file
 * (it would load `effect`). `ReplayPool` and `InlineReplayer` implement
 * its shape; `replay/layer.ts` provides the tag, over
 * `sharedReplayer()`. Replay reads no `PlatformConfig` (only
 * `SOCIO_REPLAY`), so there is no config tag.
 */
import type { BaseEvent, Message } from '@ag-ui/client';
import { Context } from 'effect';

// ── Plain types and constants ─────────────────────────────────────────────

/** A finished run's row as `agent_runs` stores it: its events as JSON. */
export interface StoredRunRow {
    seq: number;
    runId: string;
    events: string;
}

/** What a replay leaves: the messages, and the state the events set. */
export interface ReplaySnapshot {
    messages: Message[];
    state: unknown;
}

/** How a `ReplayCache.messages` call went, for tests and logs. */
export interface ReplayStats {
    /** Rows the cached replay covered and this call did not replay. */
    cachedRows: number;
    /** Rows this call replayed. */
    replayedRows: number;
}

/** The worker's limits; defined in `@socio/foundation/replay/limits`, which the worker loads. */
export { REPLAY_CACHE_BYTES, REPLAY_TIMEOUT_MS } from '@socio/foundation/replay/limits';

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A replay that failed in the worker: it stopped, took too long, or the
 * replay threw. Kept a plain `Error` (caught with `instanceof`, its name
 * and message unchanged): it reaches callers through the shape's
 * promises, which `turns/local-runner.ts` awaits.
 */
export class ReplayError extends Error {
    constructor(
        message: string,
        readonly reason: 'timeout' | 'crash' | 'replay',
    ) {
        super(message);
        this.name = 'ReplayError';
    }
}

// ── Services ─────────────────────────────────────────────────────────────

/**
 * Rebuilds a thread's messages from its finished runs (CB-318), keeping its
 * last replay under `key` (a runner and a thread) so the next one replays
 * only the runs stored since. `turns/local-runner.ts` is the caller.
 */
export interface ReplayerShape {
    messages(
        key: string,
        threadId: string,
        rows: StoredRunRow[],
        options?: { timeoutMs?: number },
    ): Promise<{ messages: Message[]; stats: ReplayStats }>;
    forget(key: string): void;
    forgetPrefix(prefix: string): void;
}

/** The process's replayer: the replay worker, or inline with `SOCIO_REPLAY=inline`. */
export class Replayer extends Context.Service<Replayer, ReplayerShape>()('socio/replay/Replayer') {}

/**
 * Rebuilds messages from stored events on the calling thread, uncached:
 * `replayMessages` (`replay/replay.ts`), for a page of history or one run's
 * events. `context/reaction-routes.ts` and `workspace/chat-history.ts` call
 * it today through `turns/local-runner.ts`'s re-export; this tag lets them
 * reach it through the contract instead.
 */
export interface EventReplayShape {
    messages(threadId: string, events: BaseEvent[]): Promise<Message[]>;
}

/** Replays a thread's stored events here, whole (`replayMessages`). */
export class EventReplay extends Context.Service<EventReplay, EventReplayShape>()('socio/replay/EventReplay') {}
