import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import {
    ACTION_TIMEOUT_MS,
    CONTEXT_ID,
    GRANT_ID,
    IDLE_CLOSE_MS,
    SEALED,
    commandSchema,
    parseAppOrigin,
    type CommandResult,
    type WorkerMessage,
    type WorkerReply,
} from './protocol.js';

/**
 * The app browser's router (CB-232): the one process
 * Socio talks to, with `APP_BROWSER_SECRET`. It starts one worker process
 * per context (person + socio + grant), each under its own UID, and
 * relays Socio's commands to it. It holds no credential and no context
 * key: it relays the worker's public key out and the sealed credential
 * in, and can open neither (protocol.ts). It never logs a body.
 */

export interface WorkerLaunch {
    command: string;
    args: string[];
    env: Record<string, string>;
}

export interface RouterOptions {
    /** `APP_BROWSER_SECRET`: Socio's bearer token, 24+ characters. */
    secret: string;
    /** Socio's internal apps listener, where every worker fetches the app. */
    upstream: string;
    /** Contexts at most (`APP_BROWSER_MAX`). */
    max: number;
    idleMs?: number;
    /**
     * How a worker in `slot` starts; slot `max` is the start-up self-test's.
     * Production: setpriv to UID `APP_BROWSER_UID_BASE + slot`, no
     * capabilities, no new privileges (`setprivLaunch`).
     */
    launch: (slot: number) => WorkerLaunch;
    /** How long a worker may take to say it is ready. */
    readyMs?: number;
    now?: () => number;
    log?: (line: string) => void;
}

const WORKER_FILE = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    return import.meta.url.endsWith('.ts') ? join(here, 'worker.ts') : join(here, 'worker.js');
})();

/** The worker's environment: nothing of the router's but these. */
export function workerEnv(source: NodeJS.ProcessEnv = process.env) {
    const env: Record<string, string> = {
        PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: '/tmp',
        TMPDIR: '/tmp',
        NODE_ENV: source.NODE_ENV ?? 'production',
    };
    if (source.PLAYWRIGHT_BROWSERS_PATH) {
        env.PLAYWRIGHT_BROWSERS_PATH = source.PLAYWRIGHT_BROWSERS_PATH;
    }
    return env;
}

/** Node running the worker file (with tsx from source, in development). */
export function nodeWorkerArgs(heapMb = 256) {
    return [`--max-old-space-size=${heapMb}`, ...(WORKER_FILE.endsWith('.ts') ? ['--import', 'tsx'] : []), WORKER_FILE];
}

/**
 * Production: each slot its own UID, no capabilities, no new privileges
 * (the app runtime's setpriv).
 */
export function setprivLaunch(uidBase: number) {
    return (slot: number): WorkerLaunch => {
        const uid = String(uidBase + slot);
        return {
            command: 'setpriv',
            args: [
                `--reuid=${uid}`,
                `--regid=${uid}`,
                '--clear-groups',
                '--inh-caps=-all',
                '--ambient-caps=-all',
                '--no-new-privs',
                '--',
                process.execPath,
                ...nodeWorkerArgs(),
            ],
            env: workerEnv(),
        };
    };
}

/**
 * Development and tests: the worker as this user, with this user's HOME
 * (where Playwright keeps its browsers when PLAYWRIGHT_BROWSERS_PATH is
 * unset).
 */
export const sameUserLaunch = (): WorkerLaunch => ({
    command: process.execPath,
    args: nodeWorkerArgs(),
    env: { ...workerEnv(), HOME: process.env.HOME ?? '/tmp' },
});

/** One running worker, spoken to over its stdin and stdout. */
class WorkerProcess {
    publicKey = '';
    private next = 1;
    private waiting = new Map<number, (result: CommandResult) => void>();
    private ready: Promise<void>;
    private exited = false;
    constructor(
        readonly child: ChildProcessWithoutNullStreams,
        readyMs: number,
    ) {
        let resolveReady!: () => void;
        let rejectReady!: (error: Error) => void;
        this.ready = new Promise((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });
        const timer = setTimeout(() => rejectReady(new Error('The worker did not start.')), readyMs);
        createInterface({ input: child.stdout }).on('line', (line) => {
            let reply: WorkerReply;
            try {
                reply = JSON.parse(line) as WorkerReply;
            } catch {
                return;
            }
            if ('type' in reply && reply.type === 'ready') {
                if (typeof reply.publicKey === 'string') {
                    this.publicKey = reply.publicKey;
                }
                clearTimeout(timer);
                resolveReady();
                return;
            }
            if (!('id' in reply)) {
                return;
            }
            const done = this.waiting.get(reply.id);
            if (!done) {
                return;
            }
            this.waiting.delete(reply.id);
            done(
                reply.ok
                    ? { ok: true, result: reply.result ?? {} }
                    : { ok: false, error: String(reply.error ?? 'Failed.') },
            );
        });
        // A worker's own logs go nowhere: they could name what a page showed.
        child.stderr.resume();
        child.on('exit', () => {
            this.exited = true;
            clearTimeout(timer);
            rejectReady(new Error('The worker exited.'));
            for (const done of this.waiting.values()) {
                done({ ok: false, error: 'The app browser context ended.' });
            }
            this.waiting.clear();
        });
        child.on('error', () => undefined);
        child.stdin.on('error', () => undefined);
    }

    get alive() {
        return !this.exited;
    }
    started() {
        return this.ready;
    }

    request(message: WorkerMessage, timeoutMs = ACTION_TIMEOUT_MS): Promise<CommandResult> {
        if (this.exited) {
            return Promise.resolve({
                ok: false,
                error: 'The app browser context ended.',
            });
        }
        const id = this.next++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.waiting.delete(id);
                resolve({ ok: false, error: 'The app took too long.' });
            }, timeoutMs);
            this.waiting.set(id, (result) => {
                clearTimeout(timer);
                resolve(result);
            });
            this.child.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
        });
    }

    /** SIGTERM, then SIGKILL: this child's own PID, never a pattern. */
    stop() {
        if (this.exited) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            const kill = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
            this.child.once('exit', () => {
                clearTimeout(kill);
                resolve();
            });
            this.child.stdin.end();
            this.child.kill('SIGTERM');
        });
    }
}

interface ContextEntry {
    id: string;
    grantId: string;
    slot: number;
    worker: WorkerProcess;
    openedAt: number;
    lastUsedAt: number;
}

const openSchema = z
    .object({
        contextId: z.string().regex(CONTEXT_ID),
        grantId: z.string().regex(GRANT_ID),
        origin: z.string().max(300),
        /** The router boot Socio expects; a restarted router refuses. */
        bootId: z.string().uuid().optional(),
    })
    .strict();

export class AppBrowserRouter {
    /** Changes on every start: Socio closes contexts of an older boot. */
    readonly bootId = randomUUID();
    private contexts = new Map<string, ContextEntry>();
    /** Contexts whose worker is still starting, by slot: neither is given twice. */
    private starting = new Map<string, number>();
    private timer?: ReturnType<typeof setInterval>;
    private now: () => number;
    constructor(private options: RouterOptions) {
        if (options.secret.length < 24) {
            throw new Error('APP_BROWSER_SECRET must be at least 24 characters.');
        }
        if (!parseAppOrigin(options.upstream)) {
            throw new Error('APP_BROWSER_UPSTREAM must be an http(s) origin.');
        }
        this.now = options.now ?? Date.now;
    }

    private freeSlot() {
        const used = new Set([...[...this.contexts.values()].map((c) => c.slot), ...this.starting.values()]);
        for (let slot = 0; slot < this.options.max; slot++) {
            if (!used.has(slot)) {
                return slot;
            }
        }
        return undefined;
    }

    private async start(slot: number) {
        const launch = this.options.launch(slot);
        const child = spawn(launch.command, launch.args, {
            env: launch.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const worker = new WorkerProcess(child, this.options.readyMs ?? 15_000);
        try {
            await worker.started();
        } catch (error) {
            await worker.stop();
            throw error;
        }
        return worker;
    }

    /** Opens a context: its worker starts and says its public key. */
    async open(input: z.infer<typeof openSchema>) {
        const origin = parseAppOrigin(input.origin);
        if (!origin) {
            return { status: 400 as const, body: { error: 'Invalid origin.' } };
        }
        if (input.bootId && input.bootId !== this.bootId) {
            return {
                status: 409 as const,
                body: { error: 'Restarted.', bootId: this.bootId },
            };
        }
        if (this.contexts.has(input.contextId) || this.starting.has(input.contextId)) {
            return {
                status: 409 as const,
                body: { error: 'Already open.', bootId: this.bootId },
            };
        }
        const slot = this.freeSlot();
        if (slot === undefined) {
            return {
                status: 429 as const,
                body: { error: 'The app browser is busy.' },
            };
        }
        this.starting.set(input.contextId, slot);
        let entry: ContextEntry;
        try {
            const worker = await this.start(slot);
            entry = {
                id: input.contextId,
                grantId: input.grantId,
                slot,
                worker,
                openedAt: this.now(),
                lastUsedAt: this.now(),
            };
            this.contexts.set(entry.id, entry);
        } catch {
            return {
                status: 503 as const,
                body: { error: 'The app browser could not start.' },
            };
        } finally {
            this.starting.delete(input.contextId);
        }
        const init = await entry.worker.request({
            type: 'init',
            contextId: input.contextId,
            origin: origin.origin,
            upstream: this.options.upstream,
        });
        if (!init.ok) {
            await this.close(entry.id);
            return { status: 400 as const, body: { error: init.error } };
        }
        entry.worker.child.once('exit', () => {
            if (this.contexts.get(entry.id) === entry) {
                this.contexts.delete(entry.id);
            }
        });
        return {
            status: 200 as const,
            body: { bootId: this.bootId, workerKey: entry.worker.publicKey },
        };
    }

    list() {
        return {
            bootId: this.bootId,
            contexts: [...this.contexts.values()].map((entry) => ({
                id: entry.id,
                grantId: entry.grantId,
                workerKey: entry.worker.publicKey,
                openedAt: entry.openedAt,
                lastUsedAt: entry.lastUsedAt,
            })),
        };
    }

    /** Relays a sealed credential; the router can't read it. */
    async deliver(contextId: string, sealed: string) {
        const entry = this.contexts.get(contextId);
        if (!entry) {
            return { status: 404 as const, body: { error: 'No such context.' } };
        }
        const result = await entry.worker.request({ type: 'credential', sealed });
        return result.ok
            ? { status: 200 as const, body: result.result }
            : { status: 400 as const, body: { error: result.error } };
    }

    async command(contextId: string, command: unknown) {
        const entry = this.contexts.get(contextId);
        if (!entry) {
            return { status: 404 as const, body: { error: 'No such context.' } };
        }
        const parsed = commandSchema.safeParse(command);
        if (!parsed.success || parsed.data.op === 'sandbox') {
            return { status: 400 as const, body: { error: 'Invalid command.' } };
        }
        entry.lastUsedAt = this.now();
        const result = await entry.worker.request({
            type: 'command',
            command: parsed.data,
        });
        entry.lastUsedAt = this.now();
        return result.ok
            ? { status: 200 as const, body: { result: result.result } }
            : { status: 422 as const, body: { error: result.error } };
    }

    async close(contextId: string) {
        const entry = this.contexts.get(contextId);
        if (!entry) {
            return false;
        }
        this.contexts.delete(contextId);
        await entry.worker.stop();
        return true;
    }

    /** Every context of a grant (a revocation). */
    async closeGrant(grantId: string) {
        const ids = [...this.contexts.values()].filter((entry) => entry.grantId === grantId).map((entry) => entry.id);
        await Promise.all(ids.map((id) => this.close(id)));
        return ids.length;
    }

    /** Contexts idle past the limit close. */
    async closeIdle() {
        const limit = this.options.idleMs ?? IDLE_CLOSE_MS;
        const idle = [...this.contexts.values()].filter(
            (entry) => this.now() - entry.lastUsedAt >= limit || !entry.worker.alive,
        );
        await Promise.all(idle.map((entry) => this.close(entry.id)));
        return idle.length;
    }

    /**
     * The start-up self-test: a worker in the reserved slot launches
     * Chromium and reports whether its renderer is sandboxed.
     */
    async selfTest() {
        const worker = await this.start(this.options.max);
        try {
            const report = await worker.request({ type: 'command', command: { op: 'sandbox' } }, 60_000);
            return report.ok
                ? (report.result as {
                      sandboxed: boolean;
                      renderers: number;
                      uid: number | null;
                  })
                : { sandboxed: false, renderers: 0, uid: null, error: report.error };
        } finally {
            await worker.stop();
        }
    }

    watch(everyMs = 30_000) {
        if (this.timer) {
            return;
        }
        this.timer = setInterval(() => void this.closeIdle(), everyMs);
        this.timer.unref();
    }

    async stop() {
        clearInterval(this.timer);
        this.timer = undefined;
        await Promise.all([...this.contexts.keys()].map((id) => this.close(id)));
    }

    /** The HTTP API Socio calls (broker-client.ts). */
    app() {
        const app = new Hono();
        const expected = Buffer.from(this.options.secret);
        app.get('/healthz', (c) => c.json({ ok: true }));
        app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
        app.use('*', async (c, next) => {
            const supplied = Buffer.from(/^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '');
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
                return c.json({ error: 'Unauthorized' }, 401);
            }
            await next();
        });
        const json = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);
        const idOf = (value: string) => (CONTEXT_ID.test(value) ? value : undefined);
        app.get('/contexts', (c) => c.json(this.list()));
        app.post('/contexts', async (c) => {
            const parsed = openSchema.safeParse(await json(c));
            if (!parsed.success) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            const { status, body } = await this.open(parsed.data);
            return c.json(body, status);
        });
        app.put('/contexts/:id/credential', async (c) => {
            const id = idOf(c.req.param('id'));
            const parsed = z
                .object({ sealed: z.string().regex(SEALED) })
                .strict()
                .safeParse(await json(c));
            if (!id || !parsed.success) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            const { status, body } = await this.deliver(id, parsed.data.sealed);
            return c.json(body, status);
        });
        app.post('/contexts/:id/commands', async (c) => {
            const id = idOf(c.req.param('id'));
            const body = (await json(c)) as { command?: unknown } | null;
            if (!id || !body) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            const result = await this.command(id, body.command);
            return c.json(result.body, result.status);
        });
        app.delete('/contexts/:id', async (c) => {
            const id = idOf(c.req.param('id'));
            if (!id) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            return c.json({ closed: await this.close(id) });
        });
        app.delete('/grants/:id', async (c) => {
            const id = c.req.param('id');
            if (!GRANT_ID.test(id)) {
                return c.json({ error: 'Invalid request.' }, 400);
            }
            return c.json({ closed: await this.closeGrant(id) });
        });
        return app;
    }
}
