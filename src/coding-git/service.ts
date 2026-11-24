import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { git, gitOk, GitFailure, readBlobs, type GitOptions } from './git.js';
import {
    AddedLineScanner,
    FILE_MODES,
    commitProblems,
    compileScope,
    hasGitSegment,
    parseCommit,
    parseRawDiff,
    pathProblem,
    scopePathProblem,
    MAX_SCOPE_PATHS,
    type GitIdentity,
    type PushRefusal,
} from './rules.js';

/**
 * `coding-git` (CB-239; CB-267): the one place Socio's hostile
 * Git input is parsed. It keeps a bare mirror per listed repository,
 * inspects each push in a quarantine over that mirror before Socio forwards
 * it, and reads extractions out of the mirror. It has no outside network
 * and no GitHub credential: the app fetches from GitHub and streams the
 * packs here, so a pack-parsing bug here yields mirrors, never a token.
 * Pushed objects never reach the mirror.
 */

const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);
/** The refs a mirror keeps: branches and tags. */
const MIRROR_REF = /^refs\/(heads|tags)\/[^\0\s~^:?*[\\]{1,250}$/;
const REPOSITORY = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;

export interface CodingGitConfig {
    /** Mirrors, spools and git's home live here. */
    dir: string;
    /** The largest push pack (the app's PACK_LIMIT, 100 MB). */
    maxPushBytes: number;
    /** The largest mirror refresh pack. */
    maxMirrorBytes: number;
    /** Objects a push pack may declare. */
    maxPushObjects: number;
    /** New commits one push may add. */
    maxCommits: number;
    /** Inspections at once for the instance (2 by default). */
    concurrency: number;
    /** Per git command. */
    timeoutMs: number;
    /** How long an accepted push's pack waits for the app to forward it. */
    spoolTtlMs: number;
}

export const CODING_GIT_DEFAULTS: Omit<CodingGitConfig, 'dir'> = {
    maxPushBytes: 100 * 1024 * 1024,
    maxMirrorBytes: 2 * 1024 * 1024 * 1024,
    maxPushObjects: 200_000,
    maxCommits: 1_000,
    concurrency: 2,
    timeoutMs: 120_000,
    spoolTtlMs: 10 * 60_000,
};

export class CodingGitError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 404 | 409 | 413 = 400,
    ) {
        super(message);
    }
}

export interface PushCommand {
    old: string;
    new: string;
    ref: string;
}

export interface InspectMeta {
    repository: string;
    commands: PushCommand[];
    identity: GitIdentity;
}

export type InspectVerdict =
    | { ok: true; spool: string; commits: number }
    | { ok: false; reason: PushRefusal | 'mirror_missing'; detail: string };

export interface ExtractRequest {
    commit: string;
    paths: string[];
    maxBytes: number;
    maxFiles: number;
}

export interface ExtractedFile {
    path: string;
    executable: boolean;
    size: number;
    /** base64 */
    content: string;
}

export type ExtractResult =
    | { ok: true; files: ExtractedFile[]; bytes: number; dropped: number }
    | {
          ok: false;
          reason: 'commit_missing' | 'too_large' | 'paths_invalid';
          detail: string;
      };

/** A counting semaphore: at most `size` holders, the rest wait in order. */
class Semaphore {
    private waiting: Array<() => void> = [];
    private held = 0;
    constructor(private size: number) {}
    async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.held >= this.size) {
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        } else {
            this.held += 1;
        }
        try {
            return await work();
        } finally {
            const next = this.waiting.shift();
            if (next) {
                next();
            } else {
                this.held -= 1;
            }
        }
    }
}

export class CodingGit {
    private inspections: Semaphore;
    private locks = new Map<string, Promise<unknown>>();
    readonly config: CodingGitConfig;
    constructor(config: Partial<CodingGitConfig> & { dir: string }) {
        this.config = { ...CODING_GIT_DEFAULTS, ...config };
        this.inspections = new Semaphore(this.config.concurrency);
    }

    private get home() {
        return join(this.config.dir, 'home');
    }

    /** The mirror's directory; refuses anything but `owner/name`. */
    mirrorPath(repository: string) {
        const key = repository.toLowerCase();
        if (!REPOSITORY.test(key) || key.includes('..')) {
            throw new CodingGitError('Not a repository name.');
        }
        const [owner, name] = key.split('/');
        return join(this.config.dir, 'mirrors', owner, `${name}.git`);
    }

    private options(gitDir: string, extra: Partial<GitOptions> = {}): GitOptions {
        return {
            gitDir,
            home: this.home,
            timeoutMs: this.config.timeoutMs,
            ...extra,
        };
    }

    /** One repository's operations run one at a time (refresh vs. reads). */
    private locked<T>(repository: string, work: () => Promise<T>): Promise<T> {
        const key = repository.toLowerCase();
        const before = this.locks.get(key) ?? Promise.resolve();
        const run = before.then(work, work);
        const settled = run.catch(() => undefined);
        this.locks.set(key, settled);
        void settled.then(() => {
            if (this.locks.get(key) === settled) {
                this.locks.delete(key);
            }
        });
        return run;
    }

    private async ensureMirror(repository: string) {
        const path = this.mirrorPath(repository);
        await mkdir(this.home, { recursive: true });
        try {
            await stat(join(path, 'HEAD'));
        } catch {
            await mkdir(path, { recursive: true });
            await git(['init', '--quiet', '--bare', path], this.options(path));
        }
        return path;
    }

    private async exists(repository: string) {
        const path = this.mirrorPath(repository);
        try {
            await stat(join(path, 'HEAD'));
            return true;
        } catch {
            return false;
        }
    }

    /** The mirror's ref tips (for the app's `have` lines), and one commit's presence. */
    refs(repository: string, has?: string) {
        return this.locked(repository, async () => {
            if (!(await this.exists(repository))) {
                return { tips: [] as string[], has: false };
            }
            const path = this.mirrorPath(repository);
            const out = (await git(['for-each-ref', '--format=%(objectname)'], this.options(path))).toString('utf8');
            const tips = [...new Set(out.split('\n').filter((line) => SHA.test(line)))];
            const present =
                !!has && SHA.test(has) && (await gitOk(['cat-file', '-e', `${has}^{commit}`], this.options(path)));
            return { tips, has: present };
        });
    }

    /**
     * A refresh the app fetched from GitHub: `pack` (complete, never thin)
     * indexed into the mirror, then its refs set to `refs`, those gone from
     * GitHub deleted. Refs whose object is missing are skipped.
     */
    refresh(repository: string, refs: Record<string, string>, pack: Readable | null) {
        return this.locked(repository, async () => {
            const path = await this.ensureMirror(repository);
            if (pack) {
                await git(
                    ['index-pack', '--stdin', `--max-input-size=${this.config.maxMirrorBytes}`],
                    this.options(path, {
                        input: pack,
                        timeoutMs: this.config.timeoutMs * 5,
                    }),
                ).catch((error: unknown) => {
                    throw new CodingGitError(
                        error instanceof GitFailure ? 'The fetched pack could not be indexed.' : 'The fetch failed.',
                    );
                });
            }
            const wanted = Object.entries(refs).filter(([ref, sha]) => MIRROR_REF.test(ref) && SHA.test(sha));
            const current = (await git(['for-each-ref', '--format=%(refname) %(objectname)'], this.options(path)))
                .toString('utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => line.split(' ') as [string, string]);
            const lines: string[] = [];
            for (const [ref, sha] of wanted) {
                if (await gitOk(['cat-file', '-e', sha], this.options(path))) {
                    lines.push(`update ${ref} ${sha}`);
                }
            }
            const keep = new Set(wanted.map(([ref]) => ref));
            for (const [ref] of current) {
                if (!keep.has(ref)) {
                    lines.push(`delete ${ref}`);
                }
            }
            if (lines.length) {
                await git(['update-ref', '--stdin'], {
                    ...this.options(path),
                    input: Buffer.from(`${lines.join('\n')}\n`),
                });
            }
            return { refs: lines.filter((line) => line.startsWith('update')).length };
        });
    }

    private spoolDir(id: string) {
        if (!/^[0-9a-f-]{36}$/.test(id)) {
            throw new CodingGitError('No such spool.', 404);
        }
        return join(this.config.dir, 'spool', id);
    }

    /** The accepted push's pack, for the app to forward; undefined when gone. */
    async spoolFile(id: string) {
        const file = join(this.spoolDir(id), 'pack');
        try {
            await stat(file);
            return file;
        } catch {
            return undefined;
        }
    }

    async dropSpool(id: string) {
        await rm(this.spoolDir(id), { recursive: true, force: true });
    }

    /** Spools older than their time (an app that never came back). */
    async sweepSpools(now = Date.now()) {
        const root = join(this.config.dir, 'spool');
        const names = await readdir(root).catch(() => undefined);
        if (!names) {
            return 0;
        }
        let dropped = 0;
        for (const name of names) {
            const path = join(root, name);
            const info = await stat(path).catch(() => undefined);
            if (info && now - info.mtimeMs > this.config.spoolTtlMs) {
                await rm(path, { recursive: true, force: true });
                dropped += 1;
            }
        }
        return dropped;
    }

    /**
     * Inspects one push (CB-239): spools the pack, indexes it with
     * `--fix-thin --strict` into a quarantine over the mirror, lists the new
     * commits of each command and refuses the whole push on the first
     * problem. On success the spool stays for the app to forward; the
     * quarantine's objects never reach the mirror.
     */
    inspect(meta: InspectMeta, pack: Readable): Promise<InspectVerdict> {
        return this.inspections.run(() => this.locked(meta.repository, () => this.inspectNow(meta, pack)));
    }

    private async inspectNow(meta: InspectMeta, pack: Readable): Promise<InspectVerdict> {
        void this.sweepSpools().catch(() => undefined);
        if (!(await this.exists(meta.repository))) {
            pack.destroy();
            return {
                ok: false,
                reason: 'mirror_missing',
                detail: 'the repository has no mirror yet',
            };
        }
        const mirror = this.mirrorPath(meta.repository);
        const id = randomUUID();
        const dir = this.spoolDir(id);
        const objects = join(dir, 'objects');
        await mkdir(join(objects, 'pack'), { recursive: true });
        const file = join(dir, 'pack');
        const refuse = async (reason: PushRefusal, detail: string): Promise<InspectVerdict> => {
            await rm(dir, { recursive: true, force: true });
            return { ok: false, reason, detail };
        };
        try {
            // Spool, counting: never more than the push limit on disk.
            let size = 0;
            const limit = this.config.maxPushBytes;
            const counted = async function* (source: Readable) {
                for await (const chunk of source) {
                    size += (chunk as Buffer).length;
                    if (size > limit) {
                        throw new CodingGitError('too large', 413);
                    }
                    yield chunk as Buffer;
                }
            };
            try {
                await pipeline(pack, counted, createWriteStream(file));
            } catch (error) {
                if (error instanceof CodingGitError && error.status === 413) {
                    return await refuse('pack_too_large', 'the push is larger than allowed');
                }
                throw error;
            }
            const env = {
                GIT_OBJECT_DIRECTORY: objects,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: join(mirror, 'objects'),
            };
            const options = this.options(mirror, { env });
            if (size > 0) {
                const header = Buffer.alloc(12);
                const handle = await open(file, 'r');
                try {
                    await handle.read(header, 0, 12, 0);
                } finally {
                    await handle.close();
                }
                if (
                    size < 32 ||
                    header.toString('ascii', 0, 4) !== 'PACK' ||
                    ![2, 3].includes(header.readUInt32BE(4))
                ) {
                    return await refuse('pack_invalid', 'the push is not a Git pack');
                }
                if (header.readUInt32BE(8) > this.config.maxPushObjects) {
                    return await refuse('pack_too_large', 'the push has too many objects');
                }
                try {
                    await git(['index-pack', '--stdin', '--fix-thin', '--strict', `--max-input-size=${limit}`], {
                        ...options,
                        input: createReadStream(file),
                    });
                } catch (error) {
                    if (error instanceof GitFailure) {
                        return await refuse('pack_invalid', 'the pack failed Git’s checks');
                    }
                    throw error;
                }
            }
            let commits = 0;
            for (const command of meta.commands) {
                if (command.new === ZERO) {
                    continue;
                }
                if (!SHA.test(command.new)) {
                    return await refuse('not_a_commit', 'a pushed ref is not a commit');
                }
                const type = await git(['cat-file', '-t', command.new], options)
                    .then((out) => out.toString('utf8').trim())
                    .catch(() => '');
                if (type !== 'commit') {
                    return await refuse('not_a_commit', 'a pushed ref is not a commit');
                }
                const listed = (
                    await git(
                        [
                            'rev-list',
                            '--topo-order',
                            `--max-count=${this.config.maxCommits + 1}`,
                            command.new,
                            '--not',
                            '--all',
                        ],
                        options,
                    )
                )
                    .toString('utf8')
                    .split('\n')
                    .filter((line) => SHA.test(line));
                if (listed.length > this.config.maxCommits) {
                    return await refuse('too_many_commits', `a push may add at most ${this.config.maxCommits} commits`);
                }
                commits += listed.length;
                const raw = new Map<string, string>();
                if (listed.length) {
                    await readBlobs(listed, options, (sha, data) => raw.set(sha, data.toString('utf8')));
                }
                for (const sha of listed) {
                    const commit = parseCommit(raw.get(sha) ?? '');
                    const problem = commitProblems(commit, meta.identity);
                    if (problem) {
                        return await refuse(problem.reason, problem.detail);
                    }
                    // Paths new against every parent (`-c`: a clean merge of the
                    // base brings nothing new; an evil merge does).
                    const changes = parseRawDiff(
                        await git(
                            ['diff-tree', '-r', '-z', '--root', '-c', '--no-commit-id', '--no-renames', '--raw', sha],
                            { ...options, maxOutput: 64 * 1024 * 1024 },
                        ),
                    );
                    for (const change of changes) {
                        const found = pathProblem(change);
                        if (found) {
                            return await refuse(found.reason, found.detail);
                        }
                    }
                    // Added lines, against every parent, scanned for token shapes.
                    const scanner = new AddedLineScanner(Math.max(1, commit.parents.length));
                    await git(
                        [
                            'diff-tree',
                            '-p',
                            '-U0',
                            '--cc',
                            '--root',
                            '-a',
                            '--no-commit-id',
                            '--no-renames',
                            '--no-ext-diff',
                            '--no-textconv',
                            sha,
                        ],
                        {
                            ...options,
                            maxOutput: 1024 * 1024 * 1024,
                            onData: (chunk) => scanner.push(chunk.toString('utf8')),
                        },
                    );
                    if (scanner.end()) {
                        return await refuse('token_shape', 'an added line holds something shaped like a Socio token');
                    }
                }
            }
            // The quarantine's objects go; the pack waits to be forwarded.
            await rm(objects, { recursive: true, force: true });
            return { ok: true, spool: id, commits };
        } catch (error) {
            await rm(dir, { recursive: true, force: true });
            throw error;
        }
    }

    /**
     * An extraction's files (CB-267) from the mirror at `commit`: only
     * regular files under the approved paths (symlinks, gitlinks and `.git`
     * paths dropped), compared after normalization, and refused rather than
     * cut short when over `maxBytes` or `maxFiles`.
     */
    extract(repository: string, request: ExtractRequest): Promise<ExtractResult> {
        return this.locked(repository, async () => {
            if (
                !request.paths.length ||
                request.paths.length > MAX_SCOPE_PATHS ||
                request.paths.some((path) => scopePathProblem(path))
            ) {
                return {
                    ok: false,
                    reason: 'paths_invalid',
                    detail: 'the paths are not a valid scope',
                };
            }
            if (!SHA.test(request.commit) || !(await this.exists(repository))) {
                return {
                    ok: false,
                    reason: 'commit_missing',
                    detail: 'the commit is not in the mirror',
                };
            }
            const path = this.mirrorPath(repository);
            const options = this.options(path);
            if (!(await gitOk(['cat-file', '-e', `${request.commit}^{commit}`], options))) {
                return {
                    ok: false,
                    reason: 'commit_missing',
                    detail: 'the commit is not in the mirror',
                };
            }
            const listing = (
                await git(['ls-tree', '-r', '-z', '-l', '--full-tree', request.commit], {
                    ...options,
                    maxOutput: 256 * 1024 * 1024,
                })
            )
                .toString('utf8')
                .split('\0')
                .filter(Boolean);
            const inScope = compileScope(request.paths);
            const chosen: Array<{
                path: string;
                sha: string;
                size: number;
                mode: string;
            }> = [];
            let dropped = 0;
            let bytes = 0;
            for (const entry of listing) {
                const tab = entry.indexOf('\t');
                const [mode, type, sha, size] = entry.slice(0, tab).trim().split(/\s+/);
                const file = entry.slice(tab + 1);
                if (!inScope(file)) {
                    continue;
                }
                if (type !== 'blob' || !FILE_MODES.includes(mode) || hasGitSegment(file)) {
                    dropped += 1;
                    continue;
                }
                bytes += Number(size);
                chosen.push({ path: file, sha, size: Number(size), mode });
                if (chosen.length > request.maxFiles || bytes > request.maxBytes) {
                    return {
                        ok: false,
                        reason: 'too_large',
                        detail: `the paths hold more than ${request.maxFiles} files or ${Math.round(request.maxBytes / 1048576)} MB`,
                    };
                }
            }
            const contents = new Map<string, Buffer>();
            if (chosen.length) {
                await readBlobs([...new Set(chosen.map((entry) => entry.sha))], options, (sha, data) =>
                    contents.set(sha, data),
                );
            }
            return {
                ok: true,
                bytes,
                dropped,
                files: chosen.map((entry) => ({
                    path: entry.path,
                    executable: entry.mode === '100755',
                    size: entry.size,
                    content: (contents.get(entry.sha) ?? Buffer.alloc(0)).toString('base64'),
                })),
            };
        });
    }
}
