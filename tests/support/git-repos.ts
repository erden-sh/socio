// Local Git repositories for the Git proxy's and coding-git's tests
// (CB-239): real git, on temporary directories, no network.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Who {
    name: string;
    email: string;
}

/** The socio identity the tests push as. */
export const SOCIO: Who = {
    name: 'Rulo (Socio)',
    email: 'socio-0123456789abcdef@users.noreply.apps.example',
};
export const PERSON: Who = { name: 'Pat Person', email: 'pat@example.com' };

const env = (author: Who, committer: Who = author) => ({
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_AUTHOR_DATE: '2026-10-28T12:00:00Z',
    GIT_COMMITTER_DATE: '2026-10-28T12:00:00Z',
});

export function tempDir(prefix: string, cleanup: Array<() => unknown>) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** A working repository with helpers to commit files as someone. */
export function workRepo(dir: string) {
    mkdirSync(dir, { recursive: true });
    const run = (args: string[], who: Who = SOCIO, committer?: Who, input?: string) =>
        execFileSync('git', ['-C', dir, ...args], {
            env: env(who, committer),
            input,
            maxBuffer: 256 * 1024 * 1024,
        })
            .toString('utf8')
            .trim();
    run(['init', '--quiet', '-b', 'main']);
    return {
        dir,
        git: run,
        write(path: string, content: string | Buffer) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            writeFileSync(join(dir, path), content);
        },
        symlink(path: string, target: string) {
            mkdirSync(dirname(join(dir, path)), { recursive: true });
            symlinkSync(target, join(dir, path));
        },
        commit(message: string, who: Who = SOCIO, committer?: Who) {
            run(['add', '-A']);
            run(['commit', '--quiet', '--allow-empty', '-m', message], who, committer);
            return run(['rev-parse', 'HEAD']);
        },
        /** Commits the index as it is (a gitlink staged by hand stays). */
        commitStaged(message: string, who: Who = SOCIO) {
            run(['commit', '--quiet', '--allow-empty', '-m', message], who);
            return run(['rev-parse', 'HEAD']);
        },
        head: () => run(['rev-parse', 'HEAD']),
        /** A pack of `include` minus `exclude` (thin: deltas against `exclude`). */
        pack(include: string[], exclude: string[], thin = true) {
            return execFileSync(
                'git',
                ['-C', dir, 'pack-objects', '--stdout', '--revs', ...(thin ? ['--thin'] : []), '-q'],
                {
                    env: env(SOCIO),
                    input: [...include, ...exclude.map((sha) => `^${sha}`)].join('\n') + '\n',
                    maxBuffer: 256 * 1024 * 1024,
                },
            );
        },
        /** Every ref and its object id. */
        refs() {
            const out = run(['for-each-ref', '--format=%(refname) %(objectname)']);
            return Object.fromEntries(
                out
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => line.split(' ') as [string, string]),
            );
        },
    };
}
export type WorkRepo = ReturnType<typeof workRepo>;
