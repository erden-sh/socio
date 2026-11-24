/** External work is best effort; claimed durable notices are never retried by this queue. */
export const APP_DELIVERY_CONCURRENCY = 4;
export const APP_DELIVERY_QUEUE_LIMIT = 32;
export const APP_DELIVERY_DRAIN_MS = 250;
export const APP_DELIVERY_TIMEOUT_MS = 30_000;
type Task = { id: string; run: (signal: AbortSignal) => Promise<void> };
type Active = {
    controller: AbortController;
    promise: Promise<void>;
    timer: ReturnType<typeof setTimeout>;
};

/** Timeouts request cancellation, but never pretend an uncooperative promise has ended. */
export class AppDeliveryTasks {
    private active = new Map<string, Active>();
    private queue: Task[] = [];
    private accepting = true;
    private skipped = 0;
    private failed = 0;
    private capacityReported = false;
    private waiters = new Set<() => void>();
    constructor(
        private log: (message: string) => void,
        private concurrency = APP_DELIVERY_CONCURRENCY,
        private queueLimit = APP_DELIVERY_QUEUE_LIMIT,
    ) {}
    status() {
        return {
            accepting: this.accepting,
            running: this.active.size,
            queued: this.queue.length,
            concurrency: this.concurrency,
            queueLimit: this.queueLimit,
            abortRequested: [...this.active.values()].filter((task) => task.controller.signal.aborted).length,
            skipped: this.skipped,
            failedTasks: this.failed,
        };
    }
    resume() {
        this.accepting = true;
        this.pump();
    }
    enqueue(id: string, run: Task['run']) {
        if (this.active.has(id) || this.queue.some((task) => task.id === id)) {
            return;
        }
        if (!this.accepting || this.queue.length >= this.queueLimit) {
            this.skipped++;
            if (!this.capacityReported) {
                this.capacityReported = true;
                this.log(
                    'App notification external attempt not started: delivery capacity unavailable; in-app notice retained.',
                );
            }
            return;
        }
        this.queue.push({ id, run });
        this.pump();
    }
    private pump() {
        while (this.accepting && this.active.size < this.concurrency && this.queue.length) {
            const task = this.queue.shift()!;
            const controller = new AbortController();
            const timer = setTimeout(() => {
                controller.abort();
                this.log('App notification external attempt exceeded its deadline; outcome may remain unknown.');
            }, APP_DELIVERY_TIMEOUT_MS);
            timer.unref?.();
            const promise = Promise.resolve()
                .then(() => task.run(controller.signal))
                .catch(() => {
                    this.failed++;
                    this.log('App notification external task failed; in-app notice retained.');
                })
                .finally(() => {
                    clearTimeout(timer);
                    this.active.delete(task.id);
                    this.capacityReported = false;
                    this.pump();
                    for (const waiter of [...this.waiters]) {
                        waiter();
                    }
                });
            this.active.set(task.id, { controller, promise, timer });
        }
    }
    async idle(timeoutMs = 5000, signal?: AbortSignal): Promise<boolean> {
        if (!this.active.size && !this.queue.length) {
            return true;
        }
        if (signal?.aborted) {
            return false;
        }
        return new Promise((resolve) => {
            const finish = (value: boolean) => {
                clearTimeout(timer);
                this.waiters.delete(check);
                signal?.removeEventListener('abort', aborted);
                resolve(value);
            };
            const check = () => {
                if (!this.active.size && !this.queue.length) {
                    finish(true);
                }
            };
            const aborted = () => finish(false);
            const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
            this.waiters.add(check);
            signal?.addEventListener('abort', aborted, { once: true });
            check();
        });
    }
    async stop(timeoutMs = APP_DELIVERY_DRAIN_MS, signal?: AbortSignal) {
        this.accepting = false;
        this.skipped += this.queue.length;
        this.queue = [];
        for (const task of this.active.values()) {
            clearTimeout(task.timer);
            task.controller.abort();
        }
        const drained = await this.idle(timeoutMs, signal);
        if (!drained) {
            this.log(
                'App notification shutdown left unresolved external attempts tracked; outcomes remain unknown and in-app notices are retained.',
            );
        }
        return { drained, ...this.status() };
    }
}
