import { notificationLimits } from '@socio/shared/notifications/limits';

import { Media } from '../media/contract.js';
import type { ServerModule } from '../modules/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';

import { NotificationGoals } from './contract.js';
import { notificationsSchema } from './migrations.js';
import { notificationRoutes } from './routes.js';
import { NotificationsService } from './tags.js';
import { NOTIFY_TOOL_NAMES, notifyTools } from './tools.js';

/**
 * Notifications (CB-114): `notify_user` for every Dot turn that acts for
 * its person, their channels and devices under `/api/notifications`, and
 * an hourly prune. The service and its push channel are the platform's
 * (`platform.notifications`), so other modules (Telegram) can register
 * channels on it.
 *
 * The hooks read the service (`NotificationsService`, `tags.ts`), media's
 * `Media`, the workspace's settings and a goal by its task
 * (`NotificationGoals`) from the app's services at the moment of use.
 */
export const notificationsModule: ServerModule = {
    ...notificationsSchema,
    routes: ({ services }) => notificationRoutes(services.get(NotificationsService)),
    dotTools: ({ services }, turn) => {
        const notifications = services.get(NotificationsService);
        return notifyTools(notifications, turn, {
            limits: notificationLimits(services.get(WorkspaceSettings).settings(), notifications.dailyLimits),
            goalOf: (taskId) => services.get(NotificationGoals).byTask(taskId),
            image: (url) =>
                notifications.resolveImage(
                    url,
                    { userId: turn.userId, dotId: turn.dot.id, signal: turn.signal },
                    services.get(Media),
                ),
        });
    },
    // The workspace's settings are read when the status is asked for, after
    // boot (`WorkspaceSettings`).
    capabilities: ({ services }) => [
        {
            id: 'notifications',
            label: 'Notifications',
            description:
                'Notify the person you work for (notify_user) when something needs them and they may not be watching: unattended work that finished or needs a decision, a problem you found. It goes to the channels they chose (their devices, Telegram), only while they are away from Socio.',
            tools: NOTIFY_TOOL_NAMES,
            status: async (turn) => {
                const notifications = services.get(NotificationsService);
                const limits = notificationLimits(
                    services.get(WorkspaceSettings).settings(),
                    notifications.dailyLimits,
                );
                const used = await notifications.usage(turn.dot.id, turn.userId);
                const reachable = await notifications.reachable(turn.userId);
                return {
                    enabled: true,
                    ...(reachable
                        ? {}
                        : {
                              note: 'They have no notification channel turned on yet (Account → Notifications); notify_user would only show in the app while they use it.',
                          }),
                    limits: {
                        perDotDaily: limits.perDot,
                        perPersonDaily: limits.perUser,
                    },
                    usage: {
                        sentByYouToday: used.byDot,
                        sentToPersonToday: used.byUser,
                    },
                    details: { reachable },
                };
            },
        },
    ],
    tick: {
        everyMs: 60 * 60_000,
        run: ({ services }) => services.get(NotificationsService).prune(),
    },
};
