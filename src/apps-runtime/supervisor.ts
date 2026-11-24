import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    chmodSync,
    chownSync,
    closeSync,
    constants,
    existsSync,
    fchownSync,
    fstatSync,
    lchownSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import { decodeBundle, BundleError } from '@socio/foundation/apps/bundle';
import { LogRedactor, secretSettings } from '@socio/foundation/apps/log-redact';
import type { AppManifest } from '@socio/shared/apps/app-manifest';
import {
    RUNTIME_ACTOR_ENV,
    RUNTIME_APP_ID,
    type RuntimeAppStatus,
    type RuntimeAttempt,
    type RuntimeAttemptState,
    type RuntimeExitReason,
    type RuntimeProcessState,
    type RuntimeStartRequest,
} from '@socio/shared/apps/apps-runtime-types';

import { agentUserCommand } from './agent-user.js';
import type { RuntimeConfig } from './config.js';
import { egressProxyUrl } from './keys.js';

/** A key (base64url, 43) or the previous key's deadline (epoch ms). */
const ACTOR_ENV_VALUE = /^(?:[A-Za-z0-9_-]{43}|\d{1,16})$/;

export class RuntimeError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 403 | 404 | 409 | 413 | 500 | 503 = 400,
    ) {
        super(message);
    }
}

interface Version {
    dir: string;
    sha256: string;
    manifest: AppManifest;
}
/** A line a flood held back, or a notice among them. */
interface Held {
    source: 'out' | 'err' | 'runtime';
    raw: string;
    cut: boolean;
}
/** An attempt as kept here: its output's size, and what ended it. */
interface Attempt extends RuntimeAttempt {
    bytes: number;
    /**
     * Values its own process was given that its output must not show (secret
     * settings, egress credentials): a later start's are its own.
     */
    secrets: string[];
    /** Its redactor, for the app's tokens as of `secretsSeen`. */
    redactor?: LogRedactor;
    secretsSeen?: number;
    /**
     * Lines over `LINES_PER_SECOND`: the second, its count, the newest held
     * (in the order they came), and whether it drains (exited or stopping:
     * every later line is held).
     */
    rate: {
        second: number;
        count: number;
        held: Held[];
        dropped: number;
        draining: boolean;
        timer?: ReturnType<typeof setTimeout>;
    };
    /** Its streams still open, and who waits for them to end. */
    open: number;
    done: Array<() => void>;
    /** The memory watchdog killed it. */
    oom?: boolean;
    /** Its command couldn't run. */
    spawnError?: string;
}
interface AppProcess {
    id: string;
    /** Versions that can start: unpacked, with their install finished. */
    versions: Map<number, Version>;
    /** Versions unpacking or installing now, by version: their bundle and end. */
    builds: Map<number, { sha256: string; done: Promise<void> }>;
    uid?: number;
    child?: ChildProcess;
    state: RuntimeProcessState;
    version: number | null;
    startedAt: number | null;
    /** What the last start asked for: crashes restart it. */
    wanted?: RuntimeStartRequest;
    stopping: boolean;
    crashes: number[];
    restartTimer?: ReturnType<typeof setTimeout>;
    logs: string[];
    /** Values never shown in the logs (the data token). */
    secrets: Set<string>;
    /** Counts changes to `secrets`: attempts' redactors follow it. */
    secretsChanged: number;
    /** Build and start attempts, oldest first (`ATTEMPTS_KEPT`). */
    attempts: Attempt[];
    /** The start attempt of the process now (or last) running. */
    current?: Attempt;
    error: string | null;
}

const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_CRASHES = 5;
const STOP_GRACE_MS = 5_000;
/** Attempts kept per app, and each one's output (its last lines). */
export const ATTEMPTS_KEPT = 10;
export const ATTEMPT_LINES = 400;
export const ATTEMPT_BYTES = 32 * 1024;
/** What `GET /v1/apps/:id/attempts` sends at most (the app reads up to 1 MB). */
export const ATTEMPTS_RESPONSE_BYTES = 512 * 1024;
/** Characters kept of one line of output. */
export const LINE_CHARS = 1000;
/** Characters of a raw line read at most (color codes leave less). */
const RAW_CHARS = 4 * LINE_CHARS;
/**
 * Lines of one attempt taken per second; past it, the newest `HELD_LINES`
 * wait for the next second, stderr's first. Output is always read at
 * once: an app waiting on a full pipe slows to a crawl, and one that
 * crashes then loses what it queued (its stack trace).
 */
export const LINES_PER_SECOND = 500;
export const HELD_LINES = 50;
/** Characters a cut line loses at least: part of a key may sit there. */
const CUT_MARGIN = 64;
/** How long the end of a process's output is waited for after it exits. */
const OUTPUT_GRACE_MS = 2_000;
/** Terminal colors and cursor moves, and other control characters. */
// oxlint-disable-next-line no-control-regex -- output is cleaned of these
const ANSI = /\u001b\[[0-9;?]{0,32}[ -/]{0,8}[@-~]/g;
/** The start of a color code a cut line ends with. */
// oxlint-disable-next-line no-control-regex -- output is cleaned of these
const ANSI_SPLIT = /\u001b\[?[0-9;?]{0,32}[ -/]{0,8}$/;
// oxlint-disable-next-line no-control-regex -- output is cleaned of these
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Linux's O_PATH (x86-64, arm64): a handle on a path, opening nothing. */
const O_PATH = 0o10000000;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The workspace app runtime: promoted mini apps, each in its own
 * directory and process, as its own uid when isolation is on, with file,
 * process and memory limits, an environment of its own (no secrets but
 * its data token), egress only through the egress proxy with its
 * manifest's allowlist, and a unix socket as its only way in. Nothing
 * here is durable: the platform deploys and starts apps again after a
 * restart. Apps keep their state in the data space.
 */
export class AppsSupervisor {
    private apps = new Map<string, AppProcess>();
    private uids = new Map<string, number>();
    private watchdog?: ReturnType<typeof setInterval>;
    /** This process's run: attempt ids start with it. */
    readonly boot = randomUUID();
    constructor(
        private config: RuntimeConfig,
        private log: (line: string) => void = (line) => console.log(line),
    ) {}

    /** Empties the working directory and starts the memory watchdog. */
    init() {
        mkdirSync(this.config.dir, { recursive: true });
        // Apps' users pass through to their own directories; nobody lists.
        chmodSync(this.config.dir, 0o711);
        for (const entry of readdirSync(this.config.dir)) {
            this.removeTree(join(this.config.dir, entry));
        }
        this.watchdog = setInterval(() => this.checkMemory(), 5_000);
        this.watchdog.unref();
    }

    // ---- paths and users ----------------------------------------------------
    private appDir(id: string) {
        return join(this.config.dir, id);
    }
    socketPath(id: string) {
        return join(this.appDir(id), 'run', 'http.sock');
    }
    private tokenPath(id: string) {
        return join(this.appDir(id), 'run', 'data-token');
    }
    private uidFor(id: string) {
        const isolate = this.config.isolate;
        if (!isolate) {
            return undefined;
        }
        const known = this.uids.get(id);
        if (known !== undefined) {
            return known;
        }
        const used = new Set(this.uids.values());
        for (let n = 0; n < isolate.uidCount; n++) {
            const uid = isolate.uidBase + n;
            if (!used.has(uid)) {
                this.uids.set(id, uid);
                return uid;
            }
        }
        throw new RuntimeError('No free user for another app here.', 503);
    }
    /** Gives a tree to the app's user (group: this process's, read only). */
    private own(path: string, uid: number | undefined) {
        const isolate = this.config.isolate;
        const walk = (target: string) => {
            const stat = lstatSync(target);
            if (stat.isSymbolicLink()) {
                return;
            }
            if (stat.isDirectory()) {
                chmodSync(target, 0o750);
                for (const entry of readdirSync(target)) {
                    walk(join(target, entry));
                }
            } else {
                chmodSync(target, stat.mode & 0o100 ? 0o750 : 0o640);
            }
            if (isolate && uid !== undefined) {
                lchownSync(target, uid, isolate.gid);
            }
        };
        walk(path);
    }
    /**
     * The app's directory: its root stays this process's (0711, so the app's
     * user can pass but not list), `run/` (the socket and the token file:
     * setgid, shared with this process's group), `home/` and `tmp/` belong to
     * the app's user. Returns a new, empty directory for the version.
     */
    private prepare(id: string, uid: number | undefined, version: number) {
        const root = this.appDir(id);
        mkdirSync(root, { recursive: true });
        chmodSync(root, 0o711);
        for (const [sub, mode] of [
            ['run', 0o2770],
            ['home', 0o750],
            ['tmp', 0o750],
        ] as const) {
            const path = join(root, sub);
            if (existsSync(path)) {
                continue;
            }
            mkdirSync(path);
            chmodSync(path, mode);
            if (this.config.isolate && uid !== undefined) {
                lchownSync(path, uid, this.config.isolate.gid);
            }
        }
        const dir = join(root, `v${version}`);
        this.removeTree(dir);
        mkdirSync(dir);
        return dir;
    }
    /**
     * Removes a tree an app's user may own. Its directories are taken back
     * first, top down, each opened without following links and changed
     * through that descriptor (/proc/self/fd), so an app that swaps one for
     * a link meanwhile can't send this elsewhere; once a directory is this
     * process's, the app can't change what is in it.
     */
    private removeTree(path: string) {
        if (!existsSync(path)) {
            return;
        }
        if (this.config.isolate) {
            const self = process.getuid?.() ?? 0;
            const gid = process.getgid?.() ?? 0;
            const walk = (target: string) => {
                let fd: number;
                try {
                    fd = openSync(target, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                } catch {
                    // Not a directory, or gone: removing it takes only its parent.
                    return;
                }
                try {
                    const here = `/proc/self/fd/${fd}`;
                    chownSync(here, self, gid);
                    chmodSync(here, 0o700);
                    for (const entry of readdirSync(here)) {
                        walk(join(here, entry));
                    }
                } catch {
                    // Not ours to take: rmSync reports what matters.
                } finally {
                    closeSync(fd);
                }
            };
            walk(path);
        }
        rmSync(path, { recursive: true, force: true });
    }
    private entry(id: string): AppProcess {
        if (!RUNTIME_APP_ID.test(id)) {
            throw new RuntimeError('Invalid app id.');
        }
        let app = this.apps.get(id);
        if (!app) {
            if (this.apps.size >= this.config.maxApps) {
                throw new RuntimeError(`This runtime runs at most ${this.config.maxApps} apps.`, 503);
            }
            app = {
                id,
                versions: new Map(),
                builds: new Map(),
                state: 'not_deployed',
                version: null,
                startedAt: null,
                stopping: false,
                crashes: [],
                logs: [],
                secrets: new Set(),
                secretsChanged: 0,
                attempts: [],
                error: null,
            };
            this.apps.set(id, app);
        }
        return app;
    }
    private existing(id: string) {
        const app = RUNTIME_APP_ID.test(id) ? this.apps.get(id) : undefined;
        if (!app) {
            throw new RuntimeError('App not found here.', 404);
        }
        return app;
    }

    // ---- output -------------------------------------------------------------
    /**
     * The redactor for an attempt's output: the app's tokens and the
     * attempt's own values, built again only when either changed.
     */
    private redactorFor(app: AppProcess, attempt?: Attempt) {
        if (!attempt) {
            return new LogRedactor(app.secrets);
        }
        if (!attempt.redactor || attempt.secretsSeen !== app.secretsChanged) {
            attempt.redactor = new LogRedactor([...app.secrets, ...attempt.secrets]);
            attempt.secretsSeen = app.secretsChanged;
        }
        return attempt.redactor;
    }
    /** Adds the runtime's own lines (or a message) to the log. */
    private append(
        app: AppProcess,
        source: 'out' | 'err' | 'runtime',
        text: string,
        attempt: Attempt | undefined = app.current,
    ) {
        this.add(
            app,
            attempt,
            source,
            text
                .split(/\r?\n/)
                .filter(Boolean)
                .map((raw) => ({
                    raw: raw.slice(0, RAW_CHARS),
                    cut: raw.length > RAW_CHARS,
                })),
        );
    }
    /**
     * Adds lines to the app's log and to the attempt they belong to, each
     * attempt to its last `ATTEMPT_LINES` lines and `ATTEMPT_BYTES` bytes.
     * Each line is cleaned of color codes and control characters, then
     * redacted, then cut to `LINE_CHARS`. A line that came in cut loses its
     * last characters too, where part of a value may sit unrecognized.
     */
    private add(
        app: AppProcess,
        attempt: Attempt | undefined,
        source: 'out' | 'err' | 'runtime',
        lines: Array<{ raw: string; cut: boolean }>,
    ) {
        if (!lines.length) {
            return;
        }
        const redactor = this.redactorFor(app, attempt);
        const stamp = new Date().toISOString();
        for (const { raw, cut: came } of lines) {
            let clean = raw.replace(ANSI, '');
            // A color code the cut split in two goes too.
            if (came) {
                clean = clean.replace(ANSI_SPLIT, '');
            }
            clean = redactor.redact(clean.replace(CONTROL, '?'));
            if (came) {
                clean = clean.slice(0, Math.max(0, clean.length - Math.max(CUT_MARGIN, redactor.longest)));
            }
            const cut = came || clean.length > LINE_CHARS;
            const line = `${stamp} ${source} ${clean.slice(0, LINE_CHARS)}${cut ? ' […]' : ''}`;
            app.logs.push(line);
            if (!attempt) {
                continue;
            }
            attempt.lines.push(line);
            attempt.bytes += Buffer.byteLength(line) + 1;
            while (
                attempt.lines.length > 1 &&
                (attempt.lines.length > ATTEMPT_LINES || attempt.bytes > ATTEMPT_BYTES)
            ) {
                attempt.bytes -= Buffer.byteLength(attempt.lines.shift()!) + 1;
                attempt.dropped++;
            }
        }
        if (app.logs.length > this.config.logLines) {
            app.logs.splice(0, app.logs.length - this.config.logLines);
        }
    }
    logs(id: string, tail = 200) {
        const app = this.existing(id);
        return app.logs.slice(-Math.max(1, Math.min(tail, this.config.logLines)));
    }
    /**
     * Takes a child's lines without letting a flood hold up the runtime
     * (every app shares its event loop): of one write only the last
     * `ATTEMPT_LINES` are read, the rest dropped with a notice in their
     * place, and at most `LINES_PER_SECOND` lines a second per attempt.
     * Past that the newest `HELD_LINES` wait for the next second: stderr's
     * first (a crash's stack trace), stdout's in the room left.
     */
    private take(
        app: AppProcess,
        attempt: Attempt,
        source: 'out' | 'err',
        lines: Array<{ raw: string; cut: boolean }>,
        skipped: number,
    ) {
        const rate = attempt.rate;
        const now = Date.now();
        if (now - rate.second >= 1000) {
            this.release(app, attempt);
            rate.second = now;
            rate.count = 0;
        }
        // Once it drains (exited, stopping), late lines are held like a
        // flood's: they can't push out what came before them, such as a
        // stack trace.
        const holding = rate.held.length > 0 || rate.draining;
        if (skipped && holding) {
            rate.dropped += skipped;
        } else if (skipped) {
            // In its place, at once.
            attempt.dropped += skipped;
            this.add(app, attempt, 'runtime', [
                {
                    raw: `${skipped} lines dropped (more than ${ATTEMPT_LINES} in one write)`,
                    cut: false,
                },
            ]);
        }
        const room = holding ? 0 : Math.max(0, LINES_PER_SECOND - rate.count);
        const taken = lines.slice(0, room);
        rate.count += taken.length;
        this.add(app, attempt, source, taken);
        const over = lines.slice(room);
        if (over.length) {
            this.hold(attempt, source, over);
        }
        if (!rate.held.length) {
            return;
        }
        if (!rate.timer) {
            rate.timer = setTimeout(() => this.release(app, attempt), Math.max(1, rate.second + 1000 - now));
            rate.timer.unref?.();
        }
    }
    /** Holds lines for the next second: stderr's newest first, then stdout's. */
    private hold(attempt: Attempt, source: 'out' | 'err', lines: Array<{ raw: string; cut: boolean }>) {
        const rate = attempt.rate;
        const kept = lines.slice(-HELD_LINES);
        rate.dropped += lines.length - kept.length;
        rate.held.push(...kept.map((line) => ({ source, ...line })));
        const count = (of: 'out' | 'err') => rate.held.filter((line) => line.source === of).length;
        const errs = count('err');
        let over = {
            err: Math.max(0, errs - HELD_LINES),
            out: Math.max(0, count('out') - (HELD_LINES - Math.min(errs, HELD_LINES))),
        };
        if (!over.err && !over.out) {
            return;
        }
        // The oldest go first.
        rate.held = rate.held.filter((line) => {
            if (line.source === 'runtime' || !over[line.source]) {
                return true;
            }
            over = { ...over, [line.source]: over[line.source] - 1 };
            rate.dropped++;
            return false;
        });
    }
    /**
     * The next second: how many lines were dropped, then what was held, in
     * the order it came.
     */
    private release(app: AppProcess, attempt: Attempt) {
        const rate = attempt.rate;
        clearTimeout(rate.timer);
        rate.timer = undefined;
        // Dropped lines count as the attempt's dropped lines too.
        attempt.dropped += rate.dropped;
        if (rate.dropped) {
            this.append(
                app,
                'runtime',
                `${rate.dropped} lines dropped (more than ${LINES_PER_SECOND} a second)`,
                attempt,
            );
        }
        rate.dropped = 0;
        const held = rate.held.splice(0);
        for (let index = 0; index < held.length;) {
            const source = held[index].source;
            let end = index;
            while (end < held.length && held[end].source === source) {
                end++;
            }
            this.add(app, attempt, source, held.slice(index, end));
            index = end;
        }
        rate.second = Date.now();
        rate.count = held.length;
    }
    /** What is held comes out; later lines are only held (stop, exit). */
    private drain(app: AppProcess, attempt: Attempt | undefined) {
        if (!attempt) {
            return;
        }
        attempt.rate.draining = true;
        this.release(app, attempt);
    }
    /**
     * A child's stdout or stderr as lines: a line split between two writes
     * is joined (so is a secret in it) before it is added. A line longer
     * than `RAW_CHARS` is added cut, and the rest of it is dropped; what is
     * held stays that small.
     */
    private lines(app: AppProcess, source: 'out' | 'err', attempt: Attempt, stream: NodeJS.ReadableStream | null) {
        if (!stream) {
            return;
        }
        let pending = '';
        let dropping = false;
        attempt.open++;
        let ended = false;
        const end = () => {
            if (ended) {
                return;
            }
            ended = true;
            const last = pending && !dropping ? [{ raw: pending, cut: false }] : [];
            pending = '';
            this.take(app, attempt, source, last, 0);
            this.release(app, attempt);
            if (--attempt.open === 0) {
                for (const done of attempt.done.splice(0)) {
                    done();
                }
            }
        };
        // Characters split between two writes come out whole.
        stream.setEncoding('utf8');
        stream.on('data', (text: string) => {
            const ends: number[] = [];
            for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', end + 1)) {
                ends.push(end);
            }
            // Only the last lines of a write are read; the rest are counted.
            // (One fewer when some go, so the notice fits beside them.)
            const skip = ends.length > ATTEMPT_LINES ? ends.length - (ATTEMPT_LINES - 1) : 0;
            const lines: Array<{ raw: string; cut: boolean }> = [];
            let start = skip ? ends[skip - 1] + 1 : 0;
            if (skip) {
                pending = '';
                dropping = false;
            }
            for (const end of ends.slice(skip)) {
                if (!dropping) {
                    const raw = pending + text.slice(start, Math.min(end, start + RAW_CHARS));
                    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
                    if (line) {
                        lines.push({
                            raw: line.slice(0, RAW_CHARS),
                            cut: pending.length + end - start > RAW_CHARS,
                        });
                    }
                }
                pending = '';
                dropping = false;
                start = end + 1;
            }
            if (!dropping) {
                pending += text.slice(start, start + RAW_CHARS + 1 - pending.length);
                if (pending.length > RAW_CHARS) {
                    lines.push({ raw: pending.slice(0, RAW_CHARS), cut: true });
                    pending = '';
                    dropping = true;
                }
            }
            this.take(app, attempt, source, lines, skip);
        });
        stream.on('end', end);
        stream.on('close', end);
    }
    /** Resolves once an attempt's output has ended, or after `ms`. */
    private outputDone(attempt: Attempt, ms = OUTPUT_GRACE_MS) {
        return new Promise<void>((resolve) => {
            if (!attempt.open) {
                return resolve();
            }
            const timer = setTimeout(resolve, ms);
            timer.unref?.();
            attempt.done.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    /** A new attempt; the oldest ended ones past `ATTEMPTS_KEPT` go. */
    private begin(app: AppProcess, kind: 'build' | 'start', version: number) {
        const attempt: Attempt = {
            // The runtime's boot first: the app tells a restart from an age-out.
            id: `${this.boot}:${randomUUID()}`,
            version,
            kind,
            state: 'running',
            startedAt: Date.now(),
            upAt: null,
            endedAt: null,
            exit: null,
            lines: [],
            dropped: 0,
            bytes: 0,
            secrets: [],
            rate: {
                second: 0,
                count: 0,
                held: [],
                dropped: 0,
                draining: false,
            },
            open: 0,
            done: [],
        };
        app.attempts.push(attempt);
        // One still running (the app being served) stays however old.
        for (let index = 0; app.attempts.length > ATTEMPTS_KEPT && index < app.attempts.length;) {
            if (app.attempts[index].state === 'running') {
                index++;
            } else {
                app.attempts.splice(index, 1);
            }
        }
        return attempt;
    }
    /** Ends an attempt once; what ended it first is what it says. */
    private finish(
        app: AppProcess,
        attempt: Attempt,
        state: Exclude<RuntimeAttemptState, 'running'>,
        exit: {
            reason: RuntimeExitReason;
            code?: number | null;
            signal?: string | null;
            message: string;
        } | null,
    ) {
        if (attempt.state !== 'running') {
            return;
        }
        attempt.state = state;
        attempt.endedAt = Date.now();
        attempt.exit = exit && {
            reason: exit.reason,
            code: exit.code ?? null,
            signal: exit.signal ?? null,
            message: this.redactorFor(app, attempt).redact(exit.message.slice(0, 500)),
        };
    }
    /**
     * Its attempts with their last `tail` lines, oldest first (CB-146), and
     * this runtime's boot: within `ATTEMPTS_RESPONSE_BYTES` as JSON, the
     * newest attempts' lines first.
     */
    attempts(id: string, tail = ATTEMPT_LINES): { boot: string; attempts: RuntimeAttempt[] } {
        const app = this.existing(id);
        const keep = Math.max(1, Math.min(tail, ATTEMPT_LINES));
        let budget = ATTEMPTS_RESPONSE_BYTES;
        const attempts = [...app.attempts].reverse().map((attempt) => {
            const exit = attempt.exit && { ...attempt.exit };
            const head: Omit<RuntimeAttempt, 'lines' | 'dropped'> = {
                id: attempt.id,
                version: attempt.version,
                kind: attempt.kind,
                state: attempt.state,
                startedAt: attempt.startedAt,
                upAt: attempt.upAt,
                endedAt: attempt.endedAt,
                exit,
            };
            budget -= Buffer.byteLength(JSON.stringify(head)) + 32;
            const lines: string[] = [];
            for (const line of attempt.lines.slice(-keep).reverse()) {
                const size = Buffer.byteLength(JSON.stringify(line)) + 1;
                if (size > budget) {
                    break;
                }
                budget -= size;
                lines.push(line);
            }
            lines.reverse();
            return {
                ...head,
                lines,
                dropped: attempt.dropped + attempt.lines.length - lines.length,
            };
        });
        return { boot: this.boot, attempts: attempts.reverse() };
    }

    // ---- deploy -------------------------------------------------------------
    /** Unpacks a version (and installs its locked dependencies). */
    async deploy(id: string, version: number, bytes: Buffer, sha256: string) {
        if (!Number.isInteger(version) || version < 1 || version > 1_000_000) {
            throw new RuntimeError('Invalid version.');
        }
        if (sha(bytes) !== sha256) {
            throw new RuntimeError('The bundle does not match its checksum.');
        }
        const app = this.entry(id);
        const building = app.builds.get(version);
        if (building) {
            if (building.sha256 !== sha256) {
                throw new RuntimeError(`Version ${version} is being deployed; try again once it’s done.`, 409);
            }
            // The same bundle is installing (a Start meanwhile): its end is ours.
            await building.done;
            return this.status(id);
        }
        const current = app.versions.get(version);
        if (current?.sha256 === sha256) {
            return this.status(id);
        }
        if (current && app.version === version && app.state !== 'stopped') {
            throw new RuntimeError('That version is running; stop it first.', 409);
        }
        const done = this.buildAttempt(app, version, bytes, sha256);
        app.builds.set(version, { sha256, done });
        try {
            await done;
        } finally {
            app.builds.delete(version);
        }
        return this.status(id);
    }
    private async buildAttempt(app: AppProcess, version: number, bytes: Buffer, sha256: string) {
        // A build attempt: unpacking and installing, failures included.
        const attempt = this.begin(app, 'build', version);
        this.append(app, 'runtime', `building version ${version}`, attempt);
        try {
            await this.build(app, attempt, version, bytes, sha256);
        } catch (error) {
            const text = error instanceof RuntimeError ? error.message : 'The build failed.';
            this.append(app, 'runtime', text, attempt);
            this.finish(app, attempt, 'failed', { reason: 'build', message: text });
            throw error;
        }
        this.finish(app, attempt, 'succeeded', null);
        this.append(app, 'runtime', `deployed version ${version}`, attempt);
    }
    private async build(app: AppProcess, attempt: Attempt, version: number, bytes: Buffer, sha256: string) {
        let bundle;
        try {
            bundle = decodeBundle(bytes, this.config.bundleLimits);
        } catch (error) {
            throw new RuntimeError(
                error instanceof BundleError ? error.message : 'Unreadable bundle.',
                error instanceof BundleError ? 400 : 500,
            );
        }
        const uid = this.uidFor(app.id);
        // Its directory is emptied: the bundle it had there can't start now.
        app.versions.delete(version);
        const dir = this.prepare(app.id, uid, version);
        for (const file of bundle.files) {
            const target = join(dir, file.path);
            if (!target.startsWith(`${dir}/`)) {
                throw new RuntimeError('A bundle path leaves its directory.');
            }
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, file.data, {
                mode: file.executable ? 0o750 : 0o640,
            });
        }
        this.own(dir, uid);
        try {
            await this.install(app, attempt, dir, bundle.files);
        } catch (error) {
            this.removeTree(dir);
            throw error;
        }
        // Startable only now: a Start during the install would run it without
        // its dependencies (CB-150).
        app.versions.set(version, { dir, sha256, manifest: bundle.manifest });
        if (app.state === 'not_deployed') {
            app.state = 'stopped';
        }
        this.prune(app, version);
    }
    /**
     * Keeps the two newest versions, the one just deployed (a rollback may
     * deploy an older one), the running one and the one last asked for.
     */
    private prune(app: AppProcess, deployed: number) {
        const keep = new Set([...app.versions.keys()].sort((a, b) => b - a).slice(0, 2));
        keep.add(deployed);
        if (app.version !== null) {
            keep.add(app.version);
        }
        if (app.wanted) {
            keep.add(app.wanted.version);
        }
        for (const [version, entry] of app.versions) {
            if (!keep.has(version)) {
                this.removeTree(entry.dir);
                app.versions.delete(version);
            }
        }
    }
    private async install(
        app: AppProcess,
        attempt: Attempt,
        dir: string,
        files: Array<{ path: string; data: Buffer }>,
    ) {
        // From the bundle, not the directory: that is the app's user's now.
        const manifest = files.find((file) => file.path === 'package.json');
        if (!manifest) {
            return;
        }
        const paths = files.map((file) => file.path);
        let pkg: { dependencies?: Record<string, unknown> };
        try {
            pkg = JSON.parse(manifest.data.toString('utf8'));
        } catch {
            throw new RuntimeError('package.json is not valid JSON.');
        }
        if (!pkg.dependencies || !Object.keys(pkg.dependencies).length) {
            return;
        }
        if (!paths.some((path) => ['bun.lock', 'bun.lockb'].includes(path))) {
            throw new RuntimeError('The app has dependencies but no bun.lock: package it with its lockfile.');
        }
        if (!this.config.install || !this.config.registry || !this.config.egressProxy) {
            throw new RuntimeError(
                'The app has dependencies, but this runtime installs none (APPS_RUNTIME_INSTALL, APPS_RUNTIME_REGISTRY and the egress proxy).',
            );
        }
        const proxy = egressProxyUrl(this.config.egressProxy, this.config.token, `${app.id}`, [this.config.registry]);
        await this.proxyReady(app, attempt, this.config.egressProxy);
        this.append(app, 'runtime', 'installing dependencies', attempt);
        const ended = await this.run(
            app,
            attempt,
            this.config.install,
            dir,
            {
                ...this.baseEnv(app),
                HTTPS_PROXY: proxy,
                https_proxy: proxy,
                HTTP_PROXY: proxy,
                http_proxy: proxy,
            },
            this.config.installTimeoutMs,
            [new URL(proxy).password],
        );
        if (ended.code === 0) {
            return;
        }
        const message = ended.timedOut
            ? `Installing the dependencies took longer than ${this.config.installTimeoutMs / 1000} s.`
            : ended.error
              ? `Installing the dependencies couldn’t start: ${ended.error}.`
              : `Installing the dependencies failed (${ended.signal ? `signal ${ended.signal}` : `exit ${ended.code}`}); see the app's logs.`;
        // `deploy` adds the message to the log.
        this.finish(app, attempt, 'failed', {
            reason: 'build',
            code: ended.code,
            signal: ended.signal,
            message,
        });
        throw new RuntimeError(message);
    }
    /**
     * Waits up to `proxyWaitMs` for the egress proxy to take a connection.
     * When the stack starts, the proxy's name only resolves once it is
     * healthy, and an install before that fails at once (CB-149).
     */
    private async proxyReady(app: AppProcess, attempt: Attempt, proxy: string) {
        const url = new URL(proxy);
        const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
        const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        const deadline = Date.now() + this.config.proxyWaitMs;
        const reachable = () =>
            new Promise<boolean>((resolve) => {
                const socket = connect({ host, port });
                const done = (ok: boolean) => {
                    socket.destroy();
                    resolve(ok);
                };
                socket.setTimeout(2000, () => done(false));
                socket.once('connect', () => done(true));
                socket.once('error', () => done(false));
            });
        for (let tries = 0; !(await reachable()); tries++) {
            if (!tries) {
                this.append(app, 'runtime', 'waiting for the egress proxy', attempt);
            }
            const left = deadline - Date.now();
            if (left <= 0) {
                throw new RuntimeError(
                    `The egress proxy didn’t answer within ${this.config.proxyWaitMs / 1000} s, so the dependencies weren’t installed.`,
                    503,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000, left)));
        }
    }
    /**
     * Runs a one-off command as the app's user, its output to the attempt
     * (with `secrets` kept out); resolves with how it ended.
     */
    private run(
        app: AppProcess,
        attempt: Attempt,
        command: string[],
        cwd: string,
        env: Record<string, string>,
        timeoutMs: number,
        secrets: string[] = [],
    ) {
        const argv = this.argv(app, command);
        // This attempt's own: a start meanwhile keeps its own environment's.
        attempt.secrets = secrets;
        attempt.redactor = undefined;
        return new Promise<{
            code: number | null;
            signal: string | null;
            timedOut: boolean;
            error?: string;
        }>((resolve) => {
            let timedOut = false;
            const done = (result: { code: number | null; signal: string | null; error?: string }) => {
                clearTimeout(timer);
                resolve({ ...result, timedOut });
            };
            const child = spawn(argv[0], argv.slice(1), {
                cwd,
                env,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.lines(app, 'out', attempt, child.stdout);
            this.lines(app, 'err', attempt, child.stderr);
            const timer = setTimeout(() => {
                timedOut = true;
                this.kill(child, 'SIGKILL');
            }, timeoutMs);
            child.once('error', (error) => done({ code: 127, signal: null, error: error.message }));
            child.once('exit', (code, signal) => done({ code: code ?? (signal ? null : 1), signal }));
        });
    }

    // ---- processes ----------------------------------------------------------
    /** setpriv (own uid) and prlimit, then the command. */
    private argv(app: AppProcess, command: string[]) {
        const uid = this.uidFor(app.id);
        return [
            ...(uid !== undefined ? agentUserCommand(String(uid)) : []),
            ...(this.config.prlimit
                ? [
                      'prlimit',
                      '--nofile=1024',
                      // Counted per user (threads included): only with a user per app.
                      ...(uid !== undefined ? ['--nproc=512'] : []),
                      `--fsize=${64 * 1048576}`,
                      '--core=0',
                      '--',
                  ]
                : []),
            ...command,
        ];
    }
    private baseEnv(app: AppProcess): Record<string, string> {
        const root = this.appDir(app.id);
        return {
            PATH: this.config.path,
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            NODE_ENV: 'production',
            LANG: 'C.UTF-8',
            // Bun (and anything else that honors it) sends nothing of its own.
            DO_NOT_TRACK: '1',
        };
    }
    /** The app's environment; what it injects is kept out of the logs. */
    private appEnv(app: AppProcess, version: Version, spec: RuntimeStartRequest, attempt: Attempt) {
        const env: Record<string, string> = { ...this.baseEnv(app) };
        const settings: Record<string, string> = {};
        // Only what the manifest declares, and never a reserved name.
        for (const name of Object.keys(version.manifest.env ?? {})) {
            if (typeof spec.env[name] === 'string') {
                env[name] = settings[name] = spec.env[name].slice(0, 300);
            }
        }
        // Secret settings stay out of the logs; ordinary ones stay readable.
        const injected = secretSettings(settings, version.manifest.env ?? {});
        env.CB_SOCKET = this.socketPath(app.id);
        env.CB_APP_ID = app.id;
        env.CB_APP_URL = spec.appUrl;
        if (spec.dataUrl && spec.token) {
            env.CB_DATA_URL = spec.dataUrl;
            env.CB_DATA_TOKEN = spec.token;
            env.CB_DATA_TOKEN_FILE = this.tokenPath(app.id);
        }
        // CB-232: the app's envelope keys, kept out of its logs.
        for (const name of RUNTIME_ACTOR_ENV) {
            const value = spec.env[name];
            if (typeof value !== 'string' || !ACTOR_ENV_VALUE.test(value)) {
                continue;
            }
            env[name] = value;
            if (name !== 'CB_ACTOR_KEY_PREVIOUS_UNTIL') {
                injected.push(value);
            }
        }
        const egress = version.manifest.egress;
        if (this.config.egressProxy && egress.length) {
            const proxy = egressProxyUrl(this.config.egressProxy, this.config.token, app.id, egress);
            for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
                env[name] = proxy;
            }
            injected.push(new URL(proxy).password);
        }
        // This start's own: its output keeps them out, whatever starts later.
        attempt.secrets = injected;
        attempt.redactor = undefined;
        // The data API and the app's own loopback never go through the proxy.
        const direct = [
            ...(spec.dataUrl ? [new URL(spec.dataUrl).hostname] : []),
            'localhost',
            '127.0.0.1',
            '::1',
        ].join(',');
        env.NO_PROXY = direct;
        env.no_proxy = direct;
        return env;
    }
    private kill(child: ChildProcess, signal: NodeJS.Signals) {
        if (child.exitCode !== null || child.signalCode !== null) {
            return;
        }
        try {
            if (child.pid) {
                process.kill(-child.pid, signal);
            }
        } catch {
            try {
                child.kill(signal);
            } catch {
                // Already gone.
            }
        }
    }
    /**
     * The token file, readable by the app's user only. Created new under a
     * temporary name with its final mode, written and given to the app's
     * user through its descriptor (never by name: run/ is the app's), then
     * renamed into place. A chmod after the chown would need CAP_FOWNER,
     * which the runtime doesn't have.
     */
    private writeToken(app: AppProcess, token: string | null) {
        const path = this.tokenPath(app.id);
        mkdirSync(dirname(path), { recursive: true });
        if (!token) {
            rmSync(path, { force: true });
            return;
        }
        const temp = `${path}.${randomBytes(6).toString('hex')}`;
        try {
            const fd = openSync(temp, 'wx', 0o400);
            try {
                writeSync(fd, `${token}\n`);
                const uid = this.uids.get(app.id);
                if (this.config.isolate && uid !== undefined) {
                    fchownSync(fd, uid, this.config.isolate.gid);
                }
            } finally {
                closeSync(fd);
            }
            renameSync(temp, path);
        } catch (error) {
            rmSync(temp, { force: true });
            throw error;
        }
    }
    /** Replaces the app's data token (its file; the env has the first one). */
    setToken(id: string, token: string) {
        const app = this.existing(id);
        if (app.wanted) {
            if (app.wanted.token) {
                app.secrets.add(app.wanted.token);
            }
            app.secretsChanged++;
            app.wanted = { ...app.wanted, token };
        }
        app.secrets.add(token);
        app.secretsChanged++;
        if (app.secrets.size > 8) {
            app.secrets.delete(app.secrets.values().next().value!);
        }
        this.writeToken(app, token);
        return this.status(id);
    }
    /** Runs one version; resolves once its socket answers (or fails). */
    async start(id: string, spec: RuntimeStartRequest) {
        const app = this.existing(id);
        const missing = () => new RuntimeError(`Version ${spec.version} is not deployed here.`, 404);
        if (!app.versions.has(spec.version)) {
            throw missing();
        }
        // Wanted from here on: a deploy meanwhile doesn't prune it.
        app.wanted = spec;
        await this.stopProcess(app);
        clearTimeout(app.restartTimer);
        const version = app.versions.get(spec.version);
        if (!version) {
            throw missing();
        }
        app.crashes = [];
        if (spec.token) {
            app.secrets.add(spec.token);
        }
        app.secretsChanged++;
        await this.launch(app, version, spec);
        return this.status(id);
    }
    private async launch(app: AppProcess, version: Version, spec: RuntimeStartRequest) {
        const socket = this.socketPath(app.id);
        rmSync(socket, { force: true });
        this.writeToken(app, spec.token);
        app.state = 'starting';
        app.version = spec.version;
        app.error = null;
        app.stopping = false;
        // Each start (crash restarts too) is an attempt with its own output.
        const attempt = this.begin(app, 'start', spec.version);
        app.current = attempt;
        const argv = this.argv(app, [...this.config.command, version.manifest.entry]);
        const env = this.appEnv(app, version, spec, attempt);
        this.append(app, 'runtime', `starting version ${spec.version}`, attempt);
        const child = spawn(argv[0], argv.slice(1), {
            cwd: version.dir,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        app.child = child;
        this.lines(app, 'out', attempt, child.stdout);
        this.lines(app, 'err', attempt, child.stderr);
        child.once('error', (error) => {
            attempt.spawnError = error.message;
            this.append(app, 'runtime', `could not start: ${error.message}`, attempt);
            // A command that never ran has no exit event.
            if (child.pid === undefined) {
                this.exited(app, child, attempt, child.exitCode, null);
            }
        });
        child.once('exit', (code, signal) => this.exited(app, child, attempt, code, signal));
        const deadline = Date.now() + this.config.startTimeoutMs;
        while (Date.now() < deadline) {
            if (app.child !== child || child.exitCode !== null || child.signalCode) {
                break;
            }
            if (await this.answers(app.id)) {
                app.state = 'running';
                app.startedAt = Date.now();
                attempt.upAt = app.startedAt;
                this.append(app, 'runtime', `version ${spec.version} is up`, attempt);
                return;
            }
            await sleep(100);
        }
        if (app.child === child && app.state === 'starting') {
            app.stopping = true;
            app.state = 'failed';
            app.error = `Version ${spec.version} didn’t open its socket within ${this.config.startTimeoutMs / 1000} s (listen on CB_SOCKET).`;
            this.append(app, 'runtime', app.error, attempt);
            this.finish(app, attempt, 'failed', {
                reason: 'health_check',
                message: app.error,
            });
            this.kill(child, 'SIGKILL');
        }
        // Its last output (a stack trace) is in its log before anyone asks.
        await this.outputDone(attempt);
        throw new RuntimeError(app.error ?? `Version ${spec.version} exited while starting.`, 409);
    }
    /**
     * A connection to the app's own socket. Its name is in run/, which the
     * app's user can change: it could be a link to another app's socket. So
     * it is opened without following links, must be a socket of the app's
     * user, and is connected to through that descriptor (/proc/self/fd):
     * what is connected to is what was checked. Throws if it isn't.
     */
    connectApp(id: string): Socket {
        const fd = openSync(this.socketPath(id), O_PATH | constants.O_NOFOLLOW);
        let socket: Socket;
        try {
            const stat = fstatSync(fd);
            const uid = this.config.isolate ? this.uids.get(id) : process.getuid?.();
            if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid)) {
                throw new RuntimeError('That is not the app’s socket.', 503);
            }
            socket = connect({ path: `/proc/self/fd/${fd}` });
        } catch (error) {
            closeSync(fd);
            throw error;
        }
        let open = true;
        const close = () => {
            if (open) {
                closeSync(fd);
            }
            open = false;
        };
        socket.once('connect', close);
        socket.once('close', close);
        return socket;
    }
    private answers(id: string) {
        return new Promise<boolean>((resolve) => {
            let socket: Socket;
            try {
                socket = this.connectApp(id);
            } catch {
                return resolve(false);
            }
            const done = (ok: boolean) => {
                socket.destroy();
                resolve(ok);
            };
            socket.setTimeout(500, () => done(false));
            socket.once('connect', () => done(true));
            socket.once('error', () => done(false));
        });
    }
    private exited(
        app: AppProcess,
        child: ChildProcess,
        attempt: Attempt,
        code: number | null,
        signal: NodeJS.Signals | null,
    ) {
        const how = signal ? `signal ${signal}` : `code ${code}`;
        // What a flood held back comes out; the exit is said after its output.
        this.drain(app, attempt);
        void this.outputDone(attempt).then(() => {
            this.release(app, attempt);
            this.append(app, 'runtime', `exited (${how})`, attempt);
        });
        const stopped = app.child !== child || app.stopping;
        const wasStarting = !stopped && app.state === 'starting';
        const version = attempt.version;
        this.finish(
            app,
            attempt,
            attempt.oom || attempt.spawnError || !stopped ? 'failed' : 'stopped',
            attempt.spawnError
                ? {
                      reason: 'spawn',
                      code,
                      signal,
                      message: `Version ${version} couldn’t start: ${attempt.spawnError}.`,
                  }
                : attempt.oom
                  ? {
                        reason: 'oom',
                        code,
                        signal,
                        message: `Version ${version} used more than ${Math.round(this.config.memoryBytes / 1048576)} MB of memory; the runtime stopped it.`,
                    }
                  : stopped
                    ? { reason: 'stopped', code, signal, message: 'Stopped.' }
                    : {
                          reason: signal ? 'signal' : 'exit',
                          code,
                          signal,
                          message: wasStarting
                              ? `Version ${version} exited while starting (${how}).`
                              : `Version ${version} exited (${how}).`,
                      },
        );
        if (app.child !== child) {
            return;
        }
        app.child = undefined;
        // The process group goes with it (anything it left running).
        if (child.pid) {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                // Nothing left.
            }
        }
        if (app.stopping) {
            if (app.state !== 'failed') {
                app.state = 'stopped';
            }
            return;
        }
        const now = Date.now();
        app.crashes = app.crashes.filter((at) => at > now - RESTART_WINDOW_MS);
        app.crashes.push(now);
        if (wasStarting || app.crashes.length >= MAX_CRASHES || !app.wanted) {
            app.state = 'failed';
            app.error = wasStarting
                ? (attempt.exit?.message ?? `Version ${app.version} exited while starting (${how}).`)
                : `Version ${app.version} kept crashing; stopped after ${app.crashes.length} restarts.`;
            return;
        }
        app.state = 'starting';
        const delay = Math.min(60_000, 1000 * 2 ** (app.crashes.length - 1));
        app.restartTimer = setTimeout(() => {
            const wanted = app.wanted;
            const version = wanted && app.versions.get(wanted.version);
            if (!wanted || !version || app.stopping || app.child) {
                return;
            }
            void this.launch(app, version, wanted).catch(() => undefined);
        }, delay);
        app.restartTimer.unref?.();
    }
    private async stopProcess(app: AppProcess) {
        clearTimeout(app.restartTimer);
        const child = app.child;
        app.stopping = true;
        if (!child) {
            return;
        }
        // Its last lines, held or late, can't push out what came before.
        this.drain(app, app.current);
        const gone = new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
            } else {
                child.once('exit', () => resolve());
            }
        });
        this.kill(child, 'SIGTERM');
        const timer = setTimeout(() => this.kill(child, 'SIGKILL'), STOP_GRACE_MS);
        await gone;
        clearTimeout(timer);
    }
    async stop(id: string) {
        const app = this.existing(id);
        await this.stopProcess(app);
        app.wanted = undefined;
        if (app.state !== 'not_deployed') {
            app.state = 'stopped';
        }
        app.error = null;
        this.writeToken(app, null);
        this.append(app, 'runtime', 'stopped');
        return this.status(id);
    }
    /** Stops it and removes everything it had here. */
    async remove(id: string) {
        const app = this.apps.get(id);
        if (!app) {
            return;
        }
        await this.stopProcess(app);
        this.apps.delete(id);
        this.removeTree(this.appDir(id));
        this.uids.delete(id);
    }
    async stopAll() {
        clearInterval(this.watchdog);
        await Promise.all([...this.apps.values()].map((app) => this.stopProcess(app)));
    }

    // ---- limits -------------------------------------------------------------
    /** Restarts an app whose resident memory is above the limit (Linux). */
    checkMemory() {
        for (const app of this.apps.values()) {
            const pid = app.child?.pid;
            if (!pid || app.state !== 'running') {
                continue;
            }
            let rss: number;
            try {
                const status = readFileSync(`/proc/${pid}/status`, 'utf8');
                rss = Number(/VmRSS:\s+(\d+)\s+kB/.exec(status)?.[1] ?? 0) * 1024;
            } catch {
                continue;
            }
            if (rss > this.config.memoryBytes) {
                if (app.current) {
                    app.current.oom = true;
                }
                this.append(
                    app,
                    'runtime',
                    `memory ${Math.round(rss / 1048576)} MB is above the limit of ${Math.round(this.config.memoryBytes / 1048576)} MB; restarting`,
                );
                this.kill(app.child!, 'SIGKILL');
            }
        }
    }

    // ---- status -------------------------------------------------------------
    status(id: string): RuntimeAppStatus {
        const app = this.existing(id);
        const now = Date.now();
        return {
            id,
            state: app.state,
            version: app.version,
            versions: [...app.versions.keys()].sort((a, b) => a - b),
            startedAt: app.state === 'running' ? app.startedAt : null,
            restarts: app.crashes.filter((at) => at > now - RESTART_WINDOW_MS).length,
            error: app.error,
            attempt: app.attempts.length
                ? {
                      id: app.attempts[app.attempts.length - 1].id,
                      state: app.attempts[app.attempts.length - 1].state,
                  }
                : null,
        };
    }
    list() {
        return [...this.apps.keys()].map((id) => this.status(id));
    }
    /** Whether an app is up to take requests (the ingress). */
    running(id: string) {
        return this.apps.get(id)?.state === 'running';
    }
}
