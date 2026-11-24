import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

/**
 * Git as `coding-git` runs it (CB-239): argv only (no shell), a clean
 * environment (no system or global config, no hooks, no fsmonitor, no
 * pager, no prompts, no replace objects, no transports), a time limit and
 * a cap on what it may print. The repositories it reads
 * are mirrors and quarantines of hostile packs: nothing in them configures
 * anything that runs.
 */

export class GitFailure extends Error {
    constructor(
        message: string,
        readonly code: number | null,
        readonly stderr = '',
    ) {
        super(message);
    }
}

/** Options every command gets, before its own arguments. */
export const SAFE_CONFIG = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=',
    '-c',
    'core.pager=cat',
    '-c',
    'protocol.allow=never',
    '-c',
    'core.askPass=',
    '-c',
    'credential.helper=',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
];

export interface GitOptions {
    /** `GIT_DIR`. */
    gitDir: string;
    /** Extra environment: a quarantine's object directories. */
    env?: Record<string, string>;
    /** Bytes or a stream for stdin. */
    input?: Buffer | Readable;
    timeoutMs?: number;
    /** The most stdout may hold; past it the command is killed and fails. */
    maxOutput?: number;
    /** Called with each chunk of stdout instead of collecting it. */
    onData?: (chunk: Buffer) => void;
    /** `HOME` for git: an empty directory of the service's own. */
    home: string;
}

export function gitEnv(options: Pick<GitOptions, 'gitDir' | 'env' | 'home'>) {
    return {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: options.home,
        GIT_DIR: options.gitDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_ATTR_NOSYSTEM: '1',
        GIT_PROTOCOL_FROM_USER: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.env,
    };
}

/** Runs `git <SAFE_CONFIG> <args>`; resolves stdout, or throws `GitFailure`. */
export function git(args: string[], options: GitOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', [...SAFE_CONFIG, ...args], {
            env: gitEnv(options),
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let failed: GitFailure | undefined;
        const fail = (error: GitFailure) => {
            failed ??= error;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new GitFailure('git took too long.', null)), options.timeoutMs ?? 60_000);
        child.stdout.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (options.maxOutput !== undefined && size > options.maxOutput) {
                return fail(new GitFailure('git printed too much.', null));
            }
            if (!options.onData) {
                return void chunks.push(chunk);
            }
            try {
                options.onData(chunk);
            } catch (error) {
                fail(error instanceof GitFailure ? error : new GitFailure('Reading git’s output failed.', null));
            }
        });
        child.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < 4096) {
                stderr += chunk.toString('utf8');
            }
        });
        child.on('error', (error) => fail(new GitFailure(`git could not start: ${error.message}`, null)));
        child.stdin.on('error', () => undefined);
        const input = options.input;
        if (Buffer.isBuffer(input)) {
            child.stdin.end(input);
        } else if (input) {
            input.on('error', () => fail(new GitFailure('The input stream failed.', null)));
            input.pipe(child.stdin);
        } else {
            child.stdin.end();
        }
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failed) {
                return reject(failed);
            }
            if (code !== 0) {
                return reject(new GitFailure(`git ${args[0]} failed (${code}).`, code, stderr));
            }
            resolve(Buffer.concat(chunks));
        });
    });
}

/** Whether `git` succeeds (an existence check). */
export async function gitOk(args: string[], options: GitOptions) {
    try {
        await git(args, options);
        return true;
    } catch (error) {
        if (error instanceof GitFailure && error.code !== null) {
            return false;
        }
        throw error;
    }
}

/**
 * Reads blobs with one `git cat-file --batch`: calls `onBlob` with each
 * object's id and bytes, in the order given.
 */
export function readBlobs(
    ids: string[],
    options: Omit<GitOptions, 'input' | 'onData'>,
    onBlob: (id: string, data: Buffer) => void,
): Promise<void> {
    let header = Buffer.alloc(0);
    let pending: { id: string; left: number; parts: Buffer[] } | undefined;
    const take = (chunk: Buffer) => {
        let rest = chunk;
        while (rest.length) {
            if (!pending) {
                const newline = rest.indexOf(10);
                if (newline < 0) {
                    header = Buffer.concat([header, rest]);
                    return;
                }
                const line = Buffer.concat([header, rest.subarray(0, newline)])
                    .toString('utf8')
                    .split(' ');
                header = Buffer.alloc(0);
                rest = rest.subarray(newline + 1);
                if (line[1] === 'missing' || line.length < 3) {
                    throw new GitFailure(`Object ${line[0]} is missing.`, null);
                }
                // The object, then one newline.
                pending = { id: line[0], left: Number(line[2]) + 1, parts: [] };
                continue;
            }
            const part = rest.subarray(0, pending.left);
            pending.parts.push(part);
            pending.left -= part.length;
            rest = rest.subarray(part.length);
            if (pending.left === 0) {
                const data = Buffer.concat(pending.parts);
                onBlob(pending.id, data.subarray(0, data.length - 1));
                pending = undefined;
            }
        }
    };
    return git(['cat-file', '--batch'], {
        ...options,
        input: Buffer.from(ids.map((id) => `${id}\n`).join('')),
        onData: take,
    }).then(() => undefined);
}
