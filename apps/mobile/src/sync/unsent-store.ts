import type { HoldGroup, Outbox, UnsentWrite } from './outbox';

// The Unsent list as one snapshot for React's useSyncExternalStore
// (useUnsent in src/live). One store per outbox, shared by every screen that
// reads it. While nobody listens nothing tells it of changes, so a snapshot
// taken then can be old: each subscription looks once and tells its listener
// when it is.

/** The outbox's refused writes and what each holds back, as one snapshot for React. */
export interface UnsentSnapshot {
    readonly writes: readonly UnsentWrite[];
    readonly groups: readonly HoldGroup[];
}

export interface UnsentStore {
    readonly get: () => UnsentSnapshot;
    readonly subscribe: (listener: () => void) => () => void;
}

/** The same items in the same order (the outbox never mutates a row or a refused write). */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameGroup(a: HoldGroup, b: HoldGroup): boolean {
    return (
        a.root.id === b.root.id &&
        a.root.kind === b.root.kind &&
        a.root.lane === b.root.lane &&
        a.root.cause === b.root.cause &&
        a.root.reason === b.root.reason &&
        sameItems(a.root.candidates ?? [], b.root.candidates ?? []) &&
        sameItems(a.rows, b.rows)
    );
}

function sameSnapshot(a: UnsentSnapshot, b: UnsentSnapshot): boolean {
    return (
        sameItems(a.writes, b.writes) &&
        a.groups.length === b.groups.length &&
        a.groups.every((group, index) => {
            const other = b.groups[index];
            return other !== undefined && sameGroup(group, other);
        })
    );
}

const stores = new WeakMap<object, UnsentStore>();

export function unsentStore(outbox: Pick<Outbox, 'unsent' | 'holds' | 'onUnsent' | 'subscribe'>): UnsentStore {
    const known = stores.get(outbox);
    if (known !== undefined) {
        return known;
    }
    const read = (): UnsentSnapshot => ({ writes: outbox.unsent(), groups: outbox.holds() });
    let snapshot: UnsentSnapshot | null = null;
    const store: UnsentStore = {
        get: () => (snapshot ??= read()),
        // Rows behind a refusal change its count, so row changes count too.
        subscribe: (listener) => {
            const changed = () => {
                snapshot = null;
                listener();
            };
            const offUnsent = outbox.onUnsent(changed);
            const offRows = outbox.subscribe(changed);
            if (snapshot !== null && !sameSnapshot(snapshot, read())) {
                changed();
            }
            return () => {
                offUnsent();
                offRows();
            };
        },
    };
    stores.set(outbox, store);
    return store;
}
