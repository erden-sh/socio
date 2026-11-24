import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { UpdaterJob, UpdaterStatus } from '@socio/shared/updates/updates';

import { updaterApp } from '../src/updater/app.js';
import { UPDATER_SECRET_SETTINGS, updaterConfigFromEnv, type UpdaterConfig } from '../src/updater/config.js';
import { imagesFor, planEnv } from '../src/updater/plan.js';
import { parseUpdaterPlatform, PLATFORM_SECRET_SETTINGS } from '../src/updater/platform.js';
import { createPlatform } from '../src/updater/platforms.js';
import { PortainerPlatform } from '../src/updater/portainer-platform.js';
import { PortainerClient } from '../src/updater/portainer.js';
import { Updater } from '../src/updater/updater.js';

import { startFakeHealth, startFakePortainer, type FakeEnv } from './fixtures/fake-portainer.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const TOKEN = 'updater-token-0123456789abcdef';
const API_KEY = 'ptr_portainer-key-0123456789';
const FILE = `version: '3.8'
services:
  app:
    image: company-brain:\${IMAGE_TAG:-latest}
  apps:
    image: company-brain-apps:\${APPS_IMAGE_TAG:?Set APPS_IMAGE_TAG}
  seaweedfs:
    image: chrislusf/seaweedfs:4.47
`;
/** A stack env as Portainer keeps it; a personal value among them. */
const ENV: FakeEnv[] = [
    { name: 'IMAGE_TAG', value: 'v0.21.0' },
    { name: 'APP_ORIGIN', value: 'https://brain.example.test' },
    { name: 'AUTH_OPERATOR_EMAIL', value: 'olga@people.test' },
    { name: 'APPS_IMAGE_TAG', value: 'abc1234' },
    { name: 'EMPTY', value: '' },
    { name: 'BACKUP_KEEP', value: '14' },
];

const backup = (at = Date.now()) => ({
    database: 'company-brain-20261027-101500.sqlite',
    userdata: 'userdata-20261027-101500',
    offsite: true,
    at,
});
const request = (overrides: Record<string, unknown> = {}) => ({
    target: 'v0.22.0',
    from: '0.21.0',
    requestedBy: 'olga',
    backup: backup(),
    ...overrides,
});

async function setup(options: { images?: string[]; env?: FakeEnv[]; tagKeys?: string[] } = {}) {
    const portainer = await startFakePortainer({
        apiKey: API_KEY,
        stack: {
            id: 7,
            name: 'company-brain',
            endpointId: 1,
            env: options.env ?? ENV,
            file: FILE,
        },
        images: options.images ?? ['company-brain:v0.22.0'],
    });
    const health = await startFakeHealth();
    const stateDir = mkdtempSync(join(tmpdir(), 'updater-'));
    cleanup.push(
        () => portainer.close(),
        () => health.close(),
        () => rmSync(stateDir, { recursive: true, force: true }),
    );
    const config: UpdaterConfig = {
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        platform: 'portainer',
        portainer: {
            url: portainer.url,
            token: API_KEY,
            endpointId: 1,
            timeoutMs: 5000,
        },
        stack: 'company-brain',
        tagKeys: options.tagKeys ?? ['IMAGE_TAG'],
        pullImage: false,
        health: {
            url: health.url,
            // On the gate's own clock (below): 80 checks, each fetch given
            // the gate's longest per-check timeout, 5 s of real time.
            timeoutMs: 200_000,
            intervalMs: 2_500,
            stableChecks: 3,
        },
        backupMaxAgeMs: 60 * 60_000,
        stateDir,
    };
    const logs: string[] = [];
    // The health gate runs on a clock of its own that moves only as it
    // sleeps: its timeout is 80 checks however slow the machine is. On the
    // wall clock (400 ms, a check every 5 ms, each fetch cut off after
    // 10 ms), a loaded machine ran out of time before 3 checks were in.
    let clock = 0;
    const gate = {
        now: () => clock,
        sleep: async (ms: number) => {
            clock += ms;
            await new Promise((resolve) => setImmediate(resolve));
        },
    };
    const make = () =>
        new Updater({
            config,
            platform: new PortainerPlatform(config, new PortainerClient(config.portainer), gate),
            log: (line) => logs.push(line),
        });
    const updater = make();
    const app = updaterApp(updater, TOKEN);
    const call = (path: string, method = 'GET', body?: unknown, token = TOKEN) =>
        app.request(path, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    /** The fake app answers as whichever IMAGE_TAG the stack now has. */
    const followStack = (healthyVersions: string[]) => {
        portainer.state.onUpdate = (env) => {
            const tag = env.find((entry) => entry.name === 'IMAGE_TAG')!.value;
            const version = tag.replace(/^v/, '');
            health.state.answer = healthyVersions.includes(version)
                ? { status: 200, body: { ok: true, version } }
                : { status: 503, body: { ok: false, version } };
        };
    };
    return {
        portainer,
        health,
        updater,
        call,
        config,
        logs,
        make,
        followStack,
        stateDir,
    };
}

it('reads its settings, refusing a missing token or Portainer key', () => {
    expect(() => updaterConfigFromEnv({})).toThrow(/UPDATER_TOKEN/);
    expect(() => updaterConfigFromEnv({ UPDATER_TOKEN: 'none' })).toThrow(/UPDATER_TOKEN/);
    expect(() => updaterConfigFromEnv({ UPDATER_TOKEN: TOKEN })).toThrow(/UPDATER_PORTAINER_TOKEN/);
    const config = updaterConfigFromEnv({
        UPDATER_TOKEN: TOKEN,
        UPDATER_PORTAINER_TOKEN: API_KEY,
        UPDATER_PORTAINER_URL: 'http://10.0.0.10:9000/',
        UPDATER_TAG_KEYS: 'IMAGE_TAG, APPS_IMAGE_TAG',
    });
    expect(config).toMatchObject({
        port: 4350,
        stack: 'company-brain',
        tagKeys: ['IMAGE_TAG', 'APPS_IMAGE_TAG'],
        pullImage: false,
        portainer: { url: 'http://10.0.0.10:9000', endpointId: 1 },
        health: {
            url: 'http://company-brain_app:4310/healthz',
            timeoutMs: 900_000,
            stableChecks: 3,
        },
    });
    expect(() =>
        updaterConfigFromEnv({
            UPDATER_TOKEN: TOKEN,
            UPDATER_PORTAINER_TOKEN: API_KEY,
            UPDATER_PORTAINER_URL: 'http://p:9000',
            UPDATER_TAG_KEYS: 'image tag',
        }),
    ).toThrow(/UPDATER_TAG_KEYS/);
});

it('plans the env: every entry kept in order, only the tag keys changed', () => {
    const next = planEnv(ENV, ['IMAGE_TAG'], 'v0.22.0');
    expect(next).toEqual(ENV.map((entry) => (entry.name === 'IMAGE_TAG' ? { ...entry, value: 'v0.22.0' } : entry)));
    expect(planEnv(ENV, ['IMAGE_TAG', 'APPS_IMAGE_TAG'], 'v0.22.0').map((entry) => entry.value)).toEqual([
        'v0.22.0',
        'https://brain.example.test',
        'olga@people.test',
        'v0.22.0',
        '',
        '14',
    ]);
    expect(() => planEnv(ENV, ['CODING_EGRESS_IMAGE_TAG'], 'v0.22.0')).toThrow(
        /CODING_EGRESS_IMAGE_TAG is not in the stack's env/,
    );
    expect(() => planEnv([...ENV, { name: 'IMAGE_TAG', value: 'x' }], ['IMAGE_TAG'], 'v1.0.0')).toThrow(/2 times/);
    expect(() => planEnv(ENV, ['IMAGE_TAG'], 'v0.21.0')).toThrow(/already runs/);
    expect(imagesFor(FILE, ['IMAGE_TAG'], 'v0.22.0')).toEqual(['company-brain:v0.22.0']);
    expect(imagesFor(FILE, ['IMAGE_TAG', 'APPS_IMAGE_TAG'], 'v0.22.0')).toEqual([
        'company-brain:v0.22.0',
        'company-brain-apps:v0.22.0',
    ]);
});

it('answers only the app’s token, and says nothing without it', async () => {
    const { call, portainer } = await setup();
    expect((await call('/healthz', 'GET', undefined, '')).status).toBe(200);
    for (const token of ['', 'wrong-token-0123456789abcdef']) {
        for (const [path, method, body] of [
            ['/v1/status', 'GET'],
            ['/v1/apply', 'POST', request()],
        ] as const) {
            expect((await call(path, method, body, token)).status).toBe(401);
        }
    }
    expect(portainer.state.requests).toEqual([]);
});

it('applies an update: backup named, env preserved, image tag only, healthy', async () => {
    const { call, portainer, health, updater, followStack, stateDir } = await setup();
    followStack(['0.21.0', '0.22.0']);
    const started = await call('/v1/apply', 'POST', request());
    expect(started.status).toBe(202);
    const { job } = (await started.json()) as { job: UpdaterJob };
    expect(job).toMatchObject({
        target: 'v0.22.0',
        from: '0.21.0',
        phase: 'applying',
        requestedBy: 'olga',
        backup: { database: 'company-brain-20261027-101500.sqlite' },
    });
    await updater.idle();
    // One stack update: the same file byte for byte, every env entry in
    // order, only IMAGE_TAG changed; no prune, no pull of local images.
    expect(portainer.state.updates).toEqual([
        {
            stackFileContent: FILE,
            env: ENV.map((entry) => (entry.name === 'IMAGE_TAG' ? { ...entry, value: 'v0.22.0' } : entry)),
            prune: false,
            pullImage: false,
            endpointId: '1',
        },
    ]);
    // Only stack API calls and a read-only image lookup.
    expect(portainer.state.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /api/stacks',
        'GET /api/stacks/7',
        'GET /api/stacks/7/file',
        'GET /api/endpoints/1/docker/images/company-brain%3Av0.22.0/json',
        'PUT /api/stacks/7?endpointId=1',
    ]);
    expect(health.state.hits).toBeGreaterThanOrEqual(3);
    const status = (await (await call('/v1/status')).json()) as UpdaterStatus;
    expect(status.job).toMatchObject({ phase: 'succeeded', target: 'v0.22.0' });
    expect(status.job!.finishedAt).toBeTypeOf('number');
    // The status never carries env values or the stack file.
    const shown = JSON.stringify(status);
    expect(shown).not.toContain('olga@people.test');
    expect(shown).not.toContain('company-brain-apps');
    expect(shown).not.toContain(API_KEY);
    // The state file is private to the updater.
    const file = join(stateDir, 'updater-state.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).job.phase).toBe('succeeded');
});

it('waits for the target version: an old task still answering does not count', async () => {
    const { call, health, updater, portainer } = await setup();
    // Start-first or stop-first alike: the old version answers healthy for a
    // while after the update, then the new one does.
    // The old version answers the first 5 checks after the update.
    portainer.state.onUpdate = () => {
        const updatedAt = health.state.hits;
        health.state.onHit = (hits) => {
            health.state.answer = {
                status: 200,
                body: { ok: true, version: hits - updatedAt <= 5 ? '0.21.0' : '0.22.0' },
            };
        };
    };
    expect((await call('/v1/apply', 'POST', request())).status).toBe(202);
    await updater.idle();
    expect(updater.status().job?.phase).toBe('succeeded');
    // A draining server at the new version doesn't count either.
    expect(updater.status().job?.steps.some((step) => /healthy/.test(step.line))).toBe(true);
});

it('rolls back when the new version is not healthy in time', async () => {
    const { call, portainer, updater, followStack } = await setup();
    followStack(['0.21.0']);
    expect((await call('/v1/apply', 'POST', request())).status).toBe(202);
    await updater.idle();
    const job = updater.status().job!;
    expect(job.phase).toBe('rolled_back');
    expect(job.error).toMatch(/0\.22\.0 was not healthy within 200 s \(last: HTTP 503\)/);
    // The rollback sent the previous file and env back exactly.
    expect(portainer.state.updates).toHaveLength(2);
    expect(portainer.state.updates[1]).toMatchObject({
        stackFileContent: FILE,
        env: ENV,
        prune: false,
    });
    expect(portainer.state.stack.env).toEqual(ENV);
});

it('rolls back when Portainer refuses the update, and reports a rollback that fails', async () => {
    const first = await setup();
    first.followStack(['0.21.0']);
    first.portainer.state.refuseUpdate = 500;
    expect((await first.call('/v1/apply', 'POST', request())).status).toBe(202);
    await first.updater.idle();
    const job = first.updater.status().job!;
    // The rollback's own PUT was refused too: an operator must act, with
    // the backup to restore named.
    expect(job.phase).toBe('rollback_failed');
    expect(job.error).toMatch(/Portainer refused to update the stack \(500: Update failed: boom\)/);
    expect(job.steps.at(-1)!.line).toMatch(
        /restore the pre-update backup \(company-brain-20261027-101500\.sqlite, userdata-20261027-101500\)/,
    );

    const second = await setup();
    // The new version never gets healthy, nor does the old one come back
    // (it refuses the migrated database).
    second.followStack([]);
    expect((await second.call('/v1/apply', 'POST', request())).status).toBe(202);
    await second.updater.idle();
    expect(second.updater.status().job).toMatchObject({
        phase: 'rollback_failed',
        error: expect.stringMatching(/rollback did not come back healthy either/),
    });
});

it('refuses before changing anything: missing image, missing key, stale backup, downgrade, busy', async () => {
    const { call, portainer, updater } = await setup({ images: [] });
    const refused = await call('/v1/apply', 'POST', request());
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/company-brain:v0\.22\.0 is not on the node/);
    expect(portainer.state.updates).toEqual([]);
    for (const [body, status, message] of [
        [request({ backup: undefined }), 422, /pre-update backup/],
        [request({ backup: backup(Date.now() - 2 * 3_600_000) }), 422, /too old/],
        [request({ backup: { ...backup(), database: '../etc/passwd' } }), 422, /pre-update backup/],
        [request({ target: 'v0.20.0' }), 422, /never downgrades/],
        [request({ target: 'latest' }), 400, /release tag/],
        [{ ...request(), extra: 1 }, 400, /Unknown fields/],
    ] as const) {
        const answer = await call('/v1/apply', 'POST', body);
        expect(answer.status, JSON.stringify(body)).toBe(status);
        expect(((await answer.json()) as { error: string }).error).toMatch(message);
    }
    expect(portainer.state.updates).toEqual([]);
    expect(updater.status().job).toBeNull();

    const keyless = await setup({ tagKeys: ['CODING_EGRESS_IMAGE_TAG'] });
    const missing = await keyless.call('/v1/apply', 'POST', request());
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { error: string }).error).toMatch(
        /CODING_EGRESS_IMAGE_TAG is not in the stack's env/,
    );

    // One at a time.
    const busy = await setup();
    busy.health.state.answer = { status: 503, body: { ok: false } };
    expect((await busy.call('/v1/apply', 'POST', request())).status).toBe(202);
    expect((await busy.call('/v1/apply', 'POST', request())).status).toBe(409);
    await busy.updater.idle();
});

/** A job cut off in `phase`, as an earlier process left it on disk. */
function leaveJob(stateDir: string, phase: string) {
    const at = Date.now();
    writeFileSync(
        join(stateDir, 'updater-state.json'),
        JSON.stringify({
            job: {
                id: 'job-1',
                target: 'v0.22.0',
                from: '0.21.0',
                requestedBy: 'olga',
                phase,
                startedAt: at,
                updatedAt: at,
                backup: backup(at),
                steps: [],
                stackId: 7,
                previous: { file: FILE, env: ENV },
                next: planEnv(ENV, ['IMAGE_TAG'], 'v0.22.0'),
            },
            history: [],
        }),
    );
}

it('carries an interrupted update on after a restart instead of repeating it', async () => {
    // Cut off before Portainer took it: nothing changed, nothing is sent.
    const before = await setup();
    leaveJob(before.stateDir, 'applying');
    const first = before.make();
    first.recover();
    await first.idle();
    expect(first.status().job).toMatchObject({
        phase: 'failed',
        error: 'Interrupted before the stack update.',
    });
    expect(before.portainer.state.updates).toEqual([]);

    // Cut off while checking health: it checks again, and doesn't update twice.
    const during = await setup({
        env: planEnv(ENV, ['IMAGE_TAG'], 'v0.22.0'),
    });
    during.health.state.answer = {
        status: 200,
        body: { ok: true, version: '0.22.0' },
    };
    leaveJob(during.stateDir, 'verifying');
    const second = during.make();
    second.recover();
    await second.idle();
    expect(second.status().job?.phase).toBe('succeeded');
    expect(during.portainer.state.updates).toEqual([]);

    // Cut off while rolling back: the rollback is done again.
    const rolling = await setup({
        env: planEnv(ENV, ['IMAGE_TAG'], 'v0.22.0'),
    });
    rolling.followStack(['0.21.0']);
    leaveJob(rolling.stateDir, 'rolling_back');
    const third = rolling.make();
    third.recover();
    await third.idle();
    expect(third.status().job?.phase).toBe('rolled_back');
    expect(rolling.portainer.state.updates).toHaveLength(1);
    expect(rolling.portainer.state.stack.env).toEqual(ENV);
});

it('picks the platform adapter UPDATER_PLATFORM names, portainer by default (CB-323)', async () => {
    const env = {
        UPDATER_TOKEN: TOKEN,
        UPDATER_PORTAINER_TOKEN: API_KEY,
        UPDATER_PORTAINER_URL: 'http://10.0.0.10:9000',
    };
    expect(updaterConfigFromEnv(env).platform).toBe('portainer');
    expect(updaterConfigFromEnv({ ...env, UPDATER_PLATFORM: ' Portainer ' }).platform).toBe('portainer');
    const platform = createPlatform(updaterConfigFromEnv(env));
    expect(platform).toBeInstanceOf(PortainerPlatform);
    expect(platform.name).toBe('portainer');
    expect(platform.describe).toBe('stack company-brain (IMAGE_TAG) on Portainer endpoint 1');
    // The Portainer key is the adapter's credential, read from its _FILE.
    expect(PLATFORM_SECRET_SETTINGS.portainer).toEqual(['UPDATER_PORTAINER_TOKEN']);
    expect(UPDATER_SECRET_SETTINGS).toEqual(['UPDATER_TOKEN', 'UPDATER_PORTAINER_TOKEN']);

    // Without a platform given, the Updater builds the configured one, and it works end to end.
    const { config, portainer, followStack } = await setup();
    followStack(['0.21.0', '0.22.0']);
    const updater = new Updater({ config, log: () => {} });
    expect(updater.target).toBe('stack company-brain (IMAGE_TAG) on Portainer endpoint 1 (UPDATER_PLATFORM=portainer)');
    await updater.apply(request());
    await updater.idle();
    expect(updater.status().job?.phase).toBe('succeeded');
    expect(portainer.state.updates).toHaveLength(1);
    expect(JSON.stringify(updater.status())).not.toContain('deployment');
});

it('refuses an unknown platform with a clear message, before asking for any credential', () => {
    for (const name of ['kubernetes', 'swarm', 'docker']) {
        expect(() => updaterConfigFromEnv({ UPDATER_TOKEN: TOKEN, UPDATER_PLATFORM: name })).toThrow(
            `UPDATER_PLATFORM must be portainer (the platforms the updater can deploy to so far), not "${name}".`,
        );
    }
    expect(() => parseUpdaterPlatform('kubernetes')).toThrow(/UPDATER_PLATFORM must be portainer/);
    expect(parseUpdaterPlatform(undefined)).toBe('portainer');
    expect(parseUpdaterPlatform('  ')).toBe('portainer');
    // A config built by hand is refused too.
    const config = updaterConfigFromEnv({
        UPDATER_TOKEN: TOKEN,
        UPDATER_PORTAINER_TOKEN: API_KEY,
        UPDATER_PORTAINER_URL: 'http://p:9000',
    });
    expect(() => createPlatform({ ...config, platform: 'kubernetes' as never })).toThrow(
        'The updater has no "kubernetes" platform: UPDATER_PLATFORM must be portainer.',
    );
});
