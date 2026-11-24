#!/usr/bin/env node
// The only way this repository runs Turborepo: every script and CI go through
// here, so its telemetry, update check and remote cache stay off. turbo.json
// can't turn telemetry off, so a bare `turbo` in a shell would phone home unless
// the environment says otherwise; use this. AGENTS.md ("Checks") and SECURITY.md
// ("Vendor telemetry") say why.
//
//   node scripts/turbo.mjs check [turbo flags]    format, lint, typecheck
//   node scripts/turbo.mjs test [turbo flags]     the test buckets
//   node scripts/turbo.mjs build [turbo flags]    the production build
//   node scripts/turbo.mjs run <tasks> [flags]    anything else
//
// Results are shared between this machine's worktrees, in SOCIO_TURBO_CACHE_DIR
// or else $XDG_CACHE_HOME/socio/turbo (~/.cache/socio/turbo). `--force` runs
// everything for real; `pnpm run check`, `pnpm test` and `pnpm run build` never
// touch the cache.
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

export const GROUPS = {
    check: ['check-format', 'lint:root', 'lint', 'typecheck:root', 'typecheck:mixed', 'typecheck'],
    test: ['test:server', 'test:mixed', 'test'],
    build: ['build', 'build:packages', 'build:server', 'build:release-data', 'build:released-migrations'],
};

// Each Vitest sizes its pool from the machine's cores, so running the buckets at
// once oversubscribes it and tests hit their timeouts (measured: 3-5 of them, on
// every such run on a loaded machine). One at a time, as a single `vitest run` has it.
const GROUP_FLAGS = { test: ['--concurrency=1'] };

/** Settings turbo would otherwise take from the shell or a past `turbo login`: remote caches and tracing among them. */
const FOREIGN = /^(?:TURBO_|VERCEL_ARTIFACTS_|VC_)/;

/** Where this machine keeps results when nothing says otherwise. */
export const defaultCacheDir = (env = process.env, home = homedir()) =>
    env.SOCIO_TURBO_CACHE_DIR || join(env.XDG_CACHE_HOME || join(home, '.cache'), 'socio', 'turbo');

const versionOf = (command, args) => {
    try {
        return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return `no ${command}`;
    }
};

/** What ran the tasks, hashed through globalEnv: a result from another Node or git is not this one's. */
const toolchain = () =>
    [process.version, `${process.platform}-${process.arch}`, versionOf('git', ['--version'])].join('; ');

/** The environment turbo runs in: every opt-out on, nothing inherited that could turn one off. */
export const turboEnv = (env = process.env, tools = toolchain) => ({
    ...Object.fromEntries(Object.entries(env).filter(([name]) => !FOREIGN.test(name))),
    TURBO_TELEMETRY_DISABLED: '1',
    TURBO_TELEMETRY_MESSAGE_DISABLED: '1',
    DO_NOT_TRACK: '1',
    TURBO_NO_UPDATE_NOTIFIER: '1',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    TURBO_CACHE_DIR: defaultCacheDir(env),
    SOCIO_TOOLCHAIN: tools(),
});

/** Turbo's arguments: the group's tasks, then this repository's defaults unless the caller set them. */
export const turboArgs = (args) => {
    const [first, ...rest] = args;
    const tasks = GROUPS[first] ? ['run', ...GROUPS[first]] : [first];
    const split = rest.indexOf('--');
    // `--force` means a real run, as `--cache=local:w` does. Turbo refuses the two together.
    const flags = (split === -1 ? rest : rest.slice(0, split)).map((arg) =>
        arg === '--force' ? '--cache=local:w' : arg,
    );
    const forwarded = split === -1 ? [] : rest.slice(split);
    const unset = (flag) => !flags.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
    return [
        ...tasks,
        ...flags,
        ...(GROUP_FLAGS[first] ?? []).filter((flag) => unset(flag.split('=')[0])),
        ...(unset('--cache') ? ['--cache=local:rw'] : []),
        ...(unset('--log-order') ? ['--log-order=grouped'] : []),
        ...(unset('--output-logs') ? ['--output-logs=new-only'] : []),
        ...(unset('--continue') ? ['--continue'] : []),
        ...forwarded,
    ];
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    if (process.argv.length < 3) {
        console.error(`Usage: node scripts/turbo.mjs <${Object.keys(GROUPS).join('|')}|run> [turbo flags]`);
        process.exit(2);
    }
    const binary = join(root, 'node_modules/.bin/turbo');
    const { status, error } = spawnSync(binary, turboArgs(process.argv.slice(2)), {
        cwd: root,
        env: turboEnv(),
        stdio: 'inherit',
    });
    if (error) {
        console.error(`${binary}: ${error.message}`);
    }
    process.exit(status ?? 1);
}
