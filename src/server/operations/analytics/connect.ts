import { Context } from 'effect';

import type { AnalyticsConfig } from '../contract.js';

import { ChildAnalytics } from './child.js';
import { HttpAnalytics, type AnalyticsClient } from './client.js';

/** The app's analytics client for its configured mode. */
export function analyticsClient(config: AnalyticsConfig): AnalyticsClient {
    return config.mode === 'child' ? new ChildAnalytics(config) : new HttpAnalytics(config);
}

/**
 * The analytics client, whole (the dashboard's queries and rebuild too), as
 * operations' own code and `LegacyAnalytics` hold it: none unless
 * configured (`OPS_ANALYTICS_MODE`). Other features read the `Analytics`
 * slice (`contract.ts`); `layer.ts` provides both from the same client.
 */
export const AnalyticsStore = Context.Reference<AnalyticsClient | undefined>('socio/operations/AnalyticsStore', {
    defaultValue: () => undefined,
});
