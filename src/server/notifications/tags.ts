/**
 * Notifications' service, whole, by tag: what its module and routes use
 * (other features use the contract's tags). Moved from `layer.ts` so the
 * module can read it from the app's services: only entry files import a
 * `layer.ts`, and `contract.ts` can't name the class.
 * `layer.ts` builds it.
 */
import { Context } from 'effect';

import type { NotificationService } from './service.js';

/**
 * The whole service, with every method its own routes and module use, and
 * what the composition holds (`LegacyNotifications`). Other features see the
 * contract's tags.
 */
export class NotificationsService extends Context.Service<NotificationsService, NotificationService>()(
    'socio/notifications/NotificationsService',
) {}
