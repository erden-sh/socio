import { DEFAULT_NOTIFICATION_LIMITS, type NotificationDailyLimits } from '../notifications.js';
import type { Settings } from '../types.js';

/** The limits in force: an admin's from Settings over the environment's. */
export function notificationLimits(
    settings: Settings,
    server: NotificationDailyLimits = DEFAULT_NOTIFICATION_LIMITS,
): NotificationDailyLimits {
    return { ...server, ...settings.notificationDailyLimits };
}
