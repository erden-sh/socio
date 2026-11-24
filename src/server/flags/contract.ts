/**
 * What other features may know of the feature flags (CB-169, CB-182): their
 * tags, the slice of `FlagService` they call, and plain types. It imports
 * only `effect` and `@socio/*`, and holds no logic.
 *
 * Moved here (the re-exports at their old paths are gone):
 * - `FlagEnvDefaults` (was `env.ts`) and `FlagScope` (was
 *   `domain/repositories.ts` and `service.ts`).
 * - `FlagLayers` (was `evaluate.ts`), which `FlagAdmin` returns.
 *
 * Moved into a package: `requireFlag` and `FlagGate`, now only at
 * `@socio/foundation/flags/guard`. It takes anything with `enabled`, so
 * `Flags` below satisfies it.
 *
 * Not here, on purpose:
 * - `FlagService` itself: `layer.ts` builds it, once, and offers it as
 *   `Flags` (what other folders read) and `FlagAdmin` (what flags' own
 *   routes and start read and change).
 * - `flagDefaultsFromEnv` (`env.ts`): only the entry (`index.ts`) reads
 *   `FEATURE_FLAGS`; the composition hands the result in as `FlagsConfig.env`.
 * - `flagsModule`, `flagRoutes` and `flagsSchema`: the modules registry's.
 * - `FlagSubject`, `evaluateFlag` and `workspaceBlocked`: only flags and its
 *   tests use them.
 */
import { Context } from 'effect';

import type {
    ClientFlags,
    FlagDefinition,
    FlagEvaluation,
    FlagKey,
    FlagRule,
    FlagRuleInput,
    FlagTier,
} from '@socio/shared/flags';
import type { Role, User } from '@socio/shared/types';

// ── Plain types ──────────────────────────────────────────────────────────

/** `FEATURE_FLAGS`: this instance's default for some flags, under an operator's rule. */
export type FlagEnvDefaults = Record<string, boolean>;

/**
 * `SOCIO_DEPLOYMENT_KIND` (CB-503): `internal` for the team that builds
 * Socio, where `dev` flags may be listed and on; `customer` (the default)
 * never has a `dev` flag on.
 */
export type DeploymentKind = 'internal' | 'customer';

/** Where a rule applies: the whole instance (an operator's) or this workspace (an admin's). */
export type FlagScope = 'instance' | 'tenant';

/** Every layer that may decide a flag, from the most general. */
export interface FlagLayers {
    /** `FEATURE_FLAGS` on this instance. */
    env?: boolean;
    /** The operator's rule for the whole instance. */
    instance?: FlagRuleInput;
    /** The workspace's plan: true includes the flag (on), false leaves it out. */
    tier?: boolean;
    /** The workspace admins' rule. */
    workspace?: FlagRuleInput;
    // No person's layer (CB-503): nothing a person stores decides a flag.
}

// ── Flags ────────────────────────────────────────────────────────────────

/**
 * What other features read of the flags, evaluated per request for one
 * person, with the signatures `FlagService` has today (synchronous). Rules
 * and plans are edited only through flags' own routes.
 */
export interface FlagsShape {
    /** Whether a flag is on for this person: what routes and tools check. */
    enabled(key: FlagKey, userId: string): boolean;
    /** `WorkspaceState.flags`: what the client may show this person. */
    forUser(userId: string): ClientFlags;
    /** Socio tools this person can't have: those of every flag that is off for them. */
    toolsOff(userId: string): Set<string>;
}

export class Flags extends Context.Service<Flags, FlagsShape>()('socio/flags/Flags') {}

// ── FlagAdmin ────────────────────────────────────────────────────────────

/**
 * What flags' own routes (`/api/flags`) and start read and change: the
 * registry, each flag's layers and values, the rules and plans,
 * and the flags past their removal date. Only flags uses it; the same
 * `FlagService` as `Flags`, with the signatures it has today.
 */
export interface FlagAdminShape extends FlagsShape {
    /** The flags in code. */
    readonly registry: readonly FlagDefinition[];
    /** The workspace's TENANT_ID. */
    readonly tenantId: string;
    /** An internal deployment (CB-503): `dev` flags may be listed and on. */
    readonly internal: boolean;
    /**
     * A flag this deployment has: none for an unknown key, nor for a `dev`
     * flag in a customer deployment (its routes answer 404).
     */
    definition(key: string): FlagDefinition | undefined;
    /** `FEATURE_FLAGS` keys this deployment ignores: `dev` flags in a customer deployment. */
    ignoredEnv(): string[];
    /** The layers of one flag, for Settings: the same ones `evaluate` reads. */
    layers(key: string): FlagLayers;
    /** Every flag for one person, from one read of the rules. */
    evaluateAll(userId: string): Map<string, FlagEvaluation>;
    /** One flag for one person; an unknown key is off. */
    evaluate(key: string, userId: string): FlagEvaluation;
    /** The workspace's value when no role or person rule applies. */
    everyone(key: string): FlagEvaluation;
    /** The rule a scope has for a flag, if any. */
    rule(scope: FlagScope, key: string): FlagRule | undefined;
    setRule(scope: FlagScope, key: string, input: FlagRuleInput, by: string, now?: number): Promise<FlagRule>;
    /** Removes a scope's rule; true when there was one. */
    clearRule(scope: FlagScope, key: string): Promise<boolean>;
    tiers(): FlagTier[];
    tier(id: string): FlagTier | undefined;
    saveTier(
        tier: Pick<FlagTier, 'id' | 'name' | 'description' | 'flags'>,
        by: string,
        now?: number,
    ): Promise<FlagTier>;
    /** Deletes a plan no workspace is on. */
    deleteTier(id: string): Promise<'missing' | 'in-use' | 'deleted'>;
    /** The plan this workspace is on, if any. */
    tenantTier(): FlagTier | undefined;
    setTenantTier(tierId: string | null, by: string, now?: number): Promise<void>;
    /** Flags whose `removeBy` has passed: reported at start so they get removed. */
    overdue(today?: string): FlagDefinition[];
}

export class FlagAdmin extends Context.Service<FlagAdmin, FlagAdminShape>()('socio/flags/FlagAdmin') {}

// ── FlagsWorkspace ───────────────────────────────────────────────────────

/** A `workspace_audit` line the flag routes write: a flag's rule or a plan changed. */
export interface FlagAuditEntry {
    actor: string;
    action: 'update' | 'remove';
    targetKind: 'feature_flag' | 'flag_tier';
    targetId: string;
    detail?: string;
}

/**
 * The parts of the workspace the flag routes read (`flagRoutes`): its
 * people and its audit. The workspace's `People` and `Audit` (and
 * `WorkspaceStore`) satisfy it; flags sits below the workspace in the
 * folder order, so it names what it needs here.
 */
export interface FlagsWorkspaceShape {
    /** Everyone who has used the workspace, deactivated people included. */
    users(): User[];
    /** Who is deactivated. */
    deactivatedUsers(): Set<string>;
    /** Records one audit line. */
    audit(entry: FlagAuditEntry): void;
}

/** The workspace's people and audit as the flag routes read them; the composition builds it over `People` and `Audit`. */
export class FlagsWorkspace extends Context.Service<FlagsWorkspace, FlagsWorkspaceShape>()(
    'socio/flags/FlagsWorkspace',
) {}

// ── FlagRoles ────────────────────────────────────────────────────────────

/**
 * What flags needs of the people: a person's role now, for role rules; none
 * for someone deactivated or the workspace doesn't know. The composition
 * fills it from the workspace's `People`, so flags doesn't import them.
 */
export interface FlagRolesShape {
    role(userId: string): Role | undefined;
}

export class FlagRoles extends Context.Service<FlagRoles, FlagRolesShape>()('socio/flags/FlagRoles') {}

// ── FlagsConfig ──────────────────────────────────────────────────────────

/**
 * What flags reads of the platform's configuration: `FEATURE_FLAGS`
 * (`config.featureFlags`) and the workspace's TENANT_ID
 * (`config.storage?.tenantId ?? 'main'`).
 */
export interface FlagsConfigShape {
    /** `config.featureFlags ?? {}`. */
    readonly env: FlagEnvDefaults;
    /** `config.deploymentKind === 'internal'`: `dev` flags may be listed and on. */
    readonly internal: boolean;
    readonly tenantId: string;
}

export class FlagsConfig extends Context.Service<FlagsConfig, FlagsConfigShape>()('socio/flags/FlagsConfig') {}
