import { validSessionGap } from '@socio/foundation/operations/settings-view';
import type { OperationsSettings } from '@socio/shared/operations/operations';
import { OPS_SESSION_GAP } from '@socio/shared/operations/operations-activity';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { priceSyncFromEnv } from './pricing/sync.js';
import { resourceDefaultsFromEnv } from './retention.js';

/**
 * Operations settings (CB-164): the environment's starting values under
 * what an admin saved in Operations → Settings (`settings.operations`),
 * read on every request, so a change applies at once.
 */

/**
 * `OPS_TIME_ZONE`, `OPS_SESSION_GAP_MINUTES` and `OPS_PRICE_SYNC`, when
 * set; the server refuses to start with a bad one.
 */
export function operationsSettingsFromEnv(env: Record<string, string | undefined>): OperationsSettings {
    const settings: OperationsSettings = {};
    const resources = resourceDefaultsFromEnv(env);
    if (Object.keys(resources).length) {
        settings.resources = resources;
    }
    const sync = priceSyncFromEnv(env);
    if (sync || env.OPS_PRICE_SYNC?.trim()) {
        settings.pricing = { sync };
    }
    const raw = env.OPS_TIME_ZONE?.trim();
    if (raw) {
        const timeZone = ianaTimeZone(raw);
        if (!timeZone) {
            throw new Error('OPS_TIME_ZONE must be a time zone name, such as UTC or Europe/Madrid.');
        }
        settings.timeZone = timeZone;
    }
    const gap = env.OPS_SESSION_GAP_MINUTES?.trim();
    if (gap) {
        if (!validSessionGap(Number(gap))) {
            throw new Error(
                `OPS_SESSION_GAP_MINUTES must be a whole number of minutes from ${OPS_SESSION_GAP.min} to ${OPS_SESSION_GAP.max}.`,
            );
        }
        settings.sessionGapMinutes = Number(gap);
    }
    return settings;
}

/** The saved settings after a change: a value sets one, null goes back to the server's. */
export function savedOperationsSettings(
    saved: OperationsSettings | undefined,
    change: { timeZone?: string | null; sessionGapMinutes?: number | null },
): OperationsSettings {
    const next: OperationsSettings = { ...saved };
    if (change.timeZone === null) {
        delete next.timeZone;
    } else if (change.timeZone !== undefined) {
        next.timeZone = change.timeZone;
    }
    if (change.sessionGapMinutes === null) {
        delete next.sessionGapMinutes;
    } else if (change.sessionGapMinutes !== undefined) {
        next.sessionGapMinutes = change.sessionGapMinutes;
    }
    return next;
}
