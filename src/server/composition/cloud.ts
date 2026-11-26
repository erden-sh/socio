/**
 * The cloud connection's construction. The service is made in
 * `cloud/layer.ts`; this file builds `CloudConfig` from the startup
 * configuration and provides what the cloud connection declares there
 * (`CloudHost`: the identity's seal, the app's origin and the admins'
 * notices, `AdminNotices`). The settings' tags it reads (`WorkspaceSettings`,
 * `SecretSettings`) are the graph's leaf bridges; `Releases` comes from
 * updates' step, which is built before this one.
 */
import { Context, Effect, Layer } from 'effect';

import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';

import { Cloud, CloudConfig, type CloudConfigShape } from '../cloud/contract.js';
import { CloudHost, makeCloud, type AdminNotice, type CloudHostShape } from '../cloud/layer.js';
import type { CloudService } from '../cloud/service.js';

import { AdminNotices } from './app/notices.js';
import { LegacyConfig } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';

/** `CloudConfig`, from the startup configuration (`SOCIO_CLOUD*`, read by the entry). */
export const cloudConfig = (config: PlatformConfig): CloudConfigShape => ({ cloud: config.cloud });

/** What the cloud connection asks of the platform: the identity's seal, the origin, the admins' notices. */
export const cloudHost = (
    keys: DataKeyring,
    origin: string | undefined,
    notifyAdmins: (notice: AdminNotice) => Promise<void>,
): CloudHostShape => ({
    box: new SecretBox(keys, 'settings-secrets'),
    origin,
    notifyAdmins: (notice) => notifyAdmins(notice),
});

/** The cloud connection's service itself, for the data keys' re-seal (`composition/app/data-keys.ts`). */
export class CloudConnectionService extends Context.Service<CloudConnectionService, CloudService>()(
    'socio/composition/cloud/CloudService',
) {}

const CloudConfigLive = Layer.effect(CloudConfig, LegacyConfig.useSync(cloudConfig));

const CloudHostLive = Layer.effect(
    CloudHost,
    Effect.gen(function* () {
        const notices = yield* AdminNotices;
        const config = yield* LegacyConfig;
        return cloudHost((yield* PlatformKeys).keys, config.appOrigin, (notice) => notices.notifyAdmins(notice));
    }),
);

/**
 * The cloud connection's step of the graph: `cloud/layer.ts`'s service,
 * offered as `Cloud` and `CloudConnectionService`, with `CloudConfig`.
 */
export const cloudLayers = {
    cloud: Layer.effectContext(
        Effect.map(makeCloud, (cloud) => Context.make(CloudConnectionService, cloud).pipe(Context.add(Cloud, cloud))),
    ).pipe(Layer.provide(CloudHostLive), Layer.provideMerge(CloudConfigLive)),
};
