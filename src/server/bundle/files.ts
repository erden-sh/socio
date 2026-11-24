/**
 * Writing and reading a bundle's directory (format.ts) with bounded memory
 * (CB-380, after CB-378): records go a line at a time, attachment and
 * image bytes a file at a time, and the bytes held at once are counted
 * against a `ByteBudget`, which refuses rather than grow.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    chmodSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';

import type { z } from 'zod';

import {
    BUNDLE_FILES,
    manifestSchema,
    usersFileSchema,
    type BundleFileName,
    type BundleManifest,
    type UserRecord,
} from './format.js';

/** The largest attachment or image a bundle carries: bigger ones are left out and reported. */
export const BLOB_MAX_BYTES = 100 * 1024 * 1024;
/** What an export or import may hold of file bytes at once, by default. */
export const DEFAULT_BYTE_BUDGET = 256 * 1024 * 1024;
/** The largest manifest.json or users.json read. */
const SMALL_FILE_MAX = 64 * 1024 * 1024;
/** The largest record line in bytes, written and read: an export refuses a record over it. */
export const LINE_MAX = 64 * 1024 * 1024;

export class BundleError extends Error {}

/**
 * The file bytes an export or import holds at once. `hold` refuses what
 * would go over the limit instead of letting memory grow with the data;
 * `peak` is the most held at any time, which tests check.
 */
export class ByteBudget {
    held = 0;
    peak = 0;
    constructor(readonly limit = DEFAULT_BYTE_BUDGET) {}
    /** Runs `work` while `bytes` are counted as held. */
    async hold<T>(bytes: number, work: () => Promise<T> | T): Promise<T> {
        if (this.held + bytes > this.limit) {
            throw new BundleError(
                `Holding ${bytes} more bytes would go over the ${this.limit}-byte memory budget (${this.held} held).`,
            );
        }
        this.held += bytes;
        this.peak = Math.max(this.peak, this.held);
        try {
            return await work();
        } finally {
            this.held -= bytes;
        }
    }
    /** `hold` for synchronous work (inside a transaction). */
    holdSync<T>(bytes: number, work: () => T): T {
        if (this.held + bytes > this.limit) {
            throw new BundleError(
                `Holding ${bytes} more bytes would go over the ${this.limit}-byte memory budget (${this.held} held).`,
            );
        }
        this.held += bytes;
        this.peak = Math.max(this.peak, this.held);
        try {
            return work();
        } finally {
            this.held -= bytes;
        }
    }
}

export const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** sha256 and size of a file, read a chunk at a time. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
        hash.update(chunk as Buffer);
        bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), bytes };
}

/**
 * Writes a bundle into `<dir>.partial`, renamed to `dir` by `finish`, so a
 * failed export never looks complete. Private: 0700 directories, 0600
 * files. Refuses a `dir` that exists.
 */
export class BundleWriter {
    private partial: string;
    private fds = new Map<BundleFileName, { fd: number; hash: ReturnType<typeof createHash>; bytes: number }>();
    private blobs: Record<string, number> = {};
    constructor(
        readonly dir: string,
        private lineMax = LINE_MAX,
    ) {
        if (existsSync(dir)) {
            throw new BundleError('The bundle directory exists already. Name a new one.');
        }
        this.partial = `${dir}.partial`;
        rmSync(this.partial, { recursive: true, force: true });
        mkdirSync(join(this.partial, 'files'), { recursive: true, mode: 0o700 });
        chmodSync(this.partial, 0o700);
        for (const name of BUNDLE_FILES) {
            const fd = openSync(join(this.partial, name), 'wx', 0o600);
            this.fds.set(name, { fd, hash: createHash('sha256'), bytes: 0 });
        }
    }
    private write(name: BundleFileName, text: string) {
        const file = this.fds.get(name)!;
        const bytes = Buffer.from(text, 'utf8');
        writeSync(file.fd, bytes);
        file.hash.update(bytes);
        file.bytes += bytes.length;
    }
    /** One record, as one line. */
    line(name: Exclude<BundleFileName, 'users.json'>, record: unknown, what = 'A record') {
        const text = JSON.stringify(record);
        // What the reader takes: an export never writes a bundle it can't import.
        const size = Buffer.byteLength(text, 'utf8');
        if (size > this.lineMax) {
            throw new BundleError(`${what} is too large for a bundle (${size} bytes, ${this.lineMax} at most).`);
        }
        this.write(name, `${text}\n`);
    }
    users(users: readonly UserRecord[]) {
        this.write('users.json', JSON.stringify(users));
    }
    /** File bytes, stored once by their sha256 (which it returns). */
    blob(bytes: Uint8Array, expected?: string) {
        const sha = sha256Of(bytes);
        if (expected && expected !== sha) {
            throw new BundleError('A stored attachment’s bytes don’t match its recorded sha256.');
        }
        if (this.blobs[sha] === undefined) {
            writeFileSync(join(this.partial, 'files', sha), bytes, { mode: 0o600, flag: 'wx' });
            this.blobs[sha] = bytes.length;
        }
        return sha;
    }
    /** Closes the files, writes manifest.json and gives the bundle its name. */
    finish(manifest: Omit<BundleManifest, 'files' | 'blobs'>): BundleManifest {
        const files: BundleManifest['files'] = {};
        for (const [name, file] of this.fds) {
            closeSync(file.fd);
            files[name] = { sha256: file.hash.digest('hex'), bytes: file.bytes };
        }
        this.fds.clear();
        const full = manifestSchema.parse({ ...manifest, files, blobs: this.blobs });
        writeFileSync(join(this.partial, 'manifest.json'), JSON.stringify(full, null, 2), { mode: 0o600, flag: 'wx' });
        renameSync(this.partial, this.dir);
        return full;
    }
    /** Removes what was written (a failed export). */
    abort() {
        for (const file of this.fds.values()) {
            try {
                closeSync(file.fd);
            } catch {
                // Closed already.
            }
        }
        this.fds.clear();
        rmSync(this.partial, { recursive: true, force: true });
    }
}

/**
 * The lines of a file, read a chunk at a time and never more than `max`
 * bytes of one line held: a longer line refuses (and closes the file) as
 * soon as it passes the limit, so a record file without newlines can't
 * fill memory.
 */
export async function* boundedLines(path: string, max: number, name = 'The file'): AsyncGenerator<string> {
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 });
    let pending: Buffer[] = [];
    let held = 0;
    let number = 0;
    try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
            let at = 0;
            for (let newline = chunk.indexOf(10, at); newline !== -1; newline = chunk.indexOf(10, at)) {
                const piece = chunk.subarray(at, newline);
                number++;
                if (held + piece.length > max) {
                    throw new BundleError(`${name} line ${number} is too long.`);
                }
                yield Buffer.concat([...pending, piece]).toString('utf8');
                pending = [];
                held = 0;
                at = newline + 1;
            }
            const rest = chunk.subarray(at);
            held += rest.length;
            if (held > max) {
                throw new BundleError(`${name} line ${number + 1} is too long.`);
            }
            pending.push(rest);
        }
        if (held) {
            yield Buffer.concat(pending).toString('utf8');
        }
    } finally {
        stream.destroy();
    }
}

function readSmall(path: string) {
    if (!existsSync(path)) {
        throw new BundleError(`The bundle has no ${path.split('/').pop()}.`);
    }
    if (statSync(path).size > SMALL_FILE_MAX) {
        throw new BundleError(`${path.split('/').pop()} is too large.`);
    }
    return readFileSync(path);
}

/**
 * A bundle to import, checked: its manifest parses, its data files hash to
 * what the manifest says, and nothing else is in the directory. Records
 * are read a line at a time and parsed one by one; blobs are read one at a
 * time and checked against their name.
 */
export class BundleReader {
    private constructor(
        readonly dir: string,
        readonly manifest: BundleManifest,
        /** The sha256 of manifest.json: the bundle's identity (it holds every file's hash). */
        readonly sha256: string,
    ) {}
    static async open(dir: string): Promise<BundleReader> {
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
            throw new BundleError('There is no bundle there.');
        }
        const raw = readSmall(join(dir, 'manifest.json'));
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw.toString('utf8'));
        } catch {
            throw new BundleError('manifest.json isn’t JSON.');
        }
        const manifest = manifestSchema.safeParse(parsed);
        if (!manifest.success) {
            throw new BundleError(`manifest.json isn’t a bundle manifest: ${manifest.error.issues[0]?.message ?? ''}`);
        }
        const expected = new Set<string>(['manifest.json', 'files', ...BUNDLE_FILES]);
        const extra = readdirSync(dir).filter((name) => !expected.has(name));
        if (extra.length) {
            throw new BundleError(`The bundle holds files it shouldn’t: ${extra.slice(0, 5).join(', ')}.`);
        }
        for (const name of BUNDLE_FILES) {
            const want = manifest.data.files[name];
            const path = join(dir, name);
            if (!want || !existsSync(path)) {
                throw new BundleError(`The bundle has no ${name}.`);
            }
            const got = await hashFile(path);
            if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) {
                throw new BundleError(`${name} doesn’t match its sha256 in the manifest.`);
            }
        }
        return new BundleReader(dir, manifest.data, sha256Of(raw));
    }
    users(): UserRecord[] {
        const parsed = usersFileSchema.safeParse(JSON.parse(readSmall(join(this.dir, 'users.json')).toString('utf8')));
        if (!parsed.success) {
            throw new BundleError(`users.json isn’t valid: ${parsed.error.issues[0]?.message ?? ''}`);
        }
        return parsed.data;
    }
    /** The records of a .jsonl file, parsed one line at a time. */
    async *records<S extends z.ZodType>(
        name: Exclude<BundleFileName, 'users.json'>,
        schema: S,
    ): AsyncGenerator<z.infer<S>> {
        const lines = boundedLines(join(this.dir, name), LINE_MAX, name);
        let number = 0;
        for await (const line of lines) {
            number++;
            if (!line.trim()) {
                continue;
            }
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                throw new BundleError(`${name} line ${number} isn’t JSON.`);
            }
            const parsed = schema.safeParse(value);
            if (!parsed.success) {
                const issue = parsed.error.issues[0];
                throw new BundleError(
                    `${name} line ${number} isn’t valid: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
                );
            }
            yield parsed.data;
        }
    }
    /** Whether the manifest lists a blob of this sha256. */
    hasBlob(sha: string) {
        return this.manifest.blobs[sha] !== undefined;
    }
    blobSize(sha: string) {
        return this.manifest.blobs[sha] ?? 0;
    }
    /** A blob's bytes, checked against its name and size. */
    blob(sha: string): Buffer {
        const size = this.manifest.blobs[sha];
        if (size === undefined || !/^[0-9a-f]{64}$/.test(sha)) {
            throw new BundleError('A record names a file the bundle doesn’t list.');
        }
        const path = join(this.dir, 'files', sha);
        if (!existsSync(path) || statSync(path).size !== size || size > BLOB_MAX_BYTES) {
            throw new BundleError('A file of the bundle is missing or has the wrong size.');
        }
        const bytes = readFileSync(path);
        if (sha256Of(bytes) !== sha) {
            throw new BundleError('A file of the bundle doesn’t match its sha256.');
        }
        return bytes;
    }
}
