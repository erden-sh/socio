import type { DatabaseSync } from 'node:sqlite';

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

import { Cloud, CloudConfig, ReplyReports, type CloudConfigShape } from '../cloud/contract.js';
import { CloudHost, makeCloud, makeReplyReports, type AdminNotice, type CloudHostShape } from '../cloud/layer.js';
import type { ReplyReportsService } from '../cloud/reply-reports.js';
import type { CloudService } from '../cloud/service.js';
import { messageReactions } from '../context/reactions.js';

import { AdminNotices } from './app/notices.js';
import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';

/** `CloudConfig`, from the startup configuration (`SOCIO_CLOUD*`, read by the entry). */
export const cloudConfig = (config: PlatformConfig): CloudConfigShape => ({ cloud: config.cloud });

/** What the cloud connection asks of the platform: the identity's seal, the origin, the admins' notices. */
export const cloudHost = (
    keys: DataKeyring,
    origin: string | undefined,
    db: DatabaseSync,
    notifyAdmins: (notice: AdminNotice) => Promise<void>,
): CloudHostShape => ({
    box: new SecretBox(keys, 'settings-secrets'),
    origin,
    db,
    notifyAdmins: (notice) => notifyAdmins(notice),
});

/** The cloud connection's service itself, for the data keys' re-seal (`composition/app/data-keys.ts`). */
export class CloudConnectionService extends Context.Service<CloudConnectionService, CloudService>()(
    'socio/composition/cloud/CloudService',
) {}

/** The reply reports' service itself, for the same re-seal. */
export class ReplyReportsConnectionService extends Context.Service<
    ReplyReportsConnectionService,
    ReplyReportsService
>()('socio/composition/cloud/ReplyReportsService') {}

const CloudConfigLive = Layer.effect(CloudConfig, LegacyConfig.useSync(cloudConfig));

const CloudHostLive = Layer.effect(
    CloudHost,
    Effect.gen(function* () {
        const notices = yield* AdminNotices;
        const config = yield* LegacyConfig;
        return cloudHost((yield* PlatformKeys).keys, config.appOrigin, (yield* LegacyWorkspace).db, (notice) =>
            notices.notifyAdmins(notice),
        );
    }),
);

/**
 * The cloud connection's step of the graph: `cloud/layer.ts`'s services,
 * offered as `Cloud` and `CloudConnectionService`, and `ReplyReports` and
 * `ReplyReportsConnectionService` (CB-382), with `CloudConfig`. The
 * reactions' store gets the reports here, so removing a thumbs-down from
 * any path withdraws its report.
 */
export const cloudLayers = {
    cloud: Layer.effectContext(
        Effect.gen(function* () {
            const cloud = yield* makeCloud;
            const reports = yield* Effect.provideService(makeReplyReports, Cloud, cloud);
            messageReactions((yield* CloudHost).db).attachReports(reports);
            return Context.make(CloudConnectionService, cloud).pipe(
                Context.add(Cloud, cloud),
                Context.add(ReplyReportsConnectionService, reports),
                Context.add(ReplyReports, reports),
            );
        }),
    ).pipe(Layer.provide(CloudHostLive), Layer.provideMerge(CloudConfigLive)),
};
