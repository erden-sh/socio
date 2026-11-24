/**
 * Operations settings in force (CB-164): an admin's saved values over the
 * environment's. Pure; moved from `src/server/operations/settings.ts`,
 * which re-exports it.
 */
import type { OperationsSettings, OperationsSettingsView } from '@socio/shared/operations/operations';
import { OPS_SESSION_GAP } from '@socio/shared/operations/operations-activity';
import { DEFAULT_TIME_ZONE } from '@socio/shared/time-zone';
import type { Settings } from '@socio/shared/types';

/** A session gap the dashboard accepts: whole minutes, a day at most. */
export const validSessionGap = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= OPS_SESSION_GAP.min &&
    value <= OPS_SESSION_GAP.max;

/** The settings in force, and the server's own. */
export function operationsSettingsView(
    settings: Pick<Settings, 'operations'>,
    env: OperationsSettings = {},
): OperationsSettingsView {
    const defaults = {
        timeZone: env.timeZone ?? DEFAULT_TIME_ZONE,
        sessionGapMinutes: env.sessionGapMinutes ?? OPS_SESSION_GAP.default,
    };
    const gap = settings.operations?.sessionGapMinutes;
    return {
        timeZone: settings.operations?.timeZone ?? defaults.timeZone,
        sessionGapMinutes: validSessionGap(gap) ? gap : defaults.sessionGapMinutes,
        defaults,
    };
}
