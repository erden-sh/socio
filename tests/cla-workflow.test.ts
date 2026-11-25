// The CLA check is the one workflow on pull_request_target, which
// runs with a write token on forks' pull requests. These checks keep it from
// ever running the pull request's code or growing its token (SECURITY.md,
// "The CLA check").
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
/** Text without comment lines or trailing comments. */
const uncommented = (text: string) =>
    text
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/\s#.*$/, ''))
        .join('\n');
const cla = uncommented(read('.github/workflows/cla.yml'));
const jobText = cla.slice(cla.indexOf('\njobs:\n'));

describe('cla.yml', () => {
    it('asks for no permission by default, and its one job only for what the action does', () => {
        expect(cla).toMatch(/^permissions: \{\}$/m);
        const block = /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(cla);
        expect(
            block?.[1]
                .trim()
                .split('\n')
                .map((line) => line.trim()),
        ).toEqual(['actions: write', 'contents: write', 'pull-requests: write']);
        expect(cla.match(/permissions:/g)).toHaveLength(2);
    });

    it("never checks out, caches or runs the pull request's code", () => {
        expect(cla).not.toMatch(/actions\/checkout|actions\/cache|uses:\s*\.|github\.event\.pull_request\.head/);
        expect(cla).not.toMatch(/\$\{\{\s*github\.event\.(comment|pull_request|issue)\.(body|title)/);
        expect(cla).not.toMatch(/secrets\./);
        const uses = [...cla.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
        expect(uses).toEqual(['contributor-assistant/github-action@ca4a40a7d1004f18d9960b404b97e5f30a505a08']);
    });

    it('runs on pull requests and pull request comments only, on Blacksmith runners', () => {
        expect(cla).toMatch(/^on:\n {2}issue_comment:\n {4}types: \[created\]\n {2}pull_request_target:\n/m);
        expect(cla).not.toMatch(/workflow_dispatch|workflow_run|schedule|repository_dispatch|\n {2}push:/);
        expect(cla).toContain('github.event.issue.pull_request &&');
        expect(cla).toMatch(/runs-on: blacksmith-4vcpu-ubuntu-2604\n/);
    });

    it('serializes signing runs per pull request on the filtered job, never cancelling a running one', () => {
        // On the job, after its `if`: an unrelated comment never joins the group,
        // so it can't replace a pending signing run. A replaced pending run of the
        // group loses nothing: the next run rereads the comments.
        expect(cla).not.toMatch(/^concurrency:/m);
        expect(jobText).toMatch(
            /\n {4}concurrency:\n {6}group: cla-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \}\}\n {6}cancel-in-progress: false\n/,
        );
        expect(jobText.indexOf('\n    if: ')).toBeLessThan(jobText.indexOf('\n    concurrency:'));
    });

    it('fails a commit whose author has no GitHub account, even when its committer has one', () => {
        expect(cla).not.toMatch(/committer \{ user/);
        expect(guard(commits([{ author: 'alice' }, { author: 'bob' }])).status).toBe(0);
        const unlinked = guard(commits([{ author: 'alice' }, { author: null, oid: 'c0ffee' }]));
        expect(unlinked.status).toBe(1);
        expect(unlinked.stdout).toContain('::error::Commit with no GitHub account: c0ffee');
    });

    it('fails a pull request with more commits than the action reads', () => {
        expect(guard(commits(Array.from({ length: 100 }, () => ({ author: 'alice' })))).status).toBe(0);
        const many = guard(commits(Array.from({ length: 101 }, () => ({ author: 'alice' }))));
        expect(many.status).toBe(1);
        expect(many.stdout).toContain('has 101 commits');
    });

    it('keeps signatures in this repository on their own branch and allowlists no real account', () => {
        expect(cla).toContain('branch: cla-signatures\n');
        expect(cla).toContain('path-to-signatures: signatures/cla.json\n');
        expect(cla).not.toMatch(/remote-(repository|organization)-name|PERSONAL_ACCESS_TOKEN/);
        expect(cla).toMatch(
            /cbnsndwch,dependabot\[bot\],renovate\[bot\],github-actions\[bot\],blacksmith-sh\[bot\]\$\{\{/,
        );
    });
});

/** One page of the pull request's commits, as GitHub's GraphQL API returns it. */
const commits = (list: { author: string | null; oid?: string }[]) => ({
    data: {
        repository: {
            pullRequest: {
                commits: {
                    totalCount: list.length,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: list.slice(0, 100).map(({ author, oid }, index) => ({
                        commit: { oid: oid ?? `sha${index}`, author: { user: author ? { login: author } : null } },
                    })),
                },
            },
        },
    },
});

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** Runs the workflow's guard step with a stand-in gh that answers with `page`, through jq as gh's --jq does. */
const guard = (page: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'cla-guard-'));
    dirs.push(dir);
    const steps = parse(read('.github/workflows/cla.yml')).jobs.cla.steps as { name: string; run?: string }[];
    const step = steps.find((candidate) => candidate.run);
    writeFileSync(join(dir, 'page.json'), JSON.stringify(page));
    writeFileSync(
        join(dir, 'gh'),
        `#!/usr/bin/env bash\nwhile [ "$#" -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done\njq -r "$filter" "${dir}/page.json"\n`,
    );
    chmodSync(join(dir, 'gh'), 0o755);
    return spawnSync('bash', ['-c', step!.run!], {
        encoding: 'utf8',
        env: {
            PATH: `${dir}:${process.env.PATH}`,
            RUNNER_TEMP: dir,
            GITHUB_REPOSITORY: 'example/repo',
            PR_NUMBER: '7',
        },
    });
};
