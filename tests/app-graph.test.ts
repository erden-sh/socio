// The server builds the app's services from the layer graph
// (composition/index.ts) once, at startup, over the root's tags
// (composition/root.ts). Tests and scripts build the graph too; `platform`
// here is the tests' view of what it built.
import { Context } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { ActorActions, Actors } from '../src/server/actors/contract.js';
import { Approvals } from '../src/server/approvals/contract.js';
import { Ask } from '../src/server/ask/contract.js';
import type { BackupService } from '../src/server/backup/backup-service.js';
import { LegacyApprovals } from '../src/server/composition/approvals.js';
import { LegacyGitHub } from '../src/server/composition/github.js';
import { voiceService } from '../src/server/composition/http/voice.js';
import { loadDocs } from '../src/server/composition/lifecycle/docs.js';
import { Ports } from '../src/server/composition/ports.js';
import { LegacyVoice } from '../src/server/composition/voice.js';
import { Cycles } from '../src/server/cycles/contract.js';
import { Docs, type DocsCatalogShape } from '../src/server/docs/contract.js';
import { Flags } from '../src/server/flags/contract.js';
import { startAppRuntime, type AppBoot } from '../src/server/main.js';
import { Orchestrator } from '../src/server/rooms/contract.js';
import { Lifecycle } from '../src/server/runtime/contract.js';
import { WorkspaceSettings } from '../src/server/settings/contract.js';
import { Links } from '../src/server/telegram/contract.js';
import type { TelegramChannel } from '../src/server/telegram/telegram-channel.js';
import { Voice } from '../src/server/voice/contract.js';
import { VoiceService } from '../src/server/voice/voice.js';

import { recordRegistrations } from './helpers/registrations.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testAuth } from './helpers/test-auth.js';
import { testDatabase } from './helpers/test-database.js';
import { startWithTestPlatform } from './helpers/test-platform.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

const config = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    appOrigin: 'https://app.example.invalid',
};

function boot(): AppBoot {
    const db = testDatabase();
    const workspace = new WorkspaceStore(db);
    const store = new Store(db);
    cleanup.push(() => {
        store.close();
        workspace.close();
    });
    return { db, store, workspace, config, runner: new LocalAgentRunner(testDatabase()), auth: testAuth() };
}

/** The graph (the server's) and the tests' view of it, over a boot of its own. */
async function built() {
    const { runtime, platform } = await startWithTestPlatform(boot());
    cleanup.push(async () => {
        await platform.stop();
        await runtime.dispose();
    });
    return { runtime, platform };
}

it('offers each service under its tags: the view’s member is the service its tag holds', async () => {
    const { runtime, platform } = await built();
    const context = await runtime.context();
    expect(Context.get(context, LegacyApprovals)).toBe(platform.approvals);
    // The contracts' tags hold the same instances (bridges, not copies).
    expect(Context.get(context, Approvals)).toBe(platform.approvals);
    expect(Context.get(context, Flags)).toBe(platform.flags);
    expect(Context.get(context, Cycles)).toBe(platform.cycles);
    expect(Context.get(context, Actors)).toBe(platform.actors);
    expect(Context.get(context, Orchestrator)).toBe(platform.orchestrator);
    // The gateways read the GitHub App in force from its port, filled
    // right after github's step.
    expect(Context.get(context, Ports).github.get()).toBe(Context.get(context, LegacyGitHub));
});

it('offers the leaf bridges over the boot step’s objects, and closes with Ask, ActorActions, Docs and Voice', async () => {
    const { runtime, platform } = await built();
    const context = await runtime.context();
    // The leaf bridges hold the very objects the steps used to copy.
    expect(Context.get(context, WorkspaceSettings)).toBe(platform.store.slices.settings);
    expect(Context.get(context, Links)).toBe(platform.workspace.telegram);
    expect(Context.get(context, Ask)).toBeDefined();
    expect(Object.keys(Context.get(context, ActorActions)).sort()).toEqual([
        'accessContinuationCall',
        'approvalCall',
        'consumeAppAction',
        'consumeCall',
        'continuationCall',
    ]);
    // `Docs` reads the catalog the boot step fills (phase 4), at each call.
    const docs = Context.get(context, Docs);
    expect(() => docs.list()).toThrow('Docs: the catalog is not loaded yet.');
    const catalog = { digest: 'abc', list: () => [{ url: '/docs/a', title: 'A', description: '' }] };
    await loadDocs({ services: context, runtime }, async () => catalog as unknown as DocsCatalogShape);
    expect(Context.get(context, Ports).docs.peek()).toBe(catalog);
    expect(docs.digest).toBe('abc');
    expect(docs.list()).toEqual(catalog.list());
    // `Voice` is built once, in the graph; the HTTP edge takes it from the runtime.
    const voice = Context.get(context, LegacyVoice);
    expect(voice).toBeInstanceOf(VoiceService);
    expect(Context.get(context, Voice)).toBe(voice);
    const edge = { services: context, runtime };
    expect(voiceService(edge)).toBe(voice);
    expect(voiceService(undefined)).toBeUndefined();
});

it('registers the listeners, with Voice’s approvals listener last', async () => {
    const calls = recordRegistrations();
    await built();
    // The layers after the graph (issues' bridges, auth, the issues leader
    // work) add none at build time. Its last step, `Voice`, adds its
    // approvals listener last, as the HTTP edge's `new VoiceService(platform)`
    // did after the graph.
    const voice = calls.pop();
    expect(voice).toMatch(/^onPending:/);
    expect(voice).toContain('Approval needed');
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.filter((call) => call.startsWith('onPending:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('onSettled:')).length).toBeGreaterThan(1);
});

it('fails at the gateways’ step on a malformed coding setting', async () => {
    vi.stubEnv('CODING_WORKSPACE_RETENTION_DAYS', '0');
    const message = 'CODING_WORKSPACE_RETENTION_DAYS must be a whole number from 1 to 365.';
    await expect(startAppRuntime(boot())).rejects.toThrow(message);
});

it('reads the members set after the build through the same ports', async () => {
    const { runtime, platform } = await built();
    const context = await runtime.context();
    const ports = Context.get(context, Ports);
    expect(platform.telegram).toBeUndefined();
    expect(platform.backups).toBeUndefined();
    expect(ports.telegram.peek()).toBeUndefined();
    expect(ports.backups.peek()).toBeUndefined();
    expect(await runtime.runPromise(Lifecycle.use((lifecycle) => lifecycle.draining))).toBe(false);
    // Set after the build, as the boot steps do (startTelegram, startBackups).
    const channel = {
        status: 'online',
        handling: 0,
        drain: vi.fn(async () => undefined),
    } as unknown as TelegramChannel;
    const backups = { stop: vi.fn(), status: () => undefined } as unknown as BackupService;
    platform.useTelegram(channel);
    platform.useBackups(backups);
    expect(ports.telegram.peek()).toBe(channel);
    expect(ports.backups.peek()).toBe(backups);
    expect(platform.telegram).toBe(channel);
    expect(platform.backups).toBe(backups);
    // The graph's consumers read them at the moment of use: the drain
    // reaches the channel set after the build.
    await runtime.runPromise(Lifecycle.use((lifecycle) => lifecycle.drain));
    expect(platform.draining).toBe(true);
    expect(ports.draining.get()).toBe(true);
    expect(channel.drain).toHaveBeenCalledTimes(1);
    expect(await runtime.runPromise(Lifecycle.use((lifecycle) => lifecycle.draining))).toBe(true);
    platform.telegram = undefined;
    platform.backups = undefined;
});
