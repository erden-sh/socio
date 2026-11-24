import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serve } from '@hono/node-server';
import { afterEach, expect, it, vi } from 'vitest';

import { loadSecretFiles } from '@socio/foundation/keys/secret-files';
import type { User } from '@socio/shared/types';
import {
    autoApplyTarget,
    needsConfirmation,
    newerReleases,
    parseFeed,
    upgradingSteps,
    type FeedRelease,
    type UpdatesView,
} from '@socio/shared/updates/updates';

import { MockAuthProvider } from '../src/server/auth/mock.js';
import { BackupService } from '../src/server/backup/backup-service.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { FEED_TOKEN_SETTING } from '../src/server/updates/contract.js';
import { fetchReleases, githubRelease, UPDATE_CHECK_USER_AGENT } from '../src/server/updates/feed.js';
import { releaseData } from '../src/server/updates/releases.js';
import { updatesFromEnv } from '../src/server/updates/settings.js';
import { updaterApp } from '../src/updater/app.js';
import { Updater } from '../src/updater/updater.js';

import { startFakeHealth, startFakePortainer } from './fixtures/fake-portainer.js';
import { startFakeReleaseFeed, type FakeGitHubRelease } from './fixtures/fake-release-feed.js';
import { Runner } from './helpers/runners.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const FEED_TOKEN = 'ghp_feedReadToken0123456789abcdef';
const UPDATER_TOKEN = 'updater-token-0123456789abcdef';
const API_KEY = 'ptr_portainer-key-0123456789';
/** Workspace people: nothing about them may reach the feed. */
const USERS: (User & { email: string })[] = [
    {
        id: 'olga',
        name: 'Olga Admin',
        role: 'admin',
        email: 'olga@people.test',
    },
    {
        id: 'alice',
        name: 'Alice Admin',
        role: 'admin',
        email: 'alice@people.test',
    },
    { id: 'bob', name: 'Bob Member', role: 'member', email: 'bob@people.test' },
];

/** The running version, and ones after it. */
const current = releaseData().version;
const [major, minor] = current.split('.').map(Number) as [number, number];
const next = (by: number, patch = 0) => `${major}.${minor + by}.${patch}`;

const NOTES = (upgrading?: string) =>
    [
        'One or two plain sentences.',
        '',
        '- A highlight (CB-1)',
        '',
        '### New',
        '',
        '- **Something.** It does a thing. (CB-1)',
        ...(upgrading ? ['', '### Upgrading', '', upgrading] : []),
    ].join('\n');

const githubReleases = (): FakeGitHubRelease[] => [
    {
        tag_name: `v${next(2)}`,
        name: `v${next(2)}`,
        body: NOTES(
            '- **Create the updater token.** Create `company_brain_updater_token`.\n  Then redeploy. (CB-259)\n- **Rebuild the app image.** (CB-1)',
        ),
        published_at: '2026-11-02T10:00:00Z',
        html_url: `https://github.com/acme/socio/releases/tag/v${next(2)}`,
    },
    { tag_name: `v${next(3)}`, body: 'draft', draft: true },
    { tag_name: `v${next(4)}-rc.1`, body: 'pre', prerelease: true },
    {
        tag_name: `v${next(1)}`,
        body: NOTES(),
        published_at: '2026-10-30T10:00:00Z',
        html_url: 'javascript:alert(1)',
    },
    { tag_name: `v${current}`, body: NOTES() },
    { tag_name: 'v0.1.0', body: NOTES() },
    { tag_name: 'nightly', body: 'x' },
];

it('reads the Upgrading steps from a release’s notes', () => {
    expect(upgradingSteps(NOTES())).toEqual([]);
    expect(upgradingSteps(NOTES('- **Step one.** Do it\n  carefully. (CB-1)\n* Step two.'))).toEqual([
        '**Step one.** Do it carefully. (CB-1)',
        'Step two.',
    ]);
    expect(upgradingSteps('### Upgrading\n\nRun the migration by hand.')).toEqual(['Run the migration by hand.']);
    // No notes, or notes in another format: unknown, never "nothing to do".
    expect(upgradingSteps(undefined)).toBeNull();
    expect(upgradingSteps('   ')).toBeNull();
    expect(upgradingSteps('Fixed a bug.')).toBeNull();
});

it('compares versions numerically and picks what automatic updates may apply', () => {
    const release = (version: string, upgrading: string[] | null = []) =>
        ({ version, tag: `v${version}`, upgrading }) satisfies FeedRelease;
    const list = [
        release('0.9.0'),
        release('0.10.0'),
        release('0.10.1', ['Rebuild the apps image.']),
        release('0.11.0'),
        release('0.10.0'),
        release('0.8.5'),
    ];
    expect(newerReleases(list, '0.9.0').map((r) => r.version)).toEqual(['0.11.0', '0.10.1', '0.10.0']);
    // Up to the first release with steps, never past it.
    expect(autoApplyTarget(list, '0.9.0')?.tag).toBe('v0.10.0');
    expect(autoApplyTarget(list, '0.10.0')).toBeUndefined();
    expect(autoApplyTarget(list, '0.10.1')?.tag).toBe('v0.11.0');
    // Unknown steps (no notes) stop it too.
    expect(autoApplyTarget([release('1.0.1', null)], '1.0.0')).toBeUndefined();
    expect(needsConfirmation(list, '0.9.0', '0.10.0')).toBe(false);
    expect(needsConfirmation(list, '0.9.0', '0.11.0')).toBe(true);
    expect(needsConfirmation(list, '0.10.1', '0.11.0')).toBe(false);
});

it('reads the settings: feed, interval, auto-apply and the updater', () => {
    expect(updatesFromEnv({})).toMatchObject({
        defaults: { feed: null, checkHours: 24, autoApply: false },
        githubApiUrl: 'https://api.github.com',
        ghcrUrl: 'https://ghcr.io',
    });
    expect(parseFeed('github:acme/socio')).toEqual({
        kind: 'github',
        repository: 'acme/socio',
    });
    expect(parseFeed('ghcr:acme/socio/app')).toEqual({
        kind: 'ghcr',
        repository: 'acme/socio/app',
    });
    for (const bad of [
        'github:acme',
        'github:acme/socio/extra',
        'github:../socio',
        'github:acme/..',
        'gitlab:acme/socio',
        'github:acme/so cio',
    ]) {
        expect(parseFeed(bad), bad).toBeUndefined();
    }
    expect(() => updatesFromEnv({ UPDATES_FEED: 'acme/socio' })).toThrow(/UPDATES_FEED/);
    expect(() => updatesFromEnv({ UPDATES_CHECK_HOURS: '-1' })).toThrow(/UPDATES_CHECK_HOURS/);
    expect(() => updatesFromEnv({ UPDATES_AUTO_APPLY: 'yes' })).toThrow(/UPDATES_AUTO_APPLY/);
    // The placeholder secret leaves the updater off, saying why.
    expect(
        updatesFromEnv({
            UPDATER_URL: 'http://updater:4350',
            UPDATER_TOKEN: 'none',
        }),
    ).toMatchObject({
        updaterProblem: expect.stringMatching(/UPDATER_TOKEN_FILE/),
    });
    expect(() =>
        updatesFromEnv({
            UPDATER_URL: 'http://updater:4350',
            UPDATER_TOKEN: 'short',
        }),
    ).toThrow(/24 characters/);
    // Both tokens come from secret files.
    const env: Record<string, string | undefined> = {
        UPDATES_FEED_TOKEN_FILE: '/run/secrets/feed',
        UPDATER_TOKEN_FILE: '/run/secrets/updater',
    };
    loadSecretFiles(env, (path) => (path.endsWith('feed') ? `${FEED_TOKEN}\n` : UPDATER_TOKEN));
    expect(env.UPDATES_FEED_TOKEN).toBe(FEED_TOKEN);
    expect(env.UPDATER_TOKEN).toBe(UPDATER_TOKEN);
});

it('parses GitHub releases: no drafts, pre-releases or other tags; only GitHub links', () => {
    const parsed = githubReleases().flatMap((raw) => githubRelease(raw) ?? []);
    expect(parsed.map((release) => release.tag)).toEqual([`v${next(2)}`, `v${next(1)}`, `v${current}`, 'v0.1.0']);
    expect(parsed[0]).toMatchObject({
        date: '2026-11-02',
        upgrading: [
            '**Create the updater token.** Create `company_brain_updater_token`. Then redeploy. (CB-259)',
            '**Rebuild the app image.** (CB-1)',
        ],
        url: `https://github.com/acme/socio/releases/tag/v${next(2)}`,
    });
    expect(parsed[1]!.url).toBeUndefined();
    expect(parsed[1]!.upgrading).toEqual([]);
});

it('checks a private feed with the token only, a generic User-Agent and nothing about the workspace', async () => {
    const feed = await startFakeReleaseFeed({
        token: FEED_TOKEN,
        releases: githubReleases(),
        tags: [`v${next(1)}`, 'latest', `v${next(2)}`, 'sha-abc1234'],
    });
    cleanup.push(() => feed.close());
    const github = await fetchReleases({
        feed: { kind: 'github', repository: 'acme/socio' },
        token: FEED_TOKEN,
        githubApiUrl: feed.githubApiUrl,
        ghcrUrl: feed.ghcrUrl,
    });
    expect(github.map((release) => release.tag)).toEqual([`v${next(2)}`, `v${next(1)}`, `v${current}`, 'v0.1.0']);
    const ghcr = await fetchReleases({
        feed: { kind: 'ghcr', repository: 'acme/socio' },
        token: FEED_TOKEN,
        githubApiUrl: feed.githubApiUrl,
        ghcrUrl: feed.ghcrUrl,
    });
    // Tags carry no notes: their steps are unknown.
    expect(ghcr).toEqual([
        { version: next(2), tag: `v${next(2)}`, upgrading: null },
        { version: next(1), tag: `v${next(1)}`, upgrading: null },
    ]);
    expect(feed.state.requests.map((r) => r.path)).toEqual([
        '/repos/acme/socio/releases?per_page=50',
        `/ghcr/token?scope=${encodeURIComponent('repository:acme/socio:pull')}&service=ghcr.io`,
        '/ghcr/v2/acme/socio/tags/list?n=1000',
    ]);
    for (const request of feed.state.requests) {
        expect(request.headers['user-agent']).toBe(UPDATE_CHECK_USER_AGENT);
        expect(request.headers.cookie).toBeUndefined();
        const sent = JSON.stringify(request);
        for (const user of USERS) {
            expect(sent).not.toContain(user.email);
            expect(sent).not.toContain(user.name);
        }
    }
    // A refusal names the status and a hint, never the token.
    const refused = fetchReleases({
        feed: { kind: 'github', repository: 'acme/socio' },
        token: 'ghp_wrongToken0123456789abcdef',
        githubApiUrl: feed.githubApiUrl,
        ghcrUrl: feed.ghcrUrl,
    });
    await expect(refused).rejects.toThrow(/GitHub answered 404: Not Found\. Check the repository name/);
    feed.state.failWith = 500;
    await expect(
        fetchReleases({
            feed: { kind: 'github', repository: 'acme/socio' },
            githubApiUrl: feed.githubApiUrl,
            ghcrUrl: feed.ghcrUrl,
        }),
    ).rejects.toThrow(/GitHub answered 500/);
});

/** The app, a fake feed, the real updater sidecar on loopback, a fake Portainer and the app's health. */
async function appFixture(
    options: {
        env?: Record<string, string>;
        releases?: FakeGitHubRelease[];
        offsite?: boolean;
        updater?: boolean;
    } = {},
) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const feed = await startFakeReleaseFeed({
        token: FEED_TOKEN,
        releases: options.releases ?? githubReleases(),
    });
    const stackEnv = [
        { name: 'IMAGE_TAG', value: `v${current}` },
        { name: 'AUTH_OPERATOR_EMAIL', value: 'olga@people.test' },
        { name: 'BACKUP_KEEP', value: '14' },
    ];
    const portainer = await startFakePortainer({
        apiKey: API_KEY,
        stack: {
            id: 3,
            name: 'company-brain',
            endpointId: 1,
            env: stackEnv,
            file: 'services:\n  app:\n    image: company-brain:${IMAGE_TAG:-latest}\n',
        },
        images: [`company-brain:v${next(1)}`, `company-brain:v${next(2)}`],
    });
    const health = await startFakeHealth();
    health.state.answer = { status: 200, body: { ok: true, version: current } };
    // The new version comes up healthy.
    portainer.state.onUpdate = (env) => {
        const version = env.find((entry) => entry.name === 'IMAGE_TAG')!.value.slice(1);
        health.state.answer = { status: 200, body: { ok: true, version } };
    };
    const dir = mkdtempSync(join(tmpdir(), 'updates-'));
    const stateDir = join(dir, 'updater');
    const sidecar = new Updater({
        config: {
            host: '127.0.0.1',
            port: 0,
            token: UPDATER_TOKEN,
            platform: 'portainer',
            portainer: {
                url: portainer.url,
                token: API_KEY,
                endpointId: 1,
                timeoutMs: 5000,
            },
            stack: 'company-brain',
            tagKeys: ['IMAGE_TAG'],
            pullImage: false,
            health: {
                url: health.url,
                timeoutMs: 2000,
                intervalMs: 5,
                stableChecks: 2,
            },
            backupMaxAgeMs: 3_600_000,
            stateDir,
        },
        log: () => {},
    });
    const server = serve({
        fetch: updaterApp(sidecar, UPDATER_TOKEN).fetch,
        hostname: '127.0.0.1',
        port: 0,
    });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
    const sidecarUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A database to back up, and its data spaces.
    const database = join(dir, 'company-brain.sqlite');
    const db = new DatabaseSync(database);
    db.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1);');
    db.close();
    mkdirSync(join(dir, 'userdata'));
    const backupDir = join(dir, 'backups');
    const backups = new BackupService({
        databasePath: database,
        userDataDir: join(dir, 'userdata'),
        settings: {
            directory: backupDir,
            keep: 3,
            intervalHours: 0,
            // An off-site copy that can't be made (no data key): honored.
            ...(options.offsite
                ? {
                      offsite: {
                          endpoint: 'http://127.0.0.1:1',
                          bucket: 'b',
                          region: 'us-east-1',
                          accessKeyId: 'a',
                          secretAccessKey: 's',
                          prefix: '',
                      },
                  }
                : {}),
        },
        log: () => {},
    });
    const config: PlatformConfig = {
        baseUrl: '',
        voiceName: 'marin',
        runtimeUrl: '',
        updates: updatesFromEnv({
            UPDATES_FEED: 'github:acme/socio',
            UPDATES_FEED_TOKEN: FEED_TOKEN,
            UPDATES_GITHUB_API_URL: feed.githubApiUrl,
            UPDATES_GHCR_URL: feed.ghcrUrl,
            ...(options.updater === false ? {} : { UPDATER_URL: sidecarUrl, UPDATER_TOKEN }),
            ...options.env,
        }),
    };
    const notified: { userId: string; trigger: string; title: string }[] = [];
    let scheduler!: Runner;
    const { platform, store, app, dispose } = await makeTestRuntime({
        config,
        beforeApp: ({ platform, workspace }) => {
            platform.useBackups(backups);
            for (const user of USERS) {
                workspace.recordUser(user);
            }
            vi.spyOn(platform.notifications, 'notifyFromApp').mockImplementation(async (input) => {
                notified.push(input);
                return [];
            });
        },
        app: {
            runner: (store) =>
                (scheduler = new Runner(store, { mode: 'live', baseUrl: '' }, async () => ({
                    text: '',
                    sources: [],
                    sample: false,
                }))),
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(async () => {
        await platform.updates.idle();
        await sidecar.idle();
        scheduler.stop();
        await dispose();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await feed.close();
        await portainer.close();
        await health.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const as = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0];
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    const settled = async () => {
        await platform.updates.idle();
        await sidecar.idle();
    };
    return {
        feed,
        portainer,
        sidecar,
        platform,
        store,
        as,
        notified,
        backupDir,
        stackEnv,
        settled,
    };
}

it('lets only admins see, check, configure and apply updates (CB-390)', async () => {
    const { feed, portainer, as } = await appFixture();
    for (const id of ['bob']) {
        const call = await as(id);
        for (const [path, method, body] of [
            ['/updates', 'GET'],
            ['/updates/check', 'POST'],
            ['/updates/settings', 'PUT', { autoApply: true }],
            ['/updates/apply', 'POST', { tag: `v${next(1)}` }],
        ] as const) {
            expect((await call(path, method, body)).status, `${id} ${method} ${path}`).toBe(403);
        }
        // Not in the state every tab polls, either.
        const state = (await (await call('/state')).json()) as {
            settings: Record<string, unknown>;
        };
        expect(state.settings).not.toHaveProperty('updates');
    }
    expect(feed.state.requests).toEqual([]);
    expect(portainer.state.requests).toEqual([]);
    const olga = await as('olga');
    expect((await olga('/updates')).status).toBe(200);
});

it('shows newer releases with their notes and steps, and tells admins once', async () => {
    const { as, notified, store, feed } = await appFixture();
    const olga = await as('olga');
    const before = (await (await olga('/updates')).json()) as UpdatesView;
    expect(before).toMatchObject({
        current: { version: current },
        settings: {
            feed: { kind: 'github', repository: 'acme/socio' },
            checkHours: 24,
            autoApply: false,
            source: 'environment',
        },
        token: 'environment',
        check: { running: false },
        available: [],
        updater: { configured: true, reachable: true, status: { job: null } },
    });
    const checked = await olga('/updates/check', 'POST');
    expect(checked.status).toBe(200);
    const view = (await checked.json()) as UpdatesView;
    expect(view.check).toMatchObject({ ok: true });
    expect(view.available.map((release) => release.tag)).toEqual([`v${next(2)}`, `v${next(1)}`]);
    expect(view.available[0]!.upgrading).toHaveLength(2);
    expect(view.available[0]!.notesMarkdown).toContain('### Upgrading');
    // The token went as the Authorization header, and nowhere back.
    expect(feed.state.requests.at(-1)!.headers.authorization).toBe(`Bearer ${FEED_TOKEN}`);
    expect(JSON.stringify(view)).not.toContain(FEED_TOKEN);
    // Every admin (CB-390: the operators' notice now reaches admins), once per newest release.
    const told = notified.map((notice) => notice.userId).sort();
    expect(told).toEqual(['alice', 'olga']);
    expect(notified[0]).toMatchObject({
        trigger: 'update_available',
        title: `Socio v${next(2)} is available`,
    });
    await olga('/updates/check', 'POST');
    expect(notified).toHaveLength(2);
    expect(store.settings().updates?.notified).toBe(next(2));
    // Admins' own state doesn't carry it either.
    const state = (await (await olga('/state')).json()) as {
        settings: Record<string, unknown>;
    };
    expect(state.settings).not.toHaveProperty('updates');
});

it('saves a read token sealed, for one feed only', async () => {
    const { as, store, feed } = await appFixture();
    const olga = await as('olga');
    const token = 'ghp_operatorToken0123456789abcd';
    const saved = await olga('/updates/settings', 'PUT', {
        feed: { kind: 'github', repository: 'acme/socio' },
        checkHours: 6,
        token,
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as UpdatesView;
    expect(view).toMatchObject({
        settings: { checkHours: 6, source: 'settings' },
        token: 'settings',
    });
    expect(JSON.stringify(view)).not.toContain(token);
    const secret = store.secretSetting(FEED_TOKEN_SETTING)!;
    expect(secret.url).toBe('github:acme/socio');
    expect(secret.value).not.toContain(token);
    expect(JSON.stringify(store.settings())).not.toContain(token);
    // The saved token is the one sent now.
    await olga('/updates/check', 'POST');
    expect(feed.state.requests.at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
    // Another feed drops it: no token follows a feed it wasn't given for,
    // and the environment's goes only to the environment's feed.
    const moved = (await (
        await olga('/updates/settings', 'PUT', {
            feed: { kind: 'github', repository: 'other/socio' },
        })
    ).json()) as UpdatesView;
    expect(moved.token).toBe('none');
    expect(store.secretSetting(FEED_TOKEN_SETTING)).toBeUndefined();
    for (const [body, message] of [
        [{ checkHours: 200 }, /0 to 168/],
        [{ feed: { kind: 'github', repository: 'acme' } }, /owner\/repo/],
        [{ token: 'two words' }, /one word/],
        [{ nope: true }, /Invalid settings/],
    ] as const) {
        const answer = await olga('/updates/settings', 'PUT', body);
        expect(answer.status, JSON.stringify(body)).toBe(400);
        expect(((await answer.json()) as { error: string }).error).toMatch(message);
    }
    // Back to the environment's.
    const reset = (await (await olga('/updates/settings', 'PUT', { reset: true })).json()) as UpdatesView;
    expect(reset.settings).toMatchObject({
        source: 'environment',
        checkHours: 24,
        feed: { repository: 'acme/socio' },
    });
    expect(reset.token).toBe('environment');
});

it('backs up, then has the updater apply the release, keeping every env entry', async () => {
    const { as, portainer, sidecar, backupDir, stackEnv, settled } = await appFixture();
    const olga = await as('olga');
    // Not before a check has seen it.
    const unknown = await olga('/updates/apply', 'POST', { tag: `v${next(2)}` });
    expect(unknown.status).toBe(404);
    await olga('/updates/check', 'POST');
    // Its Upgrading steps need confirming.
    const unconfirmed = await olga('/updates/apply', 'POST', {
        tag: `v${next(2)}`,
    });
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({ code: 'confirm_required' });
    // The running release, or an older one: never a downgrade.
    const same = await olga('/updates/apply', 'POST', { tag: `v${current}` });
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ code: 'not_newer' });
    expect(portainer.state.updates).toEqual([]);

    const started = await olga('/updates/apply', 'POST', {
        tag: `v${next(2)}`,
        confirmUpgrading: true,
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
        preparing: {
            target: `v${next(2)}`,
            phase: 'backing_up',
            requestedBy: 'olga',
        },
    });
    await settled();
    // The backup came first, in the configured backup directory.
    const job = sidecar.status().job!;
    expect(job).toMatchObject({
        phase: 'succeeded',
        target: `v${next(2)}`,
        from: current,
        requestedBy: 'olga',
        backup: { offsite: false },
    });
    expect(existsSync(join(backupDir, job.backup.database))).toBe(true);
    expect(existsSync(join(backupDir, job.backup.userdata))).toBe(true);
    expect(portainer.state.updates).toHaveLength(1);
    expect(portainer.state.updates[0]!.env).toEqual(
        stackEnv.map((entry) => (entry.name === 'IMAGE_TAG' ? { ...entry, value: `v${next(2)}` } : entry)),
    );
    const view = (await (await olga('/updates')).json()) as UpdatesView;
    expect(view.preparing).toBeUndefined();
    expect(view.updater.status?.job?.phase).toBe('succeeded');
    // Env values stay in the updater.
    expect(JSON.stringify(view)).not.toContain('olga@people.test');
});

it('changes nothing when the backup’s off-site copy fails', async () => {
    const { as, portainer, settled } = await appFixture({ offsite: true });
    const olga = await as('olga');
    await olga('/updates/check', 'POST');
    expect((await olga('/updates/apply', 'POST', { tag: `v${next(1)}` })).status).toBe(202);
    await settled();
    const view = (await (await olga('/updates')).json()) as UpdatesView;
    expect(view.preparing).toMatchObject({
        phase: 'failed',
        error: expect.stringMatching(/off-site copy failed.*Nothing was changed/),
    });
    expect(portainer.state.requests).toEqual([]);
});

it('is notify-only without an updater', async () => {
    const { as, portainer } = await appFixture({ updater: false });
    const olga = await as('olga');
    const view = (await (await olga('/updates/check', 'POST')).json()) as UpdatesView;
    expect(view.updater).toEqual({ configured: false });
    expect(view.available).toHaveLength(2);
    const refused = await olga('/updates/apply', 'POST', { tag: `v${next(1)}` });
    expect(refused.status).toBe(503);
    expect(portainer.state.requests).toEqual([]);
});

it('applies automatically only when turned on, and only releases without steps', async () => {
    const off = await appFixture();
    const offOlga = await off.as('olga');
    await offOlga('/updates/check', 'POST');
    await off.settled();
    expect(off.portainer.state.updates).toEqual([]);

    const on = await appFixture({ env: { UPDATES_AUTO_APPLY: 'true' } });
    const olga = await on.as('olga');
    const view = (await (await olga('/updates')).json()) as UpdatesView;
    expect(view.settings.autoApply).toBe(true);
    await olga('/updates/check', 'POST');
    await on.settled();
    // next(1) has no steps; next(2) has some: it stops at next(1).
    expect(on.sidecar.status().job).toMatchObject({
        phase: 'succeeded',
        target: `v${next(1)}`,
        requestedBy: 'auto',
    });
    expect(on.portainer.state.updates).toHaveLength(1);
});
