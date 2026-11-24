import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings } from '../../src/data';
import { createDeviceSettings, type DeviceSettingsStore, followAppearance } from '../../src/shell/device-settings';
import {
    accountRow,
    ADVANCED_ROW,
    APPEARANCE_CHOICES,
    appearanceLabel,
    cacheLine,
    HAPTICS_ROW,
    SETTINGS_HEADING,
    WEB_SETTINGS_ROW,
} from '../../src/shell/settings';

// The phone's own settings in memory:
// the defaults until launch loads the registry's, a change shown at once and
// stored, and one the registry refuses put back.

function fakeStore(initial: DeviceSettings = DEFAULT_DEVICE_SETTINGS, fail = false) {
    let kept = initial;
    const store: DeviceSettingsStore = {
        settings: async () => kept,
        setSettings: async (change) => {
            if (fail) {
                throw new Error('disk full');
            }
            kept = { ...kept, ...change };
            return kept;
        },
    };
    return { store, kept: () => kept };
}

describe('the device settings', () => {
    it('are Advanced mode off and haptics on until loaded, then the stored ones', async () => {
        const settings = createDeviceSettings();
        expect(settings.get()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
        const listener = vi.fn();
        settings.subscribe(listener);
        await settings.load(fakeStore({ advanced: true, haptics: true, appearance: 'system' }).store);
        expect(settings.get()).toEqual({ advanced: true, haptics: true, appearance: 'system' });
        expect(listener).toHaveBeenCalledOnce();
    });

    it('show a change at once and store it, telling listeners once per change', async () => {
        const settings = createDeviceSettings();
        const fake = fakeStore();
        await settings.load(fake.store);
        const seen: DeviceSettings[] = [];
        const stop = settings.subscribe(() => seen.push(settings.get()));
        const done = settings.set({ advanced: true });
        expect(settings.get().advanced).toBe(true);
        await done;
        expect(fake.kept()).toEqual({ advanced: true, haptics: true, appearance: 'system' });
        await settings.set({ haptics: false });
        expect(seen).toEqual([
            { advanced: true, haptics: true, appearance: 'system' },
            { advanced: true, haptics: false, appearance: 'system' },
        ]);
        stop();
        await settings.set({ haptics: true });
        expect(seen).toHaveLength(2);
    });

    it('tell listeners when only Appearance changes, and keep it', async () => {
        const settings = createDeviceSettings();
        const fake = fakeStore();
        await settings.load(fake.store);
        const listener = vi.fn();
        settings.subscribe(listener);
        await settings.set({ appearance: 'dark' });
        expect(settings.get().appearance).toBe('dark');
        expect(fake.kept().appearance).toBe('dark');
        expect(listener).toHaveBeenCalledOnce();
    });

    it('go back to what is stored when the store refuses a change', async () => {
        const settings = createDeviceSettings();
        await settings.load(fakeStore({ advanced: false, haptics: true, appearance: 'system' }, true).store);
        await expect(settings.set({ advanced: true })).rejects.toThrow('disk full');
        expect(settings.get()).toEqual({ advanced: false, haptics: true, appearance: 'system' });
    });

    it('refuse a change before launch loads them', async () => {
        await expect(createDeviceSettings().set({ advanced: true })).rejects.toThrow();
    });
});

describe('Settings’ words', () => {
    it('say the cache size in plain words, and never "Dot"', () => {
        expect(cacheLine(null)).toBe('Measuring…');
        expect(cacheLine(512)).toBe('512 B on this phone');
        expect(cacheLine(3.4 * 1048576)).toBe('3.4 MB on this phone');
        for (const row of [HAPTICS_ROW, ADVANCED_ROW]) {
            expect(`${row.title} ${row.subtitle}`).not.toMatch(/\bDot\b/);
        }
    });
});

describe('Appearance', () => {
    it('applies Light or Dark at once and on each change, and System only after another', async () => {
        const settings = createDeviceSettings();
        const fake = fakeStore({ ...DEFAULT_DEVICE_SETTINGS, appearance: 'dark' });
        const setTheme = vi.fn();
        const stop = followAppearance(settings, setTheme);
        // The defaults (System) ask for nothing: the app starts on the system's scheme.
        expect(setTheme).not.toHaveBeenCalled();
        await settings.load(fake.store);
        expect(setTheme).toHaveBeenLastCalledWith('dark');
        await settings.set({ haptics: false });
        expect(setTheme).toHaveBeenCalledTimes(1);
        await settings.set({ appearance: 'system' });
        expect(setTheme).toHaveBeenLastCalledWith('system');
        await settings.set({ appearance: 'light' });
        expect(setTheme).toHaveBeenLastCalledWith('light');
        stop();
        await settings.set({ appearance: 'dark' });
        expect(setTheme).toHaveBeenCalledTimes(3);
    });

    it('applies a stored scheme loaded before it follows', async () => {
        const settings = createDeviceSettings();
        await settings.load(fakeStore({ ...DEFAULT_DEVICE_SETTINGS, appearance: 'light' }).store);
        const setTheme = vi.fn();
        followAppearance(settings, setTheme);
        expect(setTheme).toHaveBeenCalledExactlyOnceWith('light');
    });
});

describe('Settings’ items', () => {
    it('offer Light, Dark or System, each said with its place in the group', () => {
        expect(APPEARANCE_CHOICES.map((choice) => choice.label)).toEqual(['Light', 'Dark', 'System']);
        expect(appearanceLabel('dark')).toBe('Appearance: Dark, 2 of 3');
        expect(appearanceLabel('system')).toBe('Appearance: System, 3 of 3');
    });

    it('show the person’s name, read-only, from the workspace’s user or what sign-in kept', () => {
        expect(accountRow({ name: 'Ada', email: 'ada@example.test' })).toEqual({
            name: 'Ada',
            email: 'ada@example.test',
            accessibilityLabel: 'Your name, Ada, ada@example.test',
        });
        expect(accountRow({ name: '  ', email: 'ada@example.test' })).toEqual({
            name: 'ada@example.test',
            email: null,
            accessibilityLabel: 'Your name, ada@example.test',
        });
        expect(accountRow({ name: null, email: null })).toBeNull();
    });

    it('link everything else to the workspace’s settings on the web, under a big title', () => {
        expect(WEB_SETTINGS_ROW).toMatchObject({ title: 'Everything else', href: '/settings' });
        expect(SETTINGS_HEADING.title).toBe('Settings');
        expect(SETTINGS_HEADING.description).not.toMatch(/\bDot\b/);
    });
});
