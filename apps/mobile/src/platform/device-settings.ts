import { useSyncExternalStore } from 'react';
import { Uniwind } from 'uniwind';

import type { DeviceSettings } from '../data/registry';
import { createDeviceSettings, followAppearance } from '../shell/device-settings';

// The phone's own settings for the app (src/shell/device-settings.ts): loaded
// from the registry by launch (device-store.ts) before the first frame, and
// changed by Settings. `useAdvanced()` is what a screen asks before it shows
// technical detail; `useHaptics()` before it buzzes. Appearance applies itself.

export const deviceSettings = createDeviceSettings();

// The person's Light, Dark or System, app-wide: class names, the navigation theme, the system
// bars and SVG colors all read uniwind's scheme (src/theme/scheme.ts). Launch loads the settings
// before the first frame, so a chosen scheme is the first one drawn.
followAppearance(deviceSettings, (theme) => Uniwind.setTheme(theme));

/** The phone's settings, and their changes. */
export function useDeviceSettings(): DeviceSettings {
    return useSyncExternalStore(deviceSettings.subscribe, deviceSettings.get);
}

/** Whether Advanced mode is on: show the technical detail, never more permissions. */
export function useAdvanced(): boolean {
    return useDeviceSettings().advanced;
}

/** Whether haptic feedback is on. */
export function useHaptics(): boolean {
    return useDeviceSettings().haptics;
}
