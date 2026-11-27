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
        expect(prepare!.steps.some((step) => step.run === 'pnpm i18n:check')).toBe(true);
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

    it('pushes only to i18n/ branches, without force, and opens pull requests against main', () => {
        const run = publish!.steps.find((step) => step.name === 'Open or update the pull requests')!.run!;
        expect([...run.matchAll(/git push [^\n]*/g)].map((match) => match[0])).toEqual([
            'git push --quiet origin "HEAD:refs/heads/$branch"',
        ]);
        expect(run).toContain('branch="i18n/$locale-$DATE"');
        expect(run).not.toMatch(/git push[^\n]*(--force|\s-f\b|\+)/);
        expect(run).toContain('gh pr create --base main --head "$branch"');
    });
});
