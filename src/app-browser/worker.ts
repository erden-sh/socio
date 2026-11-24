import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { OriginLock, type ContextCredential } from './intercept.js';
import { chromiumLaunchOptions, contextOptions, PAGE_INIT_SCRIPT } from './launch.js';
import {
    ACTION_TIMEOUT_MS,
    CONTEXT_ID,
    SNAPSHOT_CHARS,
    commandSchema,
    contextSecretSchema,
    openSealed,
    parseAppOrigin,
    workerKeyPair,
    type BrowserCommand,
    type CommandResult,
    type WorkerReply,
    type WorkerRequest,
} from './protocol.js';

/**
 * One app browser context (CB-232): a process of its own, under its
 * own UID in the container (the router starts it with setpriv), holding
 * only its own context's credential and key, running one sandboxed
 * Chromium locked to one app origin. It talks only to the router, over
 * stdin and stdout, one JSON line per message.
 */

export class ContextWorker {
    readonly keys = workerKeyPair();
    private contextId?: string;
    private origin?: URL;
    private upstream?: URL;
    private credential?: ContextCredential;
    private browser?: Browser;
    private context?: BrowserContext;
    private page?: Page;
    private lock?: OriginLock;
    private snapshotId = 0;
    private home?: string;

    constructor(private now: () => number = Date.now) {}

    async handle(request: WorkerRequest): Promise<CommandResult> {
        switch (request.type) {
            case 'init':
                return this.init(request);
            case 'credential':
                return this.receive(request.sealed);
            case 'command': {
                const parsed = commandSchema.safeParse(request.command);
                if (!parsed.success) {
                    return { ok: false, error: 'Invalid command.' };
                }
                try {
                    return { ok: true, result: await this.run(parsed.data) };
                } catch (error) {
                    return { ok: false, error: this.clean(messageOf(error)) };
                }
            }
        }
    }

    private init(request: Extract<WorkerRequest, { type: 'init' }>): CommandResult {
        if (this.contextId) {
            return { ok: false, error: 'Already started.' };
        }
        const origin = parseAppOrigin(request.origin);
        const upstream = parseAppOrigin(request.upstream);
        if (!CONTEXT_ID.test(request.contextId) || !origin || !upstream) {
            return { ok: false, error: 'Invalid context.' };
        }
        this.contextId = request.contextId;
        this.origin = origin;
        this.upstream = upstream;
        return { ok: true, result: {} };
    }

    /** A sealed credential from Socio: only this worker can open it. */
    private receive(sealed: string): CommandResult {
        if (!this.contextId) {
            return { ok: false, error: 'Not started.' };
        }
        const parsed = contextSecretSchema.safeParse(openSealed(this.keys, this.contextId, sealed));
        if (!parsed.success) {
            return { ok: false, error: 'Invalid credential.' };
        }
        if (parsed.data.expiresAt <= this.now()) {
            return { ok: false, error: 'Expired credential.' };
        }
        this.credential = {
            token: parsed.data.token,
            key: Buffer.from(parsed.data.key, 'base64url'),
            expiresAt: parsed.data.expiresAt,
        };
        return { ok: true, result: { expiresAt: parsed.data.expiresAt } };
    }

    private async launch() {
        if (this.page && !this.page.isClosed()) {
            return this.page;
        }
        if (!this.origin || !this.upstream) {
            throw new Error('Not started.');
        }
        // Its own directory (0700, this worker's UID): nothing of another
        // context's profile is readable here.
        this.home ??= mkdtempSync(join(tmpdir(), 'app-browser-'));
        this.browser ??= await chromium.launch(chromiumLaunchOptions(this.home));
        this.context = await this.browser.newContext(contextOptions());
        this.context.setDefaultTimeout(ACTION_TIMEOUT_MS - 5_000);
        await this.context.addInitScript(PAGE_INIT_SCRIPT);
        this.lock = new OriginLock({
            origin: this.origin,
            upstream: this.upstream,
            credential: () => this.credential,
            now: this.now,
        });
        await this.lock.attach(this.context);
        const page = await this.context.newPage();
        // Popups, file pickers and downloads go nowhere.
        this.context.on('page', (other) => {
            if (other !== this.page) {
                void other.close().catch(() => undefined);
            }
        });
        page.on('filechooser', () => undefined);
        page.on('download', (download) => void download.cancel().catch(() => undefined));
        // A main-frame navigation that left the origin some way routing
        // didn't see (a data: or blob: document): back to a blank page.
        page.on('framenavigated', (frame) => {
            if (frame !== page.mainFrame()) {
                return;
            }
            const url = frame.url();
            if (url === 'about:blank' || url.startsWith('chrome-error:') || url.startsWith(this.origin!.origin + '/')) {
                return;
            }
            if (this.lock) {
                this.lock.stats.blocked++;
                this.lock.stats.ended = 'a page outside the app';
            }
            void page.goto('about:blank').catch(() => undefined);
        });
        this.page = page;
        return page;
    }

    /**
     * Waits for same-origin navigation redirects to land (the lock answers
     * them with a refresh page, intercept.ts), a few hops at most.
     */
    private async settle(page: Page) {
        for (let hop = 0; hop < 10; hop++) {
            const next = this.lock?.takeRedirect();
            if (!next) {
                return;
            }
            await page.waitForURL((url) => url.href === next, { timeout: 10_000 }).catch(() => undefined);
            await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        }
    }

    private ended() {
        const ended = this.lock?.stats.ended;
        if (this.lock) {
            this.lock.stats.ended = undefined;
        }
        return ended ? { stopped: `The app browser stopped ${ended}.` } : {};
    }

    private state(page: Page) {
        return {
            url: page.url(),
            blocked: this.lock?.stats.blocked ?? 0,
            // Counted apart for the context audit.
            offOriginRedirects: this.lock?.stats.offOriginRedirects ?? 0,
            ...this.ended(),
        };
    }

    private async run(command: BrowserCommand): Promise<Record<string, unknown>> {
        if (command.op === 'sandbox') {
            return this.sandboxReport();
        }
        if (!this.credential || this.credential.expiresAt <= this.now()) {
            throw new Error('This app browser’s access has ended.');
        }
        const page = await this.launch();
        switch (command.op) {
            case 'open': {
                const response = await page.goto(this.origin!.origin + command.path, {
                    waitUntil: 'domcontentloaded',
                    timeout: ACTION_TIMEOUT_MS - 5_000,
                });
                const redirected = await this.settle(page).then(() => page.url());
                return {
                    status: redirected === response?.url() ? (response?.status() ?? null) : null,
                    title: await page.title(),
                    ...this.state(page),
                };
            }
            case 'snapshot': {
                const text = await page.ariaSnapshot({ mode: 'ai' });
                this.snapshotId++;
                return {
                    snapshotId: this.snapshotId,
                    title: await page.title(),
                    snapshot: this.clean(text).slice(0, SNAPSHOT_CHARS),
                    ...this.state(page),
                };
            }
            case 'click':
            case 'type': {
                if (command.snapshotId !== this.snapshotId) {
                    throw new Error('That snapshot is old: take a fresh app_snapshot.');
                }
                const target = page.locator(`aria-ref=${command.ref}`);
                if (command.op === 'click') {
                    await target.click();
                } else {
                    await target.fill(command.text);
                    if (command.submit) {
                        await target.press('Enter');
                    }
                }
                await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
                await this.settle(page);
                return { title: await page.title(), ...this.state(page) };
            }
            case 'screenshot': {
                const bytes = await page.screenshot({ type: 'jpeg', quality: 80 });
                const viewport = page.viewportSize();
                return {
                    base64: bytes.toString('base64'),
                    ...(viewport ? { width: viewport.width, height: viewport.height } : {}),
                    capturedAt: new Date(this.now()).toISOString(),
                    ...this.state(page),
                };
            }
        }
    }

    /**
     * The self-test: Chromium starts with its sandbox, renders a page with
     * no network, and its renderer runs under seccomp-bpf in a user
     * namespace of its own. Linux only (it reads /proc).
     */
    private async sandboxReport() {
        const browser = await chromium.launch(chromiumLaunchOptions());
        try {
            const page = await browser.newPage();
            await page.setContent('<p>sandbox check</p>');
            const renderers = descendants(process.pid).filter((proc) => /--type=renderer\b/.test(proc.cmdline));
            const ownUserNs = safeReadlink('/proc/self/ns/user');
            const sandboxed =
                renderers.length > 0 && renderers.every((proc) => proc.seccomp === 2 && proc.userNs !== ownUserNs);
            return {
                sandboxed,
                renderers: renderers.length,
                uid: process.getuid?.() ?? null,
            };
        } finally {
            await browser.close().catch(() => undefined);
        }
    }

    /** This context's own secrets out of any text it returns. */
    private clean(text: string) {
        const token = this.credential?.token;
        return token ? text.split(token).join('[redacted]') : text;
    }

    async close() {
        await this.browser?.close().catch(() => undefined);
        this.browser = undefined;
        this.credential = undefined;
        if (this.home) {
            rmSync(this.home, { recursive: true, force: true });
        }
    }
}

const messageOf = (error: unknown) =>
    (error instanceof Error ? error.message : 'The app browser failed.').split('\n')[0]!.slice(0, 300);

const safeReadlink = (path: string) => {
    try {
        return readlinkSync(path);
    } catch {
        return '';
    }
};

interface ProcInfo {
    pid: number;
    ppid: number;
    cmdline: string;
    seccomp: number;
    userNs: string;
}

/** Every process descended from `root`, read from /proc. */
export function descendants(root: number): ProcInfo[] {
    const all: ProcInfo[] = [];
    for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) {
            continue;
        }
        try {
            const status = readFileSync(`/proc/${entry}/status`, 'utf8');
            all.push({
                pid: Number(entry),
                ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0),
                cmdline: readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' '),
                seccomp: Number(/^Seccomp:\s+(\d)/m.exec(status)?.[1] ?? 0),
                userNs: safeReadlink(`/proc/${entry}/ns/user`),
            });
        } catch {
            // Gone, or not ours to read.
        }
    }
    const mine = new Set([root]);
    for (let grew = true; grew;) {
        grew = false;
        for (const proc of all) {
            if (!mine.has(proc.pid) && mine.has(proc.ppid)) {
                mine.add(proc.pid);
                grew = true;
            }
        }
    }
    return all.filter((proc) => proc.pid !== root && mine.has(proc.pid));
}

/** The worker process: one JSON line in, one out, until stdin closes. */
export async function runWorker() {
    const worker = new ContextWorker();
    const write = (reply: WorkerReply) => process.stdout.write(`${JSON.stringify(reply)}\n`);
    write({ type: 'ready', publicKey: worker.keys.publicKey });
    let queue = Promise.resolve();
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', (line) => {
        queue = queue.then(async () => {
            let request: WorkerRequest;
            try {
                request = JSON.parse(line) as WorkerRequest;
            } catch {
                return;
            }
            if (typeof request?.id !== 'number') {
                return;
            }
            write({ id: request.id, ...(await worker.handle(request)) });
        });
    });
    const stop = () => void queue.finally(() => worker.close()).finally(() => process.exit(0));
    lines.on('close', stop);
    process.on('SIGTERM', stop);
}

if (process.argv[1] && /app-browser[\\/]worker\.(?:ts|js)$/.test(process.argv[1])) {
    void runWorker();
}
