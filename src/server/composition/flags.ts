/**
 * The feature flags' construction: `flags/layer.ts` builds the service and
 * offers it as `Flags` and `FlagAdmin`; this file builds `FlagsConfig` and
 * `FlagRoles` (from `People`) and adds the tag the other steps read it from.
 */
import { Context, Effect, Layer } from 'effect';

import {
    FlagRoles,
    FlagsConfig,
    FlagsWorkspace,
    type FlagRolesShape,
    type FlagsConfigShape,
    type FlagsWorkspaceShape,
} from '../flags/contract.js';
import { flagsContext, makeFlags } from '../flags/layer.js';
import type { FlagService } from '../flags/service.js';
import { Audit, People, type AuditShape, type PeopleShape } from '../workspace/contract.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';

/**
 * What flags reads of the configuration: `SOCIO_DEPLOYMENT_KIND` and
 * `FEATURE_FLAGS`, which the entry
 * parses once (`flagDefaultsFromEnv` in `index.ts`, where tests pass their
 * own), and the workspace's TENANT_ID.
 */
export const flagsConfig = (config: PlatformConfig): FlagsConfigShape => ({
    env: config.featureFlags ?? {},
    internal: config.deploymentKind === 'internal',
    tenantId: config.storage?.tenantId ?? 'main',
});

/** A person's role now, from the people: none for someone deactivated or unknown. */
export const flagRoles = (people: Pick<PeopleShape, 'users' | 'isDeactivated'>): FlagRolesShape => ({
    role: (userId) =>
        people.isDeactivated(userId) ? undefined : people.users().find((user) => user.id === userId)?.role,
});

/** Feature flags (CB-169, CB-182), evaluated per request for one person. */
/** What the flag routes read of the workspace (`FlagsWorkspace`): its people and its audit. */
export const flagsWorkspace = (
    people: Pick<PeopleShape, 'users' | 'deactivatedUsers'>,
    audit: AuditShape,
): FlagsWorkspaceShape => ({
    users: () => people.users(),
    deactivatedUsers: () => people.deactivatedUsers(),
    audit: (entry) => audit.audit(entry),
});

/** Feature flags, under the graph's `LegacyFlags` tag (the class). */
export class LegacyFlags extends Context.Service<LegacyFlags, FlagService>()('socio/composition/flags/FlagService') {}

/** `FlagsConfig`, from the process's config. */
const FlagsConfigLive = Layer.effect(
    FlagsConfig,
    Effect.gen(function* () {
        return flagsConfig(yield* LegacyConfig);
    }),
);

/** `FlagRoles`, over the workspace's `People`. */
/** `FlagsWorkspace`, over the workspace's `People` and `Audit`: builds nothing, starts nothing. */
const FlagsWorkspaceLive = Layer.effect(
    FlagsWorkspace,
    Effect.gen(function* () {
        return flagsWorkspace(yield* People, yield* Audit);
    }),
);

const FlagRolesLive = Layer.effect(
    FlagRoles,
    Effect.gen(function* () {
        return flagRoles(yield* People);
    }),
);

/**
 * The flags' step of the graph: `flags/layer.ts`'s service on the workspace
 * connection, offered as `Flags`, `FlagAdmin` and `LegacyFlags`, with
 * `FlagsConfig`.
 */
export const flagsLayers = {
    flags: Layer.effectContext(
        Effect.gen(function* () {
            const { db } = yield* LegacyWorkspace;
            const flags = yield* makeFlags(db);
            return flagsContext(flags).pipe(Context.add(LegacyFlags, flags));
        }),
    ).pipe(Layer.provide(FlagRolesLive), Layer.provideMerge(FlagsConfigLive), Layer.provideMerge(FlagsWorkspaceLive)),
};
