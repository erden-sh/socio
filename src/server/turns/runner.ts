import { memoryOf } from '@socio/foundation/memory/memory-of';
import type { Result, Memory } from '@socio/shared/types';

import type { TaskClaim, TaskRunnerShape, TaskRunnerStore } from './contract.js';

/**
 * What runs one claimed task: a scheduled turn or job, or research. The
 * composition hands it in (`composition/lifecycle/turns.ts`: scheduled
 * turns and jobs).
 */
export type TaskExecutor = (
    claim: TaskClaim,
    memories: Memory[],
    signal: AbortSignal,
    progress: (text: string) => void,
) => Promise<Result>;

export class Runner implements TaskRunnerShape {
    private timer?: ReturnType<typeof setInterval>;
    private active = new Map<string, AbortController>();
    /** The claims in progress, by task (their interrupts need the lease). */
    private claims = new Map<string, TaskClaim>();
    private claiming = false;
    constructor(
        private store: TaskRunnerStore,
        private execute: TaskExecutor,
        /**
         * How long one task may run: 90 s by default (research); index.ts gives
         * scheduled turns the turn limit plus a margin. A function is read each
         * time a task starts, for a limit an admin can change (CB-123).
         */
        private timeLimitMs: number | (() => number) = 90_000,
        private admitted: () => boolean = () => true,
    ) {
        store.leaseMs = Math.max(store.leaseMs, this.limitMs() + 60_000);
    }
    private limitMs() {
        return typeof this.timeLimitMs === 'function' ? this.timeLimitMs() : this.timeLimitMs;
    }
    start() {
        if (!this.timer) {
            this.timer = setInterval(() => void this.tick(), 1000);
            void this.tick();
        }
    }
    /** Stops claiming tasks; a task in progress finishes (shutdown drain). */
    drain() {
        clearInterval(this.timer);
        this.timer = undefined;
    }
    /** Tasks in progress. */
    get running() {
        return this.active.size;
    }
    stop() {
        clearInterval(this.timer);
        this.timer = undefined;
        this.interruptAll('Server stopped during this run. Review completed effects before retrying.');
    }
    /**
     * Ends the tasks in progress at once as interrupted, with `reason` (an
     * operator's force stop, the shutdown); returns how many there were.
     */
    interruptAll(reason: string) {
        const running = this.active.size;
        for (const claim of this.claims.values())
        // Queued before the aborted runs record their failure (CB-110).
        {
            void this.store
                .interrupt(claim, reason)
                .catch(() => console.error('Background runner could not mark a run interrupted.'));
        }
        for (const controller of this.active.values()) {
            controller.abort(new Error(reason));
        }
        return running;
    }
    abort(id: string) {
        this.active.get(id)?.abort(new Error('Run stopped.'));
    }
    abortAll() {
        for (const controller of this.active.values()) {
            controller.abort(new Error('Run stopped because settings changed.'));
        }
    }
    async tick() {
        try {
            await this.runTick();
        } catch {
            // Store errors must not become unhandled interval promise rejections.
            // Do not log task content, provider responses, or database details.
            console.error('Background runner tick failed; will retry on the next tick.');
        }
    }
    private async runTick() {
        if (this.active.size || this.claiming || !this.admitted()) {
            return;
        }
        const limitMs = this.limitMs();
        this.store.leaseMs = Math.max(this.store.leaseMs, limitMs + 60_000);
        // The claim may wait for the write lock (CB-110): one tick claims.
        this.claiming = true;
        let claim: TaskClaim | null;
        try {
            claim = await this.store.claim(undefined, this.admitted);
        } finally {
            this.claiming = false;
        }
        if (!claim) {
            return;
        }
        const controller = new AbortController();
        this.active.set(claim.id, controller);
        this.claims.set(claim.id, claim);
        const revoked = () => controller.abort(new Error('Run permission or lease was revoked.'));
        const check = async () => {
            try {
                if (!(await this.store.owns(claim))) {
                    revoked();
                }
            } catch {
                controller.abort(new Error('Run ownership check failed.'));
            }
        };
        const ownershipCheck = setInterval(() => void check(), 100);
        const timeout = setTimeout(
            () => controller.abort(new Error(`Research exceeded the ${Math.round(limitMs / 1000)} second time limit.`)),
            limitMs,
        );
        try {
            const settings = this.store.settings();
            const memories =
                settings.memoryAllowed && claim.userId
                    ? (await this.store.memoryItems.active(claim.userId)).map(memoryOf)
                    : [];
            const progress = (text: string) => {
                controller.signal.throwIfAborted();
                void check();
                // A history line nothing reads back at once: queued in order.
                this.store
                    .event(claim.id, claim.lease, text)
                    .catch(() => console.error('Background runner could not record progress.'));
            };
            const result = await this.execute(claim, memories, controller.signal, progress);
            controller.signal.throwIfAborted();
            await this.store.finish(claim, result);
        } catch (error) {
            await this.store.fail(claim, error instanceof Error ? error.message : 'Unexpected research failure.');
        } finally {
            clearInterval(ownershipCheck);
            clearTimeout(timeout);
            this.active.delete(claim.id);
            this.claims.delete(claim.id);
        }
    }
}
