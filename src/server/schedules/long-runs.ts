import { createHash, randomUUID } from 'node:crypto';

import type { DataTokenScope } from '@socio/foundation/http/app-env';
import {
    LONG_RUN_DEAD_SHOWN,
    type JobRunTrigger,
    type JobRunView,
    type LongRunStatus,
    type LongRunView,
} from '@socio/shared/schedule-types';

import { DEACTIVATED_JOB_RUN, type LongRunRow, type LongRunsShape } from './contract.js';
import type { ItemCounts, LongRunPatch, LongRunRepository } from './domain/repositories.js';
import { JobError, type JobService } from './jobs.js';

/**
 * What a batch started from: progress is measured against it. An item
 * done, failed, set aside or declared, or a checkpoint that moved, is
 * progress; a batch that claimed items and handed them all back made
 * none. A batch that crashed or timed out while on an item (it was
 * charged for it) made progress only by getting items done: not by the
 * charge, nor by a checkpoint that changes each batch.
 */
interface BatchMark {
    done: number;
    resolved: number;
    total: number;
    tries: number;
    /** The checkpoint's fingerprint (`fingerprint`). */
    checkpoint: string | null;
}
/** A checkpoint, short: saving the same one again doesn't move it. */
const fingerprint = (checkpoint: string | null) =>
    checkpoint === null ? null : createHash('sha256').update(checkpoint).digest('base64url');

/** How often open long runs are looked at, besides their own wake-ups. */
const TICK_MS = 15_000;
/** The most keys one call declares, and items one claim takes. */
export const ITEMS_PER_CALL = 1000;
export const CLAIM_MAX = 200;
/** A checkpoint is the job's own small state, as JSON. */
export const CHECKPOINT_MAX_BYTES = 16 * 1024;
/** Unreported ends older than this are left alone at start. */
const REPORT_WINDOW_MS = 24 * 3600_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
const duration = (ms: number) => {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) {
        return 'under a minute';
    }
    if (minutes < 120) {
        return plural(minutes, 'minute');
    }
    return `${Math.round(minutes / 6) / 10} hours`;
};
const at = (t: number) => new Date(t).toISOString().slice(0, 16) + ' UTC';
// oxlint-disable-next-line no-control-regex -- one line of text
const CONTROL = /[\u0000-\u001f\u007f]+/g;
const oneLine = (text: string, max = 300) => text.replace(CONTROL, ' ').trim().slice(0, max);

/**
 * The data space's write, as a batch's `done` uses it: an upsert with the
 * run's token, done or waiting for an approval. `DataSpace` has it; the
 * dataspace contract's `DataSpaceShape` doesn't offer it yet. The actor is
 * the token's, typed here so this folder doesn't import `dataspace/`,
 * which sits above it.
 */
export interface LongRunData {
    write(
        actor: {
            kind: 'token';
            userId: string;
            dotId: string;
            datasetIds?: readonly string[];
            reach?: 'socio';
        },
        ref: string | undefined,
        write: { op: 'upsert'; table: string; rows: unknown; key: string[] },
    ): Promise<{ status: string }>;
}

export interface LongRunServiceOptions {
    data: LongRunData;
    workspace: {
        dot(id: string): { name: string; archivedAt?: number | null } | undefined;
        isDeactivated?(userId: string): boolean;
    };
    /** The workspace's pause: no batch starts while it lasts. */
    paused?: () => boolean;
    log?: (line: string) => void;
    /**
     * Resolves once the HTTP server is listening (CB-161). Open long runs
     * resume only after it and a short settle, or a batch's first call to the
     * app is refused. Without it, they resume at once.
     */
    listening?: () => Promise<void> | undefined;
}

/** What a batch writes when the app didn't answer (Bun, curl, Node). */
const APP_DOWN =
    /ConnectionRefused|ECONNREFUSED|ECONNRESET|ConnectionClosed|Unable to connect|Connection refused|Could not connect/i;

/**
 * Jobs that run until done (CB-122). A job saved with `untilDone` isn't
 * one bounded run: starting it opens a long run, which the server (not
 * the Dot's computer) owns and works through in batches, each an ordinary
 * job run within the job's timeout, until the job declares it complete:
 * its whole list of items declared and none left, or an explicit
 * `complete`. One batch succeeding is never the end.
 *
 * Between batches the long run waits: at once after progress, longer
 * after a batch that failed, made no progress or was refused (403, 429),
 * doubling each time; `batchRetries` such batches in a row end it as
 * failed. A batch that crashed or timed out while on an item is such a
 * batch unless it got items done. A batch stopped from outside (a
 * deploy, a restart, the computer stopping, a pause, a force stop) costs
 * nothing: its items go back and the next batch resumes from the
 * checkpoint, after a short wait if it made no progress. A restart finds
 * open long runs in the database and carries on (`resume`). Getting
 * through every item is done only if no more were set aside than done.
 *
 * Batches reach their long run through the checkpoint API (the run's data
 * token, `/api/data/job`): declare items, claim some, mark each done or
 * failed, keep a checkpoint, pause on a refusal, say it is complete.
 */
export class LongRunService implements LongRunsShape {
    private timer?: ReturnType<typeof setTimeout>;
    private wakeAt = Infinity;
    private interval?: ReturnType<typeof setInterval>;
    private stopped = false;
    private ticking?: Promise<void>;
    private again = false;
    private recovered: Promise<void>;
    private pendingRecovery = new Set<string>();
    /** When the app was listening and settled; set once resuming may start. */
    private readyAt?: number;
    private ready?: Promise<void>;
    /** The server was still to listen when the wait began. */
    private waited = false;
    /** Batch ends being handled: a tick waits for them. */
    private handling = new Set<Promise<void>>();
    private finished = new Set<(row: LongRunRow, view: LongRunView) => void>();
    private progress = new Set<(row: LongRunRow, view: LongRunView) => void>();
    private log: (line: string) => void;

    constructor(
        private repo: LongRunRepository,
        private jobs: JobService,
        private options: LongRunServiceOptions,
    ) {
        this.log = options.log ?? (() => {});
        jobs.onRunEnded((run) => {
            if (!run.longRunId) {
                return;
            }
            const work = this.batchEnded(run)
                .then(() => this.progressed(run.longRunId!))
                .catch((error: unknown) =>
                    this.log(
                        `Long runs: a batch's end could not be recorded (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
                    ),
                )
                .finally(() => this.handling.delete(work));
            this.handling.add(work);
        });
        this.recovered = this.recover(true).catch((error: unknown) =>
            this.log(
                `Long runs: could not recover open runs (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
            ),
        );
    }
    get settings() {
        return this.jobs.settings;
    }
    /**
     * Calls `listener` after each batch of a long run that goes on (running
     * or waiting): where it stands now (Telegram's progress message, CB-145).
     */
    onProgress(listener: (row: LongRunRow, view: LongRunView) => void) {
        this.progress.add(listener);
        return () => this.progress.delete(listener);
    }
    private async progressed(id: string) {
        if (!this.progress.size) {
            return;
        }
        const row = await this.repo.get(id);
        if (!row || (row.status !== 'running' && row.status !== 'waiting')) {
            return;
        }
        const view = await this.view(row);
        for (const listener of this.progress) {
            try {
                listener(row, view);
            } catch {
                // Progress is best effort; the long run goes on either way.
            }
        }
    }
    /** Calls `listener` once a long run has ended: done, failed or canceled. */
    onFinished(listener: (row: LongRunRow, view: LongRunView) => void) {
        this.finished.add(listener);
        return () => this.finished.delete(listener);
    }

    // ---- lifecycle -----------------------------------------------------------

    /**
     * Startup batches are recovered only after their runtime is gone. A
     * candidate leaves live owners' claims intact and retries those startup
     * rows on later ticks; its own normal completions are settled by batchEnded.
     */
    private async recover(initial = false) {
        const now = Date.now();
        const rows = await this.repo.openRuns();
        const open = new Set(rows.map((row) => row.id));
        for (const id of this.pendingRecovery) {
            if (!open.has(id)) {
                this.pendingRecovery.delete(id);
            }
        }
        for (const row of rows) {
            if (!initial && !this.pendingRecovery.has(row.id)) {
                continue;
            }
            if (!row.currentRunId) {
                this.pendingRecovery.delete(row.id);
                continue;
            }
            const runId = row.currentRunId;
            const recovered = await this.jobs.withOrphanedRun(runId, async () => {
                // Recheck after acquiring the writer lock: the incumbent may have settled
                // this batch or started a replacement since the initial list read.
                const current = await this.repo.get(row.id);
                if (!current || current.currentRunId !== runId) {
                    return;
                }
                const refusal = current.nextAt !== null && current.nextAt > now;
                await this.repo.release(
                    row.id,
                    runId,
                    {
                        refund: true,
                        maxAttempts: this.settings.itemAttempts,
                        error: '',
                        waitMs: (attempts) => this.backoff(attempts),
                    },
                    now,
                );
                await this.repo.update(
                    row.id,
                    {
                        status: 'waiting',
                        currentRunId: null,
                        nextAt: refusal ? current.nextAt : now,
                        waitReason: refusal
                            ? current.waitReason
                            : 'Resuming from its checkpoint after the server restarted.',
                    },
                    now,
                );
                this.log(`Long runs: resuming run=${row.id} job=${row.jobId}`);
            });
            if (recovered) {
                this.pendingRecovery.delete(row.id);
            } else {
                this.pendingRecovery.add(row.id);
            }
        }
    }

    /**
     * Resolves once the server is listening plus a short settle (CB-161); at
     * once if the service wasn't given a server to wait for.
     */
    private whenReady(): Promise<void> {
        this.ready ??= (async () => {
            const listening = this.options.listening?.();
            // Only a server that is still to listen needs the settle.
            if (listening) {
                this.waited = true;
                await listening;
                await new Promise((resolve) => setTimeout(resolve, this.settings.startupSettleMs));
            }
            this.readyAt = Date.now();
        })();
        return this.ready;
    }
    /**
     * A batch that failed only because the app wasn't answering yet: it
     * started soon after the app was ready (its start counts, not its end),
     * made no progress, and its output says a connection to the app was
     * refused or reset. Such a batch isn't the job's fault.
     */
    private async appWasDown(run: JobRunView, idle: boolean) {
        if (!this.waited || this.readyAt === undefined || !idle) {
            return false;
        }
        if (run.status !== 'failed' || !run.startedAt) {
            return false;
        }
        if (run.startedAt > this.readyAt + this.settings.startupWindowMs) {
            return false;
        }
        const { stdout, stderr } = await this.jobs.runLogs(run.id);
        return APP_DOWN.test(`${stderr}\n${stdout}`);
    }
    /** The server's start (`LeaderWork`): open long runs carry on, and are looked at regularly. */
    async resume() {
        await this.recovered;
        if (this.stopped) {
            return;
        }
        clearInterval(this.interval);
        this.interval = setInterval(() => void this.tick(), TICK_MS);
        this.interval.unref?.();
        // Not holding up the other modules' start while the server comes up.
        if (this.readyAt === undefined && this.options.listening) {
            void this.tick();
        } else {
            await this.tick();
        }
    }
    /** The server's stop (`LeaderWork.stop`): nothing new starts; what runs is the job service's to stop. */
    stop() {
        this.stopped = true;
        clearInterval(this.interval);
        clearTimeout(this.timer);
        this.timer = undefined;
    }
    /** Settles batch ends being recorded (tests, the stop). */
    async settled() {
        while (this.handling.size) {
            await Promise.all(this.handling);
        }
        await this.ticking;
    }
    private wake(at: number) {
        if (this.stopped || at >= this.wakeAt) {
            return;
        }
        clearTimeout(this.timer);
        this.wakeAt = at;
        this.timer = setTimeout(
            () => {
                this.timer = undefined;
                this.wakeAt = Infinity;
                void this.tick();
            },
            Math.max(0, at - Date.now()),
        );
        this.timer.unref?.();
    }
    /** Starts the next batch of every long run that is due; never throws. */
    tick(): Promise<void> {
        if (this.ticking) {
            this.again = true;
            return this.ticking;
        }
        this.ticking = (async () => {
            do {
                this.again = false;
                await this.recovered;
                await this.whenReady();
                const now = Date.now();
                if (this.stopped || this.jobs.isDraining) {
                    return;
                }
                await this.recover();
                if (this.options.paused?.()) {
                    continue;
                }
                for (const row of await this.repo.openRuns()) {
                    if (row.currentRunId || row.status === 'running') {
                        continue;
                    }
                    if ((row.nextAt ?? 0) > now) {
                        this.wake(row.nextAt!);
                        continue;
                    }
                    await this.launch(row, now).catch((error: unknown) =>
                        this.log(
                            `Long runs: run=${row.id} could not start a batch (${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}).`,
                        ),
                    );
                }
            } while (this.again && !this.stopped);
        })().finally(() => (this.ticking = undefined));
        return this.ticking;
    }

    // ---- starting ------------------------------------------------------------

    /**
     * Starts a job as its owner: a run of it, or for a job that runs until
     * done, its long run (the open one if there is one).
     */
    async startJob(
        userId: string,
        jobId: string,
        origin: {
            trigger: JobRunTrigger;
            dotId?: string;
            scheduleId?: string;
            threadId?: string;
        },
    ): Promise<{ run?: JobRunView; longRun?: LongRunView; already?: boolean }> {
        const job = await this.jobs.job(userId, jobId, origin.dotId);
        if (!job.untilDone) {
            return { run: await this.jobs.start(userId, jobId, origin) };
        }
        await this.jobs.startable(userId, jobId, origin.dotId);
        const open = await this.repo.open(jobId);
        if (open) {
            return { longRun: await this.view(open), already: true };
        }
        const now = Date.now();
        const row = await this.repo.create({
            id: randomUUID(),
            jobId,
            userId,
            dotId: job.dotId,
            trigger: origin.trigger,
            scheduleId: origin.scheduleId ?? null,
            threadId: origin.threadId ?? null,
            createdAt: now,
        });
        this.log(`Long runs: started run=${row.id} job=${jobId}`);
        await this.tick();
        return { longRun: await this.view((await this.repo.get(row.id)) ?? row) };
    }
    private async launch(row: LongRunRow, now: number) {
        const dot = this.options.workspace.dot(row.dotId);
        try {
            await this.jobs.owned(row.userId, row.jobId);
        } catch {
            return this.finish(row, 'cancelled', 'The job was deleted.');
        }
        if (!dot) {
            return this.finish(row, 'failed', 'The socio was deleted.');
        }
        if (this.options.workspace.isDeactivated?.(row.userId)) {
            return this.finish(row, 'failed', DEACTIVATED_JOB_RUN);
        }
        if (row.batches >= this.settings.maxBatches) {
            return this.finish(
                row,
                'failed',
                `It took ${plural(row.batches, 'batch')}, the most one run may take, without finishing.`,
            );
        }
        const counts = await this.repo.counts(row.id);
        const mark: BatchMark = {
            done: counts.done,
            resolved: counts.done + counts.dead,
            total: counts.total,
            tries: counts.tries,
            checkpoint: fingerprint(row.checkpoint),
        };
        let run: JobRunView;
        try {
            run = await this.jobs.start(row.userId, row.jobId, {
                trigger: row.trigger,
                ...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
                longRunId: row.id,
            });
        } catch (error) {
            if (!(error instanceof JobError)) {
                throw error;
            }
            // Draining: the next process starts it.
            if (this.jobs.isDraining) {
                return;
            }
            if (error.status === 404 || error.status === 409) {
                return this.finish(row, 'failed', error.message);
            }
            return this.retry(row, now, false, error.message);
        }
        if (run.longRunId !== row.id) {
            // A run of the job from before it ran until done is still going.
            await this.repo.update(
                row.id,
                {
                    nextAt: now + this.settings.retryBaseMs,
                    waitReason: 'Waiting for the job’s other run to finish.',
                },
                now,
            );
            this.wake(now + this.settings.retryBaseMs);
            return;
        }
        await this.repo.update(
            row.id,
            {
                status: 'running',
                currentRunId: run.id,
                batches: row.batches + 1,
                mark: JSON.stringify(mark),
                nextAt: null,
                waitReason: null,
            },
            now,
        );
    }

    // ---- a batch ended -------------------------------------------------------

    private backoff(retries: number) {
        return Math.min(this.settings.maxWaitMs, this.settings.retryBaseMs * 2 ** Math.max(0, retries - 1));
    }
    private complete(row: LongRunRow, counts: ItemCounts) {
        return !!row.completed || (!!row.sealed && counts.pending + counts.claimed === 0);
    }
    /**
     * How a long run with nothing left went: done, unless more of its items
     * were set aside than done. Working through every item isn't success.
     */
    private ending(counts: ItemCounts): ['done' | 'failed', string?] {
        if (counts.dead <= counts.done) {
            return ['done'];
        }
        return [
            'failed',
            counts.done
                ? 'More of its items were set aside as failed than done.'
                : 'None of its items could be done; each was set aside as failed.',
        ];
    }
    private async batchEnded(run: JobRunView) {
        const id = run.longRunId!;
        const now = Date.now();
        // Stopped from outside: nothing is the job's fault.
        // Or the app wasn't answering yet after a restart (CB-161), when the
        // batch got nowhere.
        const early = await this.repo.get(id);
        if (!early || early.currentRunId !== run.id) {
            return;
        }
        const startMark = JSON.parse(early?.mark ?? '{}') as Partial<BatchMark>;
        const startCounts = await this.repo.counts(id);
        const idle =
            !!early &&
            startCounts.done <= (startMark.done ?? 0) &&
            startCounts.done + startCounts.dead <= (startMark.resolved ?? 0) &&
            startCounts.total <= (startMark.total ?? 0) &&
            fingerprint(early.checkpoint) === (startMark.checkpoint ?? null);
        const appDown = await this.appWasDown(run, idle);
        const outside = run.status === 'interrupted' || appDown;
        const crashed = !appDown && (run.status === 'failed' || run.status === 'timed_out');
        // A refusal (`pause`, or a 403 or 429) set a wait (launch() clears it): a
        // batch that exits nonzero after one wasn't on an item, so none is charged.
        const refused = !!early && early.nextAt !== null && early.nextAt > now;
        const released = await this.repo.release(
            id,
            run.id,
            {
                // A batch that exited cleanly with items left just ran out of
                // budget; one that failed or timed out was on its first.
                refund: !crashed || refused,
                maxAttempts: this.settings.itemAttempts,
                error: `Its batch ended (${run.status.replace('_', ' ')}) before it was done${run.error ? `: ${run.error}` : '.'}`,
                waitMs: (attempts) => this.backoff(attempts),
            },
            now,
        );
        const row = await this.repo.get(id);
        if (!row || row.currentRunId !== run.id) {
            return;
        }
        const counts = await this.repo.counts(id);
        if (row.status !== 'running' && row.status !== 'waiting') {
            await this.repo.update(id, { currentRunId: null }, now);
            return;
        }
        const mark = JSON.parse(row.mark ?? '{}') as Partial<BatchMark>;
        // It crashed while on an item, and was charged for it.
        const charged = crashed && released.released + released.dead > 0;
        const progress =
            counts.done > (mark.done ?? 0) ||
            // Without an item done, a batch that crashed on one made none, whatever
            // its checkpoint says (a checkpoint may change each batch, `{ batch:
            // n }`), or a job that crashes every batch would go on until its last
            // batch, setting good items aside one by one.
            (!charged &&
                (fingerprint(row.checkpoint) !== (mark.checkpoint ?? null) ||
                    counts.done + counts.dead > (mark.resolved ?? 0) ||
                    counts.total > (mark.total ?? 0) ||
                    counts.tries !== (mark.tries ?? 0)));
        const base: LongRunPatch = { status: 'waiting', currentRunId: null };
        if (this.complete(row, counts)) {
            await this.repo.update(id, base, now);
            const [status, reason] = this.ending(counts);
            return this.finish({ ...row, ...base }, status, reason);
        }
        // A refusal during the batch set when to go on (`pause`).
        const refusal = row.nextAt !== null && row.nextAt > now;
        if (outside) {
            // The next batch resumes, at no cost: at once after progress, else
            // after a wait, so a computer that keeps stopping isn't restarted
            // back to back; never before a refusal's wait is over.
            const nextAt = Math.max(progress ? now : now + this.settings.retryBaseMs, refusal ? row.nextAt! : now);
            await this.repo.update(
                id,
                {
                    ...base,
                    ...(progress ? { retries: 0 } : {}),
                    nextAt,
                    waitReason: refusal
                        ? row.waitReason
                        : `Resuming from its checkpoint${progress ? '' : ` at ${at(nextAt)}`}: ${run.error ?? 'the batch was stopped.'}`,
                },
                now,
            );
            if (nextAt > now) {
                this.wake(nextAt);
            } else {
                void this.tick();
            }
            return;
        }
        const lastError = crashed ? (run.error ?? `The batch ended ${run.status.replace('_', ' ')}.`) : row.lastError;
        const retries = progress ? 0 : row.retries + 1;
        if (retries > this.settings.batchRetries) {
            await this.repo.update(id, { ...base, retries, lastError }, now);
            return this.finish(
                { ...row, ...base, retries, lastError },
                'failed',
                refusal
                    ? `${plural(retries, 'batch')} in a row were refused. ${lastError ?? ''}`.trim()
                    : crashed
                      ? `${plural(retries, 'batch')} in a row failed without progress; the last: ${lastError}`
                      : `${plural(retries, 'batch')} in a row made no progress. The job must declare its whole list of items or say it is complete.`,
            );
        }
        const due = await this.repo.nextDue(id);
        // Not before an item is due, or the batch finds none and costs a retry.
        const nextAt = refusal ? row.nextAt! : Math.max(retries ? now + this.backoff(retries) : now, due ?? now);
        await this.repo.update(
            id,
            {
                ...base,
                retries,
                lastError,
                nextAt,
                waitReason: refusal
                    ? row.waitReason
                    : retries
                      ? `Retry ${retries} of ${this.settings.batchRetries} at ${at(nextAt)}: ${crashed ? lastError : 'the last batch made no progress.'}`
                      : nextAt > now
                        ? `Items wait to be retried; the next is due at ${at(nextAt)}.`
                        : null,
            },
            now,
        );
        if (nextAt > now) {
            this.wake(nextAt);
        } else {
            void this.tick();
        }
    }
    private async retry(row: LongRunRow, now: number, progress: boolean, reason: string) {
        const retries = progress ? 0 : row.retries + 1;
        if (retries > this.settings.batchRetries) {
            return this.finish(
                { ...row, retries, lastError: reason },
                'failed',
                `${plural(retries, 'batch')} in a row could not start; the last: ${reason}`,
            );
        }
        const nextAt = now + this.backoff(retries);
        await this.repo.update(
            row.id,
            {
                retries,
                lastError: reason,
                nextAt,
                waitReason: `Retry ${retries} of ${this.settings.batchRetries} at ${at(nextAt)}: ${reason}`,
            },
            now,
        );
        this.wake(nextAt);
    }
    private async finish(
        row: LongRunRow,
        status: Extract<LongRunStatus, 'done' | 'failed' | 'cancelled'>,
        reason?: string,
    ) {
        const now = Date.now();
        const counts = await this.repo.counts(row.id);
        const name = await this.jobs
            .job(row.userId, row.jobId)
            .then((job) => job.name)
            .catch(() => 'The job');
        const outcome = summary(name, status, counts, row, now, reason);
        await this.repo.update(
            row.id,
            {
                status,
                currentRunId: null,
                nextAt: null,
                waitReason: null,
                outcome,
                finishedAt: now,
                ...(status === 'failed' && reason ? { lastError: reason } : {}),
            },
            now,
        );
        this.log(
            `Long runs: run=${row.id} job=${row.jobId} status=${status} batches=${row.batches} done=${counts.done} failed=${counts.dead} left=${counts.pending + counts.claimed}`,
        );
        const ended = await this.repo.get(row.id);
        if (!ended) {
            return;
        }
        const view = await this.view(ended);
        for (const listener of this.finished) {
            try {
                listener(ended, view);
            } catch {
                // A report is best effort; the long run has ended either way.
            }
        }
    }

    // ---- the owner and the Dot -----------------------------------------------

    async view(row: LongRunRow): Promise<LongRunView> {
        const counts = await this.repo.counts(row.id);
        return {
            id: row.id,
            jobId: row.jobId,
            trigger: row.trigger,
            scheduleId: row.scheduleId,
            status: row.status,
            items: {
                total: counts.total,
                done: counts.done,
                remaining: counts.pending + counts.claimed,
                inProgress: counts.claimed,
                failed: counts.dead,
            },
            listComplete: !!row.sealed,
            batches: row.batches,
            maxBatches: this.settings.maxBatches,
            currentRunId: row.currentRunId,
            checkpoint: row.checkpoint ? row.checkpoint.slice(0, 200) : null,
            checkpointAt: row.checkpointAt,
            retries: row.retries,
            maxRetries: this.settings.batchRetries,
            nextAt: row.status === 'waiting' ? row.nextAt : null,
            waitReason: row.waitReason,
            lastError: row.lastError,
            deadLetters: await this.repo.dead(row.id, LONG_RUN_DEAD_SHOWN),
            outcome: row.outcome,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            finishedAt: row.finishedAt,
        };
    }
    /** The job's open or latest long run, for its owner (and with `dotId`, that Dot). */
    async status(userId: string, jobId: string, dotId?: string) {
        await this.jobs.owned(userId, jobId, dotId);
        const row = (await this.repo.open(jobId)) ?? (await this.repo.latest(jobId));
        return row ? this.view(row) : null;
    }
    /** Each job's open or latest long run (the app's job list). */
    async latestFor(jobIds: string[]) {
        const out = new Map<string, LongRunView>();
        for (const jobId of jobIds) {
            const row = (await this.repo.open(jobId)) ?? (await this.repo.latest(jobId));
            if (row) {
                out.set(jobId, await this.view(row));
            }
        }
        return out;
    }
    /** Stops the job's open long run (its owner, in the app); null when none. */
    async cancel(userId: string, jobId: string, reason = 'Stopped by its owner.') {
        await this.jobs.owned(userId, jobId);
        const row = await this.repo.open(jobId);
        if (!row) {
            return null;
        }
        await this.finish(row, 'cancelled', reason);
        if (row.currentRunId) {
            this.jobs.stopRun(row.currentRunId, reason);
        }
        return this.view((await this.repo.get(row.id))!);
    }
    /** The job was deleted (its owner, who checked it ran no batch). */
    async jobDeleted(jobId: string) {
        const row = await this.repo.open(jobId);
        if (row) {
            await this.finish(row, 'cancelled', 'The job was deleted.');
        }
    }
    /** Marks a long run's end as reported to whoever started it. */
    async reported(id: string) {
        await this.repo.update(id, { reportedAt: Date.now() }, Date.now());
    }
    /** Ends not reported yet (the last process stopped first). */
    async unreported() {
        return this.repo.unreported(Date.now() - REPORT_WINDOW_MS);
    }

    // ---- the checkpoint API (a batch, through its data token) ---------------

    /** The batch a data token belongs to, and its long run, which must be open. */
    private async batchOf(scope: DataTokenScope) {
        const runId = scope.purpose === 'job' && scope.session.startsWith('job:') ? scope.session.slice(4) : undefined;
        const run = runId ? await this.jobs.runRecord(runId) : undefined;
        if (!run?.longRunId) {
            throw new JobError(
                'Only a job that runs until done has items and checkpoints. Save it with untilDone.',
                409,
            );
        }
        const row = await this.repo.get(run.longRunId);
        if (!row || row.currentRunId !== run.id) {
            throw new JobError('This batch is no longer its job’s current one. Stop now.', 409);
        }
        if (row.status !== 'running' && row.status !== 'waiting') {
            throw new JobError(`This run has ended (${row.status}). Stop now.`, 409);
        }
        return { row, runId: run.id };
    }
    /** `GET /job`: where the long run stands, the checkpoint included. */
    async batchState(scope: DataTokenScope) {
        const { row } = await this.batchOf(scope);
        const counts = await this.repo.counts(row.id);
        return {
            longRunId: row.id,
            batch: row.batches,
            checkpoint: row.checkpoint ? (JSON.parse(row.checkpoint) as unknown) : null,
            checkpointAt: row.checkpointAt,
            listComplete: !!row.sealed,
            items: {
                total: counts.total,
                done: counts.done,
                pending: counts.pending,
                inProgress: counts.claimed,
                failed: counts.dead,
            },
        };
    }
    /** `POST /job/items`: declares items (keys); `complete` says that's all of them. */
    async addItems(scope: DataTokenScope, keys: string[], complete: boolean) {
        const { row } = await this.batchOf(scope);
        const now = Date.now();
        const added = keys.length ? await this.repo.addItems(row.id, [...new Set(keys)], now) : 0;
        if (complete && !row.sealed) {
            await this.repo.update(row.id, { sealed: 1 }, now);
        }
        const counts = await this.repo.counts(row.id);
        return {
            added,
            total: counts.total,
            listComplete: complete || !!row.sealed,
        };
    }
    /**
     * `POST /job/claim`: up to `limit` items for this batch. While the long
     * run waits after a refusal, none: the batch should stop.
     */
    async claim(scope: DataTokenScope, limit: number) {
        const { row, runId } = await this.batchOf(scope);
        const now = Date.now();
        if (row.nextAt !== null && row.nextAt > now) {
            return {
                items: [] as string[],
                stop: 'waiting',
                until: row.nextAt,
                message: row.waitReason ?? 'The run is waiting. Stop now.',
            };
        }
        const items = await this.repo.claim(row.id, runId, limit, now);
        if (items.length) {
            return { items };
        }
        const due = await this.repo.nextDue(row.id);
        return due !== null && due > now
            ? {
                  items,
                  stop: 'later',
                  until: due,
                  message: 'The items left wait to be retried. Stop now; a later batch takes them.',
              }
            : { items };
    }
    /**
     * `POST /job/done`: the item is done, once. With `write`, its rows are
     * upserted first (by `key` columns), so doing an item again after a
     * stop overwrites instead of adding duplicates.
     */
    async done(
        scope: DataTokenScope,
        key: string,
        write?: {
            dataset: string;
            table: string;
            rows: Record<string, unknown>[];
            key: string[];
        },
    ) {
        const { row, runId } = await this.batchOf(scope);
        if (write) {
            const result = await this.options.data.write(
                {
                    kind: 'token',
                    userId: scope.userId,
                    dotId: scope.dotId,
                    datasetIds: scope.datasetIds,
                    ...(scope.reach ? { reach: scope.reach } : {}),
                },
                write.dataset,
                { op: 'upsert', table: write.table, rows: write.rows, key: write.key },
            );
            if (result.status !== 'done') {
                throw new JobError(
                    'The write needs the user’s approval, so the item is not done. Mark it failed.',
                    409,
                );
            }
        }
        const result = await this.repo.done(row.id, runId, key, Date.now());
        if (result === 'unknown') {
            throw new JobError('No such item.', 404);
        }
        if (result === 'not_claimed') {
            throw new JobError('This batch didn’t claim that item.', 409);
        }
        return { done: true, ...(result === 'already' ? { already: true } : {}) };
    }
    /**
     * `POST /job/fail`: the item failed. With a 403 or 429 `status` (the
     * source refused), its try doesn't count and the long run pauses.
     */
    async fail(
        scope: DataTokenScope,
        input: {
            key: string;
            error: string;
            retry?: boolean;
            status?: number;
            retryAfterSeconds?: number;
        },
    ) {
        const { row, runId } = await this.batchOf(scope);
        const refused = input.status === 403 || input.status === 429;
        const result = await this.repo.fail(
            row.id,
            runId,
            input.key,
            {
                error: oneLine(input.error, 500),
                retry: input.retry !== false,
                refund: refused,
                maxAttempts: this.settings.itemAttempts,
                waitMs: (attempts) => this.backoff(attempts),
            },
            Date.now(),
        );
        if (result === 'unknown') {
            throw new JobError('No such item.', 404);
        }
        if (result === 'not_claimed') {
            throw new JobError('This batch didn’t claim that item.', 409);
        }
        if (refused) {
            const paused = await this.pause(scope, {
                reason: input.error,
                status: input.status,
                retryAfterSeconds: input.retryAfterSeconds,
            });
            return { item: 'pending', ...paused };
        }
        return {
            item: result === 'dead' ? 'failed' : result === 'retry' ? 'pending' : result,
        };
    }
    /** `POST /job/checkpoint`: the job's own state to resume from. */
    async checkpoint(scope: DataTokenScope, value: unknown) {
        const { row } = await this.batchOf(scope);
        const text = JSON.stringify(value ?? null);
        if (Buffer.byteLength(text) > CHECKPOINT_MAX_BYTES) {
            throw new JobError(
                `A checkpoint is at most ${CHECKPOINT_MAX_BYTES / 1024} KB of JSON. Keep a cursor, not the data.`,
                413,
            );
        }
        const now = Date.now();
        await this.repo.update(row.id, { checkpoint: text, checkpointAt: now }, now);
        return { ok: true, checkpointAt: now };
    }
    /**
     * `POST /job/pause`: a source refused (403, 429). The long run waits
     * (`retryAfterSeconds` when the source said, else longer each time in a
     * row) and the batch should stop now; the next batch resumes.
     */
    async pause(scope: DataTokenScope, input: { reason: string; status?: number; retryAfterSeconds?: number }) {
        const { row } = await this.batchOf(scope);
        const now = Date.now();
        const base = this.settings.refusalWaitMs * (input.status === 403 ? 3 : 1);
        const waitMs = Math.min(
            this.settings.maxWaitMs,
            input.retryAfterSeconds && input.retryAfterSeconds > 0
                ? input.retryAfterSeconds * 1000
                : base * 2 ** row.retries,
        );
        const until = now + waitMs;
        const refusal = `The source refused${input.status ? ` (HTTP ${input.status})` : ''}: ${oneLine(input.reason, 200) || 'no reason given'}.`;
        await this.repo.update(
            row.id,
            {
                nextAt: until,
                lastError: refusal,
                waitReason: `${refusal} Waiting until ${at(until)}.`,
            },
            now,
        );
        return { paused: true, until, message: 'Stop now; a later batch resumes.' };
    }
    /** `POST /job/complete`: the job's own completion condition holds. */
    async markComplete(scope: DataTokenScope, summary?: string) {
        const { row } = await this.batchOf(scope);
        const counts = await this.repo.counts(row.id);
        const open = counts.pending + counts.claimed;
        if (open) {
            throw new JobError(`${plural(open, 'item')} not done or failed yet. Finish or fail them first.`, 409);
        }
        await this.repo.update(
            row.id,
            {
                completed: 1,
                ...(summary ? { jobSummary: oneLine(summary, 500) } : {}),
            },
            Date.now(),
        );
        return {
            complete: true,
            message: 'Exit now; the run ends with this batch.',
        };
    }
}

/** A long run's end in a few plain sentences, for its chat and the app. */
export function summary(
    name: string,
    status: 'done' | 'failed' | 'cancelled',
    counts: ItemCounts,
    row: Pick<LongRunRow, 'batches' | 'createdAt' | 'jobSummary'>,
    now: number,
    reason?: string,
) {
    const left = counts.pending + counts.claimed;
    const items = counts.total
        ? `${counts.done} of ${plural(counts.total, 'item')} done${counts.dead ? `, ${counts.dead} set aside as failed` : ''}${left ? `, ${left} left` : ''}`
        : 'no items declared';
    const took = `${plural(row.batches, 'batch')} over ${duration(now - row.createdAt)}`;
    if (status === 'done') {
        return `“${name}” is done${counts.dead ? ', but not all of it' : ''}: ${items}, in ${took}.${row.jobSummary ? ` The job said: ${row.jobSummary}` : ''}`;
    }
    const Items = items[0].toUpperCase() + items.slice(1);
    if (status === 'cancelled') {
        return `“${name}” was stopped: ${reason ?? 'Cancelled.'} ${Items}, after ${took}.`;
    }
    // Nothing left: it got through its items, and failed.
    if (counts.total && !left) {
        return `“${name}” failed: ${reason ?? 'It failed.'} ${Items}, after ${took}.`;
    }
    return `“${name}” stopped before it was done: ${reason ?? 'It failed.'} ${Items}, after ${took}.`;
}
