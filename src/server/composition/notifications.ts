/**
 * Notifications' construction: `notifications/layer.ts` in the graph.
 */

import { Effect, Layer } from 'effect';

import {
    NotificationsConfig,
    NotificationsWorkspace,
    type NotificationsConfigShape,
} from '../notifications/contract.js';
import { NotificationsLive, NotificationsRoot, NotificationsService } from '../notifications/layer.js';
import { WebReader } from '../web/contract.js';
import { People, Socios } from '../workspace/contract.js';

import { LegacyConfig, LegacyWorkspace } from './base.js';
import type { PlatformConfig } from './config.js';
import { PlatformKeys } from './keys.js';
import { LegacyResourcePolicy } from './operations.js';

const log = (line: string) => console.log(line);

/**
 * Notifications, under the graph's `LegacyNotifications` tag (`platform.notifications`): the
 * layer's whole service.
 */
export { NotificationsService as LegacyNotifications };

/**
 * `NotificationsConfig` from the startup configuration (`PlatformConfig`,
 * which the entry parses with composition's environment readers): the fields
 * notifications reads, as the constructor's service gets them.
 */
export function notificationsConfig(config: PlatformConfig): NotificationsConfigShape {
    return NotificationsConfig.of({
        push: config.push,
        appOrigin: config.appOrigin,
        notificationLimits: config.notificationLimits,
    });
}

/**
 * Notifications' workspace reads (dependency inversion): its
 * `NotificationsWorkspace` over workspace's `People` and `Socios` slices,
 * each read at the moment of use.
 */
export const NotificationsWorkspaceLive = Layer.effect(
    NotificationsWorkspace,
    Effect.gen(function* () {
        const people = yield* People;
        const socios = yield* Socios;
        return NotificationsWorkspace.of({
            preferences: (userId) => people.preferences(userId),
            isDeactivated: (userId) => people.isDeactivated(userId),
            dot: (id) => socios.dot(id),
        });
    }),
);

/**
 * Notifications' step of the graph: `NotificationsLive`,
 * the service under `Notifier`, `NotificationChannels`, `AppDeliveries`,
 * `InAppNotices`, `UserPresence` and `PushKeys` (and whole, as
 * `NotificationsService`), with `NotificationsConfig` from the startup configuration.
 * It yields workspace's `People` and `Socios` (`NotificationsWorkspaceLive`); the root hands it the
 * connection, the keyring, the resource policy and the web reader (web's
 * `WebReader`, a leaf bridge: the connection's one reader, reached at each
 * read).
 */
export const notificationsLayers = {
    notifications: NotificationsLive.pipe(
        Layer.provide(NotificationsWorkspaceLive),
        Layer.provideMerge(
            Layer.effect(
                NotificationsConfig,
                Effect.gen(function* () {
                    return notificationsConfig(yield* LegacyConfig);
                }),
            ),
        ),
        Layer.provide(
            Layer.effect(
                NotificationsRoot,
                Effect.gen(function* () {
                    const workspace = yield* LegacyWorkspace;
                    return NotificationsRoot.of({
                        db: workspace.db,
                        secret: (yield* PlatformKeys).keys,
                        retention: yield* LegacyResourcePolicy,
                        web: yield* WebReader,
                        log,
                    });
                }),
            ),
        ),
    ),
};
