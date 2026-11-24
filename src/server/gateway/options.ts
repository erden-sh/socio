import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import type { CodingOptionsView } from '@socio/shared/coding/coding-gateway';

import type { ActorAuditShape } from '../actors/contract.js';
import type { GatewayOptionsShape } from '../coding/contract.js';

import { OptionRows } from './infra/g5-rows.js';

/**
 * Settings → Coding's switches over an environment default (CB-239),
 * kept in `gateway_options` (a missing row is the default) and read on
 * every use, so a value one runtime saves holds on the other. Today one:
 * `personalPlans`, whether people may run their own coding sessions on
 * their own plan (a ChatGPT plan they connected under Account →
 * Inference). Off unless `CODING_PERSONAL_PLANS` or an admin turns it on.
 * Every change is a `setting` row in `actor_audit` in the same
 * transaction, with the admin and the old and new values.
 */

export class GatewayOptionsError extends Error {}

/** `CODING_PERSONAL_PLANS`: on, off (the default), or a mistake. */
export function personalPlansDefault(env: Record<string, string | undefined>): boolean {
    const raw = env.CODING_PERSONAL_PLANS?.trim().toLowerCase();
    if (!raw || ['off', 'false', '0', 'no'].includes(raw)) {
        return false;
    }
    if (['on', 'true', '1', 'yes'].includes(raw)) {
        return true;
    }
    throw new Error('CODING_PERSONAL_PLANS must be on or off.');
}

export class GatewayOptions implements GatewayOptionsShape {
    private rows: OptionRows;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: {
            audit: ActorAuditShape;
            /** The environment's values, read when asked. */
            defaults: () => { personalPlans: boolean };
            now?: () => number;
        },
    ) {
        this.rows = new OptionRows(db);
        this.now = options.now ?? Date.now;
    }

    view(): CodingOptionsView {
        const fallback = this.options.defaults().personalPlans;
        const saved = this.rows.get('personalPlans');
        const known = saved === 'on' || saved === 'off';
        return {
            personalPlans: known ? saved === 'on' : fallback,
            personalPlansDefault: fallback,
            personalPlansSaved: known,
        };
    }

    /** Whether people may run their own sessions on their own plan now. */
    personalPlans(): boolean {
        return this.view().personalPlans;
    }

    /** An admin's change; `null` goes back to the default. */
    async save(input: unknown, by: string): Promise<CodingOptionsView> {
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            throw new GatewayOptionsError('Send the settings as JSON.');
        }
        const body = input as Record<string, unknown>;
        const unknown = Object.keys(body).find((key) => key !== 'personalPlans');
        if (unknown) {
            throw new GatewayOptionsError(`Unknown setting: ${unknown.slice(0, 60)}.`);
        }
        if (!('personalPlans' in body)) {
            return this.view();
        }
        const value = body.personalPlans;
        if (value !== null && typeof value !== 'boolean') {
            throw new GatewayOptionsError('personalPlans is true, false or null.');
        }
        const at = this.now();
        await transaction(this.db, 'save coding options', () => {
            const before = this.view();
            this.rows.set('personalPlans', value === null ? null : value ? 'on' : 'off', by, at);
            const after = this.view();
            if (
                before.personalPlans !== after.personalPlans ||
                before.personalPlansSaved !== after.personalPlansSaved
            ) {
                this.options.audit.recordIn({
                    at,
                    correlationId: `setting-${at}`,
                    phase: 'setting',
                    actorBy: by,
                    action: 'coding.personalPlans',
                    resourceKind: 'coding',
                    resourceId: 'personalPlans',
                    detail: JSON.stringify({
                        old: before.personalPlansSaved ? before.personalPlans : null,
                        new: after.personalPlansSaved ? after.personalPlans : null,
                        inForce: after.personalPlans,
                    }),
                });
            }
        });
        return this.view();
    }
}
