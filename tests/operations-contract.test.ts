import { Context } from 'effect';
import { expect, it } from 'vitest';

import * as deploymentMetrics from '@socio/shared/operations/deployment-metrics';

import * as contract from '../src/server/operations/contract.js';

// The pure helpers moved into packages, and their old paths are gone. The
// contract still hands out the deployment metrics' constants, the very same
// values as the package.
it('re-exports the deployment metrics constants from their package', () => {
    expect([contract.DEPLOYMENT_STATS_PATH, contract.DEPLOYMENT_STATS_TIMEOUT_MS]).toEqual([
        deploymentMetrics.DEPLOYMENT_STATS_PATH,
        deploymentMetrics.DEPLOYMENT_STATS_TIMEOUT_MS,
    ]);
    expect(contract.DEPLOYMENT_STATS_PATH).toBe('/deployment/stats');
});

it('names its tags socio/operations/<Name>', () => {
    expect([
        contract.AccessAudit.key,
        contract.RunSource.key,
        contract.Analytics.key,
        contract.OperationsConfig.key,
    ]).toEqual([
        'socio/operations/AccessAudit',
        'socio/operations/RunSource',
        'socio/operations/Analytics',
        'socio/operations/OperationsConfig',
    ]);
});

it('has no analytics store unless one is provided, as with OPS_ANALYTICS_MODE=off', () => {
    expect(Context.get(Context.empty(), contract.Analytics)).toBeUndefined();
});
