import type { SqlConnection } from '../data';

// A workspace's view state: cache.db's `kv`
// table, small strings by key, such as the last screen (src/shell/last-screen.ts).
// It is read whole as the scope opens, so a screen has it for the first frame,
// and each change is written at once in its own transaction on the cache's one
// connection, in the order made. A write that fails goes to `onError` and
// leaves memory as set: it is view state, not data. It goes with cache.db:
// Clear cache and a wipe take it too.

export interface ViewState {
    /** The value kept for `key`, or null. */
    get(key: string): string | null;
    /** Keeps `value` for `key`. Does nothing once closed, or when the value is the same. */
    set(key: string, value: string): void;
    /** Resolves once every write made so far has been tried. */
    flush(): Promise<void>;
    /** Takes no more writes, and waits for those made. */
    close(): Promise<void>;
}

export async function openViewState(
    db: SqlConnection,
    onError: (error: unknown) => void = () => {},
): Promise<ViewState> {
    const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM kv');
    const values = new Map(rows.map((row) => [row.key, row.value]));
    let writes: Promise<void> = Promise.resolve();
    let closed = false;
    return {
        get: (key) => values.get(key) ?? null,
        set(key, value) {
            if (closed || values.get(key) === value) {
                return;
            }
            values.set(key, value);
            writes = writes.then(() =>
                db
                    .transaction(async (tx) => {
                        await tx.run(
                            'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
                            [key, value],
                        );
                    })
                    .catch(onError),
            );
        },
        flush: () => writes,
        close() {
            closed = true;
            return writes;
        },
    };
}
