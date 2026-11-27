import { ThemeProvider as NextThemesProvider, useTheme } from 'next-themes';
import type { ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';

import { useHydrated } from '../lib/client-only';

export type ThemeChoice = 'light' | 'dark' | 'system';

/** Where the choice is kept (per browser); public/theme-init.js reads it. */
export const THEME_STORAGE_KEY = 'theme';

const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/**
 * Light, Dark and System, in that order, with their words (`shell.help`,
 * loaded on demand: only menus and the palette show them).
 */
export function useThemeChoices(): { value: ThemeChoice; label: string }[] {
    const { t } = useTranslation(['shell.help']);
    return THEME_CHOICES.map((value) => ({ value, label: t(`shell.help:theme.${value}`) }));
}

/**
 * Light, dark or the system's (the default), as a `light`/`dark` class on
 * <html> that the `.dark` tokens in globals.css follow. The first paint is
 * themed by public/theme-init.js, a file the CSP allows; next-themes' own
 * inline script is rendered inert (a data block, which the CSP and React
 * both leave alone) because it would never run under `script-src 'self'`.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
    return (
        <NextThemesProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
            storageKey={THEME_STORAGE_KEY}
            scriptProps={{ type: 'application/json' }}
        >
            {children}
        </NextThemesProvider>
    );
}

/**
 * The stored choice (`system` until one is made) and its setter. The
 * server can't read the browser's storage, so until the page hydrates
 * this is `system`, as the server rendered it; the page itself is already
 * themed by then (theme-init.js).
 */
export function useThemeChoice() {
    const { theme, setTheme, resolvedTheme } = useTheme();
    const hydrated = useHydrated();
    const choice: ThemeChoice = hydrated && (theme === 'light' || theme === 'dark') ? theme : 'system';
    return {
        choice,
        resolved: hydrated && resolvedTheme === 'dark' ? 'dark' : 'light',
        setChoice: (next: ThemeChoice) => setTheme(next),
    } as const;
}
