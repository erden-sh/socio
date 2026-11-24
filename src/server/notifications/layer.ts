/**
 * Notifications' layers: they implement `contract.ts`. Only the composition
 * root (`composition/notifications.ts`, `main.ts`, `platform.ts`) and
 * tests import this file.
 *
 * One `NotificationService`, built once, offered under every tag of the
 * contract: `Notifier`, `NotificationChannels`, `AppDeliveries` and
 * `InAppNotices` are the service, `UserPresence` its presence and
 * `PushKeys` its push channel. It reads the people and the socios through
 * its own `NotificationsWorkspace` (the composition root provides it over
 * workspace's `People` and `Socios`) and its settings through
 * `NotificationsConfig`. What has no tag yet (the connection, the data
 * keyring, the resource policy's retention and the web reader) the root
 * hands in as `NotificationsRoot`.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import type { DataKeyring } from '@socio/foundation/keys/secret-box';

import {
    AppDeliveries,
    DEFAULT_PUSH_HOSTS,
    InAppNotices,
    NotificationChannels,
    NotificationsConfig,
    NotificationsWorkspace,
    Notifier,
    PushKeys,
    UserPresence,
    type NotificationsConfigShape,
    type NotificationsWorkspaceShape,
} from './contract.js';
import type { ImageReader } from './images.js';
import { NotificationService, type NotificationRetention } from './service.js';
import { NotificationsService } from './tags.js';

/** The whole service: in `tags.ts` so the module can read it. */
export { NotificationsService };

/** What the root hands notifications that no tag carries yet (`NotificationsRoot`). */
export interface NotificationsDeps {
    /** The workspace connection, migrated at boot. */
    readonly db: DatabaseSync;
    /** The data keyring the push key pair is sealed with (CB-62). */
    readonly secret: DataKeyring;
    /** How long notifications, deliveries and notices are kept (the resource policy). */
    readonly retention?: NotificationRetention;
    /** The web reader a notification's outside image is downloaded through. */
    readonly web: ImageReader;
    /** Operational lines only. */
    readonly log: (line: string) => void;
}

/**
 * What the root hands notifications: the composition provides it, from
 * what the boot step opened and the steps before built.
 */
export class NotificationsRoot extends Context.Service<NotificationsRoot, NotificationsDeps>()(
    'socio/notifications/NotificationsRoot',
) {}

/**
 * The service, as the layer makes it.
 */
export function makeNotificationService(
    deps: NotificationsDeps & {
        readonly workspace: NotificationsWorkspaceShape;
        readonly config: NotificationsConfigShape;
    },
) {
    return new NotificationService(deps.db, {
        retention: deps.retention,
        workspace: deps.workspace,
        secret: deps.secret,
        push: deps.config.push ?? { hosts: DEFAULT_PUSH_HOSTS },
        origin: deps.config.appOrigin,
        dailyLimits: deps.config.notificationLimits,
        web: deps.web,
        log: deps.log,
    });
}

/** `NotificationService`, built once, over `NotificationsWorkspace` and `NotificationsConfig`. */
export const NotificationServiceLive = Layer.effect(
    NotificationsService,
    Effect.gen(function* () {
        const deps = yield* NotificationsRoot;
        const workspace = yield* NotificationsWorkspace;
        const config = yield* NotificationsConfig;
        return makeNotificationService({ ...deps, workspace, config });
    }),
);

/**
 * Every tag of the contract over that one service, which the layer also
 * offers (`NotificationsService`) for the root.
 */
export const NotificationsLive = Layer.mergeAll(
    Layer.effect(
        Notifier,
        NotificationsService.useSync((service) => Notifier.of(service)),
    ),
    Layer.effect(
        NotificationChannels,
        NotificationsService.useSync((service) => NotificationChannels.of(service)),
    ),
    Layer.effect(
        AppDeliveries,
        NotificationsService.useSync((service) => AppDeliveries.of(service)),
    ),
    Layer.effect(
        InAppNotices,
        NotificationsService.useSync((service) => InAppNotices.of(service)),
    ),
    Layer.effect(
        UserPresence,
        NotificationsService.useSync((service) => UserPresence.of(service.presence)),
    ),
    Layer.effect(
        PushKeys,
        NotificationsService.useSync((service) => PushKeys.of(service.push)),
    ),
).pipe(Layer.provideMerge(NotificationServiceLive));
