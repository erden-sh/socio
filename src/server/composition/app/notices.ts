/**
 * The admins' and operators' notices (`AdminNotices`): `notifyAdmins` and
 * `notifyOperators`, read through the tag. Placed in the graph
 * (`composition/index.ts`, right after `notificationsLayers.notifications`); it
 * registers no listener, so the graph's order doesn't change.
 */
import { Context, Effect, Layer } from 'effect';

import { isAdmin, isOperator } from '@socio/shared/roles';

import type { NotificationService } from '../../notifications/service.js';
import { LegacyWorkspace, type PlatformNotice } from '../base.js';
import { LegacyNotifications } from '../notifications.js';
import type { AppWorkspace } from '../workspace-parts.js';

/** A notice to every active admin or operator, from the app itself. */
export interface AdminNoticesShape {
    /**
     * Tells every active admin (operators too) about the service, from the
     * app itself (a failed restore drill, CB-111); one that can't be reached
     * doesn't keep it from the others.
     */
    notifyAdmins(notice: PlatformNotice): Promise<void>;
    /** The same, for active operators only (an update is available, CB-259). */
    notifyOperators(notice: PlatformNotice): Promise<void>;
    /**
     * `notifyAdmins`, saying how many admins it reached and how many it
     * couldn't, for a caller that sends a notice again when none arrived
     * (plugin backups, CB-458).
     */
    deliverToAdmins?(notice: PlatformNotice): Promise<NoticeDelivery>;
}

/** How a notice went: the people it reached, and those it couldn't. */
export interface NoticeDelivery {
    sent: number;
    failed: number;
}

/** The admins' and operators' notices (`composition/app/notices.ts`). */
export class AdminNotices extends Context.Service<AdminNotices, AdminNoticesShape>()(
    'socio/composition/app/AdminNotices',
) {}

/** The notices over the people and their notifications (`AdminNotices`). */
export function adminNotices(sources: {
    readonly workspace: Pick<AppWorkspace, 'users' | 'deactivatedUsers'>;
    readonly notifications: Pick<NotificationService, 'notifyFromApp'>;
}): AdminNoticesShape {
    const { workspace, notifications } = sources;
    const notifyWhere = async (
        picked: (user: Parameters<typeof isAdmin>[0]) => boolean,
        notice: PlatformNotice,
    ): Promise<NoticeDelivery> => {
        const delivery = { sent: 0, failed: 0 };
        const deactivated = workspace.deactivatedUsers();
        for (const user of workspace.users()) {
            if (picked(user) && !deactivated.has(user.id)) {
                await notifications.notifyFromApp({ userId: user.id, ...notice }).then(
                    () => void delivery.sent++,
                    () => void delivery.failed++,
                );
            }
        }
        return delivery;
    };
    return {
        notifyAdmins: async (notice) => void (await notifyWhere(isAdmin, notice)),
        notifyOperators: async (notice) => void (await notifyWhere(isOperator, notice)),
        deliverToAdmins: (notice) => notifyWhere(isAdmin, notice),
    };
}

/** `AdminNotices` over the workspace and notifications built before it. */
const AdminNoticesLive = Layer.effect(
    AdminNotices,
    Effect.gen(function* () {
        return AdminNotices.of(
            adminNotices({ workspace: yield* LegacyWorkspace, notifications: yield* LegacyNotifications }),
        );
    }),
);

/** The step, as `composition/index.ts` places it. */
export const appNoticesLayers = { step: AdminNoticesLive };
