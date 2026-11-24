/**
 * The GitHub App's construction: `github/layer.ts` builds the settings service
 * and offers it as `GitHubSettings` and `GitHubAdmin`, with `GitHubClients`;
 * this file builds `GitHubConfig` from the supplied configuration and adds the
 * tag the other steps read the service from. `buildGitHubApp` is the same
 * construction, which the tests use.
 */
import { Context, Effect, Layer } from 'effect';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import { GitHubConfig, type GitHubConfigShape } from '../github/contract.js';
import { gitHubAppSettings, gitHubContext, makeGitHub } from '../github/layer.js';
import type { GitHubAppSettings } from '../github/settings.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';
import type { AppWorkspace } from './workspace-parts.js';

/**
 * What github reads of the configuration: the environment's App, which the
 * entry parses once (`gitHubAppFromEnv` in `index.ts`, where tests pass
 * their own), how GitHub is reached, and the app's origin.
 */
export const gitHubConfig = (config: PlatformConfig): GitHubConfigShape => ({
    env: config.github ?? {},
    access: config.githubAccess,
    appOrigin: config.appOrigin,
});

/** The GitHub App coding sessions push and open pull requests with (CB-32). */
export function buildGitHubApp(workspace: AppWorkspace, config: PlatformConfig, keys: DataKeyring): GitHubAppSettings {
    return gitHubAppSettings(workspace.db, keys, gitHubConfig(config).env);
}

/** The GitHub App's settings, under the graph's `LegacyGitHub` tag (the class). */
export class LegacyGitHub extends Context.Service<LegacyGitHub, GitHubAppSettings>()(
    'socio/composition/github/GitHubAppSettings',
) {}

/** `GitHubConfig`, from the process's config. */
const GitHubConfigLive = Layer.effect(
    GitHubConfig,
    Effect.gen(function* () {
        return gitHubConfig(yield* LegacyConfig);
    }),
);

/**
 * GitHub's step of the graph: `github/layer.ts`'s service on the workspace
 * connection and the data keyring, offered as `GitHubSettings`,
 * `GitHubAdmin` and `LegacyGitHub`, with `GitHubClients` and `GitHubConfig`.
 */
export const githubLayers = {
    github: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const github = yield* makeGitHub(db, (yield* PlatformKeys).keys);
            return gitHubContext(github).pipe(Context.add(LegacyGitHub, github));
        }),
    ).pipe(Layer.provideMerge(GitHubConfigLive)),
};
