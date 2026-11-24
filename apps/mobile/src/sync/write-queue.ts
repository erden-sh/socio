// When the cache's changes reach cache.db:
// once they have settled for 500 ms, at most every 10 s, and at once when the
// app goes to the background or the scope closes. Pulls change the copy in
// memory straight away; the queue writes whatever is pending then, in one
// transaction, so a burst of changes costs one write.
//
// The numbers are T3 Code's (runCachePersistence in
// packages/client-runtime/src/state/cachePersistence.ts, pingdotgg/t3code at
// 240446e2d9); the code is ours. T3 Code writes its
// first change 500 ms after it comes and then at most every 10 s, a change
// after a quiet spell at once. Here every write waits for 500 ms without a
// change, and a change that never settles (one every 100 ms) waits no more
// than 10 s.
//
// The platform says when to flush (`flushTrigger`: AppState going to the
// background, a disconnect), so nothing here imports React Native.

/** How long the copy must go without a change before it is written. */
export const SETTLE_MS = 500;
/** The least time between two writes' starts, and the longest a change waits. */
export const WRITE_INTERVAL_MS = 10_000;

export interface WriteQueueOptions {
    /**
     * Writes everything pending, and rejects when that failed: the changes
     * stay pending and go with the next write. Called with nothing else
     * running, so it may take its batch at once.
     */
    write: () => Promise<void>;
    /**
     * Subscribes to the moments the copy must be written at once (the app
     * going to the background, a disconnect), and returns the unsubscribe.
     */
    flushTrigger?: (flush: () => void) => () => void;
    /** A write the cadence or the trigger started failed. It is tried again 10 s on. */
    onError?: (error: unknown) => void;
}

export interface WriteQueue {
    /** Something changed in memory: a write follows at the cadence. */
    changed(): void;
    /**
     * Writes whatever is pending now, after any write in progress, whatever
     * the cadence. Rejects when that write fails (the changes stay pending).
     */
    flush(): Promise<void>;
    /** Flushes, then stops: no more writes, and the trigger is unsubscribed. */
    close(): Promise<void>;
}

export function createWriteQueue({ write, flushTrigger, onError = () => {} }: WriteQueueOptions): WriteQueue {
    // The timers' own clock, so the waits and the times they're measured from agree.
    const now = () => Date.now();
    let dirty = false;
    let firstChangeAt: number | null = null;
    let lastChangeAt = 0;
    let lastWriteAt = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let writing: Promise<void> | null = null;
    let closed = false;

    const clearTimer = () => {
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const schedule = () => {
        clearTimer();
        if (!dirty || writing !== null || closed) {
            return;
        }
        const settled = Math.min(lastChangeAt + SETTLE_MS, (firstChangeAt ?? lastChangeAt) + WRITE_INTERVAL_MS);
        const due = Math.max(settled, lastWriteAt + WRITE_INTERVAL_MS);
        timer = setTimeout(
            () => {
                timer = null;
                // A write in progress reschedules when it ends.
                if (writing === null) {
                    start().catch(onError);
                }
            },
            Math.max(0, due - now()),
        );
    };

    /** Starts a write of what is pending, with nothing else running: the cadence's timer goes. */
    const start = (): Promise<void> => {
        clearTimer();
        dirty = false;
        firstChangeAt = null;
        lastWriteAt = now();
        let run: Promise<void>;
        try {
            run = write();
        } catch (error) {
            run = Promise.reject(error);
        }
        const done = run
            .then(
                () => {},
                (error: unknown) => {
                    dirty = true;
                    firstChangeAt ??= now();
                    throw error;
                },
            )
            .finally(() => {
                writing = null;
                schedule();
            });
        writing = done;
        return done;
    };

    const flush = async () => {
        clearTimer();
        for (;;) {
            if (writing !== null) {
                // Its failure leaves the changes pending, for the loop to write.
                await writing.catch(() => {});
                continue;
            }
            if (!dirty) {
                return;
            }
            await start();
        }
    };

    const unsubscribe = flushTrigger?.(() => {
        if (!closed) {
            flush().catch(onError);
        }
    });

    return {
        changed() {
            if (closed) {
                throw new Error('The cache write queue is closed.');
            }
            const at = now();
            dirty = true;
            firstChangeAt ??= at;
            lastChangeAt = at;
            schedule();
        },
        flush,
        async close() {
            unsubscribe?.();
            try {
                await flush();
            } finally {
                closed = true;
                clearTimer();
            }
        },
    };
}
