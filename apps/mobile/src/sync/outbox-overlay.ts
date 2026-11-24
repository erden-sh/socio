import type { OutboxKind, OutboxRow, UnsentWrite } from './outbox';

// What the outbox lays over the screens' queries. Each write kind
// says, through its `overlay`, what one of its rows looks like on screen: a
// row it adds (a message's bubble, a new chat) or a change to a row the
// server sent (a rename). Screens merge these over the synced rows; the
// composer draws them.
//
// - A row this build can't decode lays nothing over (it's counted in the
//   outbox's status: "Update Socio to send these").
// - A row sent and waiting for the stored history (`sent`) stays as it was
//   until `caughtUp` removes it, so it never flickers out and back in. An
//   added row the store already holds (`has`) isn't laid over twice: a kill
//   between the hand-off's two writes leaves both for a moment.
// - What the server refused (`unsent`) lays over in place too, as "Not sent".

/** How one write looks on screen: a row added to a collection, or a change to one there. */
export interface Overlay {
    /** The collection it lays over (`history`, `conversations`, ...). */
    readonly collection: string;
    /** The row's key there: a local id until its create resolves. */
    readonly key: string;
    /** `insert` adds a row; `patch` changes the stored one. */
    readonly mode: 'insert' | 'patch';
    readonly value: unknown;
}

/** What a kind's overlay may read: local ids resolved to the server's (the `ids` map). */
export interface OverlayScope {
    resolve(kind: string, localId: string): string | null;
}

/** Where a write stands, for the screen's words. */
export type OverlayState = 'queued' | 'sending' | 'unconfirmed' | 'held' | 'sent' | 'unsent';

export interface OverlayItem extends Overlay {
    /** The outbox row's id (or the unsent write's). */
    readonly id: string;
    readonly state: OverlayState;
    /** The row's last error or the refusal's reason, as a code. */
    readonly reason: string | null;
    readonly createdAt: number;
}

/** What `overlaysOf` needs of a kind: how it reads a row and how that looks, not how it sends. */
export type OverlayKind<Payload = unknown> = Pick<
    OutboxKind<Payload>,
    'kind' | 'payloadVersion' | 'decode' | 'overlay'
>;

export interface OverlayInput {
    readonly rows: readonly OutboxRow[];
    readonly unsent?: readonly UnsentWrite[];
    readonly kinds: readonly OverlayKind<unknown>[];
    readonly scope: OverlayScope;
    /** Whether the store holds `key` in `collection`: an added row it holds isn't laid over again. */
    readonly has?: (collection: string, key: string) => boolean;
}

const stateOf = (row: OutboxRow): OverlayState => {
    switch (row.state) {
        case 'inflight':
            return 'sending';
        case 'unknown':
            return row.lastError === 'unconfirmed' ? 'unconfirmed' : 'sending';
        case 'held':
            return 'held';
        case 'sent':
            return 'sent';
        default:
            return 'queued';
    }
};

/** Decodes a stored payload by its kind, or null when this build can't. */
function decode(
    kind: OverlayKind<unknown> | undefined,
    payload: string,
    payloadVersion: number,
): { ok: true; value: unknown } | null {
    if (kind === undefined || payloadVersion > kind.payloadVersion) {
        return null;
    }
    try {
        return {
            ok: true,
            value: kind.decode ? kind.decode(payload, payloadVersion) : (JSON.parse(payload) as unknown),
        };
    } catch {
        return null;
    }
}

/** Every write's overlay, oldest first: the outbox's rows, then what was refused, each where its kind puts it. */
export function overlaysOf({ rows, unsent = [], kinds, scope, has }: OverlayInput): OverlayItem[] {
    const byKind = new Map(kinds.map((kind) => [kind.kind, kind]));
    const items: OverlayItem[] = [];
    const add = (
        source: { id: string; kind: string; payload: string; payloadVersion: number; createdAt: number },
        row: OutboxRow | null,
        state: OverlayState,
        reason: string | null,
    ) => {
        const kind = byKind.get(source.kind);
        const decoded = decode(kind, source.payload, source.payloadVersion);
        if (decoded === null || kind?.overlay === undefined) {
            return;
        }
        const overlay = kind.overlay({ id: source.id, row, payload: decoded.value }, scope);
        if (overlay === null) {
            return;
        }
        if (overlay.mode === 'insert' && has?.(overlay.collection, overlay.key)) {
            return;
        }
        items.push({ ...overlay, id: source.id, state, reason, createdAt: source.createdAt });
    };
    for (const row of rows) {
        add(row, row, stateOf(row), row.lastError);
    }
    for (const write of unsent) {
        add(write, null, 'unsent', write.reason);
    }
    return items.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether the stored history holds message `id` (T3 Code's `threadHasCaughtUpTo`,
 * packages/client-runtime/src/state/threadState.ts, ported): `stored` is the
 * ids it holds, or a lookup. For a write the server gave its own id (steering),
 * `id` is the one the `ids` map recorded, never the device's.
 */
export function threadHasCaughtUpTo(stored: ReadonlySet<string> | ((id: string) => boolean), id: string): boolean {
    return typeof stored === 'function' ? stored(id) : stored.has(id);
}
