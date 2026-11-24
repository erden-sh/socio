import type { InAppNotice } from '@socio/shared/notifications';

import type { NewOutboxWrite, Outbox, OutboxKind } from './outbox';
import { classify, outcomeOf, readAnswer } from './outbox-answers';
import { NOTICES, NOTICES_KEPT } from './shell';
import type { SnapshotCache } from './snapshot-cache';
import type { ViewState } from './view-state';

// In-app notices (CB-114): while the person counts as in use
// (presence.ts), the server keeps a socio's notification for them instead
// of pushing it, and `/api/state` lists it (`notices`) until it is seen. The
// web shows each as a toast (packages/client/src/shell/in-app-notices.ts);
// the app shows each once as a banner over every screen:
// - **Once, across a restart:** the ids shown are kept in cache.db's `kv`
//   (`NOTICES_SHOWN_KEY`, the newest NOTICES_KEPT). A scope that finds no such
//   key (the first open with this build, or after Clear cache) counts every
//   notice it already holds as shown: the device keeps notices for the Inbox
//   long after the server's 24 h, and none of those is news. The key is
//   written only as a notice shows: until then each open seeds the same way,
//   since only a started scope pulls new notices, and it shows them at once.
// - **One at a time,** oldest first, only once the scope has started (never
//   on a locked copy). A notice is marked shown, and seen on the server, as
//   it becomes the one showing, so one a kill left unshown shows next time.
// - **Seen** is `POST /api/notifications/in-app/seen {ids}` through the
//   `notice-seen` outbox kind: one lane, a queued row takes later ids (at most
//   NOTICE_SEEN_MAX per request, the server's limit), safe to repeat, and a
//   row whose newest notice is older than the server keeps notices
//   (NOTICE_STALE_MS) is dropped unsent. A refusal is dropped too: a mark is
//   never the person's to retry, so it never reaches the Unsent list.
// No React Native: tests/sync runs it under Node.

export const NOTICE_SEEN_KIND = 'notice-seen';
export const NOTICE_SEEN_LANE = 'notice-seen';
const NOTICE_SEEN_VERSION = 1;
const NOTICE_SEEN_PATH = '/api/notifications/in-app/seen';
/** The ids one request may carry (the server's `max(20)`). */
export const NOTICE_SEEN_MAX = 20;
/** The server lists a notice for a day: a mark older than that has nothing left to do. */
export const NOTICE_STALE_MS = 24 * 60 * 60_000;
/** cache.db's `kv` key: the ids of the notices shown, as a JSON array. */
export const NOTICES_SHOWN_KEY = 'notices.shown';

export interface NoticeSeenPayload {
    readonly ids: readonly string[];
    /** The newest of their `createdAt`s (the server's clock): past NOTICE_STALE_MS the row is dropped. */
    readonly newest: number;
}

function decodeSeen(text: string): NoticeSeenPayload {
    const value = JSON.parse(text) as Partial<NoticeSeenPayload> | null;
    if (
        !value ||
        !Array.isArray(value.ids) ||
        !value.ids.every((id) => typeof id === 'string') ||
        typeof value.newest !== 'number'
    ) {
        throw new TypeError('Not a notice-seen payload.');
    }
    return { ids: value.ids, newest: value.newest };
}

/** The `notice-seen` kind. `now` is the device clock, against notices' `createdAt`. */
export function noticeSeenKind({ now = Date.now }: { now?: () => number } = {}): OutboxKind<NoticeSeenPayload> {
    return {
        kind: NOTICE_SEEN_KIND,
        payloadVersion: NOTICE_SEEN_VERSION,
        repeatable: true,
        decode: decodeSeen,
        async send(write, context) {
            const { ids, newest } = write.payload;
            if (ids.length === 0 || now() - newest > NOTICE_STALE_MS) {
                return { action: 'done' };
            }
            const response = await context.fetch(NOTICE_SEEN_PATH, {
                method: 'POST',
                json: { ids: ids.slice(0, NOTICE_SEEN_MAX) },
                signal: context.signal,
            });
            const answer = await readAnswer(response, context.signal);
            const action = classify(answer, { method: 'POST', ambiguous: write.ambiguous === true });
            // A refusal (a 400, a 403) is dropped: nothing for the person to do about a mark.
            return action.action === 'unsent' ? { action: 'done' } : outcomeOf(action, write);
        },
    };
}

/**
 * Marks `notices` seen: into the lane's queued row while it has room, else a
 * new row. Resolves once stored.
 */
export async function markNoticesSeen(
    outbox: Pick<Outbox, 'rows' | 'enqueue' | 'update' | 'revisionOf'>,
    notices: readonly Pick<InAppNotice, 'id' | 'createdAt'>[],
    newId: () => string,
): Promise<void> {
    if (notices.length === 0) {
        return;
    }
    const newest = Math.max(...notices.map((notice) => notice.createdAt));
    const queued = outbox
        .rows()
        .filter((row) => row.lane === NOTICE_SEEN_LANE && row.kind === NOTICE_SEEN_KIND)
        .at(-1);
    if (queued !== undefined && queued.state === 'queued') {
        try {
            const payload = decodeSeen(queued.payload);
            const ids = [...new Set([...payload.ids, ...notices.map((notice) => notice.id)])];
            if (ids.length <= NOTICE_SEEN_MAX) {
                const next: NoticeSeenPayload = { ids, newest: Math.max(payload.newest, newest) };
                const folded = await outbox.update(
                    queued.id,
                    { payload: JSON.stringify(next), payloadVersion: NOTICE_SEEN_VERSION },
                    outbox.revisionOf(queued.id),
                );
                if (folded) {
                    return;
                }
            }
        } catch {
            // A row this build can't read: a new one goes beside it.
        }
    }
    const row: NewOutboxWrite = {
        id: newId(),
        lane: NOTICE_SEEN_LANE,
        kind: NOTICE_SEEN_KIND,
        payload: JSON.stringify({ ids: notices.map((notice) => notice.id), newest } satisfies NoticeSeenPayload),
        payloadVersion: NOTICE_SEEN_VERSION,
        idempotencyKey: newId(),
    };
    await outbox.enqueue(row);
}

export interface NoticeFeed {
    /** The notice to show now, or null: the same object until it changes. */
    current(): InAppNotice | null;
    /** Calls `listener` after each change of `current()`. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void;
    /** The person closed notice `id` (or it timed out): the next one shows. */
    dismiss(id: string): void;
    /** Starts showing (the scope's `start`): never on a locked copy. */
    start(): void;
    /** Stops for good: no listener, nothing more shown or marked. */
    close(): void;
}

export interface NoticeFeedOptions {
    readonly cache: Pick<SnapshotCache, 'rows' | 'subscribe'>;
    readonly viewState: ViewState;
    readonly outbox: Pick<Outbox, 'rows' | 'enqueue' | 'update' | 'revisionOf'>;
    readonly newId: () => string;
    readonly onError?: (error: unknown) => void;
}

function readNotice(json: string): InAppNotice | null {
    try {
        const value = JSON.parse(json) as Partial<InAppNotice> | null;
        return value &&
            typeof value.id === 'string' &&
            typeof value.title === 'string' &&
            typeof value.body === 'string' &&
            typeof value.link === 'string' &&
            typeof value.createdAt === 'number'
            ? (value as InAppNotice)
            : null;
    } catch {
        return null;
    }
}

function readShown(text: string | null): string[] | null {
    if (text === null) {
        return null;
    }
    try {
        const ids: unknown = JSON.parse(text);
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
}

export function createNoticeFeed({
    cache,
    viewState,
    outbox,
    newId,
    onError = () => {},
}: NoticeFeedOptions): NoticeFeed {
    const held = () => [...cache.rows(NOTICES).values()].flatMap((row) => readNotice(row.json) ?? []);
    const kept = readShown(viewState.get(NOTICES_SHOWN_KEY));
    const shown = new Set(kept ?? held().map((notice) => notice.id));
    const keep = () => viewState.set(NOTICES_SHOWN_KEY, JSON.stringify([...shown].slice(-NOTICES_KEPT)));
    const listeners = new Set<() => void>();
    let showing: InAppNotice | null = null;
    let started = false;
    let closed = false;
    let unsubscribe = () => {};

    const next = () => {
        if (!started || closed || showing !== null) {
            return;
        }
        const fresh = held()
            .filter((notice) => !shown.has(notice.id))
            .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (fresh === undefined) {
            return;
        }
        showing = fresh;
        shown.add(fresh.id);
        keep();
        markNoticesSeen(outbox, [fresh], newId).catch(onError);
        for (const listener of [...listeners]) {
            listener();
        }
    };

    return {
        current: () => showing,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dismiss(id) {
            if (showing?.id !== id) {
                return;
            }
            showing = null;
            for (const listener of [...listeners]) {
                listener();
            }
            next();
        },
        start() {
            if (started || closed) {
                return;
            }
            started = true;
            unsubscribe = cache.subscribe((change) => {
                if (change.upserts.some((row) => row.collection === NOTICES)) {
                    next();
                }
            });
            next();
        },
        close() {
            closed = true;
            unsubscribe();
            listeners.clear();
        },
    };
}
