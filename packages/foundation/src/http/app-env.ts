import type { Context } from 'hono';

import type { DataApiScope } from '@socio/shared/dataspace/api-tokens';
import type { ServiceScope } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

/** What a data token may do: act as one Dot for one user, within its grants. */
export interface DataTokenScope {
    userId: string;
    dotId: string;
    /**
     * `computer`: a computer session; `job`: one job run; `app`: a mini
     * app; `plugin`: a service plugin's own work on the datasets it
     * declares (`userId` is its owner id `plugin:<id>`, `dotId` is empty);
     * `api`: an admin's data API token (`userId` is the workspace owner
     * `ws:workspace`, `dotId` is empty): the company's datasets no plugin
     * is bound to, within its `scopes`.
     */
    purpose: 'computer' | 'job' | 'app' | 'plugin' | 'api';
    /**
     * Narrows the Dot's grants to these dataset ids (`scratch` for its
     * scratch dataset); every grant of the Dot when unset. Grants are checked
     * on each request, so a revoked grant stops the token at once.
     */
    datasetIds?: readonly string[];
    /** Identifies the session or run the token belongs to, for revocation. */
    session: string;
    /**
     * `socio`: a command on a company socio's computer (CB-224), which
     * everyone who uses that socio shares. It reaches the socio's shared
     * area (a dataset and a folder owned by no person) and, to read, the
     * granted datasets shared with a Space; never the user's own scratch
     * dataset, folder or private datasets. Checked on each request.
     */
    reach?: 'socio';
    /**
     * A promoted mini app's token: it sees the datasets granted to that
     * app (`app_grants`), not the Dot's scratch dataset, grants or folders.
     */
    appId?: string;
    /**
     * A plugin's token (`purpose: 'plugin'`): the plugin, and the identity
     * version it was exchanged for. Each request checks the plugin is still
     * installed and enabled and that version still accepted.
     */
    pluginId?: string;
    identityVersion?: number;
    /**
     * A data API token's (`purpose: 'api'`): its id (its writes are
     * `token:<id>`), the admin who made it, its scopes and its budget.
     * Read from its row on every request, so a revoke holds at once.
     */
    apiToken?: {
        id: string;
        createdBy: string;
        scopes: readonly DataApiScope[];
        statementsPerMinute: number;
    };
    expiresAt: number;
}

/** A request's service key, once resolved (`AppEnv.serviceKey`). */
export interface ServiceKeyScope {
    keyId: string;
    name: string;
    scopes: ServiceScope[];
}

/**
 * Hono environment for API routes: every handler after the auth check has a
 * user, except `/api/data/*` requests made with a scoped data token
 * (computers, jobs), which carry `dataToken` instead and no user. Requests
 * with a service account's API key carry `serviceKey` and its account as
 * the user.
 */
export type AppEnv = {
    Variables: {
        user: User;
        dataToken?: DataTokenScope;
        serviceKey?: ServiceKeyScope;
        /** A rendered page's CSP nonce (web/guard.ts). */
        cspNonce?: string;
        /** Set on a plugin embed document: the one origin its iframe may load. */
        frameSrc?: string;
        /** A plugin service calling its own data routes. */
        /** `identity`: the plugin's own identity token (Socio Secrets phase 2), not the shared token. */
        /** `identityVersion`: which version of it (phase 4 notes a stale one in the audit). */
        pluginService?: { pluginId: string; identity?: true; identityVersion?: number };
    };
};

/** A request's Hono context under `AppEnv`, for types that can't name Hono themselves (a feature's `contract.ts`). */
export type AppContext = Context<AppEnv>;
