/**
 * The GitHub App's layer: one `GitHubAppSettings` on the workspace connection,
 * its key sealed under the data keyring, offered as `GitHubSettings` (what
 * other folders read) and `GitHubAdmin` (what github's own routes and connect
 * flow use), with `GitHubClients`. It reads `GitHubConfig`, which the
 * composition provides. Only the composition (`composition/github.ts`) and
 * tests import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { sqliteData } from '@socio/data/open';
import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';

import { gitHubClients } from './api.js';
import { GitHubAdmin, GitHubClients, GitHubConfig, GitHubSettings, type GitHubAppEnv } from './contract.js';
import { sqliteGitHubSettings } from './infra/store.js';
import { GitHubAppSettings } from './settings.js';

/**
 * The GitHub App's settings on a migrated connection, sealed under `keys`,
 * over the environment's App (`env`).
 */
export function gitHubAppSettings(db: DatabaseSync, keys: DataKeyring, env?: GitHubAppEnv): GitHubAppSettings {
    const data = sqliteData(db);
    return new GitHubAppSettings(
        data.uow,
        sqliteGitHubSettings(data),
        // The purpose keeps dispatch's name (CB-325): it derives the keys
        // existing seals were made with (secret-box.ts).
        new SecretBox(keys, 'dispatch-credentials'),
        env,
    );
}

/** `gitHubAppSettings` over the `GitHubConfig` tag. */
export const makeGitHub = (db: DatabaseSync, keys: DataKeyring) =>
    Effect.gen(function* () {
        return gitHubAppSettings(db, keys, (yield* GitHubConfig).env);
    });

/** One settings service under both of its tags (the same instance), with the clients. */
export const gitHubContext = (github: GitHubAppSettings) =>
    Context.make(GitHubSettings, github).pipe(
        Context.add(GitHubAdmin, github),
        Context.add(GitHubClients, gitHubClients),
    );

/**
 * `GitHubSettings`, `GitHubAdmin` and `GitHubClients`, built once over `db`
 * and `keys`; needs `GitHubConfig`.
 */
export const GitHubLive = (db: DatabaseSync, keys: DataKeyring) =>
    Layer.effectContext(Effect.map(makeGitHub(db, keys), gitHubContext));
