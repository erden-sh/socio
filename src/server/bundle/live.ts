/**
 * The live CLI channel (CB-380): `bundle-cli.js import --live`, run in the
 * app container, hands an import to the server running on the same
 * database, waits for it, and prints the same report. The server runs it
 * with the very runner the web import uses (routes.ts,
 * `bundleImports`): the same backup check, one import at a time, the same
 * log lines and `import_runs` row (`via='cli'`, `startedBy` the admin
 * it runs for).
 *
 * The channel is a Unix socket, never a network port: one per database,
 * `<tmpdir>/socio-bundle-<uid>/<hash of the database path>.sock`. Its
 * directory is the server user's alone (0700, refused when someone else
 * owns it, or it is a link), the socket is 0600, and it is in the
 * container's own filesystem, never on a volume another container
 * mounts. Only a process of the server's own user in the same container
 * can connect: one that could read the database file and its keys anyway.
 * The server still checks that `--as` names an admin, who isn't
 * deactivated, before it starts anything.
 *
 * The protocol: one request per connection, a line of JSON
 * (`{ as, input }`, input as the web POST takes it), answered with one line
 * (`{ run }` when the run ends, or `{ error }`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { BundleError } from './files.js';
import { BUNDLE_NAME, importInput, type BundleImports, type BundleRun, type ImportInput } from './routes.js';

/** A request's most bytes: a bundle name, an operator id, a Space map and terms. */
const MAX_REQUEST = 64 * 1024;
/** How long a connection may take to send its request. */
const REQUEST_TIMEOUT_MS = 10_000;

const request = z.object({ as: z.string().min(1).max(200), input: importInput }).strict();
export type LiveRequest = z.infer<typeof request>;
export interface LiveAnswer {
    run?: BundleRun;
    error?: string;
}

const uidNow = () => process.getuid?.();

/** Where the channel of the server on `databasePath` is: a private directory and the socket in it. */
export function liveSocketPath(databasePath: string, base = tmpdir(), uid = uidNow()) {
    const absolute = existsSync(databasePath) ? realpathSync(databasePath) : resolve(databasePath);
    const key = createHash('sha256').update(absolute).digest('hex').slice(0, 16);
    const dir = join(base, `socio-bundle-${uid ?? 'user'}`);
    return { dir, path: join(dir, `${key}.sock`) };
}

/** Throws unless `dir` is a real directory of this user, closed to everyone else. */
function checkPrivate(dir: string, uid = uidNow()) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new BundleError(`${dir} isn’t a directory.`);
    }
    if (uid !== undefined && stat.uid !== uid) {
        throw new BundleError(`${dir} belongs to another user.`);
    }
    if (stat.mode & 0o077) {
        throw new BundleError(`${dir} is open to other users.`);
    }
}

/** The private directory, made (0700) when missing, closed when it was open. */
function privateDir(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isSymbolicLink() && stat.isDirectory() && stat.uid === uidNow() && stat.mode & 0o077) {
        chmodSync(dir, 0o700);
    }
    checkPrivate(dir);
}

/**
 * Whether `userId` is an admin here, and not deactivated: who the CLI may
 * import as (CB-390; a retired `operator` row counts as an admin). The
 * same rule as the web's (an admin's session; a deactivated person has none).
 */
export function adminHere(db: DatabaseSync, userId: string) {
    const row = db
        .prepare(
            `SELECT u.role AS role,
                    EXISTS (SELECT 1 FROM auth_user a WHERE a.appUserId = u.id AND a.banned = 1) AS banned
               FROM users u WHERE u.id = ?`,
        )
        .get(userId) as { role: string; banned: number } | undefined;
    return (row?.role === 'admin' || row?.role === 'operator') && Number(row.banned) === 0;
}

export interface LiveChannelSources {
    databasePath: string;
    imports: BundleImports;
    /** Whether the id names an admin who may import (`adminHere`). */
    isAdmin: (userId: string) => boolean;
    log: (line: string) => void;
    /** For tests: where the private directory goes (the OS's temporary directory). */
    base?: string;
    /** For tests: the request's limits (64 kB, 10 s). */
    maxRequestBytes?: number;
    requestTimeoutMs?: number;
}

export interface LiveChannel {
    path: string;
    server: Server;
    close(): Promise<void>;
}

/**
 * Reads one line (the request) off a connection: at most `limit` bytes,
 * newline included, all of it within `deadlineMs` of the connection.
 */
function readLine(socket: Socket, limit: number, deadlineMs: number): Promise<string> {
    return new Promise((resolveLine, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const done = (error?: Error, line?: string) => {
            clearTimeout(deadline);
            socket.off('data', onData);
            socket.off('end', onEnd);
            socket.off('error', onError);
            if (error) {
                reject(error);
            } else {
                resolveLine(line!);
            }
        };
        const onData = (chunk: Buffer) => {
            const newline = chunk.indexOf(0x0a);
            const taken = newline === -1 ? chunk.length : newline + 1;
            size += taken;
            if (size > limit) {
                done(new BundleError('The request is too long.'));
                return;
            }
            chunks.push(chunk.subarray(0, taken));
            if (newline !== -1) {
                done(undefined, Buffer.concat(chunks).toString('utf8').replace(/\n$/, ''));
            }
        };
        const onEnd = () => done(new BundleError('The request ended before its line did.'));
        const onError = (error: Error) => done(error);
        const deadline = setTimeout(() => done(new BundleError('No request came in time.')), deadlineMs);
        socket.on('data', onData);
        socket.on('end', onEnd);
        socket.on('error', onError);
    });
}

/**
 * Starts the channel for the server on `databasePath`. A socket left at
 * the path (a server that stopped, or the one this one replaces in a
 * start-first upgrade) is replaced: the newest server answers.
 */
export async function startLiveChannel(sources: LiveChannelSources): Promise<LiveChannel> {
    const { dir, path } = liveSocketPath(sources.databasePath, sources.base);
    privateDir(dir);
    if (lstatExists(path) && !lstatSync(path).isSocket()) {
        throw new BundleError(`${path} is there and isn’t a socket.`);
    }
    // Bound under a name of its own, then moved into place in one step: a
    // server closing removes the name it bound, never a newer one's socket.
    const bound = `${path.slice(0, -'.sock'.length)}.${process.pid}-${randomBytes(4).toString('hex')}.sock`;
    const answer = (socket: Socket, body: LiveAnswer) => {
        if (!socket.destroyed) {
            socket.end(`${JSON.stringify(body)}\n`);
        }
    };
    const server = createServer((socket) => {
        socket.on('error', () => undefined);
        void (async () => {
            let line: string;
            try {
                line = await readLine(
                    socket,
                    sources.maxRequestBytes ?? MAX_REQUEST,
                    sources.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
                );
            } catch (error) {
                answer(socket, { error: error instanceof BundleError ? error.message : 'The request failed.' });
                return;
            }
            let parsed: LiveRequest;
            try {
                parsed = request.parse(JSON.parse(line));
            } catch {
                answer(socket, { error: 'Name a bundle under BACKUP_DIR/bundles/ (letters, digits, . _ -).' });
                return;
            }
            if (!sources.isAdmin(parsed.as)) {
                sources.log('Bundle import refused on the CLI channel: --as names no admin here.');
                answer(socket, { error: '--as must name an admin’s user id.' });
                return;
            }
            const started = sources.imports.start(parsed.input, parsed.as, 'cli');
            if (!started) {
                answer(socket, { error: 'An import is running. Wait for it to end.', run: sources.imports.current() });
                return;
            }
            await started.done;
            answer(socket, { run: started.run });
        })();
    });
    await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(bound, () => {
            server.off('error', reject);
            resolveListen();
        });
    });
    chmodSync(bound, 0o600);
    renameSync(bound, path);
    // Which file is ours: a newer server's socket may reuse the inode, never also its change time.
    const identity = (stat: { ino: bigint; ctimeNs: bigint }) => `${stat.ino}:${stat.ctimeNs}`;
    const ours = identity(lstatSync(path, { bigint: true }));
    /** Removes the socket, unless a newer server's replaced it. */
    const unlinkOurs = () => {
        try {
            if (identity(lstatSync(path, { bigint: true })) === ours) {
                unlinkSync(path);
            }
        } catch {
            // Gone already.
        }
    };
    // It never keeps the process up, and its file goes with the process.
    server.unref();
    process.once('exit', unlinkOurs);
    return {
        path,
        server,
        close: () =>
            new Promise<void>((resolveClose) => {
                process.off('exit', unlinkOurs);
                server.close(() => resolveClose());
                unlinkOurs();
            }),
    };
}

const lstatExists = (path: string) => {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
};

/**
 * The CLI's side: sends `body` to the server on `databasePath` and waits
 * for its answer (the run, with its report, as it ends). It talks only to
 * a socket in a directory of its own user's, closed to everyone else.
 */
export async function liveImport(
    databasePath: string,
    body: { as: string; input: ImportInput },
    options: { base?: string } = {},
): Promise<LiveAnswer> {
    const { dir, path } = liveSocketPath(databasePath, options.base);
    if (!lstatExists(path)) {
        throw new BundleError(
            `No server answers on this database (${path} isn’t there). Start the server, or stop it and import offline without --live.`,
        );
    }
    checkPrivate(dir);
    const socket = lstatSync(path);
    if (!socket.isSocket() || (uidNow() !== undefined && socket.uid !== uidNow())) {
        throw new BundleError(`${path} isn’t this user’s server socket.`);
    }
    return new Promise((resolveAnswer, reject) => {
        const connection = createConnection(path);
        let text = '';
        connection.setEncoding('utf8');
        connection.on('connect', () => connection.write(`${JSON.stringify(body)}\n`));
        connection.on('data', (chunk: string) => {
            text += chunk;
        });
        connection.on('error', (error: NodeJS.ErrnoException) =>
            reject(
                error.code === 'ECONNREFUSED' || error.code === 'ENOENT'
                    ? new BundleError(
                          `No server answers on this database (${path}). Start the server, or stop it and import offline without --live.`,
                      )
                    : error,
            ),
        );
        connection.on('end', () => {
            const line = text.split('\n')[0];
            try {
                resolveAnswer(JSON.parse(line ?? '') as LiveAnswer);
            } catch {
                reject(new BundleError('The server’s answer couldn’t be read.'));
            }
        });
    });
}

/**
 * `bundle-cli.js import DIR --live`: the server reads the bundle by name,
 * so DIR must be directly under the BACKUP_DIR/bundles/ it reads
 * (`where.backupDir`, by the server's rule, `backupDirFromEnv`); the
 * database names the server. Relative paths are taken from `cwd`, as the
 * server takes them.
 */
export function liveImportFromCli(
    dir: string,
    where: { database: string; backupDir: string },
    request: Omit<ImportInput, 'bundle'> & { as: string },
    options: { cwd?: string; base?: string } = {},
): Promise<LiveAnswer> {
    const cwd = options.cwd ?? process.cwd();
    const root = resolve(cwd, where.backupDir, 'bundles');
    const path = resolve(cwd, dir);
    const name = basename(path);
    if (!existsSync(root) || !existsSync(path) || realpathSync(dirname(path)) !== realpathSync(root)) {
        return Promise.reject(new BundleError(`With --live, the bundle must be a directory directly under ${root}.`));
    }
    if (!BUNDLE_NAME.test(name)) {
        return Promise.reject(new BundleError('A bundle’s name is letters, digits, . _ and -.'));
    }
    const { as, ...input } = request;
    return liveImport(
        resolve(cwd, where.database),
        { as, input: { ...input, bundle: name } },
        options.base ? { base: options.base } : {},
    );
}
