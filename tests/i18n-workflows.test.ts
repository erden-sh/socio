// The translation workflows (docs/I18N.md, "Translations from contributors"): the i18n guard,
// a required check that runs for forks too, and the import and export, which hold the
// translation app's tokens and the GitHub App's key. These checks keep their triggers,
// permissions and secrets where SECURITY.md's rules put them, and run the guard's path check
// on real merge commits.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');

interface Step {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    env?: Record<string, string>;
}
interface Job {
    name?: string;
    if?: string;
    'runs-on': string;
    environment?: string;
    permissions?: Record<string, string>;
    steps: Step[];
}
interface Workflow {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
}
/** A workflow's text without comment lines or trailing comments. */
const read = (name: string) =>
    readFileSync(join(root, '.github/workflows', name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/\s#.*$/, ''))
        .join('\n');
const load = (name: string) => parse(read(name)) as Workflow;
const guard = load('i18n-guard.yml');
const syncing = { 'i18n-import.yml': load('i18n-import.yml'), 'i18n-export.yml': load('i18n-export.yml') };
const all = { 'i18n-guard.yml': guard, ...syncing };
const steps = (workflow: Workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps);

describe('every translation workflow', () => {
    it.each(Object.entries(all))('%s pins its actions, reads by default and runs on Blacksmith', (_name, workflow) => {
        expect(workflow.permissions).toEqual({ contents: 'read' });
        for (const step of steps(workflow).filter((item) => item.uses)) {
            expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        }
        for (const job of Object.values(workflow.jobs)) {
            expect(job['runs-on']).toBe('blacksmith-4vcpu-ubuntu-2604');
        }
    });

    it.each(Object.entries(all))('%s puts no expression into a shell, but through env', (_name, workflow) => {
        for (const step of steps(workflow).filter((item) => item.run)) {
            expect(step.run, step.name).not.toMatch(/\$\{\{/);
            expect(step.run, step.name).not.toMatch(/set -x|set -o xtrace/);
        }
    });

    it.each(Object.entries(all))(
        '%s checks out without keeping the token, except where the App pushes',
        (name, workflow) => {
            for (const step of steps(workflow).filter((item) => /checkout@/.test(item.uses ?? ''))) {
                if (name === 'i18n-export.yml' && step.with?.token) {
                    expect(step.with.token).toBe('${{ steps.app.outputs.token }}');
                } else {
                    expect(step.with?.['persist-credentials']).toBe(false);
                }
            }
        },
    );
});

describe('i18n-guard.yml', () => {
    const [jobId, job] = Object.entries(guard.jobs)[0]!;

    it('runs on every pull request, never pull_request_target, with nothing secret', () => {
        expect(Object.keys(guard.on)).toEqual(['pull_request']);
        expect(read('i18n-guard.yml')).not.toMatch(/pull_request_target|secrets\.|vars\.|environment:/);
        expect(Object.keys(guard.jobs)).toEqual(['i18n-guard']);
        expect(job.permissions).toBeUndefined();
        expect(job.if).toBeUndefined();
    });

    it('triggers on every pull request: no paths or branches filter, which would leave the required check missing', () => {
        expect(guard.on).toEqual({
            pull_request: { types: ['opened', 'synchronize', 'reopened', 'ready_for_review', 'edited'] },
        });
        expect(read('i18n-guard.yml')).not.toMatch(/paths(-ignore)?:|branches(-ignore)?:/);
    });

    it('keeps the stable name the ruleset requires', () => {
        expect(jobId).toBe('i18n-guard');
        expect(job.name).toBe('i18n guard');
    });

    it('installs and fetches nothing: the checkout, then the runner’s own Node', () => {
        const text = JSON.stringify(job.steps);
        expect(text).not.toMatch(/setup-node|action-setup|pnpm|npm |npx|curl|wget|gh /);
        expect(job.steps.filter((step) => step.uses).map((step) => step.uses!.split('@')[0])).toEqual([
            'useblacksmith/checkout',
        ]);
    });

    it('passes other branches at once, and checks paths before it runs any script', () => {
        const [pass, checkout, paths, content] = job.steps;
        expect(job.steps).toHaveLength(4);
        expect(pass!.if).toBe("${{ !startsWith(github.head_ref, 'i18n/') }}");
        for (const step of [checkout, paths, content]) {
            expect(step!.if).toBe("${{ startsWith(github.head_ref, 'i18n/') }}");
        }
        expect(checkout!.with).toEqual({ 'persist-credentials': false, 'fetch-depth': 2 });
        expect(paths!.run).not.toMatch(/node |scripts\//);
        expect(content!.run).toContain('node scripts/i18n-content-guard.mjs');
    });

    describe('the path check, on merge commits', () => {
        const scratch: string[] = [];
        afterEach(() => {
            for (const dir of scratch.splice(0)) {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        const git = (cwd: string, ...args: string[]) =>
            execFileSync(
                'git',
                ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args],
                { cwd, encoding: 'utf8' },
            );

        /** A repository whose HEAD merges a branch that writes `files` into main. */
        function mergeOf(files: Record<string, string>, links: Record<string, string> = {}) {
            const dir = mkdtempSync(join(tmpdir(), 'socio-i18n-guard-git-'));
            scratch.push(dir);
            git(dir, 'init', '--quiet', '--initial-branch=main');
            mkdirSync(join(dir, 'packages/i18n/locales/en-US'), { recursive: true });
            writeFileSync(join(dir, 'packages/i18n/locales/en-US/common.json'), '{}\n');
            writeFileSync(join(dir, 'README.md'), 'main\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '--quiet', '-m', 'main');
            git(dir, 'checkout', '--quiet', '-b', 'i18n/es-419-2026-11-26');
            for (const [path, text] of Object.entries(files)) {
                mkdirSync(join(dir, dirname(path)), { recursive: true });
                writeFileSync(join(dir, path), text);
            }
            for (const [path, target] of Object.entries(links)) {
                mkdirSync(join(dir, dirname(path)), { recursive: true });
                symlinkSync(target, join(dir, path));
            }
            git(dir, 'add', '-A');
            git(dir, 'commit', '--quiet', '-m', 'branch');
            git(dir, 'checkout', '--quiet', 'main');
            writeFileSync(join(dir, 'README.md'), 'main, later\n');
            git(dir, 'commit', '--quiet', '-am', 'main moves on');
            git(dir, 'merge', '--quiet', '--no-ff', '-m', 'merge', 'i18n/es-419-2026-11-26');
            return dir;
        }
        const check = (dir: string, base = 'main') => {
            const runnerTemp = mkdtempSync(join(tmpdir(), 'socio-i18n-guard-tmp-'));
            scratch.push(runnerTemp);
            return spawnSync('bash', ['-c', job.steps[2]!.run!], {
                cwd: dir,
                encoding: 'utf8',
                env: { ...process.env, RUNNER_TEMP: runnerTemp, BASE_REF: base, DEFAULT_BRANCH: 'main' },
            });
        };

        it('passes translations only, even when main has moved on', () => {
            const result = check(
                mergeOf({
                    'packages/i18n/locales/es-419/common.json': '{"a":"b"}\n',
                    'packages/i18n/locales/es-US/settings.language.json': '{}\n',
                }),
            );
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain('2 translation files changed');
        });

        it.each([
            ['a script', { 'scripts/i18n-content-guard.mjs': 'process.exit(0)\n' }],
            ['the source', { 'packages/i18n/locales/en-US/common.json': '{"a":"https://example.org"}\n' }],
            ['a file that is not JSON', { 'packages/i18n/locales/es-419/notes.md': 'x\n' }],
            ['a nested folder', { 'packages/i18n/locales/es-419/deep/common.json': '{}\n' }],
            ['the registry', { 'packages/i18n/src/registry.ts': 'export {};\n' }],
            ['a workflow', { '.github/workflows/i18n-guard.yml': 'name: x\n' }],
            ['a name with a newline', { 'packages/i18n/locales/es-419/a\nb.json': '{}\n' }],
        ])('fails a branch that changes %s', (_what, files) => {
            const result = check(mergeOf({ 'packages/i18n/locales/es-419/common.json': '{}\n', ...files }));
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('::error::');
        });

        it('fails a symlink among the translations', () => {
            const result = check(mergeOf({}, { 'packages/i18n/locales/es-419/common.json': '../../../../README.md' }));
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('Not a regular file');
        });

        it('fails an i18n/ branch aimed at any base but the default branch', () => {
            // Another branch's content guard could be anyone's: only main's runs.
            const result = check(mergeOf({ 'packages/i18n/locales/es-419/common.json': '{}\n' }), 'feat/other');
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('must target main');
        });

        it('fails anything but a merge commit', () => {
            const dir = mergeOf({ 'packages/i18n/locales/es-419/common.json': '{}\n' });
            git(dir, 'checkout', '--quiet', 'HEAD^2');
            expect(check(dir).status).toBe(1);
        });
    });
});

describe.each(Object.entries(syncing))('%s', (name, workflow) => {
    const text = read(name);

    it('runs only on a schedule or by hand, from main, in the i18n-sync environment', () => {
        expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
        expect(text).not.toMatch(/pull_request|\n {2}push:|workflow_run|repository_dispatch/);
        for (const [id, job] of Object.entries(workflow.jobs)) {
            expect(job.environment, id).toBe('i18n-sync');
            expect(job.if, id).toMatch(/github\.ref == 'refs\/heads\/main'|needs\.prepare\.outputs\.locales/);
        }
    });

    it('does nothing without TRANSLATE_BASE_URL', () => {
        const [first] = Object.values(workflow.jobs)[0]!.steps;
        expect(first!.id).toBe('config');
        expect(first!.run).toContain('::notice::TRANSLATE_BASE_URL is not set');
        for (const step of Object.values(workflow.jobs)[0]!.steps.slice(1)) {
            expect(step.if, step.name ?? step.uses).toMatch(/steps\.(config|write)\.outputs\./);
        }
    });

    it('reads secrets only into a step’s env or an action’s inputs, never a shell', () => {
        for (const step of steps(workflow)) {
            expect(step.run ?? '', step.name).not.toMatch(/secrets\./);
            for (const [key, value] of Object.entries(step.env ?? {})) {
                if (/secrets\./.test(value)) {
                    expect(key).toMatch(/^CLIENT_(ID|SECRET)$/);
                }
            }
        }
        // A transport failure is status 000 and retried: curl's own 000 isn't doubled.
        for (const line of steps(workflow)
            .flatMap((item) => (item.run ?? '').split('\n'))
            .filter((item) => item.includes('curl '))) {
            expect(line).toMatch(/^\s*status="\$\(curl [^\n]*-w '%\{http_code\}'[^\n]*\)" \|\| status=000$/);
        }
        // Service tokens reach curl through a header file, never its command line.
        for (const step of steps(workflow).filter((item) => item.run?.includes('curl '))) {
            expect(step.run).toContain('umask 077');
            expect(step.run).toMatch(/-H "@\$headers"/);
            expect(step.run).toContain('trap \'rm -f "$headers"\' EXIT');
        }
    });
});

describe('i18n-import.yml', () => {
    const job = syncing['i18n-import.yml'].jobs.import!;

    it('asks only to read the pull requests, besides the contents', () => {
        expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
    });

    it('sends only a changed import, and remembers only one that was sent', () => {
        const byName = (name: string) => job.steps.find((step) => step.name === name)!;
        expect(byName("Restore the last import's hash").with).toMatchObject({ 'restore-keys': 'i18n-import-last-' });
        for (const name of ['Send the import', "Write the import's hash", 'Remember the import']) {
            expect(byName(name).if).toContain("steps.sent.outputs.unchanged == 'false'");
        }
        const order = job.steps.map((step) => step.name);
        expect(order.indexOf('Remember the import')).toBeGreaterThan(order.indexOf('Send the import'));
    });
});

describe('i18n-export.yml', () => {
    const { prepare, publish } = syncing['i18n-export.yml'].jobs;

    it('installs before any secret is in reach, without install scripts', () => {
        const install = prepare!.steps.findIndex((step) => step.run?.includes('pnpm install'));
        expect(prepare!.steps[install]!.run).toBe('pnpm install --frozen-lockfile --ignore-scripts');
        const firstSecret = prepare!.steps.findIndex((step) => JSON.stringify(step).includes('secrets.'));
        expect(install).toBeGreaterThan(-1);
        expect(firstSecret).toBeGreaterThan(install);
        expect(prepare!.steps.find((step) => step.id === 'write')!.run).toMatch(/^\s*pnpm i18n:check$/m);
    });

    it('mints the App token for contents and pull requests only, and runs no repository code with it', () => {
        expect(prepare!.permissions).toEqual({ contents: 'read' });
        expect(publish!.permissions).toEqual({ contents: 'read' });
        expect(JSON.stringify(prepare)).not.toMatch(/TRANSLATE_APP_/);
        const app = publish!.steps.find((step) => step.uses?.startsWith('actions/create-github-app-token@'))!;
        expect(app.with).toEqual({
            'app-id': '${{ secrets.TRANSLATE_APP_ID }}',
            'private-key': '${{ secrets.TRANSLATE_APP_PRIVATE_KEY }}',
            'permission-contents': 'write',
            'permission-pull-requests': 'write',
        });
        for (const step of publish!.steps.filter((item) => item.run)) {
            expect(step.run).not.toMatch(/\bnode |\bpnpm |\bnpx |scripts\//);
        }
    });

    describe('run for real, on a local repository', () => {
        const scratch: string[] = [];
        afterEach(() => {
            for (const dir of scratch.splice(0)) {
                rmSync(dir, { recursive: true, force: true });
            }
        });
        const temp = (name: string) => {
            const dir = mkdtempSync(join(tmpdir(), `socio-i18n-export-${name}-`));
            scratch.push(dir);
            return dir;
        };
        const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
        const identity = {
            GIT_AUTHOR_NAME: 'Ada',
            GIT_AUTHOR_EMAIL: 'ada@example.com',
            GIT_COMMITTER_NAME: 'Ada',
            GIT_COMMITTER_EMAIL: 'ada@example.com',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'commit.gpgsign',
            GIT_CONFIG_VALUE_0: 'false',
        };
        const git = (cwd: string, ...args: string[]) =>
            execFileSync(realGit, args, { cwd, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
        const write = (path: string, json: unknown) => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, typeof json === 'string' ? json : `${JSON.stringify(json, null, 4)}\n`);
        };
        const BRANCH = 'i18n/es-419-2026-11-27';
        let next = 0;
        const candidate = (key: string, value: string) => ({
            id: `k_${String(next++).padStart(26, '0')}`,
            ns: 'common',
            key,
            values: { [key]: value },
            author: 'Ana',
            origin: 'contributor',
            selfApproved: false,
            inherit: false,
        });

        /** A bare origin whose main has en-US car: Car and es-419 car: Auto, and the scripts prepare runs. */
        function origin() {
            const bare = temp('origin');
            git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
            const seed = temp('seed');
            git(seed, 'clone', '--quiet', bare, '.');
            write(join(seed, 'packages/i18n/locales/en-US/common.json'), { car: 'Car', truck: 'Truck' });
            write(join(seed, 'packages/i18n/locales/es-419/common.json'), { car: 'Auto', truck: 'Camión' });
            write(join(seed, 'scripts/i18n-sync.mjs'), readFileSync(join(root, 'scripts/i18n-sync.mjs'), 'utf8'));
            write(
                join(seed, 'packages/i18n/src/registry.ts'),
                readFileSync(join(root, 'packages/i18n/src/registry.ts'), 'utf8'),
            );
            git(seed, 'add', '-A');
            git(seed, 'commit', '--quiet', '-m', 'main');
            git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
            return bare;
        }
        /** A commit on `branch` in origin, made from a clone of it, changing es-419's file. */
        function pushTo(bare: string, branch: string, json: unknown, from = 'main') {
            const clone = temp('push');
            git(clone, 'clone', '--quiet', bare, '.');
            git(clone, 'checkout', '--quiet', '-B', branch, `origin/${from}`);
            write(join(clone, 'packages/i18n/locales/es-419/common.json'), json);
            git(clone, 'commit', '--quiet', '-am', `push to ${branch}`);
            git(clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
            return git(clone, 'rev-parse', 'HEAD');
        }
        /** A bin folder with stand-ins: pnpm, gh and curl log their calls; git can run a race before it pushes. */
        function bin() {
            const dir = temp('bin');
            const log = join(dir, 'calls.log');
            const script = (name: string, body: string) => {
                writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
            };
            script('pnpm', 'exit 0');
            script(
                'gh',
                [
                    'case "$1 $2" in',
                    '  "api "*) echo 42 ;;',
                    '  "pr list") echo "" ;;',
                    '  "pr create") echo https://github.com/erden-sh/socio/pull/77 ;;',
                    '  "pr view") echo "earlier body" ;;',
                    'esac',
                ].join('\n'),
            );
            script(
                'curl',
                [
                    'out=""',
                    'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out="$2"; fi; shift; done',
                    'echo "{}" > "$out"',
                    'printf 200',
                ].join('\n'),
            );
            writeFileSync(
                join(dir, 'git'),
                `#!/bin/sh\nif [ "$1" = push ] && [ -n "$RACE" ]; then sh "$RACE"; fi\nexec "${realGit}" "$@"\n`,
                { mode: 0o755 },
            );
            return {
                dir,
                calls: () =>
                    (readFileSync(log, { flag: 'a+', encoding: 'utf8' }) as string).split('\n').filter(Boolean),
            };
        }
        const step = (job: Job, name: string) => job.steps.find((item) => item.id === name || item.name === name)!.run!;
        const run = (script: string, cwd: string, env: Record<string, string>) =>
            spawnSync('bash', ['-c', script], {
                cwd,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ...identity,
                    PATH: `${env.BIN}:${dirname(process.execPath)}:${process.env.PATH}`,
                    ...env,
                },
            });

        function prepareRun(bare: string, exported: unknown) {
            const work = temp('prepare');
            git(work, 'clone', '--quiet', bare, '.');
            const runnerTemp = temp('runner');
            writeFileSync(join(runnerTemp, 'i18n-export.json'), JSON.stringify(exported));
            const output = join(runnerTemp, 'output');
            const tools = bin();
            const result = run(step(prepare!, 'write'), work, {
                BIN: tools.dir,
                RUNNER_TEMP: runnerTemp,
                GITHUB_OUTPUT: output,
            });
            return {
                result,
                work,
                out: join(runnerTemp, 'i18n-export-out'),
                output: readFileSync(output, { flag: 'a+', encoding: 'utf8' }),
                tools,
            };
        }
        function publishRun(bare: string, out: string, race?: string) {
            const work = temp('publish');
            git(work, 'clone', '--quiet', bare, '.');
            const runnerTemp = temp('runner');
            execFileSync('cp', ['-R', out, join(runnerTemp, 'i18n-export-out')]);
            const tools = bin();
            const env: Record<string, string> = {
                BIN: tools.dir,
                RUNNER_TEMP: runnerTemp,
                GH_TOKEN: 'test',
                APP_SLUG: 'translate-test',
                LOCALES: 'es-419',
                DATE: '2026-11-27',
                BASE_URL: 'https://translate.example.com',
                CLIENT_ID: 'id',
                CLIENT_SECRET: 'secret',
            };
            if (race) {
                const file = join(runnerTemp, 'race.sh');
                writeFileSync(file, race);
                env.RACE = file;
            }
            return { result: run(step(publish!, 'Open or update the pull requests'), work, env), tools };
        }
        const exportOf = (locales: Record<string, ReturnType<typeof candidate>[]>) => ({
            commit: 'abcdef1',
            generatedAt: 0,
            locales: Object.fromEntries(
                Object.entries(locales).map(([locale, candidates]) => [
                    locale,
                    { parent: null, candidates, contributors: [] },
                ]),
            ),
        });

        it("prepares each locale against main's own fallback, never another locale's pending change", () => {
            const bare = origin();
            const { result, work, out, output, tools } = prepareRun(
                bare,
                exportOf({ 'es-419': [candidate('car', 'Coche')], 'es-US': [candidate('car', 'Coche')] }),
            );
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(output).toContain('locales=es-419 es-US\n');
            // es-419's pull request changes car; es-US's keeps its own car, since main's es-419 says Auto:
            // merging only es-US shows Coche there, and rejecting es-419 loses nothing.
            expect(JSON.parse(readFileSync(join(out, 'es-419/files/common.json'), 'utf8'))).toEqual({
                car: 'Coche',
                truck: 'Camión',
            });
            expect(JSON.parse(readFileSync(join(out, 'es-US/files/common.json'), 'utf8'))).toEqual({ car: 'Coche' });
            expect(JSON.parse(readFileSync(join(out, 'es-US/ids.json'), 'utf8'))).toHaveLength(1);
            // Each locale's dictionaries are checked as its own pull request leaves them, and the checkout is clean after.
            expect(tools.calls().filter((call) => call === 'pnpm i18n:check')).toHaveLength(2);
            expect(git(work, 'status', '--porcelain')).toBe('');
        });

        it('drops an es-US string equal to main’s es-419, so it inherits', () => {
            const bare = origin();
            const { result, out } = prepareRun(
                bare,
                exportOf({ 'es-US': [candidate('car', 'Auto'), candidate('truck', 'Troca')] }),
            );
            expect(result.status, result.stderr).toBe(0);
            expect(JSON.parse(readFileSync(join(out, 'es-US/files/common.json'), 'utf8'))).toEqual({ truck: 'Troca' });
        });

        it('publishes a new branch, opens its pull request and acknowledges it', () => {
            const bare = origin();
            const { out } = prepareRun(bare, exportOf({ 'es-419': [candidate('car', 'Coche')] }));
            const { result, tools } = publishRun(bare, out);
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(JSON.parse(git(bare, 'show', `${BRANCH}:packages/i18n/locales/es-419/common.json`))).toEqual({
                car: 'Coche',
                truck: 'Camión',
            });
            expect(
                tools.calls().some((call) => call.startsWith('gh pr create --base main --head i18n/es-419-2026-11-27')),
            ).toBe(true);
            expect(tools.calls().filter((call) => call.includes('/export/ack'))).toHaveLength(1);
        });

        it("refuses a branch a reviewer pushed to after prepare, and keeps the reviewer's commit", () => {
            const bare = origin();
            pushTo(bare, BRANCH, { car: 'Coche', truck: 'Camión' });
            const { out } = prepareRun(bare, exportOf({ 'es-419': [candidate('truck', 'Camioneta')] }));
            const reviewer = pushTo(bare, BRANCH, { car: 'Carro', truck: 'Camión' }, BRANCH);
            const { result, tools } = publishRun(bare, out);
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('moved since this export was prepared');
            expect(git(bare, 'rev-parse', BRANCH)).toBe(reviewer);
            expect(tools.calls().filter((call) => call.includes('/export/ack'))).toEqual([]);
        });

        it("fails its push when a reviewer pushes while it publishes, and keeps the reviewer's commit", () => {
            const bare = origin();
            const base = pushTo(bare, BRANCH, { car: 'Coche', truck: 'Camión' });
            const { out } = prepareRun(bare, exportOf({ 'es-419': [candidate('truck', 'Camioneta')] }));
            expect(readFileSync(join(out, 'es-419/base'), 'utf8').trim()).toBe(base);
            // The reviewer's commit is ready; the stand-in git pushes it just before publish's own push.
            const clone = temp('reviewer');
            git(clone, 'clone', '--quiet', bare, '.');
            git(clone, 'checkout', '--quiet', '-B', BRANCH, `origin/${BRANCH}`);
            write(join(clone, 'packages/i18n/locales/es-419/common.json'), { car: 'Carro', truck: 'Camión' });
            git(clone, 'commit', '--quiet', '-am', 'reviewer');
            const reviewer = git(clone, 'rev-parse', 'HEAD');
            const { result, tools } = publishRun(
                bare,
                out,
                `"${realGit}" -C "${clone}" push --quiet origin "HEAD:refs/heads/${BRANCH}"\n`,
            );
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('moved while this export was publishing');
            expect(git(bare, 'rev-parse', BRANCH)).toBe(reviewer);
            expect(tools.calls().filter((call) => call.includes('/export/ack'))).toEqual([]);
            expect(tools.calls().some((call) => call.startsWith('gh pr create') || call.startsWith('gh pr edit'))).toBe(
                false,
            );
        });

        it('refuses a branch created since prepare, which found none', () => {
            const bare = origin();
            const { out } = prepareRun(bare, exportOf({ 'es-419': [candidate('car', 'Coche')] }));
            const reviewer = pushTo(bare, BRANCH, { car: 'Carro', truck: 'Camión' });
            const { result } = publishRun(bare, out);
            expect(result.status).toBe(1);
            expect(result.stdout).toContain('was created since this export was prepared');
            expect(git(bare, 'rev-parse', BRANCH)).toBe(reviewer);
        });
    });

    it('pushes only to i18n/ branches, without force, and opens pull requests against main', () => {
        const run = publish!.steps.find((step) => step.name === 'Open or update the pull requests')!.run!;
        expect([...run.matchAll(/git push [^\n;]*/g)].map((match) => match[0])).toEqual([
            'git push --quiet origin "HEAD:refs/heads/$branch"',
        ]);
        expect(run).toContain('branch="i18n/$locale-$DATE"');
        expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+)/);
        expect(run).toContain('gh pr create --base main --head "$branch"');
    });
});
