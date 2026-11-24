// Runs only inside the computer image: computer.Dockerfile copies it into
// OpenBot's /app/src beside principal-worker.ts, and isolate-computer.mjs
// patches OpenBot's index.ts to import it at build time (CB-227).
import { spawn } from 'node:child_process';
/**
 * CB-227: privileged allocation and an unprivileged worker for each request.
 * The private root is a dedicated volume, never part of the shared workspace.
 * Callers authenticate before choosing a principal; browser clients never do.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export type ComputerPrincipal = { kind: 'person' | 'app' | 'job'; id: string };
export type PrincipalOperation = 'exec' | 'files_read' | 'files_write' | 'files_list';
export type PrincipalRecord = {
    key: string;
    uid: number;
    gid: number;
    home: string;
};
const FIRST_UID = 20001;
const LAST_UID = 60000;
const SHARED_GID = 20000;
const OUTPUT_LIMIT = 2 * 1024 * 1024;

type Registry = {
    version: 1;
    nextUid: number;
    entries: Record<string, number>;
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
const keyOf = (principal: ComputerPrincipal) => {
    if (
        !principal ||
        !['person', 'app', 'job'].includes(principal.kind) ||
        typeof principal.id !== 'string' ||
        !principal.id.trim() ||
        principal.id.length > 200
    )
        throw new Error('A valid execution principal is required.');
    return principal.kind + '-' + createHash('sha256').update(principal.id).digest('hex');
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class PrincipalRuntime {
    readonly privateRoot: string;
    readonly sharedRoot: string;
    private workerFile: string;
    private executable: string;
    private environment: Record<string, string>;
    private queue: Promise<unknown> = Promise.resolve();
    constructor(options: {
        privateRoot: string;
        sharedRoot: string;
        workerFile: string;
        executable?: string;
        environment: Record<string, string>;
    }) {
        this.privateRoot = resolve(options.privateRoot);
        this.sharedRoot = resolve(options.sharedRoot);
        if (inside(this.privateRoot, this.sharedRoot) || inside(this.sharedRoot, this.privateRoot))
            throw new Error('Private and shared storage must be separate roots.');
        this.workerFile = options.workerFile;
        this.executable = options.executable ?? process.execPath;
        this.environment = { ...options.environment };
    }

    /** The short allocation critical section serializes both first use and restart. */
    identity(principal: ComputerPrincipal): Promise<PrincipalRecord> {
        const key = keyOf(principal);
        const work = this.queue.then(() => this.allocate(key));
        this.queue = work.catch(() => {});
        return work;
    }

    private async directory(path: string, mode: number) {
        await mkdir(path, { recursive: true, mode });
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0)
            throw new Error('Unsafe private storage directory.');
        await chmod(path, mode);
    }

    private async registry(): Promise<Registry> {
        try {
            const value = JSON.parse(
                await readFile(join(this.privateRoot, 'control', 'principals.json'), 'utf8'),
            ) as Registry;
            if (
                value.version !== 1 ||
                !Number.isInteger(value.nextUid) ||
                value.nextUid < FIRST_UID ||
                value.nextUid > LAST_UID + 1 ||
                !value.entries ||
                typeof value.entries !== 'object' ||
                Array.isArray(value.entries)
            )
                throw new Error('Invalid principal registry.');
            const used = new Set<number>();
            for (const [key, uid] of Object.entries(value.entries)) {
                if (
                    !/^(person|app|job)-[a-f0-9]{64}$/.test(key) ||
                    !Number.isInteger(uid) ||
                    uid < FIRST_UID ||
                    uid >= value.nextUid ||
                    used.has(uid)
                )
                    throw new Error('Invalid principal registry.');
                used.add(uid);
            }
            // A lost write must never reuse a UID still owning a home. Check
            // valid-but-stale registry snapshots as well as missing/corrupt JSON.
            for (const key of await readdir(join(this.privateRoot, 'homes'))) {
                const home = await lstat(join(this.privateRoot, 'homes', key));
                const uid = value.entries[key];
                if (
                    uid === undefined ||
                    !home.isDirectory() ||
                    home.isSymbolicLink() ||
                    (home.uid !== uid && home.uid !== 0)
                )
                    throw new Error('Principal registry does not match private homes; restore it before continuing.');
            }
            return value;
        } catch (error) {
            if (missing(error)) {
                if ((await readdir(join(this.privateRoot, 'homes'))).length)
                    throw new Error('Principal registry is missing; restore it before continuing.', { cause: error });
                return { version: 1, nextUid: FIRST_UID, entries: {} };
            }
            throw error;
        }
    }

    private async allocate(key: string): Promise<PrincipalRecord> {
        if (process.getuid?.() !== 0) throw new Error('Principal allocation requires the computer service.');
        // Bun's package-script resolver needs a readable ancestor. Only the
        // fixed control/homes names become visible; homes itself stays 0711.
        await this.directory(this.privateRoot, 0o755);
        await this.directory(join(this.privateRoot, 'control'), 0o700);
        await this.directory(join(this.privateRoot, 'homes'), 0o711);
        const registry = await this.registry();
        let uid = registry.entries[key];
        if (uid === undefined) {
            if (registry.nextUid > LAST_UID) throw new Error('The principal UID range is full.');
            uid = registry.nextUid++;
            registry.entries[key] = uid;
            const target = join(this.privateRoot, 'control', 'principals.json');
            const temporary = target + '.' + randomUUID();
            // Persist the assignment before creating its home: a partial creation
            // can be retried, while no UID is ever reused for another identity.
            const file = await open(temporary, 'wx', 0o600);
            try {
                await file.writeFile(JSON.stringify(registry));
                await file.sync();
            } finally {
                await file.close();
            }
            await rename(temporary, target);
            const directory = await open(join(this.privateRoot, 'control'), 'r');
            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        }
        const home = join(this.privateRoot, 'homes', key);
        let info;
        try {
            info = await lstat(home);
        } catch (error) {
            if (!missing(error)) throw error;
        }
        if (!info) {
            await mkdir(home, { mode: 0o700 });
            await symlink(this.sharedRoot, join(home, 'shared'));
            await chown(home, uid, SHARED_GID);
        } else if (info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o077)) {
            try {
                await symlink(this.sharedRoot, join(home, 'shared'));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            await chown(home, uid, SHARED_GID);
        } else if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077) {
            throw new Error('Unsafe principal home.');
        }
        return { key, uid, gid: SHARED_GID, home };
    }

    /** No credentials in argv or the worker's process environment: only stdin. */
    async dispatch(
        principal: ComputerPrincipal,
        operation: PrincipalOperation,
        payload: Record<string, unknown>,
        options: { signal?: AbortSignal } = {},
    ): Promise<unknown> {
        if (!['exec', 'files_read', 'files_write', 'files_list'].includes(operation))
            throw new Error('Unknown principal operation.');
        const identity = await this.identity(principal);
        const timeoutMs =
            operation === 'exec' && typeof payload.timeoutMs === 'number' && Number.isFinite(payload.timeoutMs)
                ? Math.max(1000, Math.min(600000, payload.timeoutMs)) + 5000
                : 30000;
        options.signal?.throwIfAborted();
        return new Promise((resolveWork, reject) => {
            // setpriv clears supplementary groups before dropping identity. NNP
            // prevents a binary left in the legacy workspace from regaining root.
            const child = spawn(
                '/usr/bin/setpriv',
                [
                    `--reuid=${identity.uid}`,
                    `--regid=${identity.gid}`,
                    '--clear-groups',
                    '--no-new-privs',
                    '--inh-caps=-all',
                    '--ambient-caps=-all',
                    '--',
                    this.executable,
                    this.workerFile,
                ],
                {
                    env: {
                        ...this.environment,
                        HOME: identity.home,
                        SOCIO_SHARED_DIR: this.sharedRoot,
                    },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: true,
                },
            );
            let output = '',
                bytes = 0,
                failure: Error | undefined;
            let killTimer: ReturnType<typeof setTimeout> | undefined;
            const stop = (error: Error) => {
                failure ??= error;
                try {
                    process.kill(-child.pid!, 'SIGTERM');
                } catch {
                    /* already gone */
                }
                killTimer ??= setTimeout(() => {
                    try {
                        process.kill(-child.pid!, 'SIGKILL');
                    } catch {
                        /* gone */
                    }
                }, 1000);
                killTimer.unref();
            };
            const abort = () => stop(new Error('The computer operation was cancelled.'));
            const timer = setTimeout(() => stop(new Error('The computer worker timed out.')), timeoutMs);
            options.signal?.addEventListener('abort', abort, { once: true });
            const clear = () => {
                clearTimeout(timer);
                if (killTimer) clearTimeout(killTimer);
                options.signal?.removeEventListener('abort', abort);
            };
            child.on('error', () => {
                clear();
                reject(new Error('The isolated computer worker could not start.'));
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                bytes += Buffer.byteLength(chunk);
                if (bytes > OUTPUT_LIMIT) {
                    stop(new Error('The computer worker returned too much data.'));
                    return;
                }
                output += chunk;
            });
            // A worker's stderr must never be promoted to a service error: it may
            // contain command output, paths or credentials. Its structured reply
            // carries the bounded result and a safe failure message.
            child.stderr.resume();
            child.stdin.on('error', () => {});
            child.once('close', (code) => {
                clear();
                if (failure) {
                    reject(failure);
                    return;
                }
                try {
                    const reply = JSON.parse(output) as { ok: boolean; value?: unknown };
                    if (code !== 0 || !reply.ok) throw new Error();
                    resolveWork(reply.value);
                } catch {
                    reject(new Error('The isolated computer operation failed.'));
                }
            });
            child.stdin.end(
                JSON.stringify({
                    operation,
                    payload,
                    home: identity.home,
                    sharedRoot: this.sharedRoot,
                }),
            );
            if (options.signal?.aborted) abort();
        });
    }
}
