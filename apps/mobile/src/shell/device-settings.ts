import { type Appearance, DEFAULT_DEVICE_SETTINGS, type DeviceSettings } from '../data/registry';

// The phone's own settings in memory: Advanced
// mode, haptics and Appearance, loaded from the registry (migration 5) before the first
// frame, so a screen never draws with the defaults and then changes. A change
// shows at once and is stored; one the registry refuses goes back to what is
// stored. No React Native, so tests/shell runs it under Node; the app binds it
// in src/platform/device-settings.ts.

/** Where the settings are kept: the registry's `settings` and `setSettings`. */
export interface DeviceSettingsStore {
    settings(): Promise<DeviceSettings>;
    setSettings(change: Partial<DeviceSettings>): Promise<DeviceSettings>;
}

export interface DeviceSettingsSource {
    /** The settings now: the defaults until `load`. */
    get(): DeviceSettings;
    subscribe(listener: () => void): () => void;
    /** Reads them from `store`, which keeps every later change. */
    load(store: DeviceSettingsStore): Promise<void>;
    /** Shows the change at once and stores it. Rejects, back at what is stored, when the store refuses it. */
    set(change: Partial<DeviceSettings>): Promise<void>;
}

export function createDeviceSettings(): DeviceSettingsSource {
    let current = DEFAULT_DEVICE_SETTINGS;
    let store: DeviceSettingsStore | null = null;
    const listeners = new Set<() => void>();
    const settle = (next: DeviceSettings) => {
        if (
            next.advanced === current.advanced &&
            next.haptics === current.haptics &&
            next.appearance === current.appearance
        ) {
            return;
        }
        current = next;
        for (const listener of [...listeners]) {
            listener();
        }
    };
    return {
        get: () => current,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        load: async (next) => {
            store = next;
            settle(await next.settings());
        },
        set: async (change) => {
            if (store === null) {
                throw new Error('The settings are not loaded.');
            }
            const kept = store;
            const before = current;
            settle({ ...current, ...change });
            try {
                settle(await kept.setSettings(change));
            } catch (error) {
                settle(await kept.settings().catch(() => before));
                throw error;
            }
        },
    };
}

/**
 * Applies the person's Appearance app-wide through `setTheme` (uniwind's,
 * which also sets React Native's Appearance, so the system bars, alerts and the
 * keyboard follow): at once, then on each change of it. The app starts on the
 * system's scheme, so System asks for nothing until another has been applied.
 * Returns the unsubscribe.
 */
export function followAppearance(
    source: Pick<DeviceSettingsSource, 'get' | 'subscribe'>,
    setTheme: (theme: Appearance) => void,
): () => void {
    let applied: Appearance = 'system';
    const apply = () => {
        const next = source.get().appearance;
        if (next !== applied) {
            applied = next;
            setTheme(next);
        }
    };
    apply();
    return source.subscribe(apply);
}
