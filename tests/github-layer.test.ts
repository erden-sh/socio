// The GitHub App's layer and the composition's step build one
// `GitHubAppSettings`, offered under every tag, from `GitHubConfig` and the
// data keyring.
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { LegacyConfig, LegacyWorkspace } from '../src/server/composition/base.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { buildGitHubApp, gitHubConfig, githubLayers, LegacyGitHub } from '../src/server/composition/github.js';
import { PlatformKeys } from '../src/server/composition/keys.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { gitHubClients } from '../src/server/github/api.js';
import { GitHubAdmin, GitHubClients, GitHubConfig, GitHubSettings } from '../src/server/github/contract.js';
import { GitHubLive } from '../src/server/github/layer.js';
import { GitHubAppSettings } from '../src/server/github/settings.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

const keys: DataKeyring = { legacy: 'a-session-secret-for-the-tests' };
const envApp = { id: '42', privateKey: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----' };

it('offers one service as GitHubSettings and GitHubAdmin, with the clients, from GitHubConfig', async () => {
    const layer = GitHubLive(database(), keys).pipe(
        Layer.provide(
            Layer.succeed(GitHubConfig, {
                env: { app: envApp, installationId: '7', repository: 'acme/socio' },
            }),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const github = Context.get(context, GitHubAdmin);
    expect(github).toBeInstanceOf(GitHubAppSettings);
    expect(Context.get(context, GitHubSettings)).toBe(github);
    expect(Context.get(context, GitHubClients)).toBe(gitHubClients);
    // The environment's App is in force until one is connected here.
    expect(await github.inForce()).toEqual({ app: envApp, installationId: '7', repository: 'acme/socio' });
    // A connected App is sealed, and wins over the environment's.
    await github.saveApp({ id: '9', slug: 'socio-ab12', owner: 'acme', privateKey: 'pem' });
    expect(await github.inForce()).toEqual({
        app: { id: '9', privateKey: 'pem' },
        installationId: undefined,
        repository: 'acme/socio',
    });
    expect(await github.sealStates()).toEqual({ current: 1, previous: 0, legacy: 0, unknown: 0 });
});

it("builds the graph's step from the config and the keyring, under the legacy tag too", async () => {
    const db = database();
    const config = {
        github: { repository: 'acme/socio' },
        githubAccess: { timeoutMs: 1_000 },
        appOrigin: 'https://brain.example',
    } as PlatformConfig;
    const layer = githubLayers.github.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyConfig, config),
                Layer.succeed(LegacyWorkspace, { db } as WorkspaceStore),
                Layer.succeed(PlatformKeys, { secret: keys.legacy!, keys }),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    const github = Context.get(context, LegacyGitHub);
    expect(github).toBeInstanceOf(GitHubAppSettings);
    expect(Context.get(context, GitHubSettings)).toBe(github);
    expect(Context.get(context, GitHubAdmin)).toBe(github);
    expect(Context.get(context, GitHubClients)).toBe(gitHubClients);
    expect(Context.get(context, GitHubConfig)).toEqual({
        env: { repository: 'acme/socio' },
        access: { timeoutMs: 1_000 },
        appOrigin: 'https://brain.example',
    });
    expect((await github.view(true)).repository).toBe('acme/socio');
});

it("defaults GitHubConfig's App to none, as Platform's own constructor does", async () => {
    expect(gitHubConfig({} as PlatformConfig)).toEqual({ env: {}, access: undefined, appOrigin: undefined });
    const github = buildGitHubApp({ db: database() } as WorkspaceStore, {} as PlatformConfig, keys);
    expect(await github.inForce()).toEqual({ app: undefined, installationId: undefined, repository: undefined });
});
