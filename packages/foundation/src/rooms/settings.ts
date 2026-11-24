import { ROOMS_BUDGET_ENV, ROOMS_ENV, roomsEnabledFromEnv, type RoomsSettings } from '@socio/shared/rooms/rooms';
import type { Settings } from '@socio/shared/types';

/**
 * Off: no room can be made or converted until an admin turns it on; and
 * only room admins see a room's use and limits (CB-218).
 */
export const DEFAULT_ROOMS: RoomsSettings = {
    enabled: false,
    budgetVisible: false,
};

/** `ROOMS_ENABLED` (CB-207) and `ROOMS_BUDGET_VISIBLE` (CB-218): on only for an explicit yes. */
export function roomsSettingsFromEnv(env: Record<string, string | undefined>): RoomsSettings {
    return {
        enabled: roomsEnabledFromEnv(env[ROOMS_ENV]),
        budgetVisible: roomsEnabledFromEnv(env[ROOMS_BUDGET_ENV]),
    };
}

/**
 * The settings in force: an admin's from Settings → General → Rooms, each
 * over the server's from the environment; off unless turned on.
 */
export function roomsSettings(
    settings: Pick<Settings, 'rooms'>,
    server: Partial<RoomsSettings> = DEFAULT_ROOMS,
): RoomsSettings {
    return {
        enabled: settings.rooms?.enabled ?? server.enabled ?? DEFAULT_ROOMS.enabled,
        budgetVisible: settings.rooms?.budgetVisible ?? server.budgetVisible ?? DEFAULT_ROOMS.budgetVisible,
    };
}
