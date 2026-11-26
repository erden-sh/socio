import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    immersive,
    iosCompactBar,
    modal,
    nativeBarOverlays,
    onPlatform,
    page,
    sheet,
    tabRoot,
} from '../src/navigation/presets';
import { ROUTE_NAMES, ROUTES } from '../src/navigation/routes';

// The route presets: each owns how a route
// is presented, so a screen never sets its own presentation.

describe('route presets', () => {
    it('pushes a page, with Back and the system bar unless turned off', () => {
        expect(page()).toMatchObject({ presentation: 'card', headerShown: true, headerTransparent: true });
        expect(page({ title: 'Spaces', header: false })).toMatchObject({ title: 'Spaces', headerShown: false });
        expect(page()).not.toHaveProperty('title');
    });

    it('opens a sheet part way with a grabber, or sized to its content', () => {
        expect(sheet({ detent: 0.5 })).toMatchObject({
            presentation: 'formSheet',
            headerShown: false,
            gestureEnabled: true,
            sheetGrabberVisible: true,
            sheetAllowedDetents: [0.5, 1],
        });
        expect(sheet({ detent: 'fit' }).sheetAllowedDetents).toBe('fitToContents');
    });

    it('covers the screen with a modal, which never shows Back', () => {
        expect(modal()).toMatchObject({
            presentation: 'fullScreenModal',
            headerShown: false,
            headerBackVisible: false,
        });
    });

    it('shows immersive media over the screen underneath, with no bar and no system dismiss gesture, hiding the system bars when asked', () => {
        // Transparent, so the viewer's own drag to dismiss shows the screen underneath (CB-537).
        expect(immersive()).toEqual({ presentation: 'transparentModal', headerShown: false, gestureEnabled: false });
        expect(immersive({ hideSystemBars: true })).toMatchObject({
            statusBarHidden: true,
            navigationBarHidden: true,
            autoHideHomeIndicator: true,
        });
    });

    it('gives every route a preset', () => {
        for (const name of ROUTE_NAMES) {
            expect(ROUTES[name].preset, name).toHaveProperty('presentation');
        }
    });

    it('keeps only the opening detent on Android, where a sheet is laid out at its largest', () => {
        expect(onPlatform(sheet({ detent: 0.85 }), 'android').sheetAllowedDetents).toEqual([0.85]);
        expect(onPlatform(sheet({ detent: 0.85 }), 'ios').sheetAllowedDetents).toEqual([0.85, 1]);
        expect(onPlatform(sheet({ detent: 'fit' }), 'android').sheetAllowedDetents).toBe('fitToContents');
        expect(onPlatform(page({ header: false }), 'android')).toEqual(page({ header: false }));
    });
});

// CB-417 and CB-420 (the owner, 2026-11-18: the web's brand in each platform's own components):
// every page takes the system's bar, as iOS and Material apps do.
describe('the native bar', () => {
    it('is the system’s, never a drawn one: the root stack has no `header` of its own', () => {
        for (const options of [page(), page({ header: 'large' }), page({ header: 'native' })]) {
            expect(options).toMatchObject({ presentation: 'card', headerShown: true, headerTransparent: true });
            expect(options).not.toHaveProperty('header');
            expect(options.headerBackButtonDisplayMode).toBe('minimal');
        }
    });

    it('has a large title on list and module pages, an inline one on detail pages and the editor', () => {
        expect(page({ header: 'large' })).toMatchObject({
            headerLargeTitleEnabled: true,
            headerLargeTitleShadowVisible: false,
        });
        expect(page().headerLargeTitleEnabled).toBe(false);
        expect(page({ header: 'native' }).headerLargeTitleEnabled).toBe(false);
        expect(tabRoot('Chats')).toMatchObject({ title: 'Chats', headerShown: true, headerLargeTitleEnabled: true });
        for (const name of [
            'Board',
            'Space',
            'Memories',
            'Settings',
            'Approvals',
            'Runs',
            'Schedules',
            'Activity',
            'Learning',
        ] as const) {
            expect(ROUTES[name].preset.headerLargeTitleEnabled, name).toBe(true);
        }
        for (const name of [
            'Issue',
            'Page',
            'Chat',
            'Schedule',
            'Task',
            'Job',
            'Run',
            'Notifications',
            'MoreItem',
        ] as const) {
            expect(ROUTES[name].preset, name).toMatchObject({ headerShown: true, headerLargeTitleEnabled: false });
        }
    });

    it('lets iOS 26’s scroll edge effect blur under it; older iOS and the WebView editor get the material', () => {
        expect(onPlatform(page(), 'ios', true).headerBlurEffect).toBeUndefined();
        expect(onPlatform(page({ header: 'large' }), 'ios', true).headerBlurEffect).toBeUndefined();
        expect(onPlatform(page(), 'ios', false).headerBlurEffect).toBe('systemChromeMaterial');
        expect(onPlatform(page({ header: 'native' }), 'ios', true).headerBlurEffect).toBe('systemChromeMaterial');
    });

    it('lies over the page on iOS only; Android’s is a Material top app bar above it, one size', () => {
        for (const options of [page(), page({ header: 'large' }), page({ header: 'native' }), tabRoot('More')]) {
            const android = onPlatform(options, 'android');
            expect(android.headerTransparent).toBe(false);
            expect(android.headerBlurEffect).toBeUndefined();
            expect(android.headerLargeTitleEnabled).toBeUndefined();
            expect(onPlatform(options, 'ios').headerTransparent).toBe(true);
        }
        expect(nativeBarOverlays('ios')).toBe(true);
        expect(nativeBarOverlays('android')).toBe(false);
    });

    it('pads under iOS 26’s 54 pt bar before the system says its height, so a chat’s first message clears it by 16 pt (CB-456)', () => {
        expect(iosCompactBar(true)).toBe(54);
        expect(iosCompactBar(false)).toBe(44);
        const inset = readFileSync(join(import.meta.dirname, '../src/navigation/bar-inset.ts'), 'utf8');
        expect(inset).toContain('useState(() => insets.top + iosCompactBar(hasLiquidGlass()))');
        // The transcript's top padding is its side padding past the bar.
        const chat = readFileSync(join(import.meta.dirname, '../src/screens/chat.tsx'), 'utf8');
        expect(chat).toContain('contentContainerStyle={{ padding: 16, paddingTop: 16 + barInset }}');
    });

    it('is the page editor’s and the page review editor’s compact one', () => {
        for (const name of ['PageEditor', 'PageReviewEditor'] as const) {
            expect(ROUTES[name].preset).toEqual(page({ header: 'native' }));
        }
    });

    it('is off only where a screen has no bar at all', () => {
        const off = Object.entries(ROUTES)
            .filter(([, route]) => route.preset.presentation === 'card' && route.preset.headerShown === false)
            .map(([name]) => name);
        expect(off).toEqual(['Tabs', 'NewChat', 'AddWorkspace', 'Lock']);
    });
});
