/**
 * What other features may know of service accounts (CB-57): the accounts
 * nobody signs in as and their API keys. Its tag, as a slice of the
 * methods callers use, the error its routes answer with, and the key
 * prefix other folders recognize. It imports only `effect` and
 * `@socio/*`, and holds no logic.
 *
 * `layer.ts` implements `Accounts`.
 *
 * Not here, on purpose:
 * - The `ServiceAccounts` class and its constructor: construction only
 *   (`layer.ts`, `composition/service-accounts.ts`, and `auth/cli.ts`, an
 *   entry file).
 * - `scopeAllows` and `requestIp`: only the HTTP edge
 *   (`composition/http/service-accounts.ts`, entry code) calls them, so
 *   no package and no tag method.
 * - The admin routes' methods (`list`, `get`, `create`, `update`,
 *   `disable`, `createKey`, `revokeKey`, `ids`): nothing outside this
 *   folder calls them.
 * - The repositories (`domain/repositories.ts`): only this folder's infra
 *   and its tests use them.
 * - A `ServiceAccountsConfig` tag: service accounts read no
 *   `PlatformConfig` field.
 * - A `ServiceAccountsViews` tag: `live/` has no view of service accounts.
 */
import { Context, Data } from 'effect';

import type { ServiceKeyScope } from '@socio/foundation/http/app-env';
import type { PersonKey } from '@socio/shared/people';
import type { KeyMadeBy } from '@socio/shared/service-accounts';
import type { User } from '@socio/shared/types';

/** What every service key starts with (`cbk_` and 32 random bytes). */
export const SERVICE_KEY_PREFIX = 'cbk_';

/**
 * A refused admin change of an account or key, with its HTTP status. Only
 * this folder's routes catch it, answering its message with its status.
 */
export class ServiceAccountError extends Data.TaggedError('ServiceAccountError')<{
    readonly message: string;
    readonly status: 400 | 404 | 409;
}> {}

/** The account and key behind a live bearer token. */
export interface ResolvedServiceKey {
    user: User;
    key: ServiceKeyScope;
}

/**
 * Service accounts as other features use them: who is one (rooms' and
 * the MCP server's people lists leave them out), a deactivation revoking
 * the keys a person made (auth), and the HTTP edge resolving and counting
 * a key. `service-accounts.ts`'s `ServiceAccounts` implements it.
 */
export interface ServiceAccountsShape {
    isService(userId: string): boolean;
    /**
     * Revokes every live key this person made (they saw its secret once);
     * returns what was revoked.
     */
    revokeKeysMadeBy(createdBy: string, now?: number): { name: string; account: string }[];
    /** What `revokeKeysMadeBy` would revoke now, changing nothing (CB-360). */
    keysMadeBy(createdBy: string, now?: number): KeyMadeBy[];
    /** Every key this person made, revoked and expired ones too, newest first (CB-360's person page). */
    keysCreatedBy(createdBy: string): PersonKey[];
    /**
     * The account and key behind a bearer token: live (not revoked,
     * expired or disabled) or undefined. Records the use, at most once a
     * minute.
     */
    resolve(token: string, ip?: string, now?: number): ResolvedServiceKey | undefined;
    /** Counts one request of a key; false once over its per-minute limit. */
    take(keyId: string, now?: number): boolean;
}

export class Accounts extends Context.Service<Accounts, ServiceAccountsShape>()('socio/service-accounts/Accounts') {}
