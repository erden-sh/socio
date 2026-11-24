import type { Theme } from '@react-navigation/native';

import { type ColorToken, type FontWeightName, type Scheme, theme } from './theme';

// React Navigation's themes, built from the web's tokens (theme.json) instead
// of its stock DefaultTheme and DarkTheme: the native stack's headers, the
// screens behind them and later the tab bar take the web's colors, in the
// system's scheme. No React Native here (only its types), so the Node tests
// build them as the app does.
//
// Based on T3 Code's apps/mobile/src/lib/useMobileNavigationTheme.ts
// (https://github.com/pingdotgg/t3code, commit 240446e2d9, MIT, Copyright (c)
// 2026 T3 Tools Inc.; the license is in THIRD_PARTY_NOTICES at the repository
// root): each navigation color from one mobile role (screen, header), and the
// dark flag native-stack reads to pick dark headers. Its fonts came from the
// stock themes; these take the web's weights.

/** Each color React Navigation draws with, and the token it takes. */
export const NAVIGATION_COLORS = {
    // Back buttons, the selected tab.
    primary: 'primary',
    // Behind every screen.
    background: 'screen',
    // Headers and the tab bar.
    card: 'header',
    // Header titles.
    text: 'header-foreground',
    // Under headers, over the tab bar.
    border: 'border',
    // Badges.
    notification: 'destructive',
} as const satisfies Record<keyof Theme['colors'], ColorToken>;

/** Each of React Navigation's font roles, and the web weight it takes: headers are semibold, as the web's. */
export const NAVIGATION_WEIGHTS = {
    regular: 'normal',
    medium: 'medium',
    bold: 'semibold',
    heavy: 'bold',
} as const satisfies Record<keyof Theme['fonts'], FontWeightName>;

export type FontPlatform = 'ios' | 'android';

/** The system font, as React Navigation names it: SF Pro on iOS, Roboto on Android (medium has its own name). */
const FAMILIES: Record<FontPlatform, Record<keyof Theme['fonts'], string>> = {
    ios: { regular: 'System', medium: 'System', bold: 'System', heavy: 'System' },
    android: { regular: 'sans-serif', medium: 'sans-serif-medium', bold: 'sans-serif', heavy: 'sans-serif' },
};

type FontWeight = Theme['fonts']['regular']['fontWeight'];

/** The navigation theme for a scheme, with the platform's system font. */
export function navigationTheme(scheme: Scheme, platform: FontPlatform): Theme {
    const { colors } = theme[scheme];
    const color = (role: keyof Theme['colors']) => colors[NAVIGATION_COLORS[role]];
    const font = (role: keyof Theme['fonts']) => ({
        fontFamily: FAMILIES[platform][role],
        fontWeight: String(theme.type.weights[NAVIGATION_WEIGHTS[role]]) as FontWeight,
    });
    return {
        dark: scheme === 'dark',
        colors: {
            primary: color('primary'),
            background: color('background'),
            card: color('card'),
            text: color('text'),
            border: color('border'),
            notification: color('notification'),
        },
        fonts: {
            regular: font('regular'),
            medium: font('medium'),
            bold: font('bold'),
            heavy: font('heavy'),
        },
    };
}
