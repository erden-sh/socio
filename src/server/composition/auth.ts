/**
 * Auth's construction: its config from the startup configuration, and its
 * layers (`auth/layer.ts`) over the setup the boot step built.
 *
 * Auth is not a step of the app's graph (`composition/index.ts`): the
 * provider is built and started before the stores open (`index.ts`:
 * `authFromEnv`, `startAuth`, `syncAccounts`), and `createApp` and the
 * pages take the setup itself. Until the root provides these layers, the
 * routes and boot steps (`composition/http/auth.ts`,
 * `composition/lifecycle/auth.ts`) call the same builders on that setup.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Effect, Layer } from 'effect';

import { CimdFetcher } from '../agents/cimd.js';
import type { CimdOptions } from '../agents/contract.js';
import { AgentGrants } from '../agents/grants.js';
import { agentOAuthOptions } from '../agents/oauth.js';
import type { AgentAuthorization } from '../auth/better-auth.js';
import { authSetupFromEnv, type AuthOptions } from '../auth/config.js';
import { AuthConfig, type AuthConfigShape, type AuthSetup } from '../auth/contract.js';
import { AuthServicesLive, CodeAccessLive } from '../auth/layer.js';
import { catalogsFromEnv, pluginOAuthScopes } from '../plugins/catalog.js';

import { LegacyConfig } from './base.js';
import type { PlatformConfig } from './config.js';

/**
 * Connected agents' side of Better Auth (CB-90), from agents/: the OAuth
 * provider's options over one client metadata fetcher (`cimd` replaces its
 * DNS and https in tests), and the grants in the auth database.
 */
export function agentAuthorization(cimd?: CimdOptions): AgentAuthorization {
    const fetcher = new CimdFetcher(cimd);
    return {
        oauthOptions: ({ origin, pluginScopes }) => agentOAuthOptions({ origin, fetcher, pluginScopes }),
        grants: (db) => new AgentGrants(db),
    };
}

/**
 * Auth from the environment (`authSetupFromEnv`), with what Better Auth
 * takes of other features: connected agents (`agentAuthorization`) and the
 * per-plugin scopes of the catalog the environment sets (CB-254). The
 * server's entry and the auth CLI call it before the stores open.
 */
export function authFromEnv(
    env: Record<string, string | undefined>,
    host: string,
    options: AuthOptions & {
        /** Replaces DNS and https for client metadata documents (tests). */
        cimd?: CimdOptions;
    } = {},
): ReturnType<typeof authSetupFromEnv> {
    const { cimd, ...rest } = options;
    return authSetupFromEnv(env, host, {
        ...rest,
        agents: agentAuthorization(cimd),
        pluginScopes: (vars) => pluginOAuthScopes(catalogsFromEnv(vars)),
    });
}

/**
 * What auth reads of the startup configuration (the `PlatformConfig` the
 * boot step built, not the environment again; the entry parses these settings
 * with composition's environment readers):
 * `codeUsers` (`CODE_USERS`, deprecated by CB-376: it only seeds the "Code" group).
 */
export function authConfigOf(config: Pick<PlatformConfig, 'codeUsers'>): AuthConfigShape {
    return { codeCeiling: config.codeUsers ?? [] };
}

/**
 * Auth's layers: `AuthConfig` over the supplied config (`LegacyConfig`),
 * and `Auth`, `RequestUsers`, `AccessPolicyReader` and `AuthViews` over the
 * boot step's setup and the workspace's connection (`RequestUsers` needs
 * the `People` slice).
 */
export const authLayers = {
    config: Layer.effect(
        AuthConfig,
        Effect.gen(function* () {
            return AuthConfig.of(authConfigOf(yield* LegacyConfig));
        }),
    ),
    services: (setup: AuthSetup, db: DatabaseSync) => AuthServicesLive(setup, db),
    /** Who may run code (CB-376): before the graph, for the gateways' step. */
    codeAccess: (setup: AuthSetup) => CodeAccessLive(setup),
};
