/**
 * Updates' construction. The service is made in `updates/layer.ts`; this file
 * builds `UpdatesConfig` from the startup configuration, provides what updates
 * declares there (`UpdatesHost`: the feed token's seal, the backups' late-bound
 * port and the operators' notices, `AdminNotices`). The settings' tags updates
 * reads (`WorkspaceSettings`, `SecretSettings`) are the graph's leaf bridges,
 * the slices the store forwards to. The backups are set after the graph is
 * built: updates read them through their port.
 */
import { Context, Effect, Layer } from 'effect';

import { SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';

import { Updates, UpdatesConfig, type UpdatesConfigShape } from '../updates/contract.js';
import {
    makeUpdates,
    ReleasesLive,
    UpdatesHost,
    type OperatorNotice,
    type UpdatesHostShape,
} from '../updates/layer.js';
import type { UpdateService } from '../updates/service.js';

import { AdminNotices } from './app/notices.js';
import { LegacyConfig } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';
import { type PlatformPorts, Ports } from './ports.js';

/** `UpdatesConfig`, from the startup configuration (`UPDATES_*`, `UPDATER_*`, read by the entry). */
export const updatesConfig = (config: PlatformConfig): UpdatesConfigShape => ({ updates: config.updates });

/** What updates asks of the platform: the token's seal, the backups' port, the operators' notices. */
export const updatesHost = (
    keys: DataKeyring,
    ports: Pick<PlatformPorts, 'backups'>,
    notifyOperators: (notice: OperatorNotice) => Promise<void>,
): UpdatesHostShape => ({
    box: new SecretBox(keys, 'settings-secrets'),
    backups: () => ports.backups.peek(),
    notifyOperators: (notice) => notifyOperators(notice),
});

/** Updates, under the graph's `LegacyUpdates` tag (the class). */
export class LegacyUpdates extends Context.Service<LegacyUpdates, UpdateService>()(
    'socio/composition/updates/UpdateService',
) {}

/** `UpdatesConfig`, from the process's config. */
const UpdatesConfigLive = Layer.effect(UpdatesConfig, LegacyConfig.useSync(updatesConfig));

/** The keys, the backups' port and the operators' notices (`AdminNotices`), as updates calls them. */
const UpdatesHostLive = Layer.effect(
    UpdatesHost,
    Effect.gen(function* () {
        const notices = yield* AdminNotices;
        return updatesHost((yield* PlatformKeys).keys, yield* Ports, (notice) => notices.notifyOperators(notice));
    }),
);

/**
 * Updates' step of the graph: `updates/layer.ts`'s service, offered as
 * `Updates` and `LegacyUpdates`, with `Releases` (the build's release data)
 * and `UpdatesConfig`.
 */
export const updatesLayers = {
    updates: Layer.effectContext(
        Effect.map(makeUpdates, (updates) => Context.make(LegacyUpdates, updates).pipe(Context.add(Updates, updates))),
    ).pipe(Layer.provide(UpdatesHostLive), Layer.provideMerge(Layer.mergeAll(ReleasesLive, UpdatesConfigLive))),
};
