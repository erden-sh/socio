/** Waiting longer than this for the lock is a bug (a deadlock), not load. */
export const ACQUIRE_TIMEOUT_MS = 15_000;

export class MutexTimeoutError extends Error {
    constructor(label: string, holder: string, ms: number) {
        super(`"${label}" waited ${ms} ms for the database write lock, held by "${holder}".`);
        this.name = 'MutexTimeoutError';
    }
}

interface Waiter {
    label: string;
    grant: () => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * The in-process write lock of one connection (CB-110): first come, first
 * served. `acquire` resolves with the release; a wait past the timeout
 * fails with an error naming who holds the lock, so a unit of work awaited
 * from a context that doesn't inherit it shows up as an error, not a hang.
 */
export class Mutex {
    private holder: string | undefined;
    private queue: Waiter[] = [];

    constructor(private timeoutMs = ACQUIRE_TIMEOUT_MS) {}

    /** Who holds the lock, by label, if anyone. */
    get heldBy() {
        return this.holder;
    }

    /** How many wait for it. */
    get waiting() {
        return this.queue.length;
    }

    acquire(label: string): Promise<() => void> {
        if (this.holder === undefined) {
            this.holder = label;
            return Promise.resolve(this.release());
        }
        return new Promise((resolve, reject) => {
            const waiter: Waiter = {
                label,
                grant: () => resolve(this.release()),
                timer: setTimeout(() => {
                    this.queue.splice(this.queue.indexOf(waiter), 1);
                    reject(new MutexTimeoutError(label, this.holder!, this.timeoutMs));
                }, this.timeoutMs),
            };
            waiter.timer.unref?.();
            this.queue.push(waiter);
        });
    }

    /** A release that works once: the lock passes to the next in line. */
    private release() {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            const next = this.queue.shift();
            this.holder = next?.label;
            if (!next) {
                return;
            }
            clearTimeout(next.timer);
            next.grant();
        };
    }
}
