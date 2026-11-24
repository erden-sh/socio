import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { sqliteData } from '@socio/data/open';
import type { CodingRepositoriesView } from '@socio/shared/coding/coding-repos';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { gitGateway } from '../src/server/gateway/git.js';
import { GitHubApp } from '../src/server/github/api.js';

import { fakeGitHub } from './github-fake.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { tempDir } from './support/git-repos.js';

// CB-239: Settings → Coding → Repositories and the Git limits, for
// admins only, dark until a coding flag is on for them; push needs the
// checklist; every change is a `setting` row with the admin.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const USERS = [
    { id: 'olga', name: 'Olga', role: 'admin' as const },
    { id: 'bob', name: 'Bob', role: 'member' as const },
];

async function setup(flags: Record<string, boolean>) {
    const root = tempDir('cb-g2-settings-', cleanup);
    const github = await fakeGitHub(join(root, 'gh'), cleanup);
    const converted = await GitHubApp.convertManifest(github.createApp('acme'), {
        hosts: github.hosts,
    });
    github.install(Number(converted.id), ['app'], 'acme');
    github.repository('acme', 'app');
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'settings-secret-0123456789abcdef',
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: flags,
            github: {
                app: { id: converted.id, privateKey: converted.privateKey },
            },
            githubAccess: { hosts: github.hosts },
        },
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api/gateway${path}`, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return {
        platform,
        workspace,
        github,
        olga: await as('olga'),
        bob: await as('bob'),
    };
}

it('is dark: no route while the coding flags are off', async () => {
    const s = await setup({});
    expect((await s.olga('/repositories')).status).toBe(404);
    expect((await s.olga('/repositories/acme/app', 'PUT', {})).status).toBe(404);
});

it('is for admins only', async () => {
    const s = await setup({ 'coding-sessions': true });
    expect((await s.bob('/repositories')).status).toBe(403);
    expect((await s.bob('/repositories/acme/app', 'PUT', { extraction: true })).status).toBe(403);
    expect((await s.bob('/git-limits', 'PUT', { tokensPerHour: 5 })).status).toBe(403);
});

it('refuses bad input, push without the checklist, and standing extraction without extraction', async () => {
    const s = await setup({ 'repo-extraction': true });
    for (const [path, body] of [
        ['/repositories/acme/app', { push: 'yes' }],
        ['/repositories/acme/app', { unknown: true }],
        ['/repositories/acme/app', { baseBranches: ['../x'] }],
        ['/repositories/acme/app', { baseBranches: ['socio/x'] }],
        ['/repositories/acme/app', { branchPrefix: 'Has Space' }],
        ['/repositories/acme/app', { users: ['nobody'] }],
        ['/repositories/acme/app', { standingExtraction: true }],
        ['/repositories/acme/app.git', {}],
        ['/repositories/ac..me/app', {}],
    ] as const) {
        expect((await s.olga(path, 'PUT', body)).status, `${path} ${JSON.stringify(body)}`).toBe(400);
    }
    const push = await s.olga('/repositories/acme/app', 'PUT', { push: true });
    expect(push.status).toBe(409);
    expect((await s.olga('/git-limits', 'PUT', { tokensPerHour: 0 })).status).toBe(400);
    expect((await s.olga('/git-limits', 'PUT', { nope: 1 })).status).toBe(400);
    expect((await s.olga('/repositories')).status).toBe(200);
    expect(((await (await s.olga('/repositories')).json()) as CodingRepositoriesView).repositories).toEqual([]);
});

it('saves repositories and limits, audited with the admin and old and new values', async () => {
    const s = await setup({ 'coding-sessions': true });
    const saved = await s.olga('/repositories/acme/app', 'PUT', {
        push: true,
        pushChecklistConfirmed: true,
        baseBranches: ['main', 'release/1'],
        extraction: true,
        standingExtraction: true,
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as CodingRepositoriesView;
    expect(view.repositories[0]).toMatchObject({
        repository: 'acme/app',
        push: true,
        pushChecklist: { by: 'olga' },
        baseBranches: ['main', 'release/1'],
        branchPrefix: 'socio',
        users: null,
        extraction: true,
        standingExtraction: true,
    });
    expect(view.checklist.length).toBe(3);
    expect(view.limits).toEqual(view.limitDefaults);
    const limits = await s.olga('/git-limits', 'PUT', {
        tokensPerHour: 50,
        extractMaxMb: 10,
    });
    expect(((await limits.json()) as CodingRepositoriesView).limits).toMatchObject({
        tokensPerHour: 50,
        extractMaxMb: 10,
    });
    // Back to the environment's value.
    await s.olga('/git-limits', 'PUT', { tokensPerHour: null });
    expect(s.platform.actors.audit.list({}).filter((row) => row.phase === 'setting')).toHaveLength(3);
    const rows = s.platform.actors.audit.list({}).filter((row) => row.phase === 'setting');
    expect(rows.every((row) => row.actorBy === 'olga')).toBe(true);
    const first = rows.at(-1)!;
    expect(first.action).toBe('coding.repository.push_checklist');
    expect(JSON.parse(first.detail!)).toMatchObject({
        old: null,
        new: { push: true },
    });
    // The App's installation, checked with its own JWT, no token minted.
    const check = await s.olga('/repositories/acme/app/check');
    expect(await check.json()).toMatchObject({ installed: true });
    expect(s.github.tokens).toEqual([]);
    expect((await s.olga('/repositories/acme/none/check')).status).toBe(404);
    // Removed.
    expect((await s.olga('/repositories/acme/app', 'DELETE', {})).status).toBe(200);
    expect((await s.olga('/repositories/acme/app', 'DELETE', {})).status).toBe(404);
});

// The audit names who was added and removed, by id.
it('audits the listed people as ids added and removed, within the row’s limit', async () => {
    const s = await setup({ 'coding-sessions': true });
    s.workspace.recordUser({ id: 'cy', name: 'Cy', role: 'member' });
    const { repos } = gitGateway(s.platform);
    const settingRows = () => s.platform.actors.audit.list({}).filter((row) => row.phase === 'setting');
    await repos.save('acme/app', { users: ['olga', 'bob'] }, 'olga');
    await repos.save('acme/app', { users: ['cy', 'olga'] }, 'olga');
    expect(JSON.parse(settingRows()[0].detail!)).toMatchObject({
        old: { users: 2 },
        new: { users: 2 },
        users: { added: ['cy'], removed: ['bob'] },
    });
    // Back to the code-access list: everyone listed is removed.
    await repos.save('acme/app', { users: null }, 'olga');
    expect(JSON.parse(settingRows()[0].detail!)).toMatchObject({
        new: { users: 'code-access list' },
        users: { added: [], removed: ['cy', 'olga'] },
    });
    // 500 people: the row still fits and is JSON, with a count of the rest.
    const many = Array.from({ length: 500 }, (_, i) => `person-${String(i).padStart(3, '0')}`);
    for (const id of many) {
        s.workspace.recordUser({ id, name: id, role: 'member' });
    }
    await repos.save('acme/app', { users: many }, 'olga');
    const detail = settingRows()[0].detail!;
    expect(detail.length).toBeLessThanOrEqual(2000);
    const parsed = JSON.parse(detail) as {
        users: { added: string[]; removed: string[]; omitted: number };
    };
    expect(parsed.users.added[0]).toBe('person-000');
    expect(parsed.users.added.length + parsed.users.omitted).toBe(500);
});

// Two saves queued behind another unit of work each
// merge onto the row the other wrote, not the one they saw when called.
it('keeps both of two saves that wait for the connection together', async () => {
    const s = await setup({ 'coding-sessions': true });
    const { repos } = gitGateway(s.platform);
    await repos.save('acme/app', {}, 'olga');
    const blocker = sqliteData(repos.database).uow.run(async () => undefined, {
        label: 'test: someone else’s unit of work',
    });
    const first = repos.save('acme/app', { extraction: true }, 'olga');
    const second = repos.save('acme/app', { baseBranches: ['main', 'release/1'] }, 'olga');
    await Promise.all([blocker, first, second]);
    expect(repos.get('acme/app')).toMatchObject({
        extraction: true,
        baseBranches: ['main', 'release/1'],
    });
});
