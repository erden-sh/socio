import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { CODING_RETENTION_DAYS, type CodingSandboxSettingsView } from '@socio/shared/coding/coding-sessions';

import {
    DEFAULT_CODING_REGISTRIES,
    parseCodingRegistries,
    registryAllowEntry,
} from '../../coding-egress/registries.js';
import type { ActorAuditShape } from '../actors/contract.js';

import { SandboxSettingRows } from './infra/rows.js';

/**
 * Settings → Coding → Sandboxes (CB-239): the package
 * registries a new sandbox may read, over `CODING_EGRESS_ALLOW` (npm and
 * PyPI by default), and how long an unused workspace volume is kept, over
 * `CODING_WORKSPACE_RETENTION_DAYS` (14). Read on every use, so a value
 * saved on one runtime holds on the other. Every change is a `setting` row
 * in `actor_audit`, in the same transaction, with the admin and the old
 * and new values.
 */

export class SandboxSettingsError extends Error {}

/** A list as the setting keeps it: `name=host` entries, one space apart. */
export const normalRegistries = (raw: string) => parseCodingRegistries(raw).map(registryAllowEntry).join(' ');

export class SandboxSettings {
    private rows: SandboxSettingRows;
    constructor(
        private db: DatabaseSync,
        private options: {
            audit: ActorAuditShape;
            /** The environment's values (`CODING_EGRESS_ALLOW`, `CODING_WORKSPACE_RETENTION_DAYS`). */
            defaults: () => { registries?: string; retentionDays: number };
            now?: () => number;
        },
    ) {
        this.rows = new SandboxSettingRows(db);
    }

    private defaults() {
        const env = this.options.defaults();
        let registries: string;
        try {
            registries = normalRegistries(env.registries?.trim() || DEFAULT_CODING_REGISTRIES);
        } catch {
            // A malformed variable keeps sandboxes to the built-in default
            // rather than to nothing; Settings shows which is in force.
            registries = normalRegistries(DEFAULT_CODING_REGISTRIES);
        }
        return { registries, retentionDays: env.retentionDays };
    }

    view(): CodingSandboxSettingsView {
        const defaults = this.defaults();
        const saved = this.rows.all();
        const days = Number(saved.retentionDays);
        const daysSaved =
            saved.retentionDays !== undefined &&
            Number.isInteger(days) &&
            days >= CODING_RETENTION_DAYS.min &&
            days <= CODING_RETENTION_DAYS.max;
        let registries = defaults.registries;
        let registriesSaved = false;
        if (saved.registries !== undefined) {
            try {
                registries = normalRegistries(saved.registries);
                registriesSaved = true;
            } catch {
                // A row no release can read falls back to the default.
            }
        }
        return {
            registries,
            registriesDefault: defaults.registries,
            registriesSaved,
            retentionDays: daysSaved ? days : defaults.retentionDays,
            retentionDaysDefault: defaults.retentionDays,
            retentionDaysSaved: daysSaved,
        };
    }

    /** The `allow` entries a new sandbox's proxy credential carries. */
    allowList(): string[] {
        return this.view().registries.split(' ').filter(Boolean);
    }

    retentionMs() {
        return this.view().retentionDays * 86_400_000;
    }

    /** Saves an admin's change; `null` goes back to the default. */
    async save(input: unknown, by: string): Promise<CodingSandboxSettingsView> {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            throw new SandboxSettingsError('Send the settings as JSON.');
        }
        const body = input as Record<string, unknown>;
        const unknown = Object.keys(body).find((key) => key !== 'registries' && key !== 'retentionDays');
        if (unknown) {
            throw new SandboxSettingsError(`Unknown setting: ${unknown.slice(0, 60)}.`);
        }
        const changes: Array<[string, string | null]> = [];
        if ('registries' in body) {
            const value = body.registries;
            if (value === null) {
                changes.push(['registries', null]);
            } else if (typeof value !== 'string' || value.length > 4000) {
                throw new SandboxSettingsError('Give the registries as name=host entries.');
            } else {
                let normal: string;
                try {
                    normal = normalRegistries(value);
                } catch (error) {
                    throw new SandboxSettingsError(
                        error instanceof Error
                            ? error.message.replace(/^CODING_EGRESS_ALLOW: /, '')
                            : 'Give the registries as name=host entries.',
                        { cause: error },
                    );
                }
                // An empty list would leave sandboxes no registry at all: say so
                // by choosing the default (null) instead.
                if (!normal) {
                    throw new SandboxSettingsError('List at least one registry, or go back to the default.');
                }
                changes.push(['registries', normal]);
            }
        }
        if ('retentionDays' in body) {
            const value = body.retentionDays;
            if (value === null) {
                changes.push(['retentionDays', null]);
            } else if (
                typeof value !== 'number' ||
                !Number.isInteger(value) ||
                value < CODING_RETENTION_DAYS.min ||
                value > CODING_RETENTION_DAYS.max
            ) {
                throw new SandboxSettingsError(
                    `Keep workspaces ${CODING_RETENTION_DAYS.min} to ${CODING_RETENTION_DAYS.max} days.`,
                );
            } else {
                changes.push(['retentionDays', String(value)]);
            }
        }
        const now = (this.options.now ?? Date.now)();
        await transaction(this.db, 'save coding sandbox settings', () => {
            const before = this.view();
            for (const [key, value] of changes) {
                this.rows.set(key, value, by, now);
            }
            const after = this.view();
            for (const key of ['registries', 'retentionDays'] as const) {
                if (before[key] !== after[key] || before[`${key}Saved`] !== after[`${key}Saved`]) {
                    this.options.audit.recordIn({
                        at: now,
                        correlationId: `setting-${now}`,
                        phase: 'setting',
                        actorBy: by,
                        action: `sandbox.${key}`,
                        resourceKind: 'coding',
                        resourceId: key,
                        detail: JSON.stringify({
                            old: before[`${key}Saved`] ? before[key] : null,
                            new: after[`${key}Saved`] ? after[key] : null,
                        }),
                    });
                }
            }
        });
        return this.view();
    }
}
