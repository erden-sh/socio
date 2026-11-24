/**
 * The feature flags' layer: one `FlagService` on the workspace connection,
 * offered as `Flags` (what other folders read) and `FlagAdmin` (what flags' own
 * routes and start use). It reads `FlagsConfig` and `FlagRoles`, which the
 * composition provides. Only the composition (`composition/flags.ts`) and tests
 * import this file.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { FlagAdmin, FlagRoles, Flags, FlagsConfig, type FlagRolesShape, type FlagsConfigShape } from './contract.js';
import { FlagService } from './service.js';

/**
 * The flags' service: rules, plans and choices on `db`, `FEATURE_FLAGS` and
 * the TENANT_ID from the config, and each person's role from `roles`.
 */
export function flagService(db: DatabaseSync, config: FlagsConfigShape, roles: FlagRolesShape): FlagService {
    return new FlagService(db, {
        env: config.env,
        internal: config.internal,
        tenantId: config.tenantId,
        role: (userId) => roles.role(userId),
    });
}

/** `flagService` over the `FlagsConfig` and `FlagRoles` tags. */
export const makeFlags = (db: DatabaseSync) =>
    Effect.gen(function* () {
        return flagService(db, yield* FlagsConfig, yield* FlagRoles);
    });

/** One service under both of its tags: the same instance. */
export const flagsContext = (flags: FlagService) => Context.make(Flags, flags).pipe(Context.add(FlagAdmin, flags));

/** `Flags` and `FlagAdmin`, built once over `db`; needs `FlagsConfig` and `FlagRoles`. */
export const FlagsLive = (db: DatabaseSync) => Layer.effectContext(Effect.map(makeFlags(db), flagsContext));
