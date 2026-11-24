import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AnalyticsConfig } from '../contract.js';

import { AnalyticsError, AnalyticsTransport } from './client.js';
import { fromChild, type AnalyticsRequest } from './ipc.js';

/** The analytics process's entry: built JS, or the source under tsx. */
export function analyticsEntry() {
    const built = fileURLToPath(new URL('./analytics-main.js', import.meta.url));
    return existsSync(built) ? built : fileURLToPath(new URL('./analytics-main.ts', import.meta.url));
}

const ANSWER_MS = 30_000;
/** How long a child gets to close its file before it is killed. */
const STOP_MS = 5_000;

export interface ChildOptions {
    /** Tests point it elsewhere; `analyticsEntry()` by default. */
    entry?: string;
    log?: (line: string) => void;
    /** Restart backoff: doubling from `firstMs` up to `maxMs`. */
    backoff?: { firstMs: number; maxMs: number };
}

/**
 * Child mode (development, single-container installs): the app forks the
 * analytics process and talks to it over IPC. Its PID is recorded and it
 * is stopped by that PID alone; when it dies it is started again, with
 * backoff. It gets none of the app's environment, only where the files
 * are and its settings. If the app dies, the child sees the channel close
 * and stops.
 */
export class ChildAnalytics extends AnalyticsTransport {
    readonly mode = 'child' as const;
    private child?: ChildProcess;
    private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    private nextId = 1;
    private stopped = true;
    private restarts = 0;
    private startedAt = 0;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private readonly log: (line: string) => void;
    constructor(
        private config: Extract<AnalyticsConfig, { mode: 'child' }>,
        private options: ChildOptions = {},
    ) {
        super();
        this.log = options.log ?? ((line) => console.log(line));
    }
    /** The running child's PID, if one runs. */
    get pid() {
        return this.child?.pid;
    }
    start() {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        this.spawn();
    }
    private spawn() {
        const entry = this.options.entry ?? analyticsEntry();
        const child = fork(entry, [], {
            execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
            // Never the app's environment: it holds the platform's secrets.
            env: {
                ...this.config.env,
                OPS_ANALYTICS_MODE: 'child',
                DATABASE_PATH: this.config.databasePath,
                OPS_ANALYTICS_DIR: this.config.dir,
                DO_NOT_TRACK: '1',
                ...(process.env.NODE_ENV ? { NODE_ENV: process.env.NODE_ENV } : {}),
            },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            serialization: 'advanced',
        });
        this.child = child;
        this.startedAt = Date.now();
        this.seen({ state: 'starting' });
        // It never holds the app open; a pending request's timer does.
        child.unref();
        (child.channel as { unref?: () => void } | undefined)?.unref?.();
        child.on('message', (raw) => {
            const message = fromChild.safeParse(raw);
            if (!message.success || this.child !== child) {
                return;
            }
            if ('status' in message.data) {
                this.seen(message.data.status);
            } else {
                const waiting = this.pending.get(message.data.id);
                this.pending.delete(message.data.id);
                waiting?.resolve(message.data.answer);
            }
        });
        child.on('error', (error) => this.log(`Analytics: the child process failed: ${error.message}`));
        child.once('exit', (code, signal) => {
            if (this.child !== child) {
                return;
            }
            this.child = undefined;
            for (const waiting of this.pending.values()) {
                waiting.reject(new AnalyticsError('The analytics process stopped.', 'unavailable'));
            }
            this.pending.clear();
            if (this.stopped) {
                return;
            }
            // A child that ran a while starts over at the shortest wait.
            if (Date.now() - this.startedAt > 60_000) {
                this.restarts = 0;
            }
            const { firstMs, maxMs } = this.options.backoff ?? {
                firstMs: 1_000,
                maxMs: 60_000,
            };
            const delay = Math.min(firstMs * 2 ** this.restarts, maxMs);
            this.restarts++;
            this.log(
                `Analytics: the child process exited (${signal ?? `code ${code}`}); starting it again in ${Math.round(delay / 1000)} s.`,
            );
            this.seen({ state: 'unavailable', detail: 'Restarting.' });
            this.restartTimer = setTimeout(() => {
                this.restartTimer = undefined;
                if (!this.stopped) {
                    this.spawn();
                }
            }, delay);
            this.restartTimer.unref();
        });
    }
    /**
     * Asks the child to close its file and exit, then kills that PID if it
     * hasn't within a few seconds. Nothing else is signaled.
     */
    async stop() {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
        }
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        const exited = new Promise<void>((resolve) => child.once('exit', resolve));
        try {
            child.send({ shutdown: true });
        } catch {
            // The channel is gone: the kill below does it.
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS);
        await exited;
        clearTimeout(timer);
    }
    protected send(request: AnalyticsRequest) {
        const child = this.child;
        if (!child?.connected) {
            return Promise.reject(new AnalyticsError('The analytics process isn’t running right now.', 'unavailable'));
        }
        const id = this.nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AnalyticsError('The analytics process didn’t answer in time.', 'unavailable'));
            }, ANSWER_MS);
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            child.send({ id, request }, (error) => {
                if (!error) {
                    return;
                }
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new AnalyticsError('The analytics process stopped.', 'unavailable'));
            });
        });
    }
}
