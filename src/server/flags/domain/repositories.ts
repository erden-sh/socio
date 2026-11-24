import type { Role } from '@socio/shared/types';

import type { FlagScope } from '../contract.js';

/**
 * Feature flags' repositories (CB-110): one per aggregate,
 * taking and returning plain domain types; only `flags/infra` implements
 * them. Each write works inside or outside a unit of work: outside one it
 * opens its own. Reads that evaluate flags per request stay with the
 * service.
 */

/** A scope's rule for one flag, as stored (`flag_rules`). */
export interface StoredFlagRule {
    scope: FlagScope;
    /** '' for the instance; the workspace's TENANT_ID for a tenant rule. */
    scopeId: string;
    flag: string;
    enabled: boolean;
    roles: Role[];
    people: string[];
    locked: boolean;
    updatedBy: string;
    updatedAt: number;
}

export interface FlagRuleRepository {
    /** Sets a scope's rule for a flag, replacing the one there. */
    save(rule: StoredFlagRule): Promise<void>;
    /** Removes a scope's rule for a flag; whether there was one. */
    clear(scope: FlagScope, scopeId: string, flag: string): Promise<boolean>;
}

/** A plan an operator defines (`flag_tiers`). */
export interface StoredFlagTier {
    id: string;
    name: string;
    description: string;
    flags: Record<string, boolean>;
}

/** Plans, and the plan each workspace is on (`flag_tenant_tiers`). */
export interface FlagTierRepository {
    /** Adds a plan, or changes one; a changed plan keeps its creation time. */
    save(tier: StoredFlagTier, by: string, at: number): Promise<void>;
    exists(id: string): Promise<boolean>;
    /** Whether a workspace is on the plan. */
    inUse(id: string): Promise<boolean>;
    remove(id: string): Promise<void>;
    /** Puts a workspace on a plan, replacing the one it was on. */
    assign(tenantId: string, tierId: string, by: string, at: number): Promise<void>;
    /** Takes a workspace off its plan. */
    unassign(tenantId: string): Promise<void>;
}

export interface FlagRepositories {
    rules: FlagRuleRepository;
    tiers: FlagTierRepository;
}
