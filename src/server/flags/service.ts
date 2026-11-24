import type { DatabaseSync } from 'node:sqlite';

import type { SchemaSet } from '@socio/data/migrate';
import { sqliteData } from '@socio/data/open';
import type { UnitOfWork } from '@socio/data/uow';
import {
    FLAGS,
    type ClientFlags,
    type FlagDefinition,
    type FlagEvaluation,
    type FlagKey,
    type FlagRule,
    type FlagRuleInput,
    type FlagTier,
} from '@socio/shared/flags';
import { MODULE_IDS } from '@socio/shared/modules';
import { ROLES } from '@socio/shared/roles';
import type { Role } from '@socio/shared/types';

import type { FlagAdminShape, FlagEnvDefaults, FlagLayers, FlagScope } from './contract.js';
import type { FlagRepositories } from './domain/repositories.js';
import { available, evaluateFlag, type FlagSubject } from './evaluate.js';
import { sqliteFlagRepositories } from './infra/sqlite/index.js';

/**
 * Feature flags' tables (CB-169, CB-182), only this module reads or
 * writes them:
 *
 * - `flag_rules`: an operator's rule for the whole instance (`instance`,
 *   scopeId '') or an admin's for one workspace (`tenant`, its TENANT_ID).
 *   No row: the layer below decides. Clearing a rule deletes its row; the
 *   workspace audit keeps what it was.
 * - `flag_choices`: retired (CB-503). People once opted into early access
 *   here; version 2 deleted every row, a trigger deletes any row an older
 *   release still writes, and nothing reads it. A later contract migration
 *   drops it.
 * - `flag_rules.optIn`: retired with it. Version 2 set it to 0 on every
 *   rule and triggers keep it 0; nothing reads it.
 * - `flag_tiers` and `flag_tenant_tiers`: plans an operator defines, each
 *   including or leaving out flags, and the plan each workspace is on.
 */
export const flagsSchema: SchemaSet = {
    id: MODULE_IDS.flags,
    migrations: [
        {
            version: 1,
            name: 'flag rules, choices and tiers',
            up: `CREATE TABLE flag_rules (
        scope TEXT NOT NULL CHECK (scope IN ('instance', 'tenant')),
        scopeId TEXT NOT NULL,
        flag TEXT NOT NULL CHECK (length(flag) BETWEEN 1 AND 48),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        roles TEXT NOT NULL DEFAULT '[]',
        people TEXT NOT NULL DEFAULT '[]',
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        optIn INTEGER NOT NULL DEFAULT 0 CHECK (optIn IN (0, 1)),
        updatedBy TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (scope, scopeId, flag)
      );
      CREATE TABLE flag_choices (
        userId TEXT NOT NULL,
        flag TEXT NOT NULL CHECK (length(flag) BETWEEN 1 AND 48),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, flag)
      );
      CREATE TABLE flag_tiers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
        description TEXT NOT NULL DEFAULT '',
        flags TEXT NOT NULL DEFAULT '{}',
        createdAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE TABLE flag_tenant_tiers (
        tenantId TEXT PRIMARY KEY,
        tierId TEXT NOT NULL REFERENCES flag_tiers(id),
        updatedBy TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );`,
        },
        {
            // CB-503: people no longer opt into early access. Expand under a
            // start-first deploy: the previous release keeps running on this
            // schema and still reads `optIn` and `flag_choices`, so both stay
            // (a later contract migration drops them). Clearing every
            // `optIn` and keeping it clear stops that release from honoring a
            // choice too: it reads one only where the nearest rule has
            // `optIn` = 1, and refuses to store one otherwise.
            version: 2,
            name: 'retire personal early-access choices',
            phase: 'expand',
            compatible:
                'Deletes flag_choices rows only, now and as the previous release writes them. That release runs on the result unchanged: it reads a choice only where the nearest rule has optIn = 1, which this migration clears and its triggers keep at 0 (no RAISE: its writes still succeed), so the rows could have no effect on it either.',
            up: `UPDATE flag_rules SET optIn = 0 WHERE optIn <> 0;
      DELETE FROM flag_choices;
      CREATE TRIGGER flag_rules_opt_in_retired_insert AFTER INSERT ON flag_rules WHEN NEW.optIn <> 0
      BEGIN
        UPDATE flag_rules SET optIn = 0 WHERE scope = NEW.scope AND scopeId = NEW.scopeId AND flag = NEW.flag;
      END;
      CREATE TRIGGER flag_rules_opt_in_retired_update AFTER UPDATE OF optIn ON flag_rules WHEN NEW.optIn <> 0
      BEGIN
        UPDATE flag_rules SET optIn = 0 WHERE scope = NEW.scope AND scopeId = NEW.scopeId AND flag = NEW.flag;
      END;
      CREATE TRIGGER flag_choices_retired_insert AFTER INSERT ON flag_choices
      BEGIN
        DELETE FROM flag_choices WHERE userId = NEW.userId AND flag = NEW.flag;
      END;`,
        },
    ],
};

export interface FlagServiceOptions {
    /** The flags in code; tests pass their own. */
    registry?: readonly FlagDefinition[];
    /** `FEATURE_FLAGS` (`flagDefaultsFromEnv`). */
    env?: FlagEnvDefaults;
    /** `SOCIO_DEPLOYMENT_KIND=internal` (CB-503); a customer deployment when false or unset. */
    internal?: boolean;
    /** The workspace's TENANT_ID: one workspace per instance today. */
    tenantId: string;
    /** A person's role now; undefined for someone the workspace doesn't know. */
    role: (userId: string) => Role | undefined;
}

/** Every rule and plan, read at once. */
interface Snapshot {
    instance: Map<string, FlagRule>;
    workspace: Map<string, FlagRule>;
    tier: Record<string, boolean> | undefined;
}

type RuleRow = {
    flag: string;
    enabled: number;
    roles: string;
    people: string;
    locked: number;
    updatedBy: string;
    updatedAt: number;
};

const list = (text: string): unknown[] => {
    try {
        const value = JSON.parse(text) as unknown;
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
};
const ruleOf = (row: RuleRow): FlagRule => ({
    enabled: row.enabled === 1,
    roles: list(row.roles).filter((role): role is Role => (ROLES as readonly unknown[]).includes(role)),
    people: list(row.people).filter((id): id is string => typeof id === 'string'),
    ...(row.locked ? { locked: true } : {}),
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
});
const tierFlags = (text: string): Record<string, boolean> => {
    try {
        const value = JSON.parse(text) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        return Object.fromEntries(
            Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
        );
    } catch {
        return {};
    }
};

/**
 * Evaluates flags on the server, per request, for one person (CB-169):
 * the code's default, `FEATURE_FLAGS`, an operator's instance rule, the
 * workspace's plan (CB-182) and an admin's workspace rule
 * (`evaluateFlag`); nothing a person stores (CB-503). Nothing is cached
 * between requests, so a change applies to the next request and the next
 * turn.
 */
export class FlagService implements FlagAdminShape {
    readonly registry: readonly FlagDefinition[];
    readonly tenantId: string;
    readonly env: FlagEnvDefaults;
    readonly internal: boolean;
    private readonly role: (userId: string) => Role | undefined;
    /** Its writes (CB-110); the per-request reads stay here. */
    private readonly repos: FlagRepositories;
    private readonly uow: UnitOfWork;

    constructor(
        private readonly db: DatabaseSync,
        options: FlagServiceOptions,
    ) {
        const data = sqliteData(db);
        this.repos = sqliteFlagRepositories(data);
        this.uow = data.uow;
        this.registry = options.registry ?? FLAGS;
        this.tenantId = options.tenantId;
        this.env = options.env ?? {};
        this.internal = options.internal === true;
        this.role = options.role;
    }

    /** A flag this deployment has: no `dev` flag in a customer deployment (CB-503). */
    definition(key: string) {
        return this.registry.find((flag) => flag.key === key && available(flag, this.internal));
    }

    /** `FEATURE_FLAGS` keys this deployment ignores: `dev` flags in a customer deployment. */
    ignoredEnv() {
        return Object.keys(this.env).filter((key) => {
            const flag = this.registry.find((item) => item.key === key);
            return !!flag && !available(flag, this.internal);
        });
    }

    /** A scope's `scopeId`: '' for the instance, else this workspace's. */
    private scopeId(scope: FlagScope) {
        return scope === 'instance' ? '' : this.tenantId;
    }

    private rules(scope: FlagScope) {
        const rows = this.db
            .prepare(
                'SELECT flag, enabled, roles, people, locked, updatedBy, updatedAt FROM flag_rules WHERE scope=? AND scopeId=?',
            )
            .all(scope, this.scopeId(scope)) as RuleRow[];
        return new Map(rows.map((row) => [row.flag, ruleOf(row)]));
    }

    private snapshot(): Snapshot {
        return {
            instance: this.rules('instance'),
            workspace: this.rules('tenant'),
            tier: this.tenantTier()?.flags,
        };
    }

    private layersOf(key: string, snapshot: Snapshot): FlagLayers {
        return {
            env: this.env[key],
            instance: snapshot.instance.get(key),
            tier: snapshot.tier?.[key],
            workspace: snapshot.workspace.get(key),
        };
    }

    /** The layers of one flag, for Settings: the same ones `evaluate` reads. */
    layers(key: string): FlagLayers {
        return this.layersOf(key, this.snapshot());
    }

    private subject(userId: string): FlagSubject {
        const role = this.role(userId);
        return role ? { userId, role } : { userId };
    }

    /** Every flag for one person, from one read of the rules. */
    evaluateAll(userId: string): Map<string, FlagEvaluation> {
        const snapshot = this.snapshot();
        const subject = this.subject(userId);
        return new Map(
            this.registry.map((flag) => [
                flag.key,
                evaluateFlag(flag, this.layersOf(flag.key, snapshot), subject, this.internal),
            ]),
        );
    }

    /** One flag for one person; an unknown key is off. */
    evaluate(key: string, userId: string): FlagEvaluation {
        const flag = this.definition(key);
        if (!flag) {
            return { enabled: false, source: 'default' };
        }
        return evaluateFlag(flag, this.layersOf(key, this.snapshot()), this.subject(userId), this.internal);
    }

    /** Whether a flag is on for this person: what routes and tools check. */
    enabled(key: FlagKey, userId: string): boolean {
        return this.evaluate(key, userId).enabled;
    }

    /** The workspace's value when no role or person rule applies. */
    everyone(key: string): FlagEvaluation {
        const flag = this.definition(key);
        if (!flag) {
            return { enabled: false, source: 'default' };
        }
        // No person: no role or person rule matches.
        return evaluateFlag(flag, this.layersOf(key, this.snapshot()), { userId: '' }, this.internal);
    }

    /** `WorkspaceState.flags`: what the client may show this person. */
    forUser(userId: string): ClientFlags {
        const on: string[] = [];
        for (const [key, value] of this.evaluateAll(userId)) {
            if (value.enabled) {
                on.push(key);
            }
        }
        return this.internal ? { on, internal: true } : { on };
    }

    /**
     * Socio tools this person can't have: those of every flag that is off
     * for them (`FlagDefinition.tools`). It walks the whole registry, `dev`
     * flags of a customer deployment included, so their tools are off.
     */
    toolsOff(userId: string): Set<string> {
        const off = new Set<string>();
        const values = this.evaluateAll(userId);
        for (const flag of this.registry) {
            if (flag.tools && !values.get(flag.key)?.enabled) {
                for (const tool of flag.tools) {
                    off.add(tool);
                }
            }
        }
        return off;
    }

    /** The rule a scope has for a flag, if any. */
    rule(scope: FlagScope, key: string): FlagRule | undefined {
        return this.rules(scope).get(key);
    }

    async setRule(scope: FlagScope, key: string, input: FlagRuleInput, by: string, now = Date.now()) {
        await this.repos.rules.save({
            scope,
            scopeId: this.scopeId(scope),
            flag: key,
            enabled: input.enabled,
            roles: [...new Set(input.roles)],
            people: [...new Set(input.people)],
            locked: scope === 'instance' && !!input.locked,
            updatedBy: by,
            updatedAt: now,
        });
        return this.rule(scope, key)!;
    }

    /** Removes a scope's rule; true when there was one. */
    async clearRule(scope: FlagScope, key: string) {
        return this.repos.rules.clear(scope, this.scopeId(scope), key);
    }

    tiers(): FlagTier[] {
        return (
            this.db
                .prepare(
                    'SELECT id, name, description, flags, updatedBy, updatedAt FROM flag_tiers ORDER BY createdAt, id',
                )
                .all() as Array<Omit<FlagTier, 'flags'> & { flags: string }>
        ).map((row) => ({ ...row, flags: tierFlags(row.flags) }));
    }

    tier(id: string) {
        return this.tiers().find((tier) => tier.id === id);
    }

    async saveTier(tier: Pick<FlagTier, 'id' | 'name' | 'description' | 'flags'>, by: string, now = Date.now()) {
        await this.repos.tiers.save(tier, by, now);
        return this.tier(tier.id)!;
    }

    /** Deletes a plan no workspace is on: 'missing', 'in-use' or 'deleted'. */
    async deleteTier(id: string) {
        const { tiers } = this.repos;
        return this.uow.run(
            async () => {
                if (!(await tiers.exists(id))) {
                    return 'missing' as const;
                }
                if (await tiers.inUse(id)) {
                    return 'in-use' as const;
                }
                await tiers.remove(id);
                return 'deleted' as const;
            },
            { label: 'delete flag tier' },
        );
    }

    /** The plan this workspace is on, if any. */
    tenantTier(): FlagTier | undefined {
        const row = this.db.prepare('SELECT tierId FROM flag_tenant_tiers WHERE tenantId=?').get(this.tenantId) as
            | { tierId: string }
            | undefined;
        return row ? this.tier(row.tierId) : undefined;
    }

    async setTenantTier(tierId: string | null, by: string, now = Date.now()) {
        if (tierId === null) {
            await this.repos.tiers.unassign(this.tenantId);
        } else {
            await this.repos.tiers.assign(this.tenantId, tierId, by, now);
        }
    }

    /** Flags whose `removeBy` has passed: reported at start so they get removed. */
    overdue(today = new Date().toISOString().slice(0, 10)) {
        return this.registry.filter((flag) => flag.removeBy < today);
    }
}
