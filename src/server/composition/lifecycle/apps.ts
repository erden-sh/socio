/**
 * Mini apps' internal listener: its start and stop. It stays a step the boot
 * and the shutdown call, not a finalizer on the apps layer's scope: it starts
 * once the pages are mounted, on every runtime, and closes with the server,
 * after the runtime is disposed; the layer's scope opens and closes at other
 * points of that order.
 */
import { Context } from 'effect';

import { appsInternalConfigFromEnv, createAppsInternalServer } from '../../apps/internal-listener.js';
import type { AppEdge } from '../../main.js';
import { AdminNotices } from '../app/notices.js';
import { LegacyApps } from '../apps.js';

/**
 * The internal apps listener the app browser's workers call (CB-232):
 * socio sessions only, from its network's subnet only.
 */
export function startAppsInternal(edge: AppEdge, env: Record<string, string | undefined>) {
    const apps = Context.get(edge.services, LegacyApps);
    // When automatic repair gives up, admins are told (CB-291).
    const notices = Context.get(edge.services, AdminNotices);
    apps.useAdminNotices((notice) => notices.notifyAdmins(notice));
    const appsInternal = createAppsInternalServer(apps, appsInternalConfigFromEnv(env));
    void appsInternal?.listen();
    return appsInternal;
}

export async function stopAppsInternal(appsInternal: ReturnType<typeof startAppsInternal>) {
    await appsInternal?.close();
}

/** Mini apps' steps, as lifecycle/index.ts runs them: their internal listener's start and stop. */
export const appsLifecycle = { startInternal: startAppsInternal, stopInternal: stopAppsInternal };
