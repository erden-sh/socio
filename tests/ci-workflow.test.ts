// CI runs untrusted code (CB-32): coding agents write branches too.
// These checks keep the workflow's sandbox from being lost in an edit, and
// run its trusted scripts (.github/ci) on real diffs and a stand-in docker.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer, connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const ci = (name: string) => join(root, '.github/ci', name);
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const workflow = read('.github/workflows/ci.yml');
const image = readFileSync(ci('Dockerfile'), 'utf8');
const box = readFileSync(ci('box.sh'), 'utf8');
const install = readFileSync(ci('install.sh'), 'utf8');
const turbo = readFileSync(ci('turbo.sh'), 'utf8');
const turboCache = readFileSync(ci('turbo-cache.sh'), 'utf8');
const referenceBaseline = readFileSync(ci('reference-baseline.sh'), 'utf8');
/** Text without comment lines or trailing comments. */
const uncommented = (text: string) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/\s#.*$/, ''))
        .join('\n');
const code = uncommented(workflow);
const scripts = uncommented(`${box}\n${install}\n${turbo}\n${turboCache}\n${referenceBaseline}`);
const jobsSection = code.slice(code.indexOf('\njobs:\n'));
/** Each job's text, by name. */
const jobs = Object.fromEntries(
    jobsSection
        .split(/^ {2}(?=[\w-]+:\n {4})/m)
        .slice(1)
        .map((text) => [text.slice(0, text.indexOf(':')), text]),
);
/** A job's steps, each as its text. */
const steps = (job: string) =>
    jobs[job]
        .slice(jobs[job].indexOf('steps:'))
        .split(/^ {6}- /m)
        .slice(1);
/** A step's shell commands, one per line (continuations joined). */
const commands = (step: string) => {
    const run = /run: (?:\|\n((?: {10}.*\n?)+)|(.+))/.exec(step);
    if (!run) {
        return [];
    }
    return (run[1] ?? run[2])
        .replace(/\\\n\s*/g, '')
        .split('\n')
        .map((line) => line.trim().replace(/^'(.*)'$/, '$1'))
        .filter(Boolean);
};
/** What each step of a job does: an action it uses, or its commands. */
const plan = (job: string) => steps(job).map((step) => /uses: (\S+)/.exec(step)?.[1] ?? commands(step));
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const RUNNER_CHECK = ['bash .github/ci/runner-check.sh'];
const RESTORE = 'actions/cache/restore@27d5ce7f107fe9357f9df03efb73ab90386fccae';
const SAVE = 'actions/cache/save@27d5ce7f107fe9357f9df03efb73ab90386fccae';
const COPY = [
    'mkdir -p "$RUNNER_TEMP/src"',
    'tar --exclude=./.git --exclude=./.turbo-ci -C "$GITHUB_WORKSPACE" -cf - . | tar -C "$RUNNER_TEMP/src" -xf -',
];
const REFERENCE = ['bash .github/ci/reference-baseline.sh'];
const ON_PULL_REQUEST = "if: github.event_name == 'pull_request'";
const ON_MAIN = "if: github.event_name == 'push' && github.ref == 'refs/heads/main'";

it('runs on pushes and pull requests, and nothing else', () => {
    const on = code.slice(code.indexOf('\non:\n') + 5, code.indexOf('\npermissions:'));
    expect([...on.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1])).toEqual(['push', 'pull_request']);
    // push is scoped to main so PR branch pushes don't duplicate (push +
    // pull_request both fire); pull_request covers PR branches.
    expect(on).toContain('  push:\n    branches: [main]\n  pull_request:\n    types: [opened, synchronize, reopened]');
    expect(code).not.toMatch(/workflow_dispatch|workflow_run|schedule|pull_request_target|repository_dispatch/);
});

it('gives CI a read-only token and no secrets', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
    expect(code).not.toMatch(/:\s*write\b/);
    expect(`${code}\n${scripts}`).not.toMatch(/secrets\.|github\.token|GITHUB_TOKEN/);
});

it('uses only actions pinned by commit, and a checkout that keeps no credentials and fetches no submodules', () => {
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
    // Per job: checkout, the cache's restore and save (the test matrix
    // expands to 4 at runtime, but the YAML has one uses: per job).
    expect(uses).toEqual([CHECKOUT, RESTORE, SAVE, CHECKOUT, RESTORE, SAVE]);
    expect(code).not.toMatch(/harden-runner|setup-node|cache:|submodules:/);
    // The test job fetches main's commit too, as the first parent: no more
    // history, and no credentials to fetch it with later.
    const pinned = { check: ['persist-credentials: false'], test: ['persist-credentials: false', 'fetch-depth: 2'] };
    for (const [job, expected] of Object.entries(pinned)) {
        const step = steps(job).find((s) => s.includes('uses:'))!;
        const options = step.slice(step.indexOf('with:') + 5);
        expect(
            [...options.matchAll(/^ {10}([\w-]+: .*)$/gm)].map((m) => m[1].trim()),
            job,
        ).toEqual(expected);
    }
});

it('runs only an allowed list of commands on the runner, none from the branch', () => {
    // check job: format/lint/typecheck, build, smoke — no tests (those are
    // in the sharded test job).
    expect(plan('check')).toEqual([
        CHECKOUT,
        RUNNER_CHECK,
        COPY,
        RESTORE,
        ['bash .github/ci/turbo-cache.sh import'],
        ['docker build --pull --tag ci-box .github/ci'],
        ['bash .github/ci/install.sh'],
        ['bash .github/ci/box.sh pnpm rebuild', 'bash .github/ci/box.sh node vendor/check-stubs.cjs'],
        ['bash .github/ci/turbo.sh check'],
        ['bash .github/ci/turbo.sh build'],
        ['bash .github/ci/box.sh bash .github/ci/smoke.sh'],
        ['bash .github/ci/turbo-cache.sh export'],
        SAVE,
    ]);
    // test job (shard 1 as representative). The --shard flag is passed via
    // ${{ matrix.shard }} — an env var, not inline text the branch controls
    // (the matrix value is trusted, from the workflow).
    // The test job also puts main's feature boundary baseline in the copy,
    // from the checkout's .git, before any container runs.
    expect(plan('test')).toEqual([
        CHECKOUT,
        RUNNER_CHECK,
        COPY,
        REFERENCE,
        RESTORE,
        ['bash .github/ci/turbo-cache.sh import'],
        ['docker build --pull --tag ci-box .github/ci'],
        ['bash .github/ci/install.sh'],
        ['bash .github/ci/box.sh pnpm rebuild', 'bash .github/ci/box.sh node vendor/check-stubs.cjs'],
        ['bash .github/ci/turbo.sh test --concurrency=1 -- --shard=$SHARD_INDEX/4'],
        ['bash .github/ci/turbo-cache.sh export'],
        SAVE,
    ]);
});

it('runs every job on GitHub-hosted runners, each checked before any container starts', () => {
    expect([...code.matchAll(/runs-on:\s*(.+)/g)].map((m) => m[1].trim())).toEqual(['ubuntu-latest', 'ubuntu-latest']);
    for (const job of ['check', 'test']) {
        expect(plan(job).slice(0, 2)).toEqual([CHECKOUT, RUNNER_CHECK]);
    }
});

/** Runs runner-check.sh against a stand-in docker and ss (which exits `ssStatus`, or is missing). */
function runnerCheck(
    dockerVersion: string,
    listeners: string,
    ssStatus: number | 'missing' = 0,
    extraEnv: Record<string, string> = {},
) {
    const dir = temp();
    writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash\necho '${dockerVersion}'\n`);
    writeFileSync(
        join(dir, 'ss'),
        `#!/usr/bin/env bash\nprintf '%s' '${listeners}'\nexit ${ssStatus === 'missing' ? 0 : ssStatus}\n`,
    );
    chmodSync(join(dir, 'docker'), 0o755);
    chmodSync(join(dir, 'ss'), 0o755);
    const result = spawnSync('bash', [ci('runner-check.sh')], {
        env: {
            PATH: process.env.PATH,
            DOCKER: join(dir, 'docker'),
            SS: ssStatus === 'missing' ? join(dir, 'no-such-ss') : join(dir, 'ss'),
            ...extraEnv,
        },
    });
    return { status: result.status, out: result.stdout.toString() };
}

const LOOPBACK = [
    'udp UNCONN 0 0 127.0.0.54:53 0.0.0.0:*',
    'udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*',
    'udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*',
    'udp UNCONN 0 0 [::1]:323 [::]:*',
    'tcp LISTEN 0 4096 127.0.0.1:25 0.0.0.0:*',
    // The DHCP client: the instance's own address, bound to its interface.
    'udp UNCONN 0 0 10.70.11.186%enp39s0:68 0.0.0.0:*',
].join('\n');

it('stops sshd on a GitHub-hosted runner before it checks, and only there', () => {
    const dir = temp();
    const sshd = join(dir, 'sshd');
    writeFileSync(sshd, 'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n');
    const loopback = join(dir, 'loopback');
    writeFileSync(loopback, `${LOOPBACK}\n`);
    const ss = join(dir, 'ss-live');
    writeFileSync(ss, `#!/usr/bin/env bash\ncat '${sshd}' 2>/dev/null\ncat '${loopback}'\n`);
    chmodSync(ss, 0o755);
    const stop = join(dir, 'stop-ssh');
    writeFileSync(stop, `#!/usr/bin/env bash\nrm -f '${sshd}'\n`);
    chmodSync(stop, 0o755);
    // Elsewhere nothing is stopped, and the listener still fails the check.
    const elsewhere = runnerCheck('29.1.3', '', 0, { SS: ss, SSH_STOP: stop });
    expect(elsewhere.status).toBe(1);
    expect(existsSync(sshd)).toBe(true);
    const hosted = runnerCheck('29.1.3', '', 0, { SS: ss, SSH_STOP: stop, RUNNER_ENVIRONMENT: 'github-hosted' });
    expect(hosted.status).toBe(0);
    expect(existsSync(sshd)).toBe(false);
});

it('passes a runner with Docker 26+ and only loopback listeners', () => {
    const ok = runnerCheck('29.1.3', LOOPBACK);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('Runner OK: Docker 29.1.3');
    expect(runnerCheck('26.0.0', '').status).toBe(0);
});

it('stops on Docker before 26, or an unreadable version', () => {
    for (const version of ['25.0.18', '9.0.0', 'unknown', '']) {
        const result = runnerCheck(version, LOOPBACK);
        expect(result.status).toBe(1);
        expect(result.out).toMatch(/^::error::Docker .* CI needs 26 or later/m);
    }
});

it('stops when it cannot list the listeners, rather than reading no output as none', () => {
    for (const status of [1, 2, 'missing'] as const) {
        const result = runnerCheck('29.1.3', '', status);
        expect(result.status).toBe(1);
        expect(result.out).toMatch(/^::error::Could not list this runner's listeners/m);
        expect(result.out).not.toContain('Runner OK');
    }
    // ss failing after printing only loopback listeners still stops.
    expect(runnerCheck('29.1.3', LOOPBACK, 1).status).toBe(1);
});

it('stops when anything on the runner listens beyond loopback', () => {
    for (const listener of [
        'tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*',
        'tcp LISTEN 0 4096 [::]:22 [::]:*',
        'tcp LISTEN 0 4096 *:8080 *:*',
        'tcp LISTEN 0 4096 172.17.0.1:9000 0.0.0.0:*',
        'udp UNCONN 0 0 0.0.0.0:68 0.0.0.0:*',
        'udp UNCONN 0 0 0.0.0.0%enp39s0:68 0.0.0.0:*',
        'udp UNCONN 0 0 10.70.11.186:68 0.0.0.0:*',
        'tcp LISTEN 0 4096 10.70.11.186%enp39s0:68 0.0.0.0:*',
        'udp UNCONN 0 0 10.70.11.186%enp39s0:5353 0.0.0.0:*',
    ]) {
        const result = runnerCheck('29.1.3', `${LOOPBACK}\n${listener}`);
        expect(result.status).toBe(1);
        expect(result.out).toMatch(/^::error::This runner listens beyond loopback/m);
    }
});

it('mounts only the copy of the checkout, and gives containers no way into the runner', () => {
    expect(code).not.toMatch(/-v |--volume|--mount/);
    const mounts = [...scripts.matchAll(/(?:-v|--volume|--mount)[ =]("?)([^\s"]+)\1:/g)].map((match) => match[2]);
    expect(mounts).toEqual(['$RUNNER_TEMP/src', '$RUNNER_TEMP/src']);
    // The directory actions/cache uses on the runner is never mounted.
    expect(`${box}\n${install}`).not.toContain('turbo-cache');
    expect(`${code}\n${scripts}`).not.toMatch(
        /\$PWD|GITHUB_WORKSPACE"?:|github\.workspace|docker\.sock|--privileged|--pid|--network host|--cap-add/,
    );
    // Never the runner's group (it may be docker): nogroup.
    expect(scripts.match(/--user "\$\(id -u\):65534"/g)).toHaveLength(2);
    expect(scripts).not.toMatch(/id -g/);
});

it('installs from the npm registry only, on the internal network, and runs the branch’s code with no network', () => {
    expect(install).toContain('"$docker" network create --internal ci-sandbox');
    // The proxy: nobody, no capabilities, registry.npmjs.org:443 alone.
    expect(uncommented(install).replace(/\\\n\s*/g, '')).toContain(
        '"$docker" run -d --init --name ci-egress --network bridge --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 -e EGRESS_ALLOW=registry.npmjs.org:443 ci-box node /ci/egress-proxy.mjs',
    );
    // Only the proxy joins the internal network; the install is on it alone.
    expect([...install.matchAll(/network connect (\S+) (\S+)/g)].map((m) => m.slice(1))).toEqual([
        ['ci-sandbox', 'ci-egress'],
    ]);
    expect([...scripts.matchAll(/--network[ =](\S+)/g)].map((m) => m[1])).toEqual(['none', 'bridge', 'ci-sandbox']);
    // Exactly the lockfile, with no scripts and no .pnpmfile hooks (CB-183).
    expect(uncommented(install).replace(/\\\n\s*/g, '')).toContain(
        'ci-box pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /tmp/pnpm-store',
    );
    expect(box).toMatch(/run --rm --init --network none --cap-drop ALL \\\n\s+--security-opt no-new-privileges/);
    // The image: the app's Node, the same digest, git and the proxy, from
    // .github/ci.
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const node = dockerfile.match(/^FROM (node:\S+) AS app$/m)![1];
    expect(image.split('\n')).toContain(`FROM ${node}`);
    expect(image).toContain('COPY egress-proxy.mjs /ci/egress-proxy.mjs');
    // pnpm: the one package.json names, baked in; never downloaded at run time.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        packageManager: string;
    };
    expect(pkg.packageManager).toMatch(/^pnpm@[\d.]+\+sha512\.[0-9a-f]{128}$/);
    expect(uncommented(image).replace(/\\\n\s*/g, '')).toContain(
        `RUN npm install -g corepack && corepack enable pnpm && corepack install --global ${pkg.packageManager} && chmod -R a+rX /opt/corepack`,
    );
    expect(image).toMatch(/^ENV COREPACK_HOME=\/opt\/corepack /m);
    expect(image).toMatch(/^ENV COREPACK_ENABLE_NETWORK=0$/m);
});

// CB-183: one Node, the latest LTS, in development and every image.
// CB-203: moved to Node 26 (Lithium) once it became LTS.
it('pins one Node version, by digest, everywhere', () => {
    const version = read('.nvmrc').trim();
    expect(version).toMatch(/^26\.\d+\.\d+$/);
    expect(read('.node-version').trim()).toBe(version);
    const pkg = JSON.parse(read('package.json')) as {
        engines: { node: string };
    };
    expect(pkg.engines.node).toBe(`>=${version} <27`);
    const froms = [read('Dockerfile'), image, read('deployment/coding/coding.Dockerfile')]
        .flatMap((text) => [...text.matchAll(/^FROM (node:\S+)/gm)])
        .map((match) => match[1]);
    // build, prod-deps, app, chromium, coding-git, apps-runtime,
    // coding-egress, CI's, and the coding host's (CB-239).
    expect(froms).toHaveLength(12);
    for (const from of froms) {
        expect(from).toMatch(new RegExp(`^node:${version.replace(/\./g, '\\.')}-bookworm-slim@sha256:[0-9a-f]{64}$`));
    }
    expect(new Set(froms).size).toBe(1);
});

it('runs two jobs, with no condition that could skip its checks', () => {
    expect(Object.keys(jobs)).toEqual(['check', 'test']);
    // Neither job has an if: that could skip it; test doesn't need check
    // (they run in parallel — both must always run). Only the cache's own
    // steps have a condition, so no check depends on it.
    expect(jobs.check).not.toMatch(/^ {4}(if|needs):/m);
    expect(jobs.test).not.toMatch(/^ {4}(if|needs):/m);
    for (const job of ['check', 'test']) {
        for (const step of steps(job).filter((text) => /^ {8}if:/m.test(text))) {
            expect(step, step).toMatch(/turbo-cache|actions\/cache\//);
        }
    }
    // Untrusted values reach the shell only through the environment.
    expect(code).not.toMatch(/run:[^\n]*\$\{\{/);
    for (const line of code.split('\n').filter((l) => l.includes('${{'))) {
        // Context expressions are allowed in env: (10-space indent, uppercase
        // key) and in concurrency.group (2-space indent, trusted built-in
        // context github.ref — never branch-controlled). The cache's path and
        // key use runner.temp, github.sha and matrix.shard alone.
        // concurrency.cancel-in-progress is exactly one comparison of
        // github.ref with main: a boolean, never interpolated anywhere.
        expect(line, line).toMatch(
            /^ {2}cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$|^( {10}[A-Z_]+:| {2}group:) .*\$\{\{ [^}]+ \}\}$|^ {10}path: \$\{\{ runner\.temp \}\}\/turbo-cache$|^ {10}(key|restore-keys): turbo-v1-(check|test-shard\$\{\{ matrix\.shard \}\})-(\$\{\{ github\.sha \}\})?$/,
        );
    }
});

describe("main's feature boundary baseline (reference-baseline.sh)", () => {
    const FILE = 'scripts/feature-boundary-baseline.json';
    const GIT_ENV = {
        PATH: process.env.PATH,
        HOME: tmpdir(),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    };
    const gitIn = (dir: string, ...args: string[]) =>
        execFileSync('git', ['-C', dir, '-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', ...args], {
            env: GIT_ENV,
            encoding: 'utf8',
        }).trim();
    /** A workspace whose commits hold these baselines in order (undefined: no file), the last checked out. */
    const workspace = (...baselines: Array<string | undefined>) => {
        const dir = temp();
        gitIn(dir, 'init', '--quiet');
        for (const [at, baseline] of baselines.entries()) {
            mkdirSync(join(dir, 'scripts'), { recursive: true });
            rmSync(join(dir, FILE), { force: true });
            if (baseline !== undefined) {
                writeFileSync(join(dir, FILE), baseline);
            }
            writeFileSync(join(dir, 'n'), String(at));
            gitIn(dir, 'add', '-A');
            gitIn(dir, 'commit', '--quiet', '-m', `commit ${at}`);
        }
        return dir;
    };
    const run = (dir: string, runner: string, event: Record<string, string> = {}) =>
        spawnSync('bash', [ci('reference-baseline.sh')], {
            env: { ...GIT_ENV, ...event, GITHUB_WORKSPACE: dir, RUNNER_TEMP: runner },
            encoding: 'utf8',
        });

    it('runs on the runner before any container, after the copy exists', () => {
        const order = plan('test').map((step) => (typeof step === 'string' ? step : step[0]));
        expect(order.indexOf(REFERENCE[0])).toBe(order.indexOf(COPY[0]) + 1);
        expect(order.indexOf(REFERENCE[0])).toBeLessThan(order.findIndex((step) => step.startsWith('docker build')));
        // Nothing but git on the workspace and files in the copy: no network, no token.
        expect(uncommented(referenceBaseline)).not.toMatch(/fetch|clone|curl|wget|docker|token|secrets/i);
    });

    it("copies the first parent's baseline into the copy, not the checked-out one", () => {
        const dir = workspace('{"main": true}\n', '{"branch": true}\n');
        const runner = temp();
        mkdirSync(join(runner, 'src'));
        const result = run(dir, runner);
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(join(runner, 'src/.ci-reference/feature-boundary-baseline.json'), 'utf8')).toBe(
            '{"main": true}\n',
        );
        expect(readdirSync(join(runner, 'src/.ci-reference'))).toEqual(['feature-boundary-baseline.json']);
    });

    it('says so when the first parent has no baseline', () => {
        const dir = workspace(undefined, '{"branch": true}\n');
        const runner = temp();
        mkdirSync(join(runner, 'src'));
        expect(run(dir, runner).status).toBe(0);
        expect(readdirSync(join(runner, 'src/.ci-reference'))).toEqual(['feature-boundary-baseline.absent']);
        expect(readFileSync(join(runner, 'src/.ci-reference/feature-boundary-baseline.absent'), 'utf8').trim()).toBe(
            gitIn(dir, 'rev-parse', 'HEAD^1'),
        );
    });

    it('fails without a parent commit, rather than leave the test nothing to compare with', () => {
        const dir = workspace('{"only": true}\n');
        const runner = temp();
        mkdirSync(join(runner, 'src'));
        const result = run(dir, runner);
        expect(result.status).toBe(1);
        expect(result.stdout).toMatch(/^::error::The checkout has no parent commit/m);
        expect(readdirSync(join(runner, 'src/.ci-reference'))).toEqual([]);
    });

    it('records no baseline for the first commit only when it is pushed to main', () => {
        const dir = workspace('{"only": true}\n');
        for (const event of [
            { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/1/merge' },
            { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/feature' },
        ]) {
            const runner = temp();
            mkdirSync(join(runner, 'src'));
            expect(run(dir, runner, event).status, JSON.stringify(event)).toBe(1);
        }
        const runner = temp();
        mkdirSync(join(runner, 'src'));
        const result = run(dir, runner, { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(readFileSync(join(runner, 'src/.ci-reference/feature-boundary-baseline.absent'), 'utf8').trim()).toBe(
            'root',
        );
    });

    it('replaces whatever the branch put at .ci-reference, a link included, without writing through it', () => {
        const dir = workspace('{"main": true}\n', '{"branch": true}\n');
        const runner = temp();
        const elsewhere = join(runner, 'elsewhere');
        mkdirSync(elsewhere);
        mkdirSync(join(runner, 'src'));
        symlinkSync(elsewhere, join(runner, 'src/.ci-reference'));
        expect(run(dir, runner).status).toBe(0);
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(lstatSync(join(runner, 'src/.ci-reference')).isDirectory()).toBe(true);

        rmSync(join(runner, 'src/.ci-reference'), { recursive: true });
        mkdirSync(join(runner, 'src/.ci-reference'));
        writeFileSync(join(runner, 'src/.ci-reference/feature-boundary-baseline.json'), '{"forged": true}\n');
        writeFileSync(join(runner, 'src/.ci-reference/extra'), 'left by the branch');
        expect(run(dir, runner).status).toBe(0);
        expect(readdirSync(join(runner, 'src/.ci-reference'))).toEqual(['feature-boundary-baseline.json']);
        expect(readFileSync(join(runner, 'src/.ci-reference/feature-boundary-baseline.json'), 'utf8')).toBe(
            '{"main": true}\n',
        );
    });
});

describe('the shared task cache', () => {
    const cacheSteps = (job: string) => steps(job).filter((step) => /turbo-cache|actions\/cache\//.test(step));
    const keys = { check: 'turbo-v1-check-', test: 'turbo-v1-test-shard${{ matrix.shard }}-' } as const;
    /** A step's whole `if:` line, so nothing can be appended to the condition (`|| true`). */
    const condition = (step: string) => step.match(/^ {8}if: .*$/gm)?.map((line) => line.trim());
    const everyStep = () => (['check', 'test'] as const).flatMap((job) => steps(job));

    it('saves only on a push to main, and through actions/cache/save alone', () => {
        const saving = everyStep().filter((step) => /actions\/cache\/save@/.test(step));
        expect(saving).toHaveLength(2);
        for (const step of saving) {
            expect(condition(step)).toEqual([ON_MAIN]);
        }
        // actions/cache (restore and save in one) saves in a post step on any event, a pull request's too.
        expect(code).not.toMatch(/actions\/cache@|actions\/cache\/(?!restore@|save@)/);
        for (const step of everyStep().filter((text) => text.includes('turbo-cache.sh export'))) {
            expect(condition(step)).toEqual([ON_MAIN]);
        }
    });

    it('reads the cache only on a pull request, into the runner’s own directory', () => {
        const restoring = everyStep().filter((step) => /actions\/cache\/restore@/.test(step));
        expect(restoring).toHaveLength(2);
        for (const step of [...restoring, ...everyStep().filter((text) => text.includes('turbo-cache.sh import'))]) {
            expect(condition(step)).toEqual([ON_PULL_REQUEST]);
        }
        // The directory actions/cache fills is named only by the cache steps and turbo-cache.sh.
        for (const step of everyStep().filter(
            (text) => text.includes('turbo-cache') && !/actions\/cache\//.test(text),
        )) {
            expect(commands(step), step).toEqual([
                expect.stringMatching(/^bash \.github\/ci\/turbo-cache\.sh (import|export)$/),
            ]);
        }
    });

    it('pins every action in every workflow by a full commit SHA', () => {
        for (const path of [
            '.github/workflows/ci.yml',
            '.github/workflows/release-images.yml',
            '.github/workflows/cla.yml',
        ]) {
            const uses = [...uncommented(read(path)).matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
            expect(uses.length, path).toBeGreaterThan(0);
            for (const action of uses) {
                expect(action, `${path}: ${action}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
            }
        }
    });

    it.each(['check', 'test'] as const)(
        'in %s: only main saves, only pull requests restore, and nothing else',
        (job) => {
            const [restore, importing, exporting, save] = cacheSteps(job);
            expect(cacheSteps(job)).toHaveLength(4);
            expect(restore).toContain(RESTORE);
            expect(condition(restore)).toEqual([ON_PULL_REQUEST]);
            expect(importing).toContain('turbo-cache.sh import');
            expect(condition(importing)).toEqual([ON_PULL_REQUEST]);
            expect(exporting).toContain('turbo-cache.sh export');
            expect(condition(exporting)).toEqual([ON_MAIN]);
            expect(save).toContain(SAVE);
            expect(condition(save)).toEqual([ON_MAIN]);
            // Same path both ways (it is part of the entry's version) and never in
            // the copy: restoring there would extract into what the branch checked out.
            for (const step of [restore, save]) {
                expect(step).toContain('path: ${{ runner.temp }}/turbo-cache\n');
                expect(step).toContain(`key: ${keys[job]}\${{ github.sha }}\n`);
            }
            expect(restore).toContain(`restore-keys: ${keys[job]}\n`);
            // A cache that is down costs a real run, not a red check or the job's time.
            for (const step of [restore, save]) {
                expect(step).toContain('continue-on-error: true');
                expect(step).toContain('timeout-minutes: 3');
            }
        },
    );

    it('restores before any container runs, and saves after the last one has finished', () => {
        for (const job of ['check', 'test']) {
            const order = plan(job).map((step) => (typeof step === 'string' ? step : step[0]));
            const firstContainer = order.findIndex((step) => step.startsWith('docker build'));
            expect(order.indexOf(RESTORE)).toBeLessThan(firstContainer);
            expect(order.indexOf('bash .github/ci/turbo-cache.sh import')).toBeLessThan(firstContainer);
            expect(order.slice(-2)).toEqual(['bash .github/ci/turbo-cache.sh export', SAVE]);
        }
    });

    it('never lets a branch bring its own cache directory', () => {
        for (const job of ['check', 'test']) {
            expect(plan(job)[2]).toEqual(COPY);
        }
        expect(read('.gitignore')).toMatch(/^\.turbo-ci\/$/m);
    });

    it('keeps every isolation property with the cache in place', () => {
        expect(code).not.toMatch(/\bactions\/cache@/);
        expect(jobs.check).toMatch(/^ {4}timeout-minutes: 30$/m);
        expect(jobs.test).toMatch(/^ {4}timeout-minutes: 30$/m);
        expect(`${turbo}\n${turboCache}`).not.toMatch(/secrets\.|GITHUB_TOKEN|ACTIONS_RUNTIME_TOKEN|--network|docker/);
    });

    it('keeps every image and release away from any task cache', () => {
        for (const path of ['.github/workflows/release-images.yml', 'Dockerfile']) {
            const text = uncommented(read(path));
            expect(text, path).not.toMatch(/turbo|actions\/cache/i);
        }
        // Not even by accident: the build context leaves them out.
        for (const entry of ['.turbo', '**/.turbo', '.turbo-ci']) {
            expect(read('.dockerignore').split('\n')).toContain(entry);
        }
    });

    it('runs real work on main, read-only elsewhere, and reads nothing else from the event', () => {
        const docker = fakeDocker();
        const mode = (event: Record<string, string>) => {
            docker.reset();
            const { calls, status } = docker.run('turbo.sh', ['check'], 0, event);
            expect(status).toBe(0);
            expect(calls).toHaveLength(1);
            return /node scripts\/turbo\.mjs check --cache=(\S+) --cache-dir=\.turbo-ci --log-order=stream$/.exec(
                calls[0],
            )?.[1];
        };
        expect(mode({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' })).toBe('local:w');
        expect(mode({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/7/merge' })).toBe('local:r');
        expect(mode({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/other' })).toBe('local:r');
        expect(mode({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/main' })).toBe('local:r');
        expect(mode({})).toBe('local:r');
    });

    it('passes the shard to every bucket, after its own flags, through the box', () => {
        const docker = fakeDocker();
        const { calls } = docker.run('turbo.sh', ['test', '--concurrency=1', '--', '--shard=2/4']);
        expect(calls[0]).toMatch(
            /--network none .*ci-box node scripts\/turbo\.mjs test --cache=local:r --cache-dir=\.turbo-ci --log-order=stream --concurrency=1 -- --shard=2\/4$/,
        );
    });

    describe('moving entries past a hostile cache directory', () => {
        const ENTRY = 'abcdef0123456789';
        const run = (mode: string, runner: string, extra: Record<string, string> = {}) =>
            spawnSync('bash', [ci('turbo-cache.sh'), mode], {
                env: { PATH: process.env.PATH, RUNNER_TEMP: runner, ...extra },
            });
        const planted = (runner: string) => {
            const boxed = join(runner, 'src/.turbo-ci');
            mkdirSync(boxed, { recursive: true });
            const secret = join(runner, 'secret');
            writeFileSync(secret, 'runner secret');
            for (const suffix of ['.tar.zst', '-meta.json', '-manifest.json']) {
                writeFileSync(join(boxed, `${ENTRY}${suffix}`), suffix);
            }
            symlinkSync(secret, join(boxed, '0000000000000001.tar.zst'));
            symlinkSync('/etc', join(boxed, 'etc'));
            mkdirSync(join(boxed, '0000000000000002.tar.zst'));
            mkdirSync(join(boxed, 'nested'));
            writeFileSync(join(boxed, `nested/${ENTRY}.tar.zst`), 'nested');
            writeFileSync(join(boxed, 'run.sh'), 'evil');
            writeFileSync(join(boxed, `${ENTRY}.tar.zst.sh`), 'evil');
            writeFileSync(join(boxed, '.abcdef0123456789.tar.zst'), 'evil');
            execFileSync('mkfifo', [join(boxed, '0000000000000003.tar.zst')]);
            return boxed;
        };

        it('exports only regular files with cache-entry names, and follows no link', () => {
            const runner = temp();
            planted(runner);
            const { status } = run('export', runner);
            expect(status).toBe(0);
            const store = join(runner, 'turbo-cache');
            expect(readdirSync(store).sort()).toEqual(
                [`${ENTRY}-manifest.json`, `${ENTRY}-meta.json`, `${ENTRY}.tar.zst`].sort(),
            );
            for (const name of readdirSync(store)) {
                expect(lstatSync(join(store, name)).isFile()).toBe(true);
            }
        });

        it('exports nothing from a cache directory that is a link, and leaves its target alone', () => {
            const runner = temp();
            const elsewhere = join(runner, 'elsewhere');
            mkdirSync(elsewhere);
            writeFileSync(join(elsewhere, `${ENTRY}.tar.zst`), 'outside');
            mkdirSync(join(runner, 'src'));
            symlinkSync(elsewhere, join(runner, 'src/.turbo-ci'));
            expect(run('export', runner).status).toBe(0);
            expect(readdirSync(join(runner, 'turbo-cache'))).toEqual([]);
            expect(readFileSync(join(elsewhere, `${ENTRY}.tar.zst`), 'utf8')).toBe('outside');
        });

        it('imports past a link the branch left in the copy, without writing through it', () => {
            const runner = temp();
            const elsewhere = join(runner, 'elsewhere');
            mkdirSync(elsewhere);
            mkdirSync(join(runner, 'src'));
            symlinkSync(elsewhere, join(runner, 'src/.turbo-ci'));
            const store = join(runner, 'turbo-cache');
            mkdirSync(store);
            writeFileSync(join(store, `${ENTRY}.tar.zst`), 'entry');
            expect(run('import', runner).status).toBe(0);
            expect(readdirSync(elsewhere)).toEqual([]);
            expect(lstatSync(join(runner, 'src/.turbo-ci')).isDirectory()).toBe(true);
            expect(readFileSync(join(runner, `src/.turbo-ci/${ENTRY}.tar.zst`), 'utf8')).toBe('entry');
        });

        it('imports nothing when nothing was restored', () => {
            const runner = temp();
            mkdirSync(join(runner, 'src'));
            expect(run('import', runner).status).toBe(0);
            expect(readdirSync(join(runner, 'src/.turbo-ci'))).toEqual([]);
        });

        it('drops everything past the size limit rather than save part of a run', () => {
            const runner = temp();
            planted(runner);
            const result = run('export', runner, { TURBO_CACHE_LIMIT_BYTES: '4' });
            expect(result.status).toBe(0);
            expect(result.stdout.toString()).toContain('dropped everything');
            expect(readdirSync(join(runner, 'turbo-cache'))).toEqual([]);
        });

        it('takes no other command', () => {
            const runner = temp();
            expect(run('save', runner).status).toBe(2);
            expect(existsSync(join(runner, 'turbo-cache'))).toBe(false);
        });
    });
});

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});
const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
};

/** The lines a step prints, and whether each could issue workflow commands. */
function commandsHonoured(output: string) {
    let stopped: string | undefined;
    const live: string[] = [];
    for (const line of output.split('\n')) {
        if (stopped) {
            if (line === `::${stopped}::`) {
                stopped = undefined;
            }
            continue;
        }
        const stop = /^::stop-commands::(.+)$/.exec(line);
        if (stop) {
            stopped = stop[1];
        } else if (line.startsWith('::')) {
            live.push(line);
        }
    }
    return live;
}

/** A docker that logs its arguments, prints workflow commands, and exits `FAKE_STATUS` for `run --rm`. */
function fakeDocker() {
    const dir = temp();
    const log = join(dir, 'calls');
    const docker = join(dir, 'docker');
    writeFileSync(
        docker,
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "run --rm") echo '::add-mask::leak'; echo '::error::from the branch' >&2; exit "\${FAKE_STATUS:-0}" ;;
  "logs "*) echo '::warning::from the proxy log' ;;
esac
`,
    );
    chmodSync(docker, 0o755);
    const run = (script: string, args: string[] = [], status = 0, extraEnv: Record<string, string> = {}) => {
        const result = spawnSync('bash', [ci(script), ...args], {
            env: {
                PATH: process.env.PATH,
                DOCKER: docker,
                RUNNER_TEMP: '/runner/temp',
                FAKE_STATUS: String(status),
                ...extraEnv,
            },
        });
        return {
            status: result.status,
            out: result.stdout.toString(),
            calls: readFileSync(log, 'utf8').trim().split('\n'),
        };
    };
    return { run, reset: () => writeFileSync(log, '') };
}

it('keeps the box’s output from issuing workflow commands, with a fresh token each time', () => {
    const docker = fakeDocker();
    const uid = execFileSync('id', ['-u']).toString().trim();
    const first = docker.run('box.sh', ['pnpm', 'test'], 3);
    expect(first.status).toBe(3);
    expect(first.out).toContain('::add-mask::leak');
    expect(first.out).toContain('::error::from the branch');
    expect(commandsHonoured(first.out)).toEqual([]);
    expect(first.out).toMatch(/^::stop-commands::[0-9a-f]{32}\n/);
    expect(first.calls).toEqual([
        `run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --user ${uid}:65534 -e HOME=/tmp -e CI=true -v /runner/temp/src:/w -w /w ci-box pnpm test`,
    ]);
    docker.reset();
    const second = docker.run('box.sh', ['pnpm', 'run', 'lint']);
    expect(second.status).toBe(0);
    const token = (out: string) => /^::stop-commands::(\w+)/.exec(out)![1];
    expect(token(second.out)).not.toBe(token(first.out));
});

it('gives only the test step the Chromium seccomp profile, from a trusted copy of production’s', () => {
    const copy = '.github/ci/chromium-seccomp.json';
    expect(readFileSync(join(root, copy), 'utf8')).toBe(
        readFileSync(join(root, 'deployment/app-browser/seccomp.json'), 'utf8'),
    );
    expect(code.match(/BOX_SECCOMP_PROFILE:/g)).toHaveLength(1);
    expect(jobs.test).toContain(`BOX_SECCOMP_PROFILE: ${copy}`);
    const docker = fakeDocker();
    const { calls } = docker.run('box.sh', ['pnpm', 'test'], 0, { BOX_SECCOMP_PROFILE: copy });
    expect(calls[0]).toContain(`--cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=${copy} --user`);
});

it('installs behind the proxy, wraps pnpm’s and the proxy’s output, and always removes the proxy', () => {
    const docker = fakeDocker();
    const uid = execFileSync('id', ['-u']).toString().trim();
    const failed = docker.run('install.sh', [], 1);
    expect(failed.status).toBe(1);
    expect(commandsHonoured(failed.out)).toEqual([]);
    expect(failed.out).toContain('::warning::from the proxy log');
    expect(failed.calls).toEqual([
        'network create --internal ci-sandbox',
        'run -d --init --name ci-egress --network bridge --cap-drop ALL --security-opt no-new-privileges --user 65534:65534 -e EGRESS_ALLOW=registry.npmjs.org:443 ci-box node /ci/egress-proxy.mjs',
        'network connect ci-sandbox ci-egress',
        `run --rm --init --network ci-sandbox --cap-drop ALL --security-opt no-new-privileges --user ${uid}:65534 -e HOME=/tmp -e HTTPS_PROXY=http://ci-egress:3128 -e npm_config_https_proxy=http://ci-egress:3128 -e npm_config_update_notifier=false -v /runner/temp/src:/w -w /w ci-box pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --store-dir /tmp/pnpm-store`,
        'logs ci-egress',
        'rm -f ci-egress',
    ]);
});

/** A server that answers every connection with `name`. */
async function listener(name: string) {
    const server = createServer((socket) => socket.end(`${name}\n`));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => server.close());
    return (server.address() as AddressInfo).port;
}

it('tunnels only to the exact host:port allowed, and refuses everything else', async () => {
    const allowed = await listener('allowed');
    const other = await listener('other');
    const proxy = spawn(process.execPath, [ci('egress-proxy.mjs')], {
        env: {
            PATH: process.env.PATH,
            EGRESS_ALLOW: `127.0.0.1:${allowed}`,
            EGRESS_PORT: '0',
            EGRESS_HOST: '127.0.0.1',
        },
    });
    cleanup.push(() => proxy.kill());
    let log = '';
    const port = await new Promise<number>((resolve) =>
        proxy.stdout.on('data', (chunk: Buffer) => {
            log += chunk.toString();
            const match = /egress proxy on :(\d+)/.exec(log);
            if (match) {
                resolve(Number(match[1]));
            }
        }),
    );
    const tunnel = (target: string) =>
        new Promise<string>((resolve) => {
            const socket = connect(port, '127.0.0.1', () =>
                socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
            );
            let out = '';
            socket.on('data', (chunk) => (out += chunk));
            socket.on('close', () => resolve(out));
            socket.on('error', () => resolve(out || 'error'));
        });
    expect(await tunnel(`127.0.0.1:${allowed}`)).toBe('HTTP/1.1 200 Connection Established\r\n\r\nallowed\n');
    for (const target of [
        `127.0.0.1:${other}`,
        `localhost:${allowed}`,
        `127.0.0.1:${allowed}0`,
        `127.0.0.1`,
        `127.0.0.1:${allowed}/x`,
        `user@127.0.0.1:${allowed}`,
    ]) {
        expect(await tunnel(target), target).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    }
    // Plain HTTP, even to the allowed host, is refused.
    const plain = await new Promise<number | undefined>((resolve) =>
        request({ host: '127.0.0.1', port, path: `http://127.0.0.1:${allowed}/` }, (response) => {
            response.resume();
            resolve(response.statusCode);
        })
            .on('error', () => resolve(undefined))
            .end(),
    );
    expect(plain).toBe(405);
    expect(log).toContain(`egress allowed "127.0.0.1:${allowed}"`);
    expect(log).toContain(`egress denied "127.0.0.1:${other}"`);
});
