import { type SqlConnection, type SqlStatements, UPDATE_TO_SEND, type UserDbState } from '../data';

import type { NewOutboxWrite, Outbox, OutboxRow, SettleStatements } from './outbox';

// Unsent composer text, on
// user.db's `drafts`, by the web's rules (packages/client/src/modules/chat/
// chat-drafts.ts, CB-153 and CB-154):
//
// - One draft per scope: a chat's (`chat:<id>`), a socio's new chat
//   (`new:<dotId>`) and an edited page review
//   (`review:<threadId>:<toolCallId>`, its JSON as the text), a page editor's
//   (`page:<pageId>`, page-drafts.ts), and the issues'
//   FileIssue box (`issue:new`) and an issue's comment box
//   (`issue-comments:<key>`; issue-create.ts names both). A draft is only
//   ever put back in its box, never sent on its own. Empty text deletes it.
// - At most `DRAFTS_KEPT`; past it, the oldest go. user.db is one person's in
//   one workspace, so the web's per-person keys aren't needed here. A page
//   review's and a page editor's drafts (`review:`, `page:`) are exempt
//   (`unboundedDraft`): neither counts nor is dropped.
// - **Sending clears the draft and inserts the outbox row in one user.db
//   transaction** (`enqueueFromDraft`): the text is in the box or
//   in the outbox, never both and never neither. The box clears after the
//   commit; a write that fails leaves it as it was. The web's `sending` restore
//   isn't used for outbox writes: the outbox keeps the message until the server
//   has it, and the composer draws it ("Not sent", Retry, Edit).
// - `sending` (up to `SENDS_KEPT`, past it the oldest's text goes back in the
//   box) is kept for a send that doesn't go through the outbox, as the web
//   keeps it, and for the column's format; the app has none yet.
// - Reads come from memory, loaded before the first frame; each change is
//   shown at once, then written through one queue, so a later change never
//   lands before an earlier one, and a send's transaction comes after every
//   change typed before it.
// - **`payloadVersion`.** A draft of a newer version is shown and kept as it
//   is: never changed, sent or dropped by the bound ("Update Socio to send
//   these"). A `sending` entry this build can't read is dropped, as the web
//   drops it. On a read-only user.db, changes stay in memory only.
// - **`close()`** refuses new changes at once, but a send already in the queue
//   still commits, and what is dirty is written once more before it resolves.
//
// No React Native: tests/sync runs it under Node.

/** At most this many drafts; the oldest go first. */
export const DRAFTS_KEPT = 50;
/** At most this many sends a draft remembers; an older one's text goes back in the box. */
export const SENDS_KEPT = 5;
/** The format this build writes and reads. */
export const DRAFT_PAYLOAD_VERSION = 1;

/** A conversation's draft scope. */
export const chatDraft = (threadId: string) => `chat:${threadId}`;
/** A socio's new-chat draft scope. */
export const newChatDraft = (dotId: string) => `new:${dotId}`;
/** Memories' Add box: its text, sent as memory-writes.ts's `memory-add` through `enqueueFromDraft`. */
export const NEW_MEMORY_DRAFT = 'memory:new';
/** A goal's comment box on Schedules: sent as schedule-writes.ts's `goal-comment` through `enqueueFromDraft`. */
export const goalDraft = (goalId: string) => `goal:${goalId}`;
/** An edited page review's draft scope: its text is the edit's JSON. */
export const reviewDraft = (threadId: string, toolCallId: string) => `review:${threadId}:${toolCallId}`;

/**
 * Whether `scope` is exempt from `DRAFTS_KEPT`: an
 * edited page review and a page editor's draft (`page:<pageId>`, page-drafts.ts)
 * are work the bound must never drop.
 */
export const unboundedDraft = (scope: string) => scope.startsWith('review:') || scope.startsWith('page:');

/** A message sent from a draft: its id and the text that went. */
export interface Sent {
    readonly id: string;
    readonly text: string;
}

export interface DraftRecord {
    /** What the box holds. */
    readonly text: string;
    /** When it last changed (the device clock): the bound drops the oldest. */
    readonly at: number;
    /** Messages sent from it, oldest first, not yet known to have arrived. */
    readonly sending?: readonly Sent[];
    /** A newer build's, or unreadable: shown, never changed (`UPDATE_TO_SEND`). */
    readonly locked?: true;
}

const EMPTY: DraftRecord = { text: '', at: 0 };

/** `text` given back to a box holding `box`: after it, never instead. */
export const joinDraft = (box: string, text: string) => (box.trim() ? `${box}\n\n${text}` : text);

/**
 * `record` once message `id` was sent with `text`: the box empties (unless
 * `keep`: a retry, the box holding something else) and the send is
 * remembered. Past `SENDS_KEPT`, the oldest's text goes back in the box.
 */
export function markedSending(record: DraftRecord, id: string, text: string, at: number, keep = false): DraftRecord {
    const sending = [...(record.sending ?? []).filter((sent) => sent.id !== id), { id, text }];
    let box = keep ? record.text : '';
    while (sending.length > SENDS_KEPT) {
        box = joinDraft(box, (sending.shift() as Sent).text);
    }
    return { text: box, at, sending };
}

/** `record` once message `id`'s send is settled: with `restore` (it never arrived) its text joins the box's. */
export function settledSending(record: DraftRecord, id: string, restore: boolean, at: number): DraftRecord {
    const sent = record.sending?.find((item) => item.id === id);
    if (sent === undefined) {
        return record;
    }
    const sending = (record.sending ?? []).filter((item) => item !== sent);
    return {
        text: restore ? joinDraft(record.text, sent.text) : record.text,
        at,
        ...(sending.length ? { sending } : {}),
    };
}

/**
 * What the box holds once `sent` went from it, if it changed meanwhile:
 * typed after it stays, the sent text goes. An edit inside it is the person's,
 * and stays whole.
 */
export function afterSend(box: string, sent: string): string {
    if (box === sent) {
        return '';
    }
    return box.startsWith(sent) ? box.slice(sent.length).trimStart() : box;
}

/** A draft change this build refuses: a newer build's draft, or a closed store. */
export class DraftError extends Error {
    override readonly name = 'DraftError';
}

export interface DraftsOptions {
    /** user.db, open; the scope closes it after `close()`. */
    readonly db: SqlConnection;
    readonly state: UserDbState;
    /** The scope's outbox, on the same user.db: `enqueueFromDraft` inserts through it. */
    readonly outbox: Outbox;
    /** A write that failed, which nothing waits for. */
    readonly onError?: (error: unknown) => void;
    /** The device clock, for `at` (the bound's order only). */
    readonly now?: () => number;
}

/** `enqueueFromDraft`'s extras (attachments' files). */
export interface SendOptions {
    /** More statements for the insert's transaction. */
    readonly also?: SettleStatements;
    /** Send a box of blank text. */
    readonly allowBlank?: boolean;
}

export interface Drafts {
    /** The draft for `scope`, or an empty one. */
    read(scope: string): DraftRecord;
    /** Each scope whose draft changed. Returns the unsubscribe. */
    subscribe(listener: (scope: string) => void): () => void;
    /** Sets the box's text, shown at once and written after; empty text deletes it. Throws a DraftError on a locked draft. */
    write(scope: string, text: string): void;
    /** The box was sent as message `id` outside the outbox (`markedSending`). */
    markSending(scope: string, id: string, text: string, keep?: boolean): void;
    /** Message `id`'s send is settled (`settledSending`). */
    settleSending(scope: string, id: string, restore: boolean): void;
    /**
     * Sends what the box holds: `build` makes the outbox write from its text,
     * and the draft's clearing goes in the insert's transaction. Resolves with
     * the row once it is durable, then the box shows what was typed after
     * the send began (`afterSend`). Null when the box holds only blank text.
     * Rejects (OutboxError, DraftError) with the box as it was. `build` may
     * make several writes (a new chat and its first message): all go in
     * the one transaction, and the result is the last. `also` runs in that
     * transaction too (attachments: the tray's files move to the message), and
     * `allowBlank` sends a box of blank text (a message of files alone).
     */
    enqueueFromDraft(
        scope: string,
        build: (text: string) => NewOutboxWrite | readonly NewOutboxWrite[],
        options?: SendOptions,
    ): Promise<OutboxRow | null>;
    /** The scopes that hold a draft. */
    scopes(): string[];
    /**
     * Moves `from`'s draft to `to` (a new chat's local id to its server id),
     * joined after what `to` holds, both written in one transaction.
     * False when `from` holds nothing, either is locked, or the drafts are closed.
     * While a send from `from` is in the queue the move waits for it (true), so
     * the text being sent never lands in `to`.
     */
    rekey(from: string, to: string): boolean;
    /** Resolves once every change made before it is written. */
    flush(): Promise<void>;
    /** Writes what is pending, then refuses changes. Never rejects. */
    close(): Promise<void>;
}

interface StoredDraft {
    readonly scope: string;
    readonly text: string;
    readonly payloadVersion: number;
    readonly updatedAt: number;
    readonly sending: string | null;
}

/**
 * `sending` as stored. Entries this build can't read are dropped, as the web
 * drops them (packages/client/src/modules/chat/chat-drafts.ts): a malformed
 * `sending` never locks a draft of this build's version.
 */
function parseSending(raw: string | null): Sent[] {
    if (raw === null) {
        return [];
    }
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return [];
    }
    const listed: unknown[] = Array.isArray(value) ? value : value ? [value] : [];
    return listed.flatMap((item) => {
        const entry = item as Partial<Sent> | null;
        return typeof entry?.id === 'string' && typeof entry.text === 'string'
            ? [{ id: entry.id, text: entry.text }]
            : [];
    });
}

function fromStored(row: StoredDraft): DraftRecord {
    // Only a newer build's draft is locked: its `sending` may mean something this build can't tell.
    const locked = row.payloadVersion > DRAFT_PAYLOAD_VERSION;
    const sending = locked ? [] : parseSending(row.sending);
    return {
        text: row.text,
        at: row.updatedAt,
        ...(sending.length ? { sending } : {}),
        ...(locked ? { locked: true as const } : {}),
    };
}

const isEmpty = (record: DraftRecord) => !record.text && !record.sending?.length;

/** Writes `record` for `scope`, or deletes it when it holds nothing. */
async function store(tx: SqlStatements, scope: string, record: DraftRecord | undefined): Promise<void> {
    if (record === undefined || isEmpty(record)) {
        await tx.run('DELETE FROM drafts WHERE scope = ?', [scope]);
        return;
    }
    await tx.run(
        `INSERT INTO drafts (scope, text, payloadVersion, updatedAt, sending) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope) DO UPDATE SET text = excluded.text, payloadVersion = excluded.payloadVersion,
         updatedAt = excluded.updatedAt, sending = excluded.sending`,
        [
            scope,
            record.text,
            DRAFT_PAYLOAD_VERSION,
            record.at,
            record.sending?.length ? JSON.stringify(record.sending) : null,
        ],
    );
}

/** Opens the drafts of the scope's user.db, all read into memory. */
export async function openDrafts(options: DraftsOptions): Promise<Drafts> {
    const { db, state, outbox, onError = () => {}, now = Date.now } = options;
    const persists = state.writable && state.version >= 1;
    const records = new Map<string, DraftRecord>();
    if (state.version >= 1) {
        for (const row of await db.all<StoredDraft>(
            'SELECT scope, text, payloadVersion, updatedAt, sending FROM drafts',
        )) {
            records.set(row.scope, fromStored(row));
        }
    }
    const listeners = new Set<(scope: string) => void>();
    const emit = (scope: string) => {
        for (const listener of [...listeners]) {
            try {
                listener(scope);
            } catch (error) {
                onError(error);
            }
        }
    };
    let closed = false;

    // ---- One queue for every write -----------------------------------------

    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    };
    /** Scopes whose memory differs from disk. One flush writes them all, as memory holds them then. */
    const dirty = new Set<string>();
    let flushing = false;
    /** Writes every dirty scope, as memory holds it now, in one transaction; a failure keeps them dirty. */
    const writeDirty = async () => {
        const scopes = [...dirty];
        dirty.clear();
        if (scopes.length === 0) {
            return;
        }
        try {
            await db.transaction(async (tx) => {
                for (const scope of scopes) {
                    await store(tx, scope, records.get(scope));
                }
            });
        } catch (error) {
            // Still shown: the next change writes them again.
            for (const scope of scopes) {
                dirty.add(scope);
            }
            onError(error);
        }
    };
    const flushDirty = () => {
        if (!persists || flushing) {
            return;
        }
        flushing = true;
        serialize(async () => {
            flushing = false;
            await writeDirty();
        }).catch(onError);
    };

    /** Keeps the newest `DRAFTS_KEPT` of the bounded scopes; a locked draft is never dropped. */
    const bound = () => {
        const bounded = [...records.entries()].filter(([scope]) => !unboundedDraft(scope));
        if (bounded.length <= DRAFTS_KEPT) {
            return;
        }
        const oldest = bounded.filter(([, record]) => !record.locked).sort(([, a], [, b]) => a.at - b.at);
        for (const [scope] of oldest.slice(0, bounded.length - DRAFTS_KEPT)) {
            records.delete(scope);
            dirty.add(scope);
            emit(scope);
        }
    };

    const read = (scope: string) => records.get(scope) ?? EMPTY;
    const requireUnlocked = (scope: string) => {
        if (read(scope).locked) {
            throw new DraftError(UPDATE_TO_SEND);
        }
    };
    /** At a change's synchronous entry only: a send queued before `close()` still commits. */
    const requireOpen = (scope: string) => {
        if (closed) {
            throw new DraftError('The drafts are closed.');
        }
        requireUnlocked(scope);
    };
    /** Shows `next` for `scope` at once, then writes it. */
    const set = (scope: string, next: DraftRecord) => {
        const known = records.has(scope);
        if (isEmpty(next)) {
            records.delete(scope);
        } else {
            records.set(scope, next);
        }
        dirty.add(scope);
        emit(scope);
        if (!known) {
            bound();
        }
        flushDirty();
    };

    /** `enqueueFromDraft`'s turn in the queue. */
    const sendFromDraft = async (
        scope: string,
        build: (text: string) => NewOutboxWrite | readonly NewOutboxWrite[],
        options: SendOptions,
    ): Promise<OutboxRow | null> => {
        requireUnlocked(scope);
        const before = read(scope);
        const text = before.text;
        if (!text.trim() && !options.allowBlank) {
            return null;
        }
        const cleared: DraftRecord = { ...before, text: '', at: now() };
        const built = build(text);
        const statements = async (tx: SqlStatements) => {
            await store(tx, scope, cleared);
            await options.also?.(tx);
        };
        const row = Array.isArray(built)
            ? ((await outbox.enqueueAll(built as readonly NewOutboxWrite[], statements)).at(-1) as OutboxRow)
            : await outbox.enqueue(built as NewOutboxWrite, statements);
        // Committed: the box shows only what was typed since (written by the next flush).
        const current = read(scope);
        const left = afterSend(current.text, text);
        if (left === '' && current === before) {
            // Nothing changed meanwhile: disk holds `cleared` already.
            if (isEmpty(cleared)) {
                records.delete(scope);
            } else {
                records.set(scope, cleared);
            }
            emit(scope);
        } else {
            set(scope, { ...current, text: left, at: now() });
        }
        return row;
    };
    /** `rekey`'s move, at once. */
    const moveDraft = (from: string, to: string): boolean => {
        const moving = records.get(from);
        const target = read(to);
        if (closed || from === to || moving === undefined || moving.locked || target.locked) {
            return false;
        }
        const sending = [...(target.sending ?? []), ...(moving.sending ?? [])];
        const joined: DraftRecord = {
            text: target.text && moving.text ? joinDraft(target.text, moving.text) : target.text || moving.text,
            at: Math.max(target.at, moving.at),
            ...(sending.length ? { sending } : {}),
        };
        // Both dirty before the flush: one transaction writes the move.
        records.delete(from);
        dirty.add(from);
        emit(from);
        set(to, joined);
        return true;
    };
    /** Scopes with a send in the queue (`enqueueFromDraft`), so a `rekey` from them waits for it. */
    const sendsFrom = new Map<string, number>();

    return {
        read,
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        write(scope, text) {
            requireOpen(scope);
            const current = read(scope);
            if (current.text !== text) {
                set(scope, { ...current, text, at: now() });
            }
        },
        markSending(scope, id, text, keep = false) {
            requireOpen(scope);
            set(scope, markedSending(read(scope), id, text, now(), keep));
        },
        settleSending(scope, id, restore) {
            requireOpen(scope);
            const current = read(scope);
            const next = settledSending(current, id, restore, now());
            if (next !== current) {
                set(scope, next);
            }
        },
        enqueueFromDraft(scope, build, options = {}) {
            try {
                requireOpen(scope);
            } catch (error) {
                return Promise.reject(error);
            }
            sendsFrom.set(scope, (sendsFrom.get(scope) ?? 0) + 1);
            const done = () => {
                const left = (sendsFrom.get(scope) ?? 1) - 1;
                if (left > 0) {
                    sendsFrom.set(scope, left);
                } else {
                    sendsFrom.delete(scope);
                }
            };
            return serialize(async () => {
                try {
                    return await sendFromDraft(scope, build, options);
                } finally {
                    done();
                }
            });
        },
        scopes: () => [...records.keys()],
        rekey(from, to) {
            if (sendsFrom.has(from)) {
                // A send from `from` is in the queue: move after it, once its text has left the box.
                if (closed || from === to) {
                    return false;
                }
                serialize(async () => void moveDraft(from, to)).catch(onError);
                return true;
            }
            return moveDraft(from, to);
        },
        flush() {
            return serialize(async () => {});
        },
        async close() {
            if (!closed) {
                closed = true;
                // After every send queued before it, one last write of what is dirty
                // (a failed flush's scopes, or a send's leftover set after it).
                await serialize(async () => {
                    if (persists) {
                        await writeDirty();
                    }
                }).catch(onError);
            }
            await queue;
        },
    };
}
