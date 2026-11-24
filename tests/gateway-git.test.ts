import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it, vi } from 'vitest';

import { pktLine } from '@socio/foundation/github/pkt-lines';

import { openSessionPullRequest } from '../src/server/gateway/pulls.js';

import { SESSION_BRANCH, SANDBOX, gitWorld, sandboxGit } from './support/git-gateway.js';
import { PERSON } from './support/git-repos.js';

// CB-239: the Git proxy end to end, with a real git client in the
// "sandbox", GitHub as the loopback fake and coding-git on loopback.
// Negative cases first: nothing reaches GitHub with a write token unless
// the push is the session's own branch and passed inspection.

const run = promisify(execFile);
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

type World = Awaited<ReturnType<typeof gitWorld>>;

/** Runs git as the sandbox's agent would; resolves { ok, out }. */
async function git(
    world: World,
    dir: string,
    token: string | undefined,
    args: string[],
    who?: { name: string; email: string },
) {
    const identity = who ?? world.gateway.identity(world.socio.id)!;
    try {
        const { stdout, stderr } = await run('git', [...sandboxGit(dir, token), ...args], {
            env: {
                PATH: process.env.PATH,
                HOME: '/nonexistent',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
                GIT_AUTHOR_NAME: identity.name,
                GIT_AUTHOR_EMAIL: identity.email,
                GIT_COMMITTER_NAME: identity.name,
                GIT_COMMITTER_EMAIL: identity.email,
            },
            maxBuffer: 64 * 1024 * 1024,
        });
        return { ok: true, out: `${stdout}${stderr}` };
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return { ok: false, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
    }
}

async function cloned(world: World, token: string) {
    const dir = join(world.root, `clone-${Math.random().toString(36).slice(2)}`);
    const result = await git(world, world.root, token, [
        'clone',
        '--quiet',
        `${world.gatewayUrl}/git/acme/app.git`,
        dir,
    ]);
    expect(result).toMatchObject({ ok: true });
    return dir;
}

const branchOnGitHub = (world: World, branch: string) => {
    try {
        return execFileSync('git', [
            '-C',
            join(world.root, 'github', 'acme', 'app.git'),
            'rev-parse',
            '--verify',
            '--quiet',
            `refs/heads/${branch}`,
        ])
            .toString()
            .trim();
    } catch {
        return undefined;
    }
};

const writeTokens = (world: World) => world.github.tokens.filter((token) => token.permissions.contents === 'write');

it('refuses requests without a credential, with another sandbox’s, or after revocation', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const url = `${world.gatewayUrl}/git/acme/app.git/info/refs?service=git-upload-pack`;
    const none = await fetch(url);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Basic realm="Socio"');
    // A credential bound to another sandbox than the stamp names.
    const elsewhere = await world.credential(grant, 'sbx-other');
    const basic = (value: string) => ({
        Authorization: `Basic ${Buffer.from(`:${value}`).toString('base64')}`,
    });
    expect((await fetch(url, { headers: basic(elsewhere) })).status).toBe(401);
    expect((await fetch(url, { headers: basic('cbgw_' + 'x'.repeat(43)) })).status).toBe(401);
    await world.platform.actors.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    expect((await fetch(url, { headers: basic(token) })).status).toBe(401);
    // Nothing was minted for any of them.
    expect(world.github.tokens).toEqual([]);
});

it('refuses repositories outside the grant, and paths that aren’t the three Git endpoints', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const auth = {
        Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
    };
    const other = await fetch(`${world.gatewayUrl}/git/acme/other.git/info/refs?service=git-upload-pack`, {
        headers: auth,
    });
    expect(other.status).toBe(403);
    for (const path of [
        '/git/acme/app.git/info/refs?service=git-upload-archive',
        '/git/acme/app.git/info/refs',
        '/git/acme/%2e%2e/app.git/info/refs?service=git-upload-pack',
        '/git/ac..me/app.git/info/refs?service=git-upload-pack',
        '/git/acme/app.git/HEAD/info/refs?service=git-upload-pack',
        '/git/acme/app.git/info/refs?service=git-upload-pack&x=1',
    ]) {
        expect([403, 404]).toContain((await fetch(`${world.gatewayUrl}${path}`, { headers: auth })).status);
    }
    expect(world.github.tokens).toEqual([]);
});

it('fetches with a read-only token for that one repository, revoked after each request', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(
        await world.grant(['git:read'], {
            repository: 'acme/app',
        }),
    );
    const dir = await cloned(world, token);
    expect(execFileSync('git', ['-C', dir, 'log', '--format=%s']).toString().trim()).toBe('base');
    expect(world.github.tokens.length).toBeGreaterThan(0);
    for (const minted of world.github.tokens) {
        expect(minted.permissions).toEqual({ metadata: 'read', contents: 'read' });
        expect(minted.repositories).toEqual(['app']);
    }
    await vi.waitFor(() => expect(world.github.tokens.every((minted) => minted.revoked)).toBe(true));
    // No token ever reached the client: the fake saw only its own.
    const secrets = world.github.tokens.map((minted) => minted.token);
    expect(secrets.some((secret) => dir.includes(secret))).toBe(false);
});

it('refuses a push without git:push, before anything reaches GitHub', async () => {
    const world = await gitWorld(cleanup);
    const reader = await world.credential(
        await world.grant(['git:read'], {
            repository: 'acme/app',
            branch: SESSION_BRANCH,
        }),
    );
    const dir = await cloned(world, reader);
    await git(world, dir, reader, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    const pushed = await git(world, dir, reader, ['push', 'origin', SESSION_BRANCH]);
    expect(pushed.ok).toBe(false);
    expect(writeTokens(world)).toEqual([]);
});

// The grant's branch is checked against the repository's session-branch
// shape, not trusted as the coding session recorded it.
it('refuses push and pull-request access when the grant’s branch isn’t a session branch', async () => {
    const world = await gitWorld(cleanup);
    const advertise = `${world.gatewayUrl}/git/acme/app.git/info/refs?service=git-receive-pack`;
    const basic = (value: string) => ({
        Authorization: `Basic ${Buffer.from(`:${value}`).toString('base64')}`,
    });
    for (const branch of [
        'main',
        'feature/readme',
        'socio/rulo',
        'socio/rulo/ab12cd34/deeper',
        'socio/../main/ab12cd34',
        'socio/Rulo/ab12cd34',
        'socio/rulo/ab1',
        'other/rulo/ab12cd34',
    ]) {
        const grant = await world.grant(['git:read', 'git:push', 'git:pr'], {
            repository: 'acme/app',
            branch,
            base: 'main',
        });
        const token = await world.credential(grant);
        const response = await fetch(advertise, { headers: basic(token) });
        expect(response.status, branch).toBe(403);
        await response.arrayBuffer();
        await expect(
            openSessionPullRequest(world.platform, {
                grantId: grant.id,
                personId: 'alice',
                socioId: world.socio.id,
                title: 'x',
                summary: 'x',
            }),
            branch,
        ).rejects.toThrow();
    }
    // The session's own branch is allowed, until the prefix changes.
    const token = await world.credential(await world.grant());
    const allowed = await fetch(advertise, { headers: basic(token) });
    expect(allowed.status).toBe(200);
    await allowed.arrayBuffer();
    await world.gateway.repos.save('acme/app', { branchPrefix: 'bots' }, 'olga');
    const moved = await world.credential(await world.grant());
    expect((await fetch(advertise, { headers: basic(moved) })).status).toBe(403);
    expect(writeTokens(world)).toEqual([]);
    expect(world.github.pulls).toEqual([]);
});

it('pushes the session branch: inspected, then forwarded with a write token, then revoked', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    execFileSync('sh', ['-c', `echo 'export const answer = 43;' > ${join(dir, 'src/index.ts')}`]);
    expect(await git(world, dir, token, ['commit', '--quiet', '-am', 'Change the answer'])).toMatchObject({ ok: true });
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
    const pushed = await git(world, dir, token, ['push', '--quiet', 'origin', SESSION_BRANCH]);
    expect(pushed).toMatchObject({ ok: true });
    expect(branchOnGitHub(world, SESSION_BRANCH)).toBe(head);
    // A force update of its own branch is allowed too.
    await git(world, dir, token, ['commit', '--quiet', '--amend', '-m', 'Change the answer again']);
    expect(await git(world, dir, token, ['push', '--quiet', '--force', 'origin', SESSION_BRANCH])).toMatchObject({
        ok: true,
    });
    expect(writeTokens(world)).toHaveLength(2);
    for (const minted of writeTokens(world)) {
        expect(minted.permissions).toEqual({ metadata: 'read', contents: 'write' });
    }
    await vi.waitFor(() => expect(world.github.tokens.every((minted) => minted.revoked)).toBe(true));
    // Audited with the ref and the commit ids; never a token.
    const pushes = () =>
        world.platform.actors.audit
            .list({ grantId: grant.id })
            .filter((row) => row.phase === 'outcome' && row.action === 'git:push');
    await vi.waitFor(() => expect(pushes()).toHaveLength(2));
    const rows = pushes();
    expect(rows[0]).toMatchObject({ decision: 'allow', status: '200' });
    expect(rows[0].detail).toContain(`refs/heads/${SESSION_BRANCH}`);
    const all = JSON.stringify(world.platform.actors.audit.list({ grantId: grant.id }));
    for (const minted of world.github.tokens) {
        expect(all).not.toContain(minted.token);
    }
    expect(all).not.toContain(token);
});

/** A commit on the session branch, ready to push. */
async function sessionCommit(world: World, token: string) {
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    await git(world, dir, token, ['commit', '--quiet', '--allow-empty', '-m', 'Work']);
    return dir;
}

/** coding-git's inspection held until `release` (the 2-at-once cap). */
function holdInspections(world: World) {
    const client = world.gateway.context.codingGit!;
    const inspect = client.inspect.bind(client);
    let entered!: () => void;
    const inspecting = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(client, 'inspect').mockImplementation(async (...args) => {
        entered();
        await released;
        return inspect(...args);
    });
    return { inspecting, release };
}

// Every Git request is tracked for its grant, and a
// push re-checks its credential and grant before the write token.
it('tracks each Git request for its grant until it ends', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const track = vi.spyOn(world.platform.actors.revocations, 'track');
    await cloned(world, token);
    // The advertisement and the fetch, each tracked, each untracked at its end.
    expect(track.mock.calls.filter(([grantId]) => grantId === grant.id).length).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(world.platform.actors.revocations.trackedCount(grant.id)).toBe(0));
});

it('refuses a push whose grant is revoked while it waits for inspection; nothing reaches GitHub', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const dir = await sessionCommit(world, token);
    const held = holdInspections(world);
    const pushing = git(world, dir, token, ['push', 'origin', SESSION_BRANCH]);
    await held.inspecting;
    await world.platform.actors.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    held.release();
    const pushed = await pushing;
    expect(pushed.ok).toBe(false);
    expect(pushed.out).toContain('refused by Socio');
    expect(writeTokens(world)).toEqual([]);
    expect(branchOnGitHub(world, SESSION_BRANCH)).toBeUndefined();
    await vi.waitFor(() =>
        expect(
            world.platform.actors.audit
                .list({ grantId: grant.id })
                .filter((row) => row.action === 'git:push' && row.decision === 'deny')
                .map((row) => row.reason),
        ).toContain('grant_revoked'),
    );
});

it('re-checks the grant before the write token even when no revocation reached this runtime', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const dir = await sessionCommit(world, token);
    // As if revoked on the other runtime, its signal not yet seen here.
    vi.spyOn(world.platform.actors.revocations, 'track').mockReturnValue(() => undefined);
    const held = holdInspections(world);
    const pushing = git(world, dir, token, ['push', 'origin', SESSION_BRANCH]);
    await held.inspecting;
    await world.platform.actors.revoke({ grantId: grant.id }, 'alice', 'person_revoked');
    held.release();
    const pushed = await pushing;
    expect(pushed.ok).toBe(false);
    expect(pushed.out).toContain('refused by Socio');
    expect(writeTokens(world)).toEqual([]);
    expect(branchOnGitHub(world, SESSION_BRANCH)).toBeUndefined();
});

it('refuses pushes to main, to another session’s branch, of tags and deletes, before any write token', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const dir = await cloned(world, token);
    execFileSync('sh', ['-c', `echo more >> ${join(dir, 'README.md')}`]);
    await git(world, dir, token, ['commit', '--quiet', '-am', 'More']);
    const main = await git(world, dir, token, ['push', 'origin', 'main']);
    expect(main.ok).toBe(false);
    expect(main.out).toContain('refused by Socio');
    const other = await git(world, dir, token, ['push', 'origin', 'HEAD:refs/heads/socio/rulo/ffffffff']);
    expect(other.ok).toBe(false);
    await git(world, dir, token, ['tag', 'v1']);
    expect((await git(world, dir, token, ['push', 'origin', 'v1'])).ok).toBe(false);
    expect((await git(world, dir, token, ['push', 'origin', 'HEAD:refs/notes/commits'])).ok).toBe(false);
    // Two refs at once, one of them the session's.
    expect(
        (await git(world, dir, token, ['push', 'origin', `HEAD:${SESSION_BRANCH}`, 'HEAD:refs/heads/other'])).ok,
    ).toBe(false);
    // A delete of the session's own branch.
    expect((await git(world, dir, token, ['push', 'origin', `:${SESSION_BRANCH}`])).ok).toBe(false);
    expect(writeTokens(world)).toEqual([]);
    expect(branchOnGitHub(world, 'main')).toBe(world.seed.head());
    expect(branchOnGitHub(world, SESSION_BRANCH)).toBeUndefined();
});

it('refuses push options and other capabilities, and malformed commands, on a raw request', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const head = world.seed.head();
    const post = (body: Buffer) =>
        fetch(`${world.gatewayUrl}/git/acme/app.git/git-receive-pack`, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
                'Content-Type': 'application/x-git-receive-pack-request',
            },
            body: new Uint8Array(body),
        });
    const ref = `refs/heads/${SESSION_BRANCH}`;
    for (const caps of ['report-status push-options', 'report-status report-status-v2', 'report-status delete-refs']) {
        expect(
            Buffer.from(
                await (
                    await post(
                        Buffer.concat([pktLine(`${'0'.repeat(40)} ${head} ${ref}\0${caps}\n`), Buffer.from('0000')]),
                    )
                ).arrayBuffer(),
            ).toString(),
        ).toContain('refused by Socio');
    }
    const cert = await post(Buffer.concat([pktLine('push-cert\0report-status\n'), Buffer.from('0000')]));
    expect(cert.status).toBe(200);
    expect(Buffer.from(await cert.arrayBuffer()).toString()).toContain('refused by Socio');
    expect((await post(Buffer.from('zzzz'))).status).toBe(400);
    expect(writeTokens(world)).toEqual([]);
});

it('refuses a push that changes .github/, through coding-git, without a write token', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    execFileSync('sh', [
        '-c',
        `mkdir -p ${join(dir, '.github/workflows')} && echo 'on: push' > ${join(dir, '.github/workflows/x.yml')}`,
    ]);
    await git(world, dir, token, ['add', '-A']);
    await git(world, dir, token, ['commit', '--quiet', '-m', 'CI']);
    const pushed = await git(world, dir, token, ['push', 'origin', SESSION_BRANCH]);
    expect(pushed.ok).toBe(false);
    expect(pushed.out).toContain('refused by Socio');
    expect(writeTokens(world)).toEqual([]);
    expect(branchOnGitHub(world, SESSION_BRANCH)).toBeUndefined();
});

it('refuses a push of commits authored as the person', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    await git(world, dir, token, ['commit', '--quiet', '--allow-empty', '-m', 'Mine'], PERSON);
    const pushed = await git(world, dir, token, ['push', 'origin', SESSION_BRANCH]);
    expect(pushed.ok).toBe(false);
    expect(writeTokens(world)).toEqual([]);
});

it('refuses pushes while coding-git isn’t configured (fails closed); fetches still work', async () => {
    const world = await gitWorld(cleanup, { codingGit: false });
    const token = await world.credential(await world.grant());
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    await git(world, dir, token, ['commit', '--quiet', '--allow-empty', '-m', 'Mine']);
    expect((await git(world, dir, token, ['push', 'origin', SESSION_BRANCH])).ok).toBe(false);
    expect(writeTokens(world)).toEqual([]);
});

it('limits Git requests per session (429), and minted tokens per hour for the instance', async () => {
    const world = await gitWorld(cleanup);
    const token = await world.credential(await world.grant());
    const url = `${world.gatewayUrl}/git/acme/app.git/info/refs?service=git-upload-pack`;
    const auth = {
        Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
    };
    await world.gateway.repos.saveLimits({ gitRequestsPerMinute: 3 }, 'olga');
    for (let i = 0; i < 3; i++) {
        const response = await fetch(url, { headers: auth });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
    }
    const limited = await fetch(url, { headers: auth });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // Another session is counted on its own; the instance's token ceiling
    // holds across sessions.
    await world.gateway.repos.saveLimits({ gitRequestsPerMinute: 100, tokensPerHour: 4 }, 'olga');
    world.stampAs('sbx-2');
    const second = await world.credential(await world.grant(), 'sbx-2');
    const auth2 = {
        Authorization: `Basic ${Buffer.from(`:${second}`).toString('base64')}`,
    };
    const first = await fetch(url, { headers: auth2 });
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    expect((await fetch(url, { headers: auth2 })).status).toBe(429);
    expect(world.github.tokens).toHaveLength(4);
    // Audited as denies.
    await vi.waitFor(() =>
        expect(
            world.platform.actors.audit
                .list({ personId: 'alice' })
                .map((row) => row.reason)
                .filter(Boolean),
        ).toEqual(expect.arrayContaining(['rate_limited', 'token_ceiling'])),
    );
    void SANDBOX;
});

// A session has its own hourly mint cap, so it can't
// spend the instance's ceiling; a capped request spends none of it.
it('limits minted tokens per session an hour, apart from the instance’s ceiling', async () => {
    const world = await gitWorld(cleanup);
    expect(world.gateway.repos.limits().tokensPerSessionHour).toBe(200);
    await world.gateway.repos.saveLimits({ tokensPerSessionHour: 2 }, 'olga');
    const url = `${world.gatewayUrl}/git/acme/app.git/info/refs?service=git-upload-pack`;
    const auth = (value: string) => ({
        Authorization: `Basic ${Buffer.from(`:${value}`).toString('base64')}`,
    });
    const token = await world.credential(await world.grant());
    for (let i = 0; i < 2; i++) {
        const response = await fetch(url, { headers: auth(token) });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
    }
    const capped = await fetch(url, { headers: auth(token) });
    expect(capped.status).toBe(429);
    expect(await capped.text()).toContain('This session');
    expect(world.github.tokens).toHaveLength(2);
    // Another session mints on.
    world.stampAs('sbx-2');
    const other = await world.credential(await world.grant(), 'sbx-2');
    const second = await fetch(url, { headers: auth(other) });
    expect(second.status).toBe(200);
    await second.arrayBuffer();
    expect(world.github.tokens).toHaveLength(3);
});

it('refuses when the App isn’t installed on the repository’s owner', async () => {
    const world = await gitWorld(cleanup);
    for (const entry of world.github.installations.values()) {
        entry.account = 'mallory';
    }
    const token = await world.credential(await world.grant());
    const response = await fetch(`${world.gatewayUrl}/git/acme/app.git/info/refs?service=git-upload-pack`, {
        headers: {
            Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`,
        },
    });
    expect(response.status).toBe(502);
    expect(world.github.tokens).toEqual([]);
});

it('ends the session’s access when its repository leaves the list or push is turned off', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    await world.gateway.repos.save('acme/app', { push: false }, 'olga');
    expect(world.platform.actors.grants.get(grant.id)).toMatchObject({
        revokeReason: 'access_changed',
    });
    const reader = await world.grant(['git:read'], { repository: 'acme/app' });
    await world.gateway.repos.remove('acme/app', 'olga');
    expect(world.platform.actors.grants.get(reader.id)).toMatchObject({
        revokeReason: 'access_changed',
    });
    // Both recorded as setting changes, with the admin.
    const settings = world.platform.actors.audit.list({}).filter((row) => row.phase === 'setting');
    expect(settings.map((row) => row.actorBy)).toEqual(['olga', 'olga', 'olga']);
});

it('opens draft pull requests only from the session branch into its base, with inert text', async () => {
    const world = await gitWorld(cleanup);
    const grant = await world.grant();
    const token = await world.credential(grant);
    const dir = await cloned(world, token);
    await git(world, dir, token, ['checkout', '--quiet', '-b', SESSION_BRANCH]);
    await git(world, dir, token, ['commit', '--quiet', '--allow-empty', '-m', 'Work']);
    expect(await git(world, dir, token, ['push', '--quiet', 'origin', SESSION_BRANCH])).toMatchObject({ ok: true });
    // Without git:pr: refused.
    const noPr = await world.grant(['git:read', 'git:push']);
    await expect(
        openSessionPullRequest(world.platform, {
            grantId: noPr.id,
            personId: 'alice',
            socioId: world.socio.id,
            title: 'x',
            summary: 'x',
        }),
    ).rejects.toThrow();
    // Another person's turn can't use alice's session.
    await expect(
        openSessionPullRequest(world.platform, {
            grantId: grant.id,
            personId: 'bob',
            socioId: world.socio.id,
            title: 'x',
            summary: 'x',
        }),
    ).rejects.toThrow();
    const pull = await openSessionPullRequest(world.platform, {
        grantId: grant.id,
        personId: 'alice',
        socioId: world.socio.id,
        title: 'Fixes #3 for @someone',
        summary: 'Done. Closes #4, mail pat@example.com [skip ci]',
        sessionLink: 'https://socio.example/chat/1',
    });
    expect(pull.draft).toBe(true);
    const opened = world.github.pulls.at(-1)!;
    expect(opened).toMatchObject({
        head: SESSION_BRANCH,
        base: 'main',
        draft: true,
    });
    expect(opened.title).not.toMatch(/Fixes #3/);
    expect(opened.title).toContain('`@someone`');
    expect(opened.body).not.toContain('pat@example.com');
    expect(opened.body).not.toMatch(/Closes #4/);
    expect(opened.body).not.toContain('[skip ci]');
    const prToken = world.github.tokens.at(-1)!;
    expect(prToken.permissions).toEqual({
        metadata: 'read',
        contents: 'read',
        pull_requests: 'write',
    });
    expect(prToken.revoked).toBe(true);
    // Where GitHub has no drafts it fails rather than open a ready one.
    world.github.settings.drafts = false;
    const next = await world.grant(['git:read', 'git:push', 'git:pr'], {
        repository: 'acme/app',
        branch: 'socio/rulo/eeeeeeee',
        base: 'main',
    });
    execFileSync('git', ['-C', join(world.root, 'github', 'acme', 'app.git'), 'branch', 'socio/rulo/eeeeeeee', 'main']);
    await expect(
        openSessionPullRequest(world.platform, {
            grantId: next.id,
            personId: 'alice',
            socioId: world.socio.id,
            title: 'x',
            summary: 'x',
        }),
    ).rejects.toThrow();
    expect(world.github.pulls).toHaveLength(1);
});
