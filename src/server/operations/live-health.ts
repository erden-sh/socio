import type { DeploymentHealth } from '@socio/shared/deployment-resources';
import {
    ANALYTICS_DEFAULTS,
    analyticsDefaults,
    analyticsInForce,
    type AnalyticsSettings,
} from '@socio/shared/operations/operations-analytics';
import type { HealthLive } from '@socio/shared/operations/operations-health';

import type { AppsShape } from '../apps/contract.js';
import type { BackupsShape } from '../backup/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';

import type { AnalyticsShape } from './contract.js';

/** At least this, or three ETL cycles, before a source counts as stale. */
const STALE_MIN_MS = 5 * 60_000;

/**
 * What Health reads live in the app (CB-192): the analytics process's
 * mode and state, backups with the continuous copy and the restore
 * drill (files the backup service reads anyway), and mini apps'
 * self-healing (CB-291, a small table in the app's database). Nothing here touches the
 * analytics store, so it shows while the store is down.
 */
export function liveHealth(
    platform: {
        readonly analytics?: Pick<AnalyticsShape, 'health'>;
        readonly backups?: Pick<BackupsShape, 'status'>;
        /** Mini apps' self-healing (CB-291), where mini apps are on. */
        readonly apps?: Pick<AppsShape, 'enabled' | 'healthSummary'>;
    },
    store: Pick<WorkspaceSettingsShape, 'settings'>,
    /** The deployment's numbers (CB-321); a failure leaves them out, never Health. */
    deployment?: () => Promise<DeploymentHealth>,
): () => Promise<HealthLive> {
    let defaults: AnalyticsSettings;
    try {
        defaults = analyticsDefaults(process.env);
    } catch {
        // The analytics process refuses such a value and says so in its log.
        defaults = ANALYTICS_DEFAULTS;
    }
    return async () => {
        const every = analyticsInForce(store.settings().operations, defaults).etlEverySeconds;
        const numbers = deployment ? await deployment().catch(() => undefined) : undefined;
        return {
            analytics: platform.analytics?.health() ?? null,
            staleAfterMs: Math.max(STALE_MIN_MS, every * 3000),
            backup: platform.backups?.status() ?? null,
            ...(numbers ? { deployment: numbers } : {}),
            ...(platform.apps?.enabled ? { apps: platform.apps.healthSummary() } : {}),
        };
    };
}
