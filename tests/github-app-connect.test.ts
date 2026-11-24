import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { SECRET_SETTINGS } from '@socio/foundation/keys/secret-files';
import type { GitHubAppView, GitHubConnectNext } from '@socio/shared/github-types';

import { DEFAULT_MOCK_USERS } from '../src/server/auth/config.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import { GitHubApp } from '../src/server/github/api.js';
import { manifest } from '../src/server/github/connect.js';
import { gitHubAppFromEnv } from '../src/server/github/settings.js';

import { fakeGitHub } from './github-fake.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/** The mock users, and a second admin. */
const USERS = [...DEFAULT_MOCK_USERS, { id: 'carol', name: 'Carol', role: 'admin' as const }];

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/**
 * The GitHub App's settings and "Connect GitHub" (CB-32, moved out of
 * dispatch in CB-325): a GitHub stand-in where acme is an organization with
 * acme/socio, and the app, whose environment names the repository.
 * `connect`: through Settings' Connect GitHub (the default), the
 * environment's App, or none.
 */
async function setup(options: { connect?: 'settings' | 'env' | false } = {}) {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
        logs.push(String(line));
    });
    const dir = mkdtempSync(join(tmpdir(), 'cb-github-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const github = await fakeGitHub(join(dir, 'github'), cleanup, {
        organizations: ['acme'],
    });
    github.repository('acme', 'socio');
    const connect = options.connect ?? 'settings';
    const envApp =
        connect === 'env'
            ? await GitHubApp.convertManifest(github.createApp('acme'), {
                  hosts: github.hosts,
              })
            : undefined;
    if (envApp) {
        github.install(Number(envApp.id), ['socio']);
    }
    const { platform, workspace, app, dispose } = await makeTestRuntime({
        config: {
            apiKey: '',
            model: '',
            appOrigin: 'https://brain.example',
            github: gitHubAppFromEnv({
                GITHUB_REPO: 'acme/socio',
                ...(envApp
                    ? {
                          GITHUB_APP_ID: envApp.id,
                          GITHUB_APP_PRIVATE_KEY: envApp.privateKey.replace(/\n/g, '\\n'),
                      }
                    : {}),
            }),
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
            app.request(path.startsWith('/api/') ? path : `/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const alice = await as('alice');
    const bob = await as('bob');
    const carol = await as('carol');
    /**
     * Connect GitHub as an admin would: Settings' button, the manifest page,
     * Create on GitHub, back to Settings, Install on GitHub, back again.
     */
    const connectGitHub = async () => {
        const start = await alice('/github/connect', 'POST', {});
        expect(start.status).toBe(200);
        const { url } = (await start.json()) as GitHubConnectNext;
        const page = await alice(url);
        const html = await page.text();
        const state = new URL(url, 'https://brain.example').searchParams.get('state')!;
        const code = github.createApp('acme');
        const created = await alice('/github/created', 'POST', {
            code,
            state,
        });
        expect(created.status).toBe(200);
        const install = new URL(((await created.json()) as GitHubConnectNext).url);
        const appId = github.apps.at(-1)!.id;
        const installationId = github.install(appId, ['socio']);
        const installed = await alice('/github/installed', 'POST', {
            installationId: String(installationId),
            state: install.searchParams.get('state')!,
        });
        expect(installed.status).toBe(200);
        return {
            page,
            html,
            state,
            code,
            install,
            installationId,
            view: (await installed.json()) as GitHubAppView,
        };
    };
    const connected = connect === 'settings' ? await connectGitHub() : undefined;
    return { github, platform, workspace, logs, connected, connectGitHub, alice, bob, carol };
}

it('connects GitHub with the App manifest flow: Create, then Install, nothing pasted', async () => {
    const s = await setup();
    const { page, html, state, install, installationId, view } = s.connected!;
    // The manifest page posts to the organization's new-App page, with the
    // state, and its own CSP lets the form go only there.
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain(`form-action ${s.github.hosts.web}`);
    expect(html).toContain(`action="${s.github.hosts.web}/organizations/acme/settings/apps/new?state=${state}"`);
    const sent = JSON.parse(
        html
            .match(/name="manifest" value="([^"]*)"/)![1]
            .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code))),
    ) as ReturnType<typeof manifest>;
    expect(sent).toMatchObject({
        url: 'https://brain.example',
        redirect_url: 'https://brain.example/settings/workspace',
        setup_url: 'https://brain.example/settings/workspace',
        public: false,
        default_permissions: {
            contents: 'write',
            pull_requests: 'write',
            metadata: 'read',
        },
        default_events: [],
    });
    expect(sent).not.toHaveProperty('hook_attributes');
    // Then the App's install page, and the installation recorded.
    expect(install.href).toBe(
        `${s.github.hosts.web}/apps/socio-1000/installations/new?state=${install.searchParams.get('state')}`,
    );
    expect(install.searchParams.get('state')).not.toBe(state);
    expect(view).toEqual({
        repository: 'acme/socio',
        repositorySource: 'env',
        app: {
            source: 'settings',
            id: '1000',
            slug: 'socio-1000',
            owner: 'acme',
        },
        installation: { id: String(installationId), account: 'acme' },
        unreadable: false,
        canConnect: true,
    });
    // The key: sealed in the database, never in an answer, a page or a log.
    const key = s.github.apps[0].pem;
    const row = s.workspace.db.prepare("SELECT value FROM dispatch_settings WHERE key='github.app'").get() as {
        value: string;
    };
    expect(row.value).not.toContain('PRIVATE KEY');
    expect(JSON.stringify({ html, view, logs: s.logs })).not.toContain(key.split('\n')[1]);
    expect(s.logs).toContain('GitHub: App 1000 (socio-1000) connected by user=alice');
});

it('refuses connect steps that are not this admin’s, used, or out of order', async () => {
    const s = await setup({ connect: false });
    expect((await (await s.alice('/github')).json()) as GitHubAppView).toMatchObject({
        app: null,
        installation: null,
    });
    // Members get none of it.
    for (const [path, method] of [
        ['/github', 'GET'],
        ['/github/connect', 'POST'],
        ['/github/created', 'POST'],
        ['/github/installed', 'POST'],
        ['/github/app', 'DELETE'],
    ] as const) {
        expect((await s.bob(path, method, method === 'GET' ? undefined : {})).status).toBe(403);
    }
    const { url } = (await (await s.alice('/github/connect', 'POST', {})).json()) as GitHubConnectNext;
    const state = new URL(url, 'https://x').searchParams.get('state')!;
    const code = s.github.createApp('acme');
    // A forged state, or the install step's endpoint with this one.
    const refused =
        'This GitHub step has expired, was used already, or was not started here; select Connect GitHub again.';
    for (const [path, body] of [
        ['/github/created', { code, state: 'forged' }],
        ['/github/installed', { installationId: '5000', state }],
    ] as const) {
        const answer = await s.alice(path, 'POST', body);
        expect(answer.status).toBe(409);
        expect(await answer.json()).toEqual({ error: refused });
    }
    expect((await s.alice(`/api/github/manifest?state=x`)).status).toBe(409);
    // The real one works once.
    expect((await s.alice('/github/created', 'POST', { code, state })).status).toBe(200);
    expect((await s.alice('/github/created', 'POST', { code, state })).status).toBe(409);
    // An App made under someone else can't serve acme/socio.
    const again = (await (await s.alice('/github/connect', 'POST', {})).json()) as GitHubConnectNext;
    const wrong = await s.alice('/github/created', 'POST', {
        code: s.github.createApp('pat'),
        state: new URL(again.url, 'https://x').searchParams.get('state'),
    });
    expect(wrong.status).toBe(502);
    expect(((await wrong.json()) as { error: string }).error).toContain('The App was created under pat, not acme');
    // Disconnect forgets the App here.
    const off = await s.alice('/github/app', 'DELETE', {});
    expect(((await off.json()) as GitHubAppView).app).toBeNull();
});

it('uses the environment’s App, finding its installation from the repository', async () => {
    const s = await setup({ connect: 'env' });
    expect((await (await s.alice('/github')).json()) as GitHubAppView).toMatchObject({
        app: { source: 'env', id: '1000', slug: null, owner: null },
        installation: null,
    });
    expect((await s.platform.github.inForce()).app?.id).toBe('1000');
});

it('lets admins set the repository in Settings', async () => {
    const s = await setup({ connect: false });
    for (const body of [
        { repository: 'https://github.com/acme/socio' },
        { baseBranch: 'main' },
        { token: 'github_pat_0123456789abcdefghijklmnop' },
        { other: true },
    ]) {
        expect((await s.alice('/github', 'PUT', body)).status).toBe(400);
    }
    const saved = await s.alice('/github', 'PUT', { repository: 'acme/app' });
    expect(await saved.json()).toMatchObject({
        repository: 'acme/app',
        repositorySource: 'settings',
    });
    await s.alice('/github', 'PUT', { repository: null });
    expect((await (await s.alice('/github')).json()) as GitHubAppView).toMatchObject({
        repository: 'acme/socio',
        repositorySource: 'env',
    });
});

it('reads the environment strictly, without echoing the key', () => {
    const quiet = () => {};
    expect(gitHubAppFromEnv({}, quiet)).toEqual({
        app: undefined,
        installationId: undefined,
        repository: undefined,
    });
    const key = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
    expect(
        gitHubAppFromEnv({
            GITHUB_APP_ID: '12',
            GITHUB_APP_PRIVATE_KEY: key,
        }).app,
    ).toEqual({
        id: '12',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    });
    for (const [env, error] of [
        [{ GITHUB_APP_ID: '12' }, 'Set both'],
        [{ GITHUB_APP_ID: 'x', GITHUB_APP_PRIVATE_KEY: key }, 'GITHUB_APP_ID must be the App’s number.'],
        [
            {
                GITHUB_APP_ID: '12',
                GITHUB_APP_PRIVATE_KEY: 'secret-value',
            },
            'GITHUB_APP_PRIVATE_KEY must be the App’s private key (PEM).',
        ],
        [{ GITHUB_REPO: 'socio' }, 'GITHUB_REPO must be owner/name.'],
        [{ GITHUB_INSTALLATION_ID: 'x' }, 'GITHUB_INSTALLATION_ID must be a number.'],
    ] as const) {
        let message = '';
        try {
            gitHubAppFromEnv(env, quiet);
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toContain(error);
        expect(message).not.toContain('secret-value');
    }
});

it('reads the DISPATCH_GITHUB_* names for one release, with a warning, under the new ones', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
    const warnings: string[] = [];
    const legacy = gitHubAppFromEnv(
        {
            DISPATCH_GITHUB_APP_ID: '12',
            DISPATCH_GITHUB_APP_PRIVATE_KEY: key,
            DISPATCH_GITHUB_INSTALLATION_ID: '34',
            DISPATCH_GITHUB_REPO: 'acme/socio',
        },
        (line) => warnings.push(line),
    );
    expect(legacy).toEqual({
        app: { id: '12', privateKey: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----' },
        installationId: '34',
        repository: 'acme/socio',
    });
    // One line per old name, naming the setting and never its value.
    expect(warnings).toEqual([
        'DISPATCH_GITHUB_APP_ID is deprecated: rename it GITHUB_APP_ID. The old name is read for one more release.',
        'DISPATCH_GITHUB_APP_PRIVATE_KEY is deprecated: rename it GITHUB_APP_PRIVATE_KEY. The old name is read for one more release.',
        'DISPATCH_GITHUB_INSTALLATION_ID is deprecated: rename it GITHUB_INSTALLATION_ID. The old name is read for one more release.',
        'DISPATCH_GITHUB_REPO is deprecated: rename it GITHUB_REPO. The old name is read for one more release.',
    ]);
    expect(warnings.join('\n')).not.toContain('PRIVATE KEY-----');
    // The new name wins, quietly.
    warnings.length = 0;
    expect(
        gitHubAppFromEnv({ GITHUB_REPO: 'acme/new', DISPATCH_GITHUB_REPO: 'acme/old' }, (line) => warnings.push(line))
            .repository,
    ).toBe('acme/new');
    expect(warnings).toEqual([]);
    // The key may come from a file under either name (Docker secrets).
    expect(SECRET_SETTINGS).toContain('GITHUB_APP_PRIVATE_KEY');
    expect(SECRET_SETTINGS).toContain('DISPATCH_GITHUB_APP_PRIVATE_KEY');
});

/** The state in a connect step's address. */
const stateOf = (url: string) => new URL(url, 'https://brain.example').searchParams.get('state')!;

it('ties each connect step to the admin who started it, for an hour, once', async () => {
    const s = await setup({ connect: false });
    const refused =
        'This GitHub step has expired, was used already, or was not started here; select Connect GitHub again.';
    const start = async () =>
        stateOf(((await (await s.alice('/github/connect', 'POST', {})).json()) as GitHubConnectNext).url);
    // Another admin can't finish Alice's step, nor open its manifest page.
    const state = await start();
    const code = s.github.createApp('acme');
    const carol = await s.carol('/github/created', 'POST', {
        code,
        state,
    });
    expect(carol.status).toBe(409);
    expect(await carol.json()).toEqual({ error: refused });
    expect((await s.carol(`/api/github/manifest?state=${state}`)).status).toBe(409);
    expect(s.github.apps).toEqual([]);
    // Alice still can; then the state is used up, even with a new code.
    const created = await s.alice('/github/created', 'POST', {
        code,
        state,
    });
    expect(created.status).toBe(200);
    const again = await s.alice('/github/created', 'POST', {
        code: s.github.createApp('acme'),
        state,
    });
    expect(again.status).toBe(409);
    expect(s.github.apps).toHaveLength(1);
    // The install step's state is Alice's too.
    const install = stateOf(((await created.json()) as GitHubConnectNext).url);
    const installationId = String(s.github.install(s.github.apps[0], ['socio']));
    expect(
        (
            await s.carol('/github/installed', 'POST', {
                installationId,
                state: install,
            })
        ).status,
    ).toBe(409);

    // A step more than an hour old.
    const late = await start();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61 * 60_000);
    const expired = await s.alice('/github/created', 'POST', {
        code: s.github.createApp('acme'),
        state: late,
    });
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: refused });
    expect(s.github.apps).toHaveLength(1);
});

it('records an installation only on the repository’s owner', async () => {
    const s = await setup({ connect: false });
    const { url } = (await (await s.alice('/github/connect', 'POST', {})).json()) as GitHubConnectNext;
    const created = await s.alice('/github/created', 'POST', {
        code: s.github.createApp('acme'),
        state: stateOf(url),
    });
    const install = stateOf(((await created.json()) as GitHubConnectNext).url);
    const elsewhere = s.github.install(s.github.apps[0], ['socio'], 'pat');
    const answer = await s.alice('/github/installed', 'POST', {
        installationId: String(elsewhere),
        state: install,
    });
    expect(answer.status).toBe(502);
    expect(await answer.json()).toEqual({
        error: 'The App was installed on pat, not acme.',
    });
    expect(((await (await s.alice('/github')).json()) as GitHubAppView).installation).toBeNull();
});

it('says when the saved App can’t be read, refuses to connect over it, and recovers with Disconnect', async () => {
    const s = await setup();
    // Sealed under a data key that is gone.
    s.workspace.db
        .prepare("UPDATE dispatch_settings SET value=? WHERE key='github.app'")
        .run('v1:gone:' + 'A'.repeat(80));
    const view = async () => (await (await s.alice('/github')).json()) as GitHubAppView;
    expect(await view()).toMatchObject({
        app: null,
        unreadable: true,
    });
    const connect = await s.alice('/github/connect', 'POST', {});
    expect(connect.status).toBe(409);
    expect(await connect.json()).toEqual({
        error: 'The GitHub App saved here can’t be opened (its data key is gone). Select Disconnect first, then Connect GitHub.',
    });
    // The coding gateway can't use it either.
    await expect(s.platform.github.inForce()).rejects.toThrow('can’t be opened');
    expect((await s.alice('/github/app', 'DELETE', {})).status).toBe(200);
    expect(await view()).toMatchObject({ unreadable: false, app: null });
    expect((await s.alice('/github/connect', 'POST', {})).status).toBe(200);
});

it('uses up the create step’s state even when GitHub refuses the code', async () => {
    const s = await setup({ connect: false });
    const { url } = (await (await s.alice('/github/connect', 'POST', {})).json()) as GitHubConnectNext;
    const state = stateOf(url);
    const refused = await s.alice('/github/created', 'POST', {
        code: 'codeunknown',
        state,
    });
    expect(refused.status).toBe(502);
    const retry = await s.alice('/github/created', 'POST', {
        code: s.github.createApp('acme'),
        state,
    });
    expect(retry.status).toBe(409);
    expect(s.github.apps).toEqual([]);
});
