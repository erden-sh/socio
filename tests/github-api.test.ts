import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { pktLine, readPktLines } from '@socio/foundation/github/pkt-lines';
import { inert } from '@socio/shared/text/untrusted-text';

import { appJwt, GitHubApp, GitHubRepository } from '../src/server/github/api.js';
import { GitHubError } from '../src/server/github/contract.js';

import { fakeGitHub } from './github-fake.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const AGENT = ['-c', 'user.name=Socio', '-c', 'user.email=agent@socio.invalid'];

/** A checkout with main (a person's commit) and an agent's branch on it. */
function checkout() {
    const root = mkdtempSync(join(tmpdir(), 'github-api-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, 'app');
    const git = (...args: string[]) =>
        execFileSync('git', args, {
            cwd: dir,
            env: { PATH: process.env.PATH, HOME: root },
        })
            .toString()
            .trim();
    execFileSync('git', ['init', '--quiet', '-b', 'main', dir]);
    writeFileSync(join(dir, 'README.md'), '# App\n');
    git('add', 'README.md');
    git('-c', 'user.name=Pat Example', '-c', 'user.email=pat@example.com', 'commit', '--quiet', '-m', 'Start');
    const base = git('rev-parse', 'HEAD');
    const branch = 'socio/CB-7-ab12cd34';
    git('switch', '--quiet', '-c', branch);
    writeFileSync(join(dir, 'README.md'), '# App\n\nFixed.\n');
    git(...AGENT, 'commit', '--quiet', '-am', 'Fix the readme\n\nIssue: CB-7');
    const head = git('rev-parse', 'HEAD');
    const bundle = join(root, 'run.bundle');
    git('bundle', 'create', '--quiet', bundle, `${base}..${branch}`);
    return { root, dir, git, base, head, branch, bundle: readFileSync(bundle) };
}

/** GitHub with acme/app (main pushed), an App made from a manifest and installed on it. */
async function connected() {
    const repo = checkout();
    const github = await fakeGitHub(join(repo.root, 'github'), cleanup);
    const remote = github.repository('acme', 'app', repo.dir);
    github.repository('acme', 'other');
    const converted = await GitHubApp.convertManifest(github.createApp('acme'), {
        hosts: github.hosts,
    });
    const installationId = github.install(Number(converted.id), ['app', 'other']);
    const app = new GitHubApp(converted, { hosts: github.hosts });
    return { repo, github, remote, converted, installationId, app };
}

/** The pack in a git bundle: what follows its header's blank line. */
const packOf = (bundle: Buffer) => bundle.subarray(bundle.indexOf('\n\n') + 2);

it('reads pkt-lines', () => {
    expect(pktLine('# service=git-receive-pack\n').toString()).toBe('001f# service=git-receive-pack\n');
    expect(readPktLines(Buffer.from('0006a\n00000005b'))).toEqual(['a\n', null, 'b']);
});

it('converts a manifest code once, into the App’s id, slug, owner and key', async () => {
    const repo = checkout();
    const github = await fakeGitHub(join(repo.root, 'github'), cleanup, {
        organizations: ['acme'],
    });
    expect(await GitHubApp.accountType('acme', { hosts: github.hosts })).toBe('Organization');
    expect(await GitHubApp.accountType('pat', { hosts: github.hosts })).toBe('User');
    const code = github.createApp('acme');
    const app = await GitHubApp.convertManifest(code, { hosts: github.hosts });
    expect(app).toMatchObject({
        id: '1000',
        slug: 'socio-1000',
        owner: 'acme',
    });
    expect(app.privateKey).toContain('PRIVATE KEY');
    // Without credentials; a code works once.
    const post = github.seen.find((r) => r.url.includes('/conversions'))!;
    expect(post.headers.authorization).toBeUndefined();
    await expect(GitHubApp.convertManifest(code, { hosts: github.hosts })).rejects.toThrow(
        'GitHub answered 404: Not Found (the code was used already or is more than an hour old; connect again).',
    );
});

it('signs nine-minute App JWTs and mints a token for one repository with contents and pull requests write only', async () => {
    const { github, converted, installationId, app } = await connected();
    const [, payload] = appJwt(converted.id, converted.privateKey, 1_000_000)
        .split('.')
        .map((part) => Buffer.from(part, 'base64url').toString());
    expect(JSON.parse(payload)).toEqual({ iat: 940, exp: 1540, iss: 1000 });

    expect(await app.installation(String(installationId))).toEqual({
        id: String(installationId),
        account: 'acme',
    });
    expect(await app.repositoryInstallation('acme/app')).toBe(String(installationId));
    const minted = await app.installationToken(String(installationId), 'acme/app');
    const request = github.seen.find((r) => r.url.endsWith('/access_tokens'))!;
    expect(JSON.parse(request.body.toString())).toEqual({
        repositories: ['app'],
        permissions: { contents: 'write', pull_requests: 'write' },
    });
    expect(github.tokens[0]).toMatchObject({
        token: minted.token,
        repositories: ['app'],
        permissions: {
            metadata: 'read',
            contents: 'write',
            pull_requests: 'write',
        },
    });
    // The App's own credential is a JWT, never the key itself.
    for (const seen of github.seen) {
        expect(JSON.stringify(seen.headers) + seen.body.toString()).not.toContain('PRIVATE KEY');
    }
    await minted.revoke();
    expect(github.tokens[0].revoked).toBe(true);

    // A GitHub that grants more: the token is revoked, never used.
    github.extraPermissions.administration = 'write';
    await expect(app.installationToken(String(installationId), 'acme/app')).rejects.toThrow(
        'GitHub granted the token more than it needs, so it was not used.',
    );
    expect(github.tokens[1].revoked).toBe(true);
    // Not installed on a repository: GitHub's 422, with advice.
    delete github.extraPermissions.administration;
    github.repository('acme', 'elsewhere');
    await expect(app.installationToken(String(installationId), 'acme/elsewhere')).rejects.toThrow(
        /does not cover acme\/elsewhere/,
    );
    await expect(app.repositoryInstallation('acme/elsewhere')).rejects.toThrow(
        'GitHub answered 404: Not Found (the GitHub App is not installed on acme/elsewhere; install it from Settings).',
    );
});

it('pushes a new branch over smart HTTP, never moves one, and keeps tokens out of URLs', async () => {
    const { repo, github, remote, installationId, app } = await connected();
    const { token } = await app.installationToken(String(installationId), 'acme/app');
    const client = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
    });
    expect(await client.branchContains('main', repo.base)).toBe(true);
    expect(await client.branchContains('main', repo.head)).toBe(false);
    expect(await client.branchContains('nope', repo.base)).toBe(false);

    const pack = packOf(repo.bundle);
    expect(await client.pushBranch(repo.branch, repo.head, pack)).toBe('pushed');
    const there = (...args: string[]) =>
        execFileSync('git', ['-C', remote, ...args])
            .toString()
            .trim();
    expect(there('rev-parse', `refs/heads/${repo.branch}`)).toBe(repo.head);
    // main is untouched; the pushed commit is the agent identity's.
    expect(there('rev-parse', 'refs/heads/main')).toBe(repo.base);
    expect(there('log', '--format=%ae %ce', `main..${repo.branch}`)).toBe('agent@socio.invalid agent@socio.invalid');
    // Again: already there, nothing sent.
    expect(await client.pushBranch(repo.branch, repo.head, pack)).toBe('present');
    // Elsewhere: refused, not forced.
    await expect(client.pushBranch(repo.branch, repo.base, pack)).rejects.toThrow(
        `${repo.branch} is already on GitHub with other commits, so it was not overwritten.`,
    );
    expect(there('rev-parse', `refs/heads/${repo.branch}`)).toBe(repo.head);

    for (const request of github.seen) {
        expect(request.url).not.toContain(token);
        expect(request.headers['user-agent']).toBe('socio');
        expect(JSON.stringify(request.headers)).not.toMatch(/pat@example|pat example/i);
    }
    expect(github.seen.filter((r) => r.method === 'POST' && r.url.endsWith('/git-receive-pack'))).toHaveLength(1);
});

it('says why GitHub refused, without the token', async () => {
    const { repo, github, installationId, app } = await connected();
    const pack = packOf(repo.bundle);
    const wrong = new GitHubRepository({
        repository: 'acme/app',
        token: 'ghs_notatoken0123456789abcdef',
        hosts: github.hosts,
    });
    await expect(wrong.pushBranch(repo.branch, repo.head, pack)).rejects.toThrow(
        'GitHub refused the push (401): check the repository, and that the GitHub App is installed on it with contents write.',
    );
    await expect(wrong.branchContains('main', repo.base)).rejects.toThrow(
        'GitHub answered 401: Bad credentials (the token was refused).',
    );
    // A message that quotes the token loses it.
    const { token } = await app.installationToken(String(installationId), 'acme/app');
    const client = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
    });
    github.fail.set('/api/repos/acme/app/pulls', {
        status: 422,
        body: { message: `Bad head for ${token}` },
    });
    const error = await client
        .draftPullRequest({
            head: repo.branch,
            base: 'main',
            title: 't',
            body: 'b',
        })
        .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as Error).message).toBe('GitHub answered 422: Bad head for [redacted].');
    // Unreachable: a plain message.
    const down = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: {
            web: 'http://127.0.0.1:1',
            git: 'http://127.0.0.1:1',
            api: 'http://127.0.0.1:1',
        },
    });
    await expect(down.branchContains('main', repo.base)).rejects.toThrow('GitHub could not be reached.');
});

it('opens one draft pull request per branch', async () => {
    const { repo, github, installationId, app } = await connected();
    const { token } = await app.installationToken(String(installationId), 'acme/app');
    const client = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
    });
    await client.pushBranch(repo.branch, repo.head, packOf(repo.bundle));
    const input = {
        head: repo.branch,
        base: 'main',
        title: 'CB-7: Fix the readme',
        body: 'Body.',
    };
    const opened = {
        number: 1,
        url: 'https://github.com/acme/app/pull/1',
        draft: true,
    };
    expect(await client.draftPullRequest(input)).toEqual(opened);
    expect(await client.draftPullRequest(input)).toEqual(opened);
    expect(github.pulls).toHaveLength(1);
    expect(github.pulls[0]).toMatchObject({ ...input, draft: true });
    const post = github.seen.find((r) => r.method === 'POST' && r.url === '/api/repos/acme/app/pulls')!;
    expect(post.headers.authorization).toBe(`Bearer ${token}`);
    expect(post.body.toString()).not.toContain(token);
});

it('opens a ready pull request titled [draft] where GitHub has no drafts', async () => {
    const { repo, github, installationId, app } = await connected();
    github.settings.drafts = false;
    const { token } = await app.installationToken(String(installationId), 'acme/app');
    const client = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
    });
    await client.pushBranch(repo.branch, repo.head, packOf(repo.bundle));
    const input = {
        head: repo.branch,
        base: 'main',
        title: 'CB-7: Fix',
        body: 'B.',
    };
    expect(await client.draftPullRequest(input)).toEqual({
        number: 1,
        url: 'https://github.com/acme/app/pull/1',
        draft: false,
    });
    expect(github.pulls).toEqual([expect.objectContaining({ title: '[draft] CB-7: Fix', draft: false })]);
    // Other refusals are not retried.
    const other = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
    });
    github.pulls.length = 0;
    github.fail.set('/api/repos/acme/app/pulls', {
        status: 422,
        body: {
            message: 'Validation Failed',
            errors: [{ message: 'No commits between main and x' }],
        },
    });
    await expect(other.draftPullRequest(input)).rejects.toThrow(
        'GitHub answered 422: Validation Failed: No commits between main and x.',
    );
});

it('says a redirect is a moved repository, and never follows it', async () => {
    const { repo, github, installationId, app } = await connected();
    const { token } = await app.installationToken(String(installationId), 'acme/app');
    const followed: string[] = [];
    const client = new GitHubRepository({
        repository: 'acme/app',
        token,
        hosts: github.hosts,
        transport: (async (url: string, init: RequestInit) => {
            followed.push(url);
            return fetch(url, init);
        }) as typeof fetch,
    });
    const moved =
        'GitHub answered with a redirect (301), which is not followed: the repository was probably renamed or moved. Check the repository in Settings.';
    github.fail.set('/api/repos/acme/app/compare', { status: 301 });
    await expect(client.branchContains('main', repo.base)).rejects.toThrow(moved);
    github.fail.set('/acme/app.git/info/refs', { status: 302 });
    await expect(client.pushBranch(repo.branch, repo.head, packOf(repo.bundle))).rejects.toThrow(
        moved.replace('301', '302'),
    );
    expect(followed.every((url) => !url.includes('elsewhere.example'))).toBe(true);
    expect(followed).toHaveLength(2);
});

it('breaks closing keywords however they are spaced, and leaves other words alone', () => {
    expect(inert('Fixes:#1 closes #2 RESOLVED: #3 fixed#4 affixes #5 prefix #6')).toBe(
        'Fixes:issue #1 closes issue #2 RESOLVED: issue #3 fixed issue #4 affixes #5 prefix #6',
    );
    expect(inert('mail a@b.example and agent@socio.invalid', ['agent@socio.invalid'])).toBe(
        'mail [email removed] and agent@socio.invalid',
    );
});

it('breaks CI skip directives, so an agent can’t switch CI off for its own pull request', () => {
    expect(
        inert(
            'Tidy [skip ci] [ci skip] [NO CI] [skip actions] [ actions skip ] [skip-ci]\n\nskip-checks: true\nSkip-Checks:TRUE',
        ),
    ).toBe(
        'Tidy (skip ci) (ci skip) (NO CI) (skip actions) (actions skip) (skip-ci)\n\nskip-checks (ignored) true\nSkip-Checks (ignored) TRUE',
    );
    // Nothing else in brackets changes.
    expect(inert('[WIP] [skip] skip-checks: false')).toBe('[WIP] [skip] skip-checks: false');
});
