import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import theme from '../../src/theme/generated/theme.json';
import {
    type FontPlatform,
    NAVIGATION_COLORS,
    NAVIGATION_WEIGHTS,
    navigationTheme,
} from '../../src/theme/navigation-theme';
import { SCHEMES } from '../../src/theme/theme';

// React Navigation's themes come from theme.json (src/theme/navigation-theme.ts),
// not its stock DefaultTheme and DarkTheme: every color the navigator draws
// with, in light and dark, is one of the web's tokens.

const app = join(import.meta.dirname, '../..');
const PLATFORMS: FontPlatform[] = ['ios', 'android'];

/** The keys of a theme object in React Navigation's own source (its themes import React Native, so Node reads them as text). */
function stockKeys(file: string, object: 'colors' | 'fonts'): string[] {
    const native = dirname(createRequire(join(app, 'package.json')).resolve('@react-navigation/native/package.json'));
    const source = readFileSync(join(native, 'lib/module/theming', file), 'utf8');
    if (object === 'colors') {
        const body = /colors:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
        return [...body.matchAll(/(\w+):/g)].map((match) => match[1]!);
    }
    const ios = /ios:\s*\{([\s\S]*?)\n {2}\}/.exec(source)?.[1] ?? '';
    return [...ios.matchAll(/^ {4}(\w+): \{/gm)].map((match) => match[1]!);
}

describe('the navigation themes', () => {
    it('set every color React Navigation’s stock themes set, and only those', () => {
        expect(Object.keys(NAVIGATION_COLORS).sort()).toEqual(stockKeys('DarkTheme.js', 'colors').sort());
        expect(Object.keys(NAVIGATION_COLORS).sort()).toEqual(stockKeys('DefaultTheme.js', 'colors').sort());
        expect(Object.keys(NAVIGATION_WEIGHTS).sort()).toEqual(stockKeys('fonts.js', 'fonts').sort());
    });

    it.each(SCHEMES)('take each %s color from its token in theme.json', (scheme) => {
        for (const platform of PLATFORMS) {
            const built = navigationTheme(scheme, platform);
            expect(built.dark).toBe(scheme === 'dark');
            expect(Object.keys(built.colors).sort()).toEqual(Object.keys(NAVIGATION_COLORS).sort());
            for (const [role, token] of Object.entries(NAVIGATION_COLORS)) {
                const value = built.colors[role as keyof typeof NAVIGATION_COLORS];
                expect(value, `${scheme} ${role}`).toBe(theme[scheme].colors[token]);
                expect(value).toMatch(/^#[\da-f]{6}$/);
            }
        }
    });

    it('draw screens on the screen role and headers on the header role, which differ between the schemes', () => {
        const light = navigationTheme('light', 'ios');
        const dark = navigationTheme('dark', 'ios');
        expect(light.colors.background).toBe(theme.light.colors.screen);
        expect(dark.colors.background).toBe(theme.dark.colors.screen);
        expect(light.colors.card).toBe(theme.light.colors.header);
        expect(dark.colors.text).toBe(theme.dark.colors['header-foreground']);
        for (const role of Object.keys(NAVIGATION_COLORS) as (keyof typeof NAVIGATION_COLORS)[]) {
            expect(light.colors[role], role).not.toBe(dark.colors[role]);
        }
    });

    it('use the system font in the web’s weights: headers semibold', () => {
        for (const platform of PLATFORMS) {
            const { fonts } = navigationTheme('light', platform);
            expect(fonts.regular.fontWeight).toBe(String(theme.type.weights.normal));
            expect(fonts.medium.fontWeight).toBe(String(theme.type.weights.medium));
            expect(fonts.bold.fontWeight).toBe(String(theme.type.weights.semibold));
            expect(fonts.heavy.fontWeight).toBe(String(theme.type.weights.bold));
            expect(navigationTheme('dark', platform).fonts).toEqual(fonts);
        }
        expect(navigationTheme('light', 'ios').fonts.regular.fontFamily).toBe('System');
        expect(navigationTheme('light', 'android').fonts.regular.fontFamily).toBe('sans-serif');
        expect(navigationTheme('light', 'android').fonts.medium.fontFamily).toBe('sans-serif-medium');
    });

    it('replace the stock themes in the app’s root', () => {
        const root = readFileSync(join(app, 'src/app.tsx'), 'utf8');
        expect(root).not.toMatch(/\b(?:DarkTheme|DefaultTheme)\b/);
        expect(root).toMatch(/navigationTheme\('light', fonts\)/);
        expect(root).toMatch(/navigationTheme\('dark', fonts\)/);
    });
});
