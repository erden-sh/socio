/**
 * The app's side of the datasets' analytics process (CB-369), child
 * mode: forked the first time an analytical table is used and stopped after
 * a few idle minutes, so an install without analytical tables runs no
 * DuckDB at all. It gets none of the app's environment. It is stopped by
 * its own PID alone: asked to exit, then killed if it hasn't. A job past
 * its time kills the process (DuckDB's interrupt is tried first, inside
 * it); the next job starts a new one, after a backoff when it keeps dying.
 * Separate from Operations analytics: a heavy dataset query never
 * starves the Operations ETL.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DataError } from '@socio/foundation/dataspace/data-error';

import type { WorkerJob, WorkerReply } from './ipc.js';

/** The process's entry: built JS, or the source under tsx. */
export function workerEntry() {
    const built = fileURLToPath(new URL('./worker.js', import.meta.url));
    return existsSync(built) ? built : fileURLToPath(new URL('./worker.ts', import.meta.url));
}

/** Jobs that wait for a slot, past which a new one is refused. */
export const QUEUE_MAX = 16;
const STOP_MS = 5_000;

export interface AnalyticsProcessStatus {
    mode: 'child' | 'off';
    /** `idle`: not running now (it starts on the next job). */
    state: 'off' | 'idle' | 'running' | 'restarting';
    pid?: number;
    running: number;
    queued: number;
}

export class DatasetAnalytics {
    private child?: ChildProcess;
    /** Jobs sent, with the process each went to: an exit fails only its own. */
    private pending = new Map<
        number,
        { child: ChildProcess; resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    private nextId = 1;
    private active = 0;
    private waiting: Array<() => void> = [];
    private idleTimer?: ReturnType<typeof setTimeout>;
    private crashes = 0;
    private startAfter = 0;
    private startedAt = 0;
    private closed = false;
    /** Children asked to stop (idle, shutdown): their exit is no crash. */
    private stopping = new WeakSet<ChildProcess>();
    constructor(
        readonly mode: 'child' | 'off',
        private options: { entry?: string; idleMs?: number; log?: (line: string) => void } = {},
    ) {}
    get pid() {
        return this.child?.pid;
    }
    status(): AnalyticsProcessStatus {
        return {
            mode: this.mode,
            state:
                this.mode === 'off'
                    ? 'off'
                    : this.child
                      ? 'running'
                      : Date.now() < this.startAfter
                        ? 'restarting'
                        : 'idle',
            ...(this.child?.pid ? { pid: this.child.pid } : {}),
            running: this.active,
            queued: this.waiting.length,
        };
    }
    /** Whether analytical tables can be used at all (`DATA_ANALYTICS_MODE`). */
    get enabled() {
        return this.mode !== 'off';
    }
    /**
     * Runs one job: waits for one of `concurrency` slots (at most
     * `QUEUE_MAX` wait; past that, 429), then sends it. Past `timeoutMs`
     * the process is killed and the job fails with 504.
     */
    async run<T>(job: WorkerJob, options: { timeoutMs: number; concurrency: number }): Promise<T> {
        if (this.mode === 'off') {
            throw new DataError('Analytical tables are off on this server (DATA_ANALYTICS_MODE=off).', 503);
        }
        if (this.closed) {
            throw new DataError('The data space is shutting down.', 409);
        }
        if (this.active >= options.concurrency) {
            if (this.waiting.length >= QUEUE_MAX) {
                throw new DataError('Too many analytical jobs at once; try again in a few seconds.', 429);
            }
            await new Promise<void>((resolve) => this.waiting.push(resolve));
            if (this.closed) {
                throw new DataError('The data space is shutting down.', 409);
            }
        }
        this.active++;
        try {
            return (await this.send(job, options.timeoutMs)) as T;
        } finally {
            this.active--;
            this.waiting.shift()?.();
            this.idleLater();
        }
    }
    private spawn() {
        if (Date.now() < this.startAfter) {
            throw new DataError('The analytics process is restarting; try again in a few seconds.', 503);
        }
        const entry = this.options.entry ?? workerEntry();
        const child = fork(entry, [], {
            execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
            // Never the app's environment: it holds the platform's secrets.
            env: { DO_NOT_TRACK: '1', ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}) },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            serialization: 'advanced',
        });
        this.child = child;
        this.startedAt = Date.now();
        child.unref();
        (child.channel as { unref?: () => void } | undefined)?.unref?.();
        child.on('message', (reply: WorkerReply) => {
            if (this.child !== child || typeof reply?.id !== 'number') {
                return;
            }
            const waiting = this.pending.get(reply.id);
            this.pending.delete(reply.id);
            if (!waiting) {
                return;
            }
            if (reply.ok) {
                waiting.resolve(reply.value);
            } else {
                waiting.reject(new DataError(reply.error, reply.status as 400));
            }
        });
        child.on('error', (error) => this.options.log?.(`Data analytics: the process failed: ${error.message}`));
        child.once('exit', (code, signal) => {
            if (this.child === child) {
                this.child = undefined;
            }
            for (const [id, waiting] of [...this.pending]) {
                if (waiting.child === child) {
                    this.pending.delete(id);
                    waiting.reject(new DataError('The analytics process stopped; try again.', 503));
                }
            }
            if (this.closed || child.killed || this.stopping.has(child)) {
                return;
            }
            // It died on its own: back off, longer each time it keeps dying.
            if (Date.now() - this.startedAt > 60_000) {
                this.crashes = 0;
            }
            const delay = Math.min(1_000 * 2 ** this.crashes, 60_000);
            this.crashes++;
            this.startAfter = Date.now() + delay;
            this.options.log?.(
                `Data analytics: the process exited (${signal ?? `code ${code}`}); the next job starts it again in ${Math.round(delay / 1000)} s or more.`,
            );
        });
        return child;
    }
    private send(job: WorkerJob, timeoutMs: number) {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
        const child = this.child?.connected ? this.child : this.spawn();
        const id = this.nextId++;
        child.ref();
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.pending.delete(id)) {
                    return;
                }
                reject(
                    new DataError(
                        `The analytical job ran longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`,
                        504,
                    ),
                );
                // Its PID alone; jobs it was running with fail and may be sent again.
                child.kill('SIGKILL');
            }, timeoutMs);
            const done = () => {
                clearTimeout(timer);
                if (![...this.pending.values()].some((waiting) => waiting.child === child)) {
                    child.unref();
                }
            };
            this.pending.set(id, {
                child,
                resolve: (value) => {
                    done();
                    resolve(value);
                },
                reject: (error) => {
                    done();
                    reject(error);
                },
            });
            child.send({ id, job }, (error) => {
                if (error && this.pending.delete(id)) {
                    done();
                    reject(new DataError('The analytics process stopped; try again.', 503));
                }
            });
        });
    }
    /** Stops the process after `idleMs` (5 minutes) without a job. */
    private idleLater() {
        if (this.active || this.waiting.length || !this.child) {
            return;
        }
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        this.idleTimer = setTimeout(
            () => {
                this.idleTimer = undefined;
                if (!this.active && !this.pending.size) {
                    void this.stopChild();
                }
            },
            this.options.idleMs ?? 5 * 60_000,
        );
        this.idleTimer.unref();
    }
    private async stopChild() {
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        this.child = undefined;
        this.stopping.add(child);
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        try {
            child.send({ shutdown: true });
        } catch {
            // The channel is gone: the kill below does it.
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
        timer.unref();
        await exited;
        clearTimeout(timer);
    }
    async close() {
        this.closed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        for (const wake of this.waiting.splice(0)) {
            wake();
        }
        await this.stopChild();
    }
}
