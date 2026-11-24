import { type SqlConnection, type SqlStatements, UPDATE_TO_SEND, type UserDbState } from '../data';
import type { AuthedFetch, AuthedRequestInit } from '../net/authed-fetch';
import { AbortedError, NetworkError } from '../net/errors';

import { type Overlay, type OverlayScope, threadHasCaughtUpTo } from './outbox-overlay';
import type { PendingWrite } from './pending';

// The outbox's core:
// the writes this device queued, in user.db's `outbox`, sent in order per lane.
// The rules are T3 Code's thread-outbox-manager (apps/mobile/src/state, at
// pingdotgg/t3code 549d182a), ported, not vendored: its file runs on Effect
// atoms and the app has none. Its test's cases are behavior specs in
// tests/sync/outbox.test.ts.
//
// - **Publish, then persist.** `enqueue` shows the row at once (the `pending`
//   collection, through `subscribe`), then writes it in one user.db
//   transaction, which may carry the caller's own statements (the composer's
//   draft). A failed write takes the row back out by reference: a newer
//   object for the same id is left alone.
// - **Durable before the network.** Every change to the table goes through one
//   queue, and a row is sent only by a task queued after its insert, which
//   checks the row is still the one queued (`confirmQueued`). So a row whose
//   write failed, or that was removed or edited meanwhile, is never sent, and
//   the fetch is never called before the commit.
// - **Revisions and tombstones.** Each accepted write bumps the row's revision;
//   `update` and `remove` may compare-and-set against one read before slow
//   work. A removal bumps it once more and keeps the count, so a stale writer
//   from before the removal can never match a row enqueued again with that id.
// - **Lanes.** One request in flight per lane, lanes in parallel. A lane's
//   head (oldest first) is the only row it may send; a head that is held,
//   unconfirmed, undecodable or waiting on another row (`dependsOn`) holds the
//   rest of its lane.
// - **States.** `queued`; `inflight`, written before the request goes; `unknown`,
//   a request that may have reached the server; `held`, waiting on the
//   person. A row in flight when the app died is `unknown` when the outbox
//   opens, and so is one that `dispose()` (a switch, `holdScope`, a sign-out)
//   or `interrupt()` (iOS's background grace running out) stopped. An unknown
//   row of a kind that is safe to repeat goes again; another kind's is checked
//   by its kind (`check`, a history pull, say) before anything is sent
//   again, and with no check, or one that can't tell, it waits for the person
//   ("Couldn't confirm this was sent", `sendNow`).
// - **Paused** by `interrupt({ pause: true })` (the grace ran out): nothing is
//   sent or checked until `unpause()` (the app is active again). A request
//   aborted on the phone may still be running on the server, so a check right
//   after it could find nothing and send the row twice; on resume it has had
//   time to land. A send begun but not yet in flight stays `queued`.
// - **Back-off** from 1 s to 60 s with jitter, with no limit on attempts.
// - **A 401** (Expired or Ended: authedFetch only answers 401 for the session)
//   holds every lane until `resume()` or the next scope, published as
//   `heldForSignIn`. Nothing is dropped.
// - **Rows this build can't decode** (a kind it doesn't know, a newer
//   `payloadVersion`, a payload its kind refuses) are kept, never sent and
//   never changed: "Update Socio to send these". A user.db opened read-only
//   sends nothing.
// - Only one workspace's outbox runs: the open scope's. Every other
//   workspace's queue waits, and the scope keeps its count in the registry
//   (`waiting`) so the drawer and the switcher say "Waiting to send".
//
// - **Order** is `createdAt`, which never goes below the last one given
//   (`max(now, last + 1)`): a device clock stepped back can't put a new write
//   ahead of an older one in its lane.
// Dependencies, local ids and refusals:
//
// - **Local ids.** A create's kind names what it `creates`; its `done` (or a
//   check's `sent`) carries the server's id, written to user.db's `ids` in the
//   transaction that settles the row. Payloads keep local ids, resolved as the
//   row is sent (`context.resolve`).
// - **Dependencies.** A row with `dependsOn` waits, across lanes, until that
//   row has settled: gone from the outbox (or `sent`) and not refused.
// - **`unsent`.** A refusal moves the row, in one transaction, to user.db's
//   `unsent` with its reason, where it stays across restarts until the
//   person retries, edits or discards it, each in place. A row in `unsent`, or
//   held for the person, holds the rest of its lane and its dependents, shown
//   as one group (`holds()`).
// - **The hand-off.** A `done` may carry `handOff`, which writes the confirmed
//   row to cache.db before the outbox row is deleted: a kill between
//   them leaves the row `unknown`, and its check finds it sent. A message's
//   `done` may instead wait for the stored history (`awaitStored`): the row
//   stays `sent`, shown as it was, until `caughtUp` finds its id there, the
//   server's id when `ids` has one (T3 Code's `threadHasCaughtUpTo`).
// - **Amends.** A `done` may carry `amend`: the lane's rows that can still
//   change get new payloads in the transaction that settles it (a page save's
//   next row takes the revision the server answered, page-save.ts).
// - **Rewrites.** Merge, relocate and re-upload (outbox-answers.ts) give
//   the row a new payload and send it again (`rewrite`), under the fresh
//   idempotency key the outcome carries: the old key's outcome was the
//   refusal. The first rewrite goes at once, the next after the
//   back-off, and one past `OUTBOX_REWRITE_MAX` goes to `unsent`, so a merge
//   that keeps meeting a 409 can't loop. The kind sees the count so far
//   (`OutboxWrite.rewrites`), to settle a last one itself.
//
// What each write does on the wire, and how its answers read, is its
// kind's (outbox-answers.ts, chat-send.ts). No React Native: tests/sync runs
// it under Node.

/**
 * `sent`: the server has it, and the row stays until the stored history does
 * (`awaitStored`, `caughtUp`). It holds nothing: its lane goes on.
 */
export type OutboxState = 'queued' | 'inflight' | 'unknown' | 'held' | 'sent';

/** The first back-off, and its cap. */
export const OUTBOX_RETRY_MIN_MS = 1_000;
export const OUTBOX_RETRY_MAX_MS = 60_000;

/** Rewrites (merge, relocate, re-upload) a row gets before it goes to `unsent` instead ("re-upload once"). */
export const OUTBOX_REWRITE_MAX = 2;

/** The refusal of a write whose chat answered 404 or 410: gone, or the person lost access. */
export const UNSENT_GONE = 'gone';

/** What the outbox shows: the composer draws them. */
export const OUTBOX_COPY = {
    heldForSignIn: 'Sign in again to send these',
    undecodable: UPDATE_TO_SEND,
    waitingToSend: 'Waiting to send',
    unconfirmed: 'Couldn’t confirm this was sent',
} as const;

/** One outbox row: what the `pending` collection shows, plus its key and revision. */
export interface OutboxRow extends PendingWrite {
    readonly idempotencyKey: string;
    readonly revision: number;
}

/** A row handed to its kind, with its payload decoded. */
export interface OutboxWrite<Payload = unknown> {
    readonly row: OutboxRow;
    readonly payload: Payload;
    /**
     * The person asked for this one to go (Send now, Send again) since the
     * outbox opened: a kind that holds a row to ask first (long-queued
     * messages) doesn't ask again. Kept in memory only, so a restart asks again.
     */
    readonly approved?: boolean;
    /**
     * An earlier attempt of this row may have reached the server: it was
     * `unknown` (in flight when it stopped, or a server error) since the
     * outbox opened. A kind that is safe to repeat reads its answers by the
     * already-applied rule then (`classify`'s `ambiguous`). Kept in memory, so
     * a kill after a later retry forgets it.
     */
    readonly ambiguous?: boolean;
    /**
     * How many times this row has been rewritten since the outbox opened: at
     * `OUTBOX_REWRITE_MAX`, another `rewrite` goes to `unsent`, so a kind
     * whose rewrite shows on screen first (a page's merge) settles it there
     * instead. Kept in memory, like the cap's count.
     */
    readonly rewrites?: number;
}

/** What a kind's request is given: the scope's authedFetch, stopped with the row. */
export interface OutboxContext {
    /**
     * The workspace's authedFetch for this row. A 401 answer throws (the
     * outbox holds for sign-in), and calling it marks the request as gone, so
     * a failure after it may have reached the server.
     */
    readonly fetch: AuthedFetch;
    /** Aborted when the outbox stops the request (dispose, interrupt). */
    readonly signal: AbortSignal;
    /** A local id's server id from the `ids` map, or null while its create hasn't resolved. */
    resolve(kind: string, localId: string): string | null;
    /** Whether the `ids` map gives server id `serverId` of `kind` to some write already: a check's candidate must be no other write's. */
    claimed(kind: string, serverId: string): boolean;
}

/** Runs inside the transaction that settles a row, for a kind's own writes there (the `ids` map). */
export type SettleStatements = (tx: SqlStatements) => Promise<void>;

/** How a write the server has settles (`done`, a check's `sent`). */
export interface Settled {
    /** The kind's statements, in the transaction that settles the row. */
    readonly after?: SettleStatements;
    /** The server's id for what this write created (the kind's `creates`), recorded in `ids`. */
    readonly serverId?: string;
    /** Writes the confirmed row to cache.db, before the outbox row goes. A throw leaves the row to the next pull. */
    readonly handOff?: () => Promise<void>;
    /** The row stays, `sent`, until the stored history holds its id (`caughtUp`). */
    readonly awaitStored?: boolean;
    /**
     * Other rows' ids (a row's own, or its server id from `ids`) whose `sent`
     * rows go in the same transaction: what they wait for will never be
     * stored (a cancelled queued message), so `caughtUp` would never remove them.
     */
    readonly forgetSent?: readonly string[];
    /**
     * Rewrites the lane's other rows that can still change (queued or held) in
     * the transaction that settles this one, each to what it returns (null
     * leaves one as it is): a page save's successor takes the base the server
     * now has (page-save.ts). Their revisions
     * move, so an `update` read before it fails its compare-and-set.
     */
    readonly amend?: (other: OutboxRow) => { readonly payload: string; readonly payloadVersion: number } | null;
}

/** What a send came to. */
export type SendOutcome =
    /** The server has it: the row goes (or waits for the store), with `Settled`'s writes. */
    | ({ readonly action: 'done' } & Settled)
    /** Nothing happened on the server: try again, after `delayMs` or the back-off. The lane waits. */
    | { readonly action: 'retry'; readonly delayMs?: number; readonly reason?: string }
    /** It waits for the person: the row and the rest of its lane hold until `sendNow`. */
    | { readonly action: 'hold'; readonly reason: string }
    /** It may have reached the server: checked before it goes again, after the back-off. */
    | { readonly action: 'unknown'; readonly reason?: string }
    /** Refused: what the person wrote moves to `unsent`, holding its lane and dependents. */
    | ({ readonly action: 'unsent' } & UnsentAs)
    /**
     * Merged, relocated or re-uploaded: the row's new payload, under a
     * fresh idempotency key (the old one's outcome was the refusal). The first
     * goes at once, the next after the back-off; past `OUTBOX_REWRITE_MAX`
     * the row goes to `unsent`.
     */
    | {
          readonly action: 'rewrite';
          readonly payload: string;
          readonly payloadVersion: number;
          /** A fresh UUID (the platform's expo-crypto), never the row's current key. */
          readonly idempotencyKey: string;
          readonly reason?: string;
          /** Where the row goes past `OUTBOX_REWRITE_MAX`; by default `unsent` as `rewrite-limit`, as it was. */
          readonly exhausted?: UnsentAs;
      };

/**
 * How a refused row lands in `unsent`: why, and, when the kind says so,
 * another lane and payload (a page's conflict leaves `page:<id>` for
 * `page-conflict:<id>` with both texts, so the page's next saves aren't held).
 */
export interface UnsentAs {
    readonly reason: string;
    readonly lane?: string;
    readonly payload?: string;
}

/** What a check of an unknown row found. */
export type CheckOutcome =
    | ({ readonly action: 'sent' } & Settled)
    | { readonly action: 'not-sent' }
    /** It can't tell yet (a turn still runs that may hold it): checked again after the back-off. */
    | { readonly action: 'later' }
    /**
     * Two candidates, or none it can trust: the person decides (View, Send
     * again). `candidates` are the server ids of what may be this write (its
     * kind's: messages, chats), for View.
     */
    | { readonly action: 'unconfirmed'; readonly candidates?: readonly string[] };

/** A write kind: how its rows are decoded, sent and checked. */
export interface OutboxKind<Payload = unknown> {
    readonly kind: string;
    /** The newest `payloadVersion` this build reads; a row above it is kept, unsent. */
    readonly payloadVersion: number;
    /**
     * Safe to repeat: a request that may have reached the server goes
     * again, and a row in flight when the app died is sent again, unchecked.
     */
    readonly repeatable: boolean;
    /** The payload this build reads, or a throw for one it can't (kept, unsent). By default JSON.parse. */
    decode?(payload: string, payloadVersion: number): Payload;
    send(write: OutboxWrite<Payload>, context: OutboxContext): Promise<SendOutcome>;
    /** Whether an unknown row reached the server. A throw is tried again with the back-off. */
    check?(write: OutboxWrite<Payload>, context: OutboxContext): Promise<CheckOutcome>;
    /** What a create of this kind makes, the `ids` map's kind for its server id: `conversation`, `message`. */
    readonly creates?: string;
    /**
     * How the write looks on screen (outbox-overlay.ts): `row` is null for one
     * in `unsent`. Null lays nothing over.
     */
    overlay?(
        write: { readonly id: string; readonly row: OutboxRow | null; readonly payload: Payload },
        scope: OverlayScope,
    ): Overlay | null;
}

/** A write the server refused, in user.db's `unsent`, with what it needs to go again in place. */
export interface UnsentWrite {
    readonly id: string;
    readonly kind: string;
    readonly lane: string;
    readonly dependsOn: string | null;
    readonly payload: string;
    readonly payloadVersion: number;
    /** The refusal, as a code (`http-413`, `conflict`...): the screens word it. */
    readonly reason: string;
    /** Its place in its lane: the outbox row's `createdAt`. */
    readonly createdAt: number;
}

/** A row that waits on the person, and what it holds: shown as one group. */
export interface HoldGroup {
    /** What holds: a write in `unsent`, a held row, or an unknown row its check couldn't settle. */
    readonly root: {
        readonly id: string;
        readonly kind: string;
        readonly lane: string;
        readonly cause: 'unsent' | 'held' | 'unconfirmed';
        readonly reason: string | null;
        /** With `unconfirmed`: what its check found that may be it (server ids, for View). Kept in memory. */
        readonly candidates?: readonly string[];
    };
    /** The rows it holds, oldest first: the rest of its lane, its dependents, and theirs. */
    readonly rows: readonly OutboxRow[];
}

/** A new write. */
export interface NewOutboxWrite {
    /** The write's local id: a message's id, which the server deduplicates. */
    readonly id: string;
    readonly lane: string;
    readonly kind: string;
    /** The payload's JSON. */
    readonly payload: string;
    readonly payloadVersion: number;
    /** A fresh UUID (the platform's expo-crypto). */
    readonly idempotencyKey: string;
    readonly dependsOn?: string | null;
}

export interface OutboxStatus {
    /** Rows waiting to send, whatever their state, but not those `sent` and waiting for the store. */
    readonly waiting: number;
    /** Writes the server refused, in `unsent`. */
    readonly unsent: number;
    readonly inflight: number;
    /** Every lane waits for the person to sign in again. */
    readonly heldForSignIn: boolean;
    /** Rows this build can't send ("Update Socio to send these"); every row while user.db is read-only. */
    readonly undecodable: number;
    /** user.db opened read-only: nothing is sent or written. */
    readonly readOnly: boolean;
}

/** A row shown or gone: what the `pending` collection follows. */
export type OutboxChange =
    | { readonly type: 'upsert'; readonly row: OutboxRow }
    | { readonly type: 'remove'; readonly id: string };

/** A write the outbox couldn't store, or refused. */
export class OutboxError extends Error {
    override readonly name = 'OutboxError';

    constructor(message: string, cause?: unknown) {
        super(message);
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}

/** A 401 to a row's request: every lane holds for sign-in. A kind that catches its fetch's errors throws it on. */
export class HeldForSignIn extends Error {
    override readonly name = 'HeldForSignIn';
}

export interface OutboxOptions {
    /** user.db, open; the scope closes it after `dispose()`. */
    readonly db: SqlConnection;
    readonly state: UserDbState;
    readonly kinds: readonly OutboxKind<unknown>[];
    /** The scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** A failure nothing waits for: a write that failed, a kind that threw. */
    readonly onError?: (error: unknown) => void;
    /** The device clock, for `createdAt` (ordering only). Waits run on the timers' clock. */
    readonly now?: () => number;
    /** The back-off's jitter. */
    readonly random?: () => number;
}

export interface Outbox {
    /** Every row, oldest first. */
    rows(): OutboxRow[];
    status(): OutboxStatus;
    /** Each row change, as it is published. Returns the unsubscribe. */
    subscribe(listener: (change: OutboxChange) => void): () => void;
    /** Each status change. Returns the unsubscribe. */
    onStatus(listener: (status: OutboxStatus) => void): () => void;
    /**
     * Shows the write at once, then stores it (with `inTransaction`'s
     * statements, in the same transaction). Resolves once it is durable;
     * rejects with OutboxError, the row taken back out, when it isn't.
     */
    enqueue(write: NewOutboxWrite, inTransaction?: SettleStatements): Promise<OutboxRow>;
    /**
     * `enqueue` for several writes in one transaction (a new chat and its first
     * message): all are stored or none. Resolves with the rows in order.
     */
    enqueueAll(writes: readonly NewOutboxWrite[], inTransaction?: SettleStatements): Promise<OutboxRow[]>;
    /** The row's current revision (0 for none), for `update` and `remove`'s compare-and-set. */
    revisionOf(id: string): number;
    /**
     * Changes a row not in flight, in place: false when it is gone, in
     * flight or unknown, or another write was accepted since `expectedRevision`.
     */
    update(
        id: string,
        change: { readonly payload: string; readonly payloadVersion: number },
        expectedRevision?: number,
    ): Promise<boolean>;
    /** Removes a row not in flight; the removed row, or null when it is gone, in flight, or changed since `expectedRevision`. */
    remove(id: string, expectedRevision?: number): Promise<OutboxRow | null>;
    /** A held or unconfirmed row goes now (Send now, Send again). False when it isn't one. */
    sendNow(id: string): Promise<boolean>;
    /** Resolves once every write queued before it has settled: whether `row` is still the one queued. */
    confirmQueued(row: OutboxRow): Promise<boolean>;
    /** What the server refused, oldest first. */
    unsent(): UnsentWrite[];
    /** Each change to `unsent()`. Returns the unsubscribe. */
    onUnsent(listener: (unsent: readonly UnsentWrite[]) => void): () => void;
    /**
     * Edits a refused write in place: false when it is gone or changed
     * since `expectedRevision`. `lane` moves it to another lane (a page's Use
     * mine puts a page's conflict back in `page:<id>` before `retryUnsent`).
     */
    editUnsent(
        id: string,
        change: { readonly payload: string; readonly payloadVersion: number; readonly lane?: string },
        expectedRevision?: number,
    ): Promise<boolean>;
    /**
     * Sends a refused write again (Retry), in its place in its lane, under a
     * fresh idempotency key (the refusal was the first one's outcome). False
     * when it is gone, or a row with its id is queued.
     */
    retryUnsent(id: string, idempotencyKey: string): Promise<boolean>;
    /** Discards a refused write (Discard): the removed write, or null. Its dependents then go to their kinds, which find no server id. */
    discardUnsent(id: string, expectedRevision?: number): Promise<UnsentWrite | null>;
    /**
     * Lost access wins over the outbox: every row of lanes `lanes` not in
     * flight moves to `unsent` with `reason`, in one transaction, whatever it
     * waited on (held, unconfirmed, behind a refusal). A `sent` row there goes:
     * the server had it, and its store will never hold it. A row in flight
     * settles by its own answer. Resolves with the ids moved to `unsent`.
     */
    refuseLanes(lanes: readonly string[], reason: string): Promise<string[]>;
    /** The rows held for the person, each group under what holds it. */
    holds(): HoldGroup[];
    /** A local id's server id, or null. */
    resolve(kind: string, localId: string): string | null;
    /**
     * Removes lane `lane`'s `sent` rows the stored history now holds
     * (`threadHasCaughtUpTo`), each looked up by its server id when `ids` has
     * one. Resolves with the ids removed.
     */
    caughtUp(lane: string, stored: ReadonlySet<string> | ((id: string) => boolean)): Promise<string[]>;
    /** Starts sending (the scope's `start`). Rows wait until then. */
    start(): void;
    /** Looks for work now (a trigger: foreground, network back, a write). Nothing goes while paused. */
    poke(): void;
    /**
     * The network is back (or changed): lanes waiting out a plain back-off go now, as the
     * scheduler's pulls do. A 429's window and a kind's own wait (`delayMs`) still hold.
     */
    wake(): void;
    /** Ends the hold for sign-in. */
    resume(): void;
    /**
     * Stops the requests in flight, their rows `unknown` first. The outbox keeps
     * running, unless `pause` (iOS's grace expiry): then nothing goes until `unpause()`.
     */
    interrupt(options?: { readonly pause?: boolean }): Promise<void>;
    /** Ends the pause `interrupt({ pause: true })` began (the app is active again). */
    unpause(): void;
    /** Resolves once nothing is in flight or about to be, and no write is queued. */
    idle(): Promise<void>;
    /** Stops for good: in-flight rows become `unknown`, then their requests stop. Never rejects. */
    dispose(): Promise<void>;
}

/** The back-off before attempt `attempts + 1`: 1 s doubling to 60 s, jittered into its upper half, never under 1 s. */
export function outboxRetryDelayMs(attempts: number, random: () => number = Math.random): number {
    const base = Math.min(OUTBOX_RETRY_MAX_MS, OUTBOX_RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
    return Math.max(OUTBOX_RETRY_MIN_MS, Math.round(base / 2 + (random() * base) / 2));
}

const COLUMNS =
    'id, lane, kind, payload, payloadVersion, dependsOn, idempotencyKey, state, attempts, revision, createdAt, lastError';

/** Oldest first, as each lane sends them. */
const byAge = (a: { createdAt: number; id: string }, b: { createdAt: number; id: string }) =>
    a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** user.db's `unsent` row as stored: its `payload` is the envelope (`encodeUnsent`). */
interface UnsentRecord {
    readonly id: string;
    readonly kind: string;
    readonly payload: string;
    readonly payloadVersion: number;
    readonly reason: string;
    readonly createdAt: number;
}

/** The envelope's version: what a refused write needs to go again in place, around what the person wrote. */
const UNSENT_ENVELOPE = 1;

/**
 * An unsent write's stored `payload`: `{v, lane, dependsOn, payload}` (user.db's
 * `unsent` has no lane or dependency column), with the write's own payload as
 * the string it was.
 */
export function encodeUnsent(write: Pick<UnsentWrite, 'lane' | 'dependsOn' | 'payload'>): string {
    return JSON.stringify({ v: UNSENT_ENVELOPE, lane: write.lane, dependsOn: write.dependsOn, payload: write.payload });
}

/**
 * Reads an `unsent` row. One whose envelope this build can't read (a newer
 * build's) keeps its stored payload, in no lane, and is `opaque`: it can be
 * copied or discarded, never sent again from here.
 */
export function readUnsent(record: UnsentRecord): { write: UnsentWrite; opaque: boolean } {
    const base = {
        id: record.id,
        kind: record.kind,
        payloadVersion: record.payloadVersion,
        reason: record.reason,
        createdAt: record.createdAt,
    };
    try {
        const envelope = JSON.parse(record.payload) as {
            v?: unknown;
            lane?: unknown;
            dependsOn?: unknown;
            payload?: unknown;
        };
        if (
            envelope.v === UNSENT_ENVELOPE &&
            typeof envelope.lane === 'string' &&
            typeof envelope.payload === 'string' &&
            (envelope.dependsOn === null || typeof envelope.dependsOn === 'string')
        ) {
            return {
                write: { ...base, lane: envelope.lane, dependsOn: envelope.dependsOn, payload: envelope.payload },
                opaque: false,
            };
        }
    } catch {
        // Kept as stored.
    }
    return { write: { ...base, lane: '', dependsOn: null, payload: record.payload }, opaque: true };
}

const idKey = (kind: string, localId: string) => `${kind}\u0000${localId}`;

interface Lane {
    busy: boolean;
    /** The back-off or a 429's window: the lane sends nothing until it fires. On the timers' clock, never the device's. */
    timer: ReturnType<typeof setTimeout> | null;
    /** The timer is a plain back-off (no window the server or the kind asked for), which `wake` may end. */
    backOff: boolean;
}

/**
 * Opens the outbox on the scope's user.db: rows in flight when the app last
 * stopped become `unknown` (written at once, unless the file is read-only),
 * then every row is read. Sends nothing until `start()`.
 */
export async function openOutbox(options: OutboxOptions): Promise<Outbox> {
    const { db, state, fetch } = options;
    const { onError = () => {}, now = Date.now, random = Math.random } = options;
    const kinds = new Map<string, OutboxKind<unknown>>(options.kinds.map((kind) => [kind.kind, kind]));
    const writable = state.writable;
    let loaded: OutboxRow[] = [];
    let loadedUnsent: UnsentRecord[] = [];
    let loadedIds: { kind: string; localId: string; serverId: string }[] = [];
    if (state.version >= 1) {
        loadedUnsent = await db.all<UnsentRecord>(
            'SELECT id, kind, payload, payloadVersion, reason, createdAt FROM unsent ORDER BY createdAt, id',
        );
        loadedIds = await db.all('SELECT kind, localId, serverId FROM ids');
        if (writable) {
            await db.run("UPDATE outbox SET state = 'unknown' WHERE state = 'inflight'");
        }
        loaded = await db.all<OutboxRow>(`SELECT ${COLUMNS} FROM outbox ORDER BY createdAt, id`);
        if (!writable) {
            loaded = loaded.map((row) => (row.state === 'inflight' ? { ...row, state: 'unknown' } : row));
        }
    }

    const rows = new Map<string, OutboxRow>(loaded.map((row) => [row.id, row]));
    /** What the server refused, by id; `opaque` ones this build can't send again. */
    const unsentWrites = new Map<string, UnsentWrite>();
    const opaque = new Set<string>();
    for (const record of loadedUnsent) {
        const read = readUnsent(record);
        unsentWrites.set(record.id, read.write);
        if (read.opaque) {
            opaque.add(record.id);
        }
    }
    /** The `ids` map, in memory: written in the transactions that settle creates. */
    const ids = new Map<string, string>(loadedIds.map((entry) => [idKey(entry.kind, entry.localId), entry.serverId]));
    const resolve = (kind: string, localId: string) => ids.get(idKey(kind, localId)) ?? null;
    const claimed = (kind: string, serverId: string) => {
        const prefix = `${kind}\u0000`;
        for (const [key, value] of ids) {
            if (value === serverId && key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    };
    /** The last `createdAt` given: the next is never below it, whatever the device clock does. */
    let lastCreatedAt = 0;
    for (const item of [...loaded, ...unsentWrites.values()]) {
        lastCreatedAt = Math.max(lastCreatedAt, item.createdAt);
    }
    // Tombstones too: a removed id keeps its last revision (the header). An unsent write's starts at 1.
    const revisions = new Map<string, number>([
        ...[...unsentWrites.keys()].map((id): [string, number] => [id, 1]),
        ...loaded.map((row): [string, number] => [row.id, row.revision]),
    ]);
    const bump = (id: string) => {
        const next = (revisions.get(id) ?? 0) + 1;
        revisions.set(id, next);
        return next;
    };
    const lanes = new Map<string, Lane>();
    const laneOf = (name: string) => {
        let lane = lanes.get(name);
        if (lane === undefined) {
            lane = { busy: false, timer: null, backOff: false };
            lanes.set(name, lane);
        }
        return lane;
    };
    /** Requests in flight, by row id, and the rows `interrupt` or `dispose` marked unknown under them. */
    const inflight = new Map<string, AbortController>();
    const interrupted = new Set<string>();
    /** Unknown rows their kind's check couldn't settle, with its candidates: they wait for `sendNow`. */
    const unconfirmed = new Map<string, readonly string[]>();
    /** Rows the person sent on (`sendNow`) since the outbox opened, until they settle (`OutboxWrite.approved`). */
    const approved = new Set<string>();
    /** Unknown rows a server error answered (not a request that broke off): their next send waits for the back-off. */
    const answered = new Set<string>();
    /** Rows that were `unknown` since the outbox opened, until they settle (`OutboxWrite.ambiguous`). */
    const ambiguous = new Set<string>();
    /** Rewrites each row has had since it was queued or edited (`OUTBOX_REWRITE_MAX`). */
    const rewrites = new Map<string, number>();
    const running = new Set<Promise<void>>();
    const rowListeners = new Set<(change: OutboxChange) => void>();
    const statusListeners = new Set<(status: OutboxStatus) => void>();
    const unsentListeners = new Set<(unsent: readonly UnsentWrite[]) => void>();
    let started = false;
    let closed = false;
    let heldForSignIn = false;
    let paused = false;
    let disposing: Promise<void> | null = null;

    // ---- Publishing --------------------------------------------------------

    /** Each row object's decoded payload, or null for one this build can't send. Rows are never mutated. */
    const decoded = new WeakMap<OutboxRow, OutboxWrite | null>();
    const decodable = (row: OutboxRow): OutboxWrite | null => {
        const known = decoded.get(row);
        if (known !== undefined) {
            return known;
        }
        let write: OutboxWrite | null = null;
        const kind = kinds.get(row.kind);
        if (kind !== undefined && row.payloadVersion <= kind.payloadVersion) {
            try {
                const payload = kind.decode
                    ? kind.decode(row.payload, row.payloadVersion)
                    : (JSON.parse(row.payload) as unknown);
                write = { row, payload };
            } catch {
                write = null;
            }
        }
        decoded.set(row, write);
        return write;
    };

    const computeStatus = (): OutboxStatus => {
        let inflightCount = 0;
        let undecodable = 0;
        let waiting = 0;
        for (const row of rows.values()) {
            if (row.state === 'inflight') {
                inflightCount += 1;
            }
            if (row.state !== 'sent') {
                waiting += 1;
            }
            if (!writable || decodable(row) === null) {
                undecodable += 1;
            }
        }
        return {
            waiting,
            unsent: unsentWrites.size,
            inflight: inflightCount,
            heldForSignIn,
            undecodable,
            readOnly: !writable,
        };
    };
    let lastStatus = computeStatus();
    const tellStatus = () => {
        const next = computeStatus();
        if (
            next.waiting === lastStatus.waiting &&
            next.unsent === lastStatus.unsent &&
            next.inflight === lastStatus.inflight &&
            next.heldForSignIn === lastStatus.heldForSignIn &&
            next.undecodable === lastStatus.undecodable
        ) {
            return;
        }
        lastStatus = next;
        for (const listener of [...statusListeners]) {
            listener(next);
        }
    };
    const tell = (change: OutboxChange) => {
        for (const listener of [...rowListeners]) {
            try {
                listener(change);
            } catch (error) {
                onError(error);
            }
        }
        tellStatus();
    };
    const publish = (row: OutboxRow) => {
        rows.set(row.id, row);
        tell({ type: 'upsert', row });
    };
    const unpublish = (id: string) => {
        if (rows.delete(id)) {
            tell({ type: 'remove', id });
        }
    };
    const unsentList = () => [...unsentWrites.values()].sort(byAge);
    const tellUnsent = () => {
        const list = unsentList();
        for (const listener of [...unsentListeners]) {
            try {
                listener(list);
            } catch (error) {
                onError(error);
            }
        }
        tellStatus();
    };

    // ---- One queue for every change to the table ---------------------------

    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };

    const requireWritable = () => {
        if (closed) {
            throw new OutboxError('The outbox is closed.');
        }
        if (!writable) {
            throw new OutboxError(UPDATE_TO_SEND);
        }
    };

    // ---- Writes from screens -----------------------------------------------

    const enqueueAll = (writes: readonly NewOutboxWrite[], inTransaction?: SettleStatements): Promise<OutboxRow[]> => {
        try {
            requireWritable();
        } catch (error) {
            return Promise.reject(error);
        }
        const fresh = new Set<string>();
        for (const write of writes) {
            if (rows.has(write.id) || unsentWrites.has(write.id) || fresh.has(write.id)) {
                return Promise.reject(new OutboxError(`Write ${write.id} is queued already.`));
            }
            fresh.add(write.id);
        }
        const made = writes.map((write): OutboxRow => {
            // Order, never below the last one given: a clock stepped back can't reorder a lane.
            lastCreatedAt = Math.max(now(), lastCreatedAt + 1);
            return {
                id: write.id,
                lane: write.lane,
                kind: write.kind,
                payload: write.payload,
                payloadVersion: write.payloadVersion,
                dependsOn: write.dependsOn ?? null,
                idempotencyKey: write.idempotencyKey,
                state: 'queued',
                attempts: 0,
                revision: bump(write.id),
                createdAt: lastCreatedAt,
                lastError: null,
            };
        });
        for (const row of made) {
            publish(row);
        }
        return serialize(async () => {
            try {
                await db.transaction(async (tx) => {
                    for (const row of made) {
                        await tx.run(`INSERT INTO outbox (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                            row.id,
                            row.lane,
                            row.kind,
                            row.payload,
                            row.payloadVersion,
                            row.dependsOn,
                            row.idempotencyKey,
                            row.state,
                            row.attempts,
                            row.revision,
                            row.createdAt,
                            row.lastError,
                        ]);
                    }
                    await inTransaction?.(tx);
                });
            } catch (error) {
                // By reference: a newer object for this id isn't this attempt's to take back.
                for (const row of made) {
                    if (rows.get(row.id) === row) {
                        unpublish(row.id);
                    }
                }
                throw new OutboxError(`Write ${made.map((row) => row.id).join(', ')} couldn't be stored.`, error);
            }
            poke();
            return made;
        });
    };

    const enqueue = (write: NewOutboxWrite, inTransaction?: SettleStatements): Promise<OutboxRow> =>
        enqueueAll([write], inTransaction).then((made) => made[0] as OutboxRow);

    /** A row the person may still change: not in flight, and not one that may have reached the server. */
    const editable = (row: OutboxRow | undefined): row is OutboxRow =>
        row !== undefined && (row.state === 'queued' || row.state === 'held') && !inflight.has(row.id);

    const update: Outbox['update'] = (id, change, expectedRevision) =>
        serialize(async () => {
            requireWritable();
            const stale = () =>
                !editable(rows.get(id)) ||
                (expectedRevision !== undefined && (revisions.get(id) ?? 0) !== expectedRevision);
            if (stale()) {
                return false;
            }
            const current = rows.get(id) as OutboxRow;
            const revision = (revisions.get(id) ?? 0) + 1;
            await db.run('UPDATE outbox SET payload = ?, payloadVersion = ?, revision = ? WHERE id = ?', [
                change.payload,
                change.payloadVersion,
                revision,
                id,
            ]);
            revisions.set(id, revision);
            // The person's edit: its merges start again.
            rewrites.delete(id);
            publish({ ...current, payload: change.payload, payloadVersion: change.payloadVersion, revision });
            poke();
            return true;
        });

    const remove: Outbox['remove'] = (id, expectedRevision) =>
        serialize(async () => {
            requireWritable();
            const current = rows.get(id);
            if (
                current === undefined ||
                current.state === 'inflight' ||
                inflight.has(id) ||
                (expectedRevision !== undefined && (revisions.get(id) ?? 0) !== expectedRevision)
            ) {
                return null;
            }
            await db.run('DELETE FROM outbox WHERE id = ?', [id]);
            unpublish(id);
            unconfirmed.delete(id);
            approved.delete(id);
            ambiguous.delete(id);
            rewrites.delete(id);
            // A tombstone: a row enqueued again with this id starts past it.
            bump(id);
            poke();
            return current;
        });

    const sendNow: Outbox['sendNow'] = (id) =>
        serialize(async () => {
            requireWritable();
            const current = rows.get(id);
            if (
                current === undefined ||
                inflight.has(id) ||
                (current.state !== 'held' && current.state !== 'unknown')
            ) {
                return false;
            }
            await db.run("UPDATE outbox SET state = 'queued', lastError = NULL WHERE id = ?", [id]);
            unconfirmed.delete(id);
            approved.add(id);
            const lane = laneOf(current.lane);
            if (lane.timer !== null) {
                clearTimeout(lane.timer);
                lane.timer = null;
            }
            publish({ ...current, state: 'queued', lastError: null });
            poke();
            return true;
        });

    const confirmQueued = (row: OutboxRow) => serialize(async () => rows.get(row.id) === row);

    // ---- The drain ---------------------------------------------------------

    const canSend = () => started && !closed && writable && !heldForSignIn && !paused;

    /** Whether row `id` has settled for its dependents: gone from the outbox (or `sent`), and not refused. */
    const settled = (id: string) => {
        const row = rows.get(id);
        return (row === undefined || row.state === 'sent') && !unsentWrites.has(id);
    };
    const laneRefused = (laneName: string) => {
        for (const write of unsentWrites.values()) {
            if (write.lane === laneName && !opaque.has(write.id)) {
                return true;
            }
        }
        return false;
    };

    /** The lane's head and what to do with it now, or null when it must wait. */
    const nextStep = (laneName: string): { row: OutboxRow; write: OutboxWrite; step: 'send' | 'check' } | null => {
        if (laneRefused(laneName)) {
            // A refused write holds the rest of its lane until the person decides.
            return null;
        }
        let head: OutboxRow | null = null;
        for (const row of rows.values()) {
            // A row sent and waiting for the store holds nothing.
            if (row.lane === laneName && row.state !== 'sent' && (head === null || byAge(row, head) < 0)) {
                head = row;
            }
        }
        if (head === null) {
            return null;
        }
        const write = decodable(head);
        if (write === null || head.state === 'held' || head.state === 'inflight') {
            return null;
        }
        if (head.dependsOn !== null && !settled(head.dependsOn)) {
            return null;
        }
        if (head.state === 'unknown') {
            const kind = kinds.get(head.kind) as OutboxKind<unknown>;
            if (kind.repeatable) {
                return { row: head, write, step: 'send' };
            }
            return kind.check !== undefined && !unconfirmed.has(head.id) ? { row: head, write, step: 'check' } : null;
        }
        return head.state === 'queued' ? { row: head, write, step: 'send' } : null;
    };

    let pokeScheduled = false;
    function poke() {
        if (pokeScheduled || !canSend()) {
            return;
        }
        pokeScheduled = true;
        queueMicrotask(() => {
            pokeScheduled = false;
            drain();
        });
    }

    function drain() {
        if (!canSend()) {
            return;
        }
        for (const laneName of new Set([...rows.values()].map((row) => row.lane))) {
            const lane = laneOf(laneName);
            if (lane.busy || lane.timer !== null) {
                continue;
            }
            const next = nextStep(laneName);
            if (next === null) {
                continue;
            }
            lane.busy = true;
            const work = (next.step === 'send' ? dispatch(next.row, next.write) : check(next.row, next.write))
                .catch(onError)
                .finally(() => {
                    lane.busy = false;
                    running.delete(work);
                    poke();
                });
            running.add(work);
        }
    }

    const schedule = (lane: Lane, delay: number, backOff = false) => {
        if (lane.timer !== null) {
            clearTimeout(lane.timer);
        }
        lane.backOff = backOff;
        lane.timer = setTimeout(() => {
            lane.timer = null;
            poke();
        }, delay);
    };

    /** A context for one row's request: its own AbortController, 401 detection, and whether a request went. */
    const contextFor = (controller: AbortController) => {
        let went = false;
        const context: OutboxContext = {
            signal: controller.signal,
            resolve,
            claimed,
            fetch: async (input: string, init: AuthedRequestInit = {}) => {
                went = true;
                const response = await fetch(input, { ...init, signal: controller.signal });
                if (response.status === 401) {
                    throw new HeldForSignIn(`401 from ${input}`);
                }
                return response;
            },
        };
        return { context, went: () => went };
    };

    /** A throw from a kind's send: a 401, or a request that may or may not have reached the server. */
    const fromThrow = (error: unknown, kind: OutboxKind<unknown>, went: boolean): SendOutcome | 'sign-in' => {
        if (error instanceof HeldForSignIn) {
            return 'sign-in';
        }
        if (!(error instanceof NetworkError) && !(error instanceof AbortedError)) {
            onError(error);
        }
        const reason = error instanceof Error ? error.name : 'Error';
        return went && !kind.repeatable ? { action: 'unknown', reason } : { action: 'retry', reason };
    };

    async function dispatch(row: OutboxRow, write: OutboxWrite): Promise<void> {
        const kind = kinds.get(row.kind) as OutboxKind<unknown>;
        const controller = new AbortController();
        // In the queue, after the row's insert: it goes only if it is still the row queued. Its
        // controller is registered in the same task, so a stop queued after it always finds it.
        const sending = await serialize(async () => {
            if (!canSend() || rows.get(row.id) !== row) {
                return null;
            }
            await db.run("UPDATE outbox SET state = 'inflight', attempts = attempts + 1 WHERE id = ?", [row.id]);
            if (row.state === 'unknown') {
                ambiguous.add(row.id);
            }
            const next: OutboxRow = { ...row, state: 'inflight', attempts: row.attempts + 1 };
            inflight.set(row.id, controller);
            publish(next);
            return next;
        });
        if (sending === null) {
            return;
        }
        if (controller.signal.aborted) {
            // Stopped before it went: already `unknown` on disk, and its check finds it absent.
            inflight.delete(row.id);
            interrupted.delete(row.id);
            return;
        }
        const { context, went } = contextFor(controller);
        let outcome: SendOutcome | 'sign-in';
        let thrown = false;
        try {
            outcome = await kind.send(
                {
                    row: sending,
                    payload: write.payload,
                    ...(approved.has(row.id) ? { approved: true } : {}),
                    ...(ambiguous.has(row.id) ? { ambiguous: true } : {}),
                    ...(rewrites.has(row.id) ? { rewrites: rewrites.get(row.id) ?? 0 } : {}),
                },
                context,
            );
        } catch (error) {
            thrown = true;
            outcome = fromThrow(error, kind, went());
        }
        if ((thrown && went()) || (outcome !== 'sign-in' && outcome.action === 'unknown')) {
            // It may have reached the server, even when a repeatable kind just goes again.
            ambiguous.add(row.id);
        }
        inflight.delete(row.id);
        await serialize(() => settle(sending, outcome, thrown));
    }

    async function check(row: OutboxRow, write: OutboxWrite): Promise<void> {
        const kind = kinds.get(row.kind) as OutboxKind<unknown>;
        const controller = new AbortController();
        inflight.set(row.id, controller);
        const { context } = contextFor(controller);
        let outcome: CheckOutcome | 'sign-in' | 'failed';
        try {
            outcome = await (kind.check as NonNullable<OutboxKind<unknown>['check']>)(write, context);
        } catch (error) {
            if (error instanceof HeldForSignIn) {
                outcome = 'sign-in';
            } else {
                if (!(error instanceof NetworkError) && !(error instanceof AbortedError)) {
                    onError(error);
                }
                outcome = 'failed';
            }
        }
        inflight.delete(row.id);
        await serialize(async () => {
            if (closed || rows.get(row.id) !== row) {
                return;
            }
            if (outcome === 'sign-in') {
                holdForSignIn();
            } else if (outcome === 'failed' || outcome.action === 'later') {
                backOff(row, row.attempts + 1);
                await db.run('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?', [row.id]);
                publish({ ...row, attempts: row.attempts + 1 });
            } else if (outcome.action === 'sent') {
                await finish(row, outcome);
            } else if (outcome.action === 'not-sent') {
                await setState(row, 'queued', null);
                if (answered.delete(row.id)) {
                    // A server error made it unknown: not at once, or one that repeats would loop.
                    backOff(row, row.attempts);
                }
            } else {
                unconfirmed.set(row.id, outcome.candidates ?? []);
                await setState(row, 'unknown', 'unconfirmed');
            }
        });
    }

    const holdForSignIn = () => {
        if (!heldForSignIn) {
            heldForSignIn = true;
            tellStatus();
        }
    };

    const backOff = (row: OutboxRow, attempts: number, delayMs?: number) => {
        const lane = laneOf(row.lane);
        schedule(lane, delayMs ?? outboxRetryDelayMs(attempts, random), delayMs === undefined);
    };

    const setState = async (row: OutboxRow, next: OutboxState, lastError: string | null) => {
        await db.run('UPDATE outbox SET state = ?, lastError = ? WHERE id = ?', [next, lastError, row.id]);
        publish({ ...(rows.get(row.id) ?? row), state: next, lastError });
    };

    /** The `sent` rows, other than `except`, whose own id or server id (`ids`) is in `wanted`. */
    const sentRowsFor = (wanted: ReadonlySet<string>, except: string) =>
        [...rows.values()].filter((other) => {
            if (other.id === except || other.state !== 'sent') {
                return false;
            }
            const creates = kinds.get(other.kind)?.creates;
            const serverId = creates !== undefined ? resolve(creates, other.id) : null;
            return wanted.has(other.id) || (serverId !== null && wanted.has(serverId));
        });

    /** The server has the row: the hand-off to cache.db, then, in one transaction, its `ids` entry and its removal (or `sent`). */
    const finish = async (row: OutboxRow, how: Settled = {}) => {
        if (how.handOff) {
            try {
                await how.handOff();
            } catch (error) {
                // The server has it; the next pull brings it to cache.db.
                onError(error);
            }
        }
        const creates = kinds.get(row.kind)?.creates;
        const entry =
            creates !== undefined && how.serverId !== undefined ? { kind: creates, serverId: how.serverId } : null;
        const forget = how.forgetSent?.length ? sentRowsFor(new Set(how.forgetSent), row.id) : [];
        const amended: OutboxRow[] = [];
        if (how.amend) {
            for (const other of rows.values()) {
                if (other.id === row.id || other.lane !== row.lane || !editable(other)) {
                    continue;
                }
                try {
                    const change = how.amend(other);
                    if (change !== null) {
                        amended.push({ ...other, ...change, revision: (revisions.get(other.id) ?? 0) + 1 });
                    }
                } catch (error) {
                    // That row keeps its payload: its kind reads the server again as it goes.
                    onError(error);
                }
            }
        }
        await db.transaction(async (tx) => {
            for (const other of amended) {
                await tx.run('UPDATE outbox SET payload = ?, payloadVersion = ?, revision = ? WHERE id = ?', [
                    other.payload,
                    other.payloadVersion,
                    other.revision,
                    other.id,
                ]);
            }
            for (const other of forget) {
                await tx.run("DELETE FROM outbox WHERE id = ? AND state = 'sent'", [other.id]);
            }
            if (how.awaitStored) {
                await tx.run("UPDATE outbox SET state = 'sent', lastError = NULL WHERE id = ?", [row.id]);
            } else {
                await tx.run('DELETE FROM outbox WHERE id = ?', [row.id]);
            }
            if (entry !== null) {
                await tx.run('INSERT OR REPLACE INTO ids (kind, localId, serverId) VALUES (?, ?, ?)', [
                    entry.kind,
                    row.id,
                    entry.serverId,
                ]);
            }
            await how.after?.(tx);
        });
        if (entry !== null) {
            ids.set(idKey(entry.kind, row.id), entry.serverId);
        }
        unconfirmed.delete(row.id);
        answered.delete(row.id);
        rewrites.delete(row.id);
        approved.delete(row.id);
        ambiguous.delete(row.id);
        for (const other of forget) {
            unpublish(other.id);
            bump(other.id);
        }
        for (const other of amended) {
            revisions.set(other.id, other.revision);
            publish(other);
        }
        if (how.awaitStored) {
            publish({ ...(rows.get(row.id) ?? row), state: 'sent', lastError: null });
            return;
        }
        unpublish(row.id);
        bump(row.id);
    };

    /** A refusal: the row moves to `unsent` in one transaction, and holds its lane and dependents. */
    const toUnsent = async (row: OutboxRow, as: UnsentAs) => {
        const { reason } = as;
        const write: UnsentWrite = {
            id: row.id,
            kind: row.kind,
            lane: as.lane ?? row.lane,
            dependsOn: row.dependsOn,
            payload: as.payload ?? row.payload,
            payloadVersion: row.payloadVersion,
            reason,
            createdAt: row.createdAt,
        };
        await db.transaction(async (tx) => {
            await tx.run('DELETE FROM outbox WHERE id = ?', [row.id]);
            await tx.run(
                'INSERT OR REPLACE INTO unsent (id, kind, payload, payloadVersion, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
                [write.id, write.kind, encodeUnsent(write), write.payloadVersion, write.reason, write.createdAt],
            );
        });
        unsentWrites.set(row.id, write);
        unconfirmed.delete(row.id);
        approved.delete(row.id);
        answered.delete(row.id);
        ambiguous.delete(row.id);
        rewrites.delete(row.id);
        bump(row.id);
        unpublish(row.id);
        tellUnsent();
    };

    /**
     * Merged, relocated or re-uploaded: the row's new payload and fresh key,
     * queued to go again. The first goes at once, the next after the back-off;
     * past the cap the row goes to `unsent`, so a rewrite that keeps meeting
     * the same answer can't loop.
     */
    const rewrite = async (row: OutboxRow, outcome: Extract<SendOutcome, { action: 'rewrite' }>) => {
        const count = (rewrites.get(row.id) ?? 0) + 1;
        if (count > OUTBOX_REWRITE_MAX) {
            await toUnsent(row, outcome.exhausted ?? { reason: 'rewrite-limit' });
            return;
        }
        rewrites.set(row.id, count);
        const reason = outcome.reason ?? null;
        const revision = bump(row.id);
        await db.run(
            "UPDATE outbox SET payload = ?, payloadVersion = ?, idempotencyKey = ?, state = 'queued', lastError = ?, revision = ? WHERE id = ?",
            [outcome.payload, outcome.payloadVersion, outcome.idempotencyKey, reason, revision, row.id],
        );
        publish({
            ...(rows.get(row.id) ?? row),
            payload: outcome.payload,
            payloadVersion: outcome.payloadVersion,
            idempotencyKey: outcome.idempotencyKey,
            state: 'queued',
            lastError: reason,
            revision,
        });
        if (count > 1) {
            backOff(row, row.attempts);
        }
    };

    /** Applies a send's outcome, in the queue. A closed outbox writes nothing more. */
    async function settle(row: OutboxRow, outcome: SendOutcome | 'sign-in', thrown: boolean): Promise<void> {
        const wasInterrupted = interrupted.delete(row.id);
        if (closed || rows.get(row.id) === undefined) {
            return;
        }
        if (outcome !== 'sign-in' && outcome.action === 'done') {
            // The server has it: that settles the row even after it was marked unknown.
            await finish(row, outcome);
            return;
        }
        if (outcome !== 'sign-in' && outcome.action === 'unsent') {
            // A refusal is an answer too: nothing happened on the server.
            await toUnsent(row, outcome);
            return;
        }
        if (wasInterrupted) {
            // Marked unknown when its request was stopped; its check settles it.
            return;
        }
        if (outcome === 'sign-in') {
            // A 401 changed nothing on the server: the row goes again once the person is back.
            await setState(row, 'queued', 'sign-in');
            holdForSignIn();
            return;
        }
        switch (outcome.action) {
            case 'retry':
                await setState(row, 'queued', outcome.reason ?? null);
                backOff(row, row.attempts, outcome.delayMs);
                return;
            case 'hold':
                await setState(row, 'held', outcome.reason);
                return;
            case 'unknown':
                await setState(row, 'unknown', outcome.reason ?? null);
                if (!thrown) {
                    // An answer: a server error. The next try waits, or one that repeats would loop.
                    if (kinds.get(row.kind)?.repeatable) {
                        backOff(row, row.attempts);
                    } else {
                        answered.add(row.id);
                    }
                }
                return;
            case 'rewrite':
                await rewrite(row, outcome);
                return;
        }
    }

    // ---- What the server refused ------------------------------------------

    const editUnsent: Outbox['editUnsent'] = (id, change, expectedRevision) =>
        serialize(async () => {
            requireWritable();
            const current = unsentWrites.get(id);
            if (
                current === undefined ||
                opaque.has(id) ||
                (expectedRevision !== undefined && (revisions.get(id) ?? 0) !== expectedRevision)
            ) {
                return false;
            }
            const next: UnsentWrite = {
                ...current,
                lane: change.lane ?? current.lane,
                payload: change.payload,
                payloadVersion: change.payloadVersion,
            };
            await db.run('UPDATE unsent SET payload = ?, payloadVersion = ? WHERE id = ?', [
                encodeUnsent(next),
                next.payloadVersion,
                id,
            ]);
            bump(id);
            unsentWrites.set(id, next);
            tellUnsent();
            return true;
        });

    const retryUnsent: Outbox['retryUnsent'] = (id, idempotencyKey) =>
        serialize(async () => {
            requireWritable();
            const current = unsentWrites.get(id);
            if (current === undefined || opaque.has(id) || rows.has(id)) {
                return false;
            }
            const row: OutboxRow = {
                id,
                lane: current.lane,
                kind: current.kind,
                payload: current.payload,
                payloadVersion: current.payloadVersion,
                dependsOn: current.dependsOn,
                idempotencyKey,
                state: 'queued',
                attempts: 0,
                revision: (revisions.get(id) ?? 0) + 1,
                // Its place in its lane, ahead of what it held.
                createdAt: current.createdAt,
                lastError: null,
            };
            await db.transaction(async (tx) => {
                await tx.run('DELETE FROM unsent WHERE id = ?', [id]);
                await tx.run(`INSERT INTO outbox (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    row.id,
                    row.lane,
                    row.kind,
                    row.payload,
                    row.payloadVersion,
                    row.dependsOn,
                    row.idempotencyKey,
                    row.state,
                    row.attempts,
                    row.revision,
                    row.createdAt,
                    row.lastError,
                ]);
            });
            revisions.set(id, row.revision);
            unsentWrites.delete(id);
            publish(row);
            tellUnsent();
            poke();
            return true;
        });

    const discardUnsent: Outbox['discardUnsent'] = (id, expectedRevision) =>
        serialize(async () => {
            requireWritable();
            const current = unsentWrites.get(id);
            if (
                current === undefined ||
                (expectedRevision !== undefined && (revisions.get(id) ?? 0) !== expectedRevision)
            ) {
                return null;
            }
            await db.run('DELETE FROM unsent WHERE id = ?', [id]);
            unsentWrites.delete(id);
            opaque.delete(id);
            bump(id);
            tellUnsent();
            poke();
            return current;
        });

    const refuseLanes: Outbox['refuseLanes'] = (laneNames, reason) =>
        serialize(async () => {
            if (closed || !writable) {
                return [];
            }
            const wanted = new Set(laneNames);
            // A request in flight settles by its own answer (the kind finds the target gone too).
            const moving = [...rows.values()]
                .filter((row) => wanted.has(row.lane) && row.state !== 'inflight' && !inflight.has(row.id))
                .sort(byAge);
            if (moving.length === 0) {
                return [];
            }
            const refused = moving.filter((row) => row.state !== 'sent');
            const writes = refused.map((row): UnsentWrite => ({
                id: row.id,
                kind: row.kind,
                lane: row.lane,
                dependsOn: row.dependsOn,
                payload: row.payload,
                payloadVersion: row.payloadVersion,
                reason,
                createdAt: row.createdAt,
            }));
            await db.transaction(async (tx) => {
                for (const row of moving) {
                    await tx.run('DELETE FROM outbox WHERE id = ?', [row.id]);
                }
                for (const write of writes) {
                    await tx.run(
                        'INSERT OR REPLACE INTO unsent (id, kind, payload, payloadVersion, reason, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
                        [
                            write.id,
                            write.kind,
                            encodeUnsent(write),
                            write.payloadVersion,
                            write.reason,
                            write.createdAt,
                        ],
                    );
                }
            });
            for (const write of writes) {
                unsentWrites.set(write.id, write);
            }
            for (const row of moving) {
                unconfirmed.delete(row.id);
                approved.delete(row.id);
                answered.delete(row.id);
                ambiguous.delete(row.id);
                rewrites.delete(row.id);
                bump(row.id);
                unpublish(row.id);
            }
            if (writes.length > 0) {
                tellUnsent();
            }
            return writes.map((write) => write.id);
        });

    const holds = (): HoldGroup[] => {
        const roots: HoldGroup['root'][] = [];
        const order = new Map<string, { createdAt: number; id: string }>();
        for (const write of unsentWrites.values()) {
            if (!opaque.has(write.id)) {
                roots.push({ id: write.id, kind: write.kind, lane: write.lane, cause: 'unsent', reason: write.reason });
                order.set(write.id, write);
            }
        }
        for (const row of rows.values()) {
            if (row.state === 'held' || (row.state === 'unknown' && unconfirmed.has(row.id))) {
                roots.push({
                    id: row.id,
                    kind: row.kind,
                    lane: row.lane,
                    cause: row.state === 'held' ? 'held' : 'unconfirmed',
                    reason: row.lastError,
                    ...(row.state === 'held' ? {} : { candidates: unconfirmed.get(row.id) ?? [] }),
                });
                order.set(row.id, row);
            }
        }
        roots.sort((a, b) => byAge(order.get(a.id)!, order.get(b.id)!));
        const shown = new Set<string>(roots.map((root) => root.id));
        const groups: HoldGroup[] = [];
        for (const root of roots) {
            // The rest of each held write's lane, and every row that waits on one of them, to a fixpoint.
            const held = new Map<string, { lane: string; createdAt: number; id: string }>([
                [root.id, { lane: root.lane, ...order.get(root.id)! }],
            ]);
            let grew = true;
            while (grew) {
                grew = false;
                for (const row of rows.values()) {
                    if (held.has(row.id) || row.state === 'sent') {
                        continue;
                    }
                    const behind = [...held.values()].some((at) => at.lane === row.lane && byAge(at, row) < 0);
                    if (behind || (row.dependsOn !== null && held.has(row.dependsOn))) {
                        held.set(row.id, row);
                        grew = true;
                    }
                }
            }
            const members = [...held.keys()]
                .filter((id) => id !== root.id && !shown.has(id))
                .map((id) => rows.get(id)!)
                .sort(byAge);
            for (const row of members) {
                shown.add(row.id);
            }
            groups.push({ root, rows: members });
        }
        return groups;
    };

    const caughtUp: Outbox['caughtUp'] = (lane, stored) =>
        serialize(async () => {
            if (closed || !writable) {
                return [];
            }
            const done = [...rows.values()].filter((row) => {
                if (row.lane !== lane || row.state !== 'sent') {
                    return false;
                }
                const creates = kinds.get(row.kind)?.creates;
                const id = (creates !== undefined ? resolve(creates, row.id) : null) ?? row.id;
                return threadHasCaughtUpTo(stored, id);
            });
            if (done.length === 0) {
                return [];
            }
            await db.transaction(async (tx) => {
                for (const row of done) {
                    await tx.run("DELETE FROM outbox WHERE id = ? AND state = 'sent'", [row.id]);
                }
            });
            for (const row of done) {
                unpublish(row.id);
                bump(row.id);
            }
            return done.map((row) => row.id);
        });

    /** Marks every row in flight `unknown`, in the queue, then stops their requests. */
    const stopInflight = () =>
        serialize(async () => {
            const ids = [...rows.values()].filter((row) => row.state === 'inflight').map((row) => row.id);
            if (ids.length > 0) {
                try {
                    await db.run("UPDATE outbox SET state = 'unknown' WHERE state = 'inflight'");
                } catch (error) {
                    // The next open marks them, as after a kill.
                    onError(error);
                }
                for (const id of ids) {
                    interrupted.add(id);
                    const row = rows.get(id);
                    if (row !== undefined) {
                        publish({ ...row, state: 'unknown' });
                    }
                }
            }
            for (const controller of inflight.values()) {
                controller.abort(new AbortedError('', 'outbox stopped'));
            }
        });

    const idle = async () => {
        for (;;) {
            const settled = queue;
            await settled;
            await Promise.allSettled([...running]);
            // A poke waits a microtask before it drains.
            await new Promise<void>((resolve) => {
                queueMicrotask(resolve);
            });
            if (running.size === 0 && !pokeScheduled && queue === settled) {
                return;
            }
        }
    };

    return {
        rows: () => [...rows.values()].sort(byAge),
        status: () => lastStatus,
        subscribe(listener) {
            rowListeners.add(listener);
            return () => {
                rowListeners.delete(listener);
            };
        },
        onStatus(listener) {
            statusListeners.add(listener);
            return () => {
                statusListeners.delete(listener);
            };
        },
        enqueue,
        enqueueAll,
        revisionOf: (id) => revisions.get(id) ?? 0,
        unsent: unsentList,
        onUnsent(listener) {
            unsentListeners.add(listener);
            return () => {
                unsentListeners.delete(listener);
            };
        },
        editUnsent,
        retryUnsent,
        discardUnsent,
        refuseLanes,
        holds,
        resolve,
        caughtUp,
        update,
        remove,
        sendNow,
        confirmQueued,
        start() {
            if (closed) {
                throw new OutboxError('The outbox is closed.');
            }
            started = true;
            poke();
        },
        poke() {
            poke();
        },
        wake() {
            for (const lane of lanes.values()) {
                if (lane.timer !== null && lane.backOff) {
                    clearTimeout(lane.timer);
                    lane.timer = null;
                }
            }
            poke();
        },
        resume() {
            if (heldForSignIn) {
                heldForSignIn = false;
                tellStatus();
            }
            poke();
        },
        interrupt(options) {
            // Before the queue: a send begun but not yet in flight sees it and stays queued.
            if (options?.pause === true) {
                paused = true;
            }
            return stopInflight();
        },
        unpause() {
            if (paused) {
                paused = false;
                poke();
            }
        },
        idle,
        dispose() {
            disposing ??= (async () => {
                closed = true;
                for (const lane of lanes.values()) {
                    if (lane.timer !== null) {
                        clearTimeout(lane.timer);
                        lane.timer = null;
                    }
                }
                try {
                    await stopInflight();
                    await Promise.allSettled([...running]);
                    await queue;
                } catch (error) {
                    onError(error);
                }
                rowListeners.clear();
                statusListeners.clear();
                unsentListeners.clear();
            })();
            return disposing;
        },
    };
}
