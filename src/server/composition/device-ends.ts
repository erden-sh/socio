import { DEVICE_END_REASONS, type DeviceEndHooks } from '../auth/contract.js';
import type { WorkspaceAuditEntry } from '../workspace/contract.js';

/**
 * What a device's ending does outside the auth database (CB-352), for
 * the server and the CLI alike: its audit lines, awaited (a failure stops
 * an ending that waits on it), and its push subscription removed if it is
 * still that person's.
 */
export function deviceEndHooks(
    auditNow: (entries: readonly WorkspaceAuditEntry[]) => Promise<void>,
    push: {
        byEndpoint(endpoint: string): Promise<{ id: string; userId: string } | null | undefined>;
        remove(userId: string, id: string): Promise<unknown>;
    },
): DeviceEndHooks {
    return {
        audit: ({ actor, how, reason, devices }) =>
            auditNow(
                devices.map((device) => ({
                    actor,
                    action: 'revoke' as const,
                    targetKind: 'device' as const,
                    targetId: device.id,
                    // The label, what became of it, and why (CB-379), for admins.
                    detail: `${device.label}; ${how}; ${DEVICE_END_REASONS[reason]}`,
                })),
            ),
        dropPush: async (userId, endpoint) => {
            const subscription = await push.byEndpoint(endpoint);
            if (subscription?.userId === userId) {
                await push.remove(userId, subscription.id);
            }
        },
    };
}
