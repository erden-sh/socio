import { randomUUID } from 'node:crypto';

import type { ProviderAdapterV2Event } from '@t3tools/provider-core/server/ProviderAdapter';
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';

import { ThreadEventRows, type ThreadEventRecord } from '../infra/rows.js';

/**
 * The session host's thread-event sink (CB-326 step 3):
 * consumes the `ProviderAdapterV2` event stream from a provider session and
 * writes one `coding_thread_events` row per event, named with the person and
 * the requester, in stream order.
 *
 * The payload is the event's data, bounded to the column's 16 KiB (truncated
 * over). Full redaction of token shapes and Socio Secrets values is CB-326
 * step 6's job (the exchange log applies the gateway redactor); here we only
 * bound size. The native ids (`nativeThreadId`, `nativeTurnId`,
 * `nativeItemId`) are pulled from the variant's own fields, so a row ties to
 * the provider's ids for resume/fork/rollback.
 *
 * This is the app-side bridge between the vendored driver's event stream and
 * Socio's database. The host (CB-326 step 3) drives it; the supervisor stream
 * endpoint that carries commands in and events out is a deployment change
 * for the deploy pipeline.
 */

/** What the sink needs to persist one session's events. */
export interface ThreadEventSinkDeps {
    readonly rows: ThreadEventRows;
    readonly sessionId: string;
    readonly personId: string;
    readonly requesterId: string;
}

/** The bounded size of one event's payload (16 KiB, matching the column). */
const PAYLOAD_MAX = 16 * 1024;

/** A bounded JSON payload for an event (truncated over the column size). */
const payloadOf = (event: ProviderAdapterV2Event): string => {
    const text = JSON.stringify(event);
    return text.length <= PAYLOAD_MAX ? text : text.slice(0, PAYLOAD_MAX);
};

/**
 * The native ids an event carries, pulled from the fields the variant actually
 * has. The union's variants put the provider's own thread/turn ids on different
 * fields (`providerThread.id`, `providerThreadId`, `providerTurn.id`,
 * `providerTurnId`), so this is a switch on `event.type` rather than a tolerant
 * read. App-side `ThreadId` (on `command_output.delta`, `runtime_request.updated`)
 * is the app thread, not the native one — it stays out of the native columns.
 * All of `ProviderThreadId`/`ProviderTurnId`/`TurnItemId` are branded strings,
 * so `string | null` is the right storage shape.
 */
const nativeIdsOf = (
    event: ProviderAdapterV2Event,
): { threadId: string | null; turnId: string | null; itemId: string | null } => {
    // Several fields are `Schema.NullOr(...)` (nullable) and at least one is
    // optional; coalesce to `string | null` for the column shape.
    const orNull = (v: string | null | undefined): string | null => v ?? null;
    switch (event.type) {
        case 'provider_thread.updated':
            return { threadId: orNull(event.providerThread.id), turnId: null, itemId: null };
        case 'provider_turn.updated':
            return {
                threadId: orNull(event.providerTurn.providerThreadId),
                turnId: orNull(event.providerTurn.id),
                itemId: null,
            };
        case 'turn_item.updated':
            return {
                threadId: orNull(event.turnItem.providerThreadId),
                turnId: orNull(event.turnItem.providerTurnId),
                itemId: orNull(event.turnItem.id),
            };
        case 'background_work.updated':
            return { threadId: null, turnId: orNull(event.providerTurnId), itemId: null };
        case 'turn.terminal':
            return {
                threadId: orNull(event.providerThreadId),
                turnId: orNull(event.providerTurnId),
                itemId: null,
            };
        // app_thread.created, provider_session.updated, node.updated,
        // subagent.updated, message.updated, command_output.delta,
        // runtime_request.updated, plan.updated carry no native ids we record.
        default:
            return { threadId: null, turnId: null, itemId: null };
    }
};

/**
 * Runs the sink: subscribes to the event stream and writes a row per event
 * until the stream ends. Returns an Effect that runs for the session's life.
 * Each event is written in its own statement (the caller wraps batches in a
 * transaction if it holds one; here, per-event is fine — events are not
 * frequent enough to warrant a write batch, and ordering matters).
 */
export const runThreadEventSink = (
    events: Stream.Stream<ProviderAdapterV2Event>,
    deps: ThreadEventSinkDeps,
    now: () => number = Date.now,
): Effect.Effect<void> =>
    Stream.runForEach(events, (event) =>
        Effect.sync(() => {
            const ordinal = deps.rows.nextOrdinal(deps.sessionId);
            const ids = nativeIdsOf(event);
            const record: ThreadEventRecord = {
                id: randomUUID(),
                sessionId: deps.sessionId,
                personId: deps.personId,
                requesterId: deps.requesterId,
                kind: event.type,
                ordinal,
                nativeThreadId: ids.threadId,
                nativeTurnId: ids.turnId,
                nativeItemId: ids.itemId,
                payload: payloadOf(event),
                createdAt: now(),
                deletedAt: null,
                deletedBy: null,
                deletedWith: null,
            };
            deps.rows.insert(record);
        }),
    );
