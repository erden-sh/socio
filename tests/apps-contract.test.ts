// The apps contract: the tags other features reach `apps/` through.
import { expect, it } from 'vitest';

import { appInRuntime } from '@socio/foundation/apps/runtime-status';
import { APP_STATUSES } from '@socio/shared/apps/app-types';

import { Apps, AppsConfig } from '../src/server/apps/contract.js';
import { AppsService } from '../src/server/apps/service.js';

it('declares its tags under socio/apps', () => {
    expect(Apps.key).toBe('socio/apps/Apps');
    expect(AppsConfig.key).toBe('socio/apps/AppsConfig');
});

it('serves promoted and unpublished apps from the runtime, development apps from the computer', () => {
    for (const status of APP_STATUSES) {
        expect(appInRuntime({ status })).toBe(status === 'promoted' || status === 'unpublished');
        expect(AppsService.inRuntime({ status })).toBe(appInRuntime({ status }));
    }
});
