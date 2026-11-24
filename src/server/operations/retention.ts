import type { OperationsSettings } from '@socio/shared/operations/operations';
import {
    OPS_RETENTION,
    RESOURCE_DEFAULTS,
    type ResourcePolicy,
    type ResourcePolicyView,
} from '@socio/shared/operations/operations-resources';

import type { WorkspaceSettingsShape } from '../settings/contract.js';

import type { ResourcesShape } from './contract.js';

export const validRetentionDays = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36500;
export const validSampleInterval = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 60 && value <= 3600 && value % 60 === 0;

/** Environment defaults are validated at boot, before a collector starts. */
export function resourceDefaultsFromEnv(env: Record<string, string | undefined>): Partial<ResourcePolicy> {
    const out: Partial<ResourcePolicy> = {};
    for (const [key, spec] of Object.entries(OPS_RETENTION)) {
        const raw = env[spec.env]?.trim();
        if (!raw) {
            continue;
        }
        const value = Number(raw);
        if (!validRetentionDays(value)) {
            throw new Error(`${spec.env} must be a whole number of days from 0 to 36500; 0 keeps history.`);
        }
        out[key as keyof ResourcePolicy] = value;
    }
    const interval = env.OPS_SAMPLE_EVERY_SECONDS?.trim();
    if (interval) {
        if (!validSampleInterval(Number(interval))) {
            throw new Error('OPS_SAMPLE_EVERY_SECONDS must be 60 to 3600 seconds, in whole minutes.');
        }
        out.sampleEverySeconds = Number(interval);
    }
    return out;
}

export function resourcePolicyView(
    saved?: OperationsSettings,
    defaults: Partial<ResourcePolicy> = {},
): ResourcePolicyView {
    const base = { ...RESOURCE_DEFAULTS, ...defaults };
    const policy = { ...base };
    for (const key of Object.keys(policy) as Array<keyof ResourcePolicy>) {
        const value = key === 'factDays' || key === 'hourlyDays' ? saved?.analytics?.[key] : saved?.resources?.[key];
        if ((key === 'sampleEverySeconds' ? validSampleInterval : validRetentionDays)(value)) {
            policy[key] = value!;
        }
    }
    return { policy, defaults: base };
}

/**
 * The resource policy in force (`Resources`), over the workspace settings
 * and the environment's defaults (`OPS_*`): read from a settings snapshot
 * on every call, so a saved value applies at once.
 */
export function resourcesOver(
    settings: Pick<WorkspaceSettingsShape, 'settingsSnapshot'>,
    env?: OperationsSettings,
): ResourcesShape {
    return { policy: () => resourcePolicyView(settings.settingsSnapshot().operations, env?.resources).policy };
}
