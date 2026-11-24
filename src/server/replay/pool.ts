import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Message } from '@ag-ui/client';

import {
    REPLAY_CACHE_BYTES,
    REPLAY_TIMEOUT_MS,
    ReplayError,
    type ReplayerShape,
    type ReplayStats,
    type StoredRunRow,
} from './contract.js';
import type { ReplayRequest, ReplayResponse } from './protocol.js';
import { ReplayCache } from './replay.js';

/**
 * Replays on the calling thread, with the same cache. For environments
 * without worker threads, and tests that ask for it; the server uses
 * `ReplayPool`.
 */
export class InlineReplayer implements ReplayerShape {
    readonly cache: ReplayCache;
    constructor(maxBytes = REPLAY_CACHE_BYTES) {
        this.cache = new ReplayCache(maxBytes);
    }
    async messages(key: string, threadId: string, rows: StoredRunRow[]) {
        const { messages, stats } = await this.cache.messages(key, threadId, rows);
        // The cache keeps its own: callers may change what they get.
        return { messages: structuredClone(messages), stats };
    }
    forget(key: string) {
        this.cache.forget(key);
    }
    forgetPrefix(prefix: string) {
        this.cache.forgetPrefix(prefix);
    }
}

/** The worker's entry: built JS, or the source under tsx (development, tests). */
export function replayWorkerEntry() {
    const built = fileURLToPath(new URL('./worker.js', import.meta.url));
    return existsSync(built) ? built : fileURLToPath(new URL('./worker.ts', import.meta.url));
}

interface Pending {
    request: Extract<ReplayRequest, { kind: 'messages' }>;
    timeoutMs: number;
    resolve: (value: { messages: Message[]; stats: ReplayStats }) => void;
    reject: (error: Error) => void;
}

export interface ReplayPoolOptions {
    /** Tests point it elsewhere; `replayWorkerEntry()` by default. */
    entry?: string;
    timeoutMs?: number;
    maxBytes?: number;
    log?: (line: string) => void;
}

/**
 * One replay worker (CB-318), started on first use and kept: a replay of a
 * long thread deep-copies its history on every event, which blocked the
 * main thread (and failed the healthcheck) for minutes. Replays run one at
 * a time, in order; each has its own timeout from when the worker takes
 * it. A worker that stops, errors or times out fails the replay it had
 * with a `ReplayError` and is replaced for the next one (its cache goes
 * with it). Without worker threads it replays inline.
 */
export class ReplayPool implements ReplayerShape {
    private worker?: Worker;
    private queue: Pending[] = [];
    private current?: Pending & { timer: ReturnType<typeof setTimeout> };
    private nextId = 1;
    private inline?: InlineReplayer;
    private closed = false;
    private readonly log: (line: string) => void;
    constructor(private options: ReplayPoolOptions = {}) {
        this.log = options.log ?? ((line) => console.error(line));
    }

    /** The running worker's thread id, if one runs (tests). */
    get threadId() {
        return this.worker?.threadId;
    }

    messages(key: string, threadId: string, rows: StoredRunRow[], options: { timeoutMs?: number } = {}) {
        if (this.inline) {
            return this.inline.messages(key, threadId, rows);
        }
        return new Promise<{ messages: Message[]; stats: ReplayStats }>((resolve, reject) => {
            this.queue.push({
                request: { kind: 'messages', id: this.nextId++, key, threadId, rows },
                timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? REPLAY_TIMEOUT_MS,
                resolve,
                reject,
            });
            this.next();
        });
    }

    forget(key: string) {
        this.inline?.forget(key);
        this.worker?.postMessage({ kind: 'forget', key } satisfies ReplayRequest);
    }

    forgetPrefix(prefix: string) {
        this.inline?.forgetPrefix(prefix);
        this.worker?.postMessage({ kind: 'forgetPrefix', prefix } satisfies ReplayRequest);
    }

    /** Stops the worker; replays waiting or running fail. */
    async close() {
        this.closed = true;
        const error = new ReplayError('The replay worker was closed.', 'crash');
        for (const pending of this.queue.splice(0)) {
            pending.reject(error);
        }
        if (this.current) {
            clearTimeout(this.current.timer);
            this.current.reject(error);
            this.current = undefined;
        }
        const worker = this.worker;
        this.worker = undefined;
        await worker?.terminate();
    }

    private spawn(): Worker | undefined {
        const entry = this.options.entry ?? replayWorkerEntry();
        let worker: Worker;
        try {
            worker = new Worker(entry, {
                execArgv: entry.endsWith('.ts') ? ['--import', 'tsx'] : [],
                workerData: { maxBytes: this.options.maxBytes ?? REPLAY_CACHE_BYTES },
                // None of the server's environment: it replays events, nothing else.
                env: {},
            });
        } catch (error) {
            this.log(`Replay: worker threads are unavailable, replaying on the main thread (${String(error)}).`);
            this.inline = new InlineReplayer(this.options.maxBytes);
            return undefined;
        }
        // An idle worker never holds the process open; a replay in progress does.
        worker.unref();
        worker.on('message', (response: ReplayResponse) => this.answer(worker, response));
        worker.on('error', (error: unknown) =>
            this.lost(worker, `The replay worker failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        worker.on('messageerror', (error) =>
            this.lost(worker, `The replay worker sent an unreadable answer: ${String(error)}`),
        );
        worker.on('exit', (code) => this.lost(worker, `The replay worker stopped (exit code ${code}).`));
        return worker;
    }

    private next() {
        if (this.current || this.closed) {
            return;
        }
        const pending = this.queue.shift();
        if (!pending) {
            return;
        }
        if (!this.worker) {
            this.worker = this.spawn();
            if (!this.worker) {
                // No worker threads: this and every later replay run inline.
                const queued = [pending, ...this.queue.splice(0)];
                for (const { request, resolve, reject } of queued) {
                    this.inline!.messages(request.key, request.threadId, request.rows).then(resolve, reject);
                }
                return;
            }
        }
        const worker = this.worker;
        const timer = setTimeout(() => {
            this.log(
                `Replay: thread ${pending.request.threadId} took over ${pending.timeoutMs} ms; replacing the worker.`,
            );
            this.replace(
                worker,
                new ReplayError(`Replaying the conversation took longer than ${pending.timeoutMs} ms.`, 'timeout'),
            );
        }, pending.timeoutMs);
        this.current = { ...pending, timer };
        worker.ref();
        worker.postMessage(pending.request);
    }

    private answer(worker: Worker, response: ReplayResponse) {
        const current = this.current;
        if (worker !== this.worker || !current || current.request.id !== response.id) {
            return;
        }
        clearTimeout(current.timer);
        this.current = undefined;
        worker.unref();
        if (response.ok) {
            current.resolve({ messages: response.messages, stats: response.stats });
        } else {
            current.reject(new ReplayError(`Replaying the conversation failed: ${response.error}`, 'replay'));
        }
        this.next();
    }

    private lost(worker: Worker, message: string) {
        if (worker !== this.worker) {
            return;
        }
        if (!this.closed) {
            this.log(`Replay: ${message}`);
        }
        this.replace(worker, new ReplayError(message, 'crash'));
    }

    /** Drops `worker`, fails its replay with `error`, and goes on with a new one. */
    private replace(worker: Worker, error: ReplayError) {
        if (worker !== this.worker) {
            return;
        }
        this.worker = undefined;
        void worker.terminate().catch(() => {});
        const current = this.current;
        this.current = undefined;
        if (current) {
            clearTimeout(current.timer);
            current.reject(error);
        }
        this.next();
    }
}

let shared: ReplayerShape | undefined;

/**
 * The process's replayer: its replay worker, started on first use. With
 * `SOCIO_REPLAY=inline` (the test suite, whose timings assume replays
 * finish at once), it replays on the main thread instead.
 */
export function sharedReplayer(): ReplayerShape {
    shared ??= process.env.SOCIO_REPLAY === 'inline' ? new InlineReplayer() : new ReplayPool();
    return shared;
}
