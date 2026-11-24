import { createHash } from 'node:crypto';

import { AbstractAgent, EventType, compactEvents, type BaseEvent, type Message } from '@ag-ui/client';
import { from, type Observable } from 'rxjs';

import { REPLAY_CACHE_BYTES } from '@socio/foundation/replay/limits';
import { replayableEvents } from '@socio/foundation/replay/replayable-events';

import type { ReplaySnapshot, ReplayStats, StoredRunRow } from './contract.js';

// Rebuilding a conversation's messages from its stored events (CB-318).
// This module is what the replay worker (`worker.ts`) imports, so it must
// stay small: the AG-UI client and rxjs, nothing of the server.

/**
 * Replays stored events through the AG-UI client to rebuild messages: its
 * default `apply`, the same code the browser runs. From `start` when given:
 * the messages and state of the events before these.
 */
export class ReplayAgent extends AbstractAgent {
    constructor(
        private events: BaseEvent[],
        start?: ReplaySnapshot,
    ) {
        super(start ? { initialMessages: start.messages, initialState: start.state as object } : {});
    }
    run(): Observable<BaseEvent> {
        throw new Error('ReplayAgent only replays stored events.');
    }
    protected connect(): Observable<BaseEvent> {
        return from(this.events);
    }
}

/** The messages and state `events` rebuild, after `start`'s when given. */
export async function replaySnapshot(
    threadId: string,
    events: BaseEvent[],
    start?: ReplaySnapshot,
): Promise<ReplaySnapshot> {
    if (!events.length) {
        return start ?? { messages: [], state: {} };
    }
    const replay = new ReplayAgent(events, start);
    replay.threadId = threadId;
    await replay.connectAgent();
    return { messages: replay.messages, state: replay.state };
}

/**
 * The messages `events` (compacted, of finished runs) rebuild, on the
 * thread that calls it. Fine for a page of history; a whole long thread
 * goes through `LocalAgentRunner.messages`, which replays off the main
 * thread and keeps what it rebuilt.
 */
export async function replayMessages(threadId: string, events: BaseEvent[]): Promise<Message[]> {
    return (await replaySnapshot(threadId, events)).messages;
}

/** The messages of `rows` (a thread's finished runs, oldest first), replayed here, whole. */
export function replayRows(threadId: string, rows: readonly StoredRunRow[]): Promise<Message[]> {
    return replayMessages(threadId, compactEvents(rows.flatMap((row) => replayableEvents(threadId, row))));
}

/**
 * Where a replay can stop and carry on later with the same result: after a
 * run's terminal event, with no text message or tool call that
 * `compactEvents` still holds open. There, compacting all the events is
 * compacting those before and those after, one after the other, and the
 * client's checks and chunk handling start over at the next RUN_STARTED,
 * so only the messages and state carry over, which a `ReplayAgent` starts
 * from. `compactEvents` keeps a text message open from its first START or
 * CONTENT to its END, a tool call from its START or ARGS to its END.
 */
class Boundaries {
    private text = new Set<string>();
    private tools = new Set<string>();
    private last?: string;
    add(events: readonly BaseEvent[]) {
        for (const event of events) {
            const { messageId, toolCallId } = event as { messageId?: string; toolCallId?: string };
            switch (event.type) {
                case EventType.TEXT_MESSAGE_START:
                case EventType.TEXT_MESSAGE_CONTENT:
                    this.text.add(messageId as string);
                    break;
                case EventType.TEXT_MESSAGE_END:
                    this.text.delete(messageId as string);
                    break;
                case EventType.TOOL_CALL_START:
                case EventType.TOOL_CALL_ARGS:
                    this.tools.add(toolCallId as string);
                    break;
                case EventType.TOOL_CALL_END:
                    this.tools.delete(toolCallId as string);
                    break;
            }
            this.last = event.type;
        }
    }
    /** Whether the events so far end at such a point. */
    get clean() {
        return (
            !this.text.size &&
            !this.tools.size &&
            (this.last === EventType.RUN_FINISHED || this.last === EventType.RUN_ERROR)
        );
    }
}

const digest = (row: StoredRunRow) =>
    createHash('sha1').update(row.runId).update('\0').update(row.events).digest('base64');

interface CachedReplay extends ReplaySnapshot {
    /** The rows it covers, oldest first: each one's seq and a digest of its run id and events. */
    rows: { seq: number; digest: string }[];
    /** Its approximate size: the characters of the events it covers. */
    bytes: number;
}

/**
 * Each thread's last replay (CB-318), so the next one replays only the runs
 * stored since. Keyed by the caller (a runner and a thread). An entry is
 * used only while every row it covers is still there, unchanged: same seq,
 * run id and events, checked on every call. Anything that rewrote, removed
 * or reordered them (a run finishing out of order, another runtime, a
 * restore) replays the thread whole. Least recently used entries go first
 * past `maxBytes` in all.
 */
export class ReplayCache {
    private entries = new Map<string, CachedReplay>();
    private total = 0;
    constructor(readonly maxBytes = REPLAY_CACHE_BYTES) {}

    get bytes() {
        return this.total;
    }
    get size() {
        return this.entries.size;
    }
    has(key: string) {
        return this.entries.has(key);
    }
    forget(key: string) {
        const entry = this.entries.get(key);
        if (entry) {
            this.entries.delete(key);
            this.total -= entry.bytes;
        }
    }
    forgetPrefix(prefix: string) {
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) {
                this.forget(key);
            }
        }
    }
    clear() {
        this.entries.clear();
        this.total = 0;
    }

    private keep(key: string, entry: CachedReplay) {
        this.forget(key);
        if (entry.bytes > this.maxBytes) {
            return;
        }
        this.entries.set(key, entry);
        this.total += entry.bytes;
        for (const [oldest] of this.entries) {
            if (this.total <= this.maxBytes) {
                break;
            }
            this.forget(oldest);
        }
    }

    /** The cached replay that `rows` still start with, if any. */
    private usable(key: string, rows: readonly StoredRunRow[]) {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        const same =
            entry.rows.length <= rows.length &&
            entry.rows.every((covered, at) => covered.seq === rows[at].seq && covered.digest === digest(rows[at]));
        if (!same) {
            this.forget(key);
            return undefined;
        }
        // Most recently used last.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry;
    }

    /**
     * The messages `rows` (a thread's finished runs, oldest first) rebuild:
     * the same as `replayRows`. The result may share objects with the cache:
     * copy it before handing it to anything that may change it.
     */
    async messages(
        key: string,
        threadId: string,
        rows: readonly StoredRunRow[],
    ): Promise<{ messages: Message[]; stats: ReplayStats }> {
        const base = this.usable(key, rows);
        try {
            return await this.replay(key, threadId, rows, base);
        } catch (error) {
            if (!base) {
                throw error;
            }
            // When unsure, replay it whole: a failure there is the thread's.
            this.forget(key);
            return this.replay(key, threadId, rows, undefined);
        }
    }

    private async replay(key: string, threadId: string, rows: readonly StoredRunRow[], base?: CachedReplay) {
        const start = base?.rows.length ?? 0;
        const rest = rows.slice(start).map((row) => replayableEvents(threadId, row));
        const firstEvent = rest.find((events) => events.length)?.[0];
        if (base && firstEvent && firstEvent.type !== EventType.RUN_STARTED) {
            throw new Error('The runs after the cached replay do not start a run.');
        }
        // The last row after which the replay can stop, with what follows it
        // starting a run.
        const boundaries = new Boundaries();
        let cut = -1;
        let candidate = -1;
        for (const [at, events] of rest.entries()) {
            if (events.length && candidate !== -1 && events[0].type === EventType.RUN_STARTED) {
                cut = candidate;
            }
            if (events.length) {
                candidate = -1;
            }
            boundaries.add(events);
            if (boundaries.clean) {
                candidate = at;
            }
        }
        if (candidate !== -1) {
            cut = candidate;
        }
        const head = rest.slice(0, cut + 1).flat();
        const tail = rest.slice(cut + 1).flat();
        let snapshot: ReplaySnapshot | undefined = base;
        if (cut !== -1) {
            snapshot = await replaySnapshot(threadId, compactEvents(head), base);
            const covered = rows.slice(0, start + cut + 1);
            this.keep(key, {
                ...snapshot,
                rows: [
                    ...(base?.rows ?? []),
                    ...covered.slice(start).map((row) => ({ seq: row.seq, digest: digest(row) })),
                ],
                bytes: (base?.bytes ?? 0) + covered.slice(start).reduce((sum, row) => sum + row.events.length, 0),
            });
        }
        const result = tail.length ? await replaySnapshot(threadId, compactEvents(tail), snapshot) : snapshot;
        return {
            messages: result?.messages ?? [],
            stats: { cachedRows: start, replayedRows: rows.length - start },
        };
    }
}
