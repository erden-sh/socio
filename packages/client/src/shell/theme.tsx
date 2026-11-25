import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { DEFAULT_THEME_ID, resolveAppearance, type ColorMode } from '@socio/shared/settings/appearance';
import type { State, WorkspaceState } from '@socio/shared/types';
import type { DocumentAppearance } from '@socio/shared/web/web';

import { ShellContext } from './shell-context';

export type ThemeChoice = ColorMode;
type Scheme = Exclude<ThemeChoice, 'system'>;

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

export const DEFAULT_DOCUMENT_APPEARANCE: DocumentAppearance = {
    themeId: DEFAULT_THEME_ID,
    workspaceThemeId: DEFAULT_THEME_ID,
    colorMode: 'system',
    signedIn: false,
};

const darkQuery = '(prefers-color-scheme: dark)';
const AppearanceSync = createContext<(value: DocumentAppearance | undefined) => void>(() => {});
const ThemeContext = createContext<{
    choice: ThemeChoice;
    resolved: Scheme;
    setAnonymousChoice(next: ThemeChoice): void;
}>({ choice: 'system', resolved: 'light', setAnonymousChoice: () => {} });

function readAnonymousChoice(): ThemeChoice {
    try {
        return resolveAppearance({ colorMode: localStorage.getItem(THEME_STORAGE_KEY) }).colorMode;
    } catch {
        return 'system';
    }
}

export function ThemeProvider({
    children,
    appearance = DEFAULT_DOCUMENT_APPEARANCE,
}: {
    children: ReactNode;
    appearance?: DocumentAppearance;
}) {
    const [live, setLive] = useState<DocumentAppearance>();
    const [anonymousChoice, setAnonymousChoice] = useState<ThemeChoice>('system');
    const [system, setSystem] = useState<Scheme>('light');
    const active = live ?? appearance;
    const choice = active.signedIn ? active.colorMode : anonymousChoice;
    const resolved = choice === 'system' ? system : choice;
    useLayoutEffect(() => {
        const query = window.matchMedia(darkQuery);
        const syncSystem = () => setSystem(query.matches ? 'dark' : 'light');
        const syncAnonymous = () => setAnonymousChoice(readAnonymousChoice());
        syncSystem();
        syncAnonymous();
        query.addEventListener('change', syncSystem);
        window.addEventListener('storage', syncAnonymous);
        return () => {
            query.removeEventListener('change', syncSystem);
            window.removeEventListener('storage', syncAnonymous);
        };
    }, []);
    useLayoutEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = active.themeId;
        root.dataset.appearanceScope = active.signedIn ? 'account' : 'browser';
        root.dataset.colorMode = choice;
        root.dataset.scheme = resolved;
        root.classList.toggle('dark', resolved === 'dark');
        root.classList.toggle('light', resolved === 'light');
        root.style.colorScheme = resolved;
        const canvas = getComputedStyle(root).getPropertyValue('--background').trim();
        if (canvas) {
            for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
                meta.setAttribute('content', canvas);
            }
        }
    }, [active.themeId, active.signedIn, choice, resolved]);
    const setAnonymous = (next: ThemeChoice) => {
        setAnonymousChoice(next);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
            // An anonymous choice can still apply for this tab.
        }
    };
    return (
        <AppearanceSync.Provider value={setLive}>
            <ThemeContext.Provider value={{ choice, resolved, setAnonymousChoice: setAnonymous }}>
                {children}
            </ThemeContext.Provider>
        </AppearanceSync.Provider>
    );
}

/** Publish changes from the existing shell poll without remounting the document or its children. */
export function useWorkspaceTheme(state: State | undefined, workspace: WorkspaceState | undefined, signedOut: boolean) {
    const setAppearance = useContext(AppearanceSync);
    const lastWorkspaceTheme = useRef<DocumentAppearance['workspaceThemeId']>(undefined);
    const defaultThemeId = state?.settings.defaultThemeId;
    const signedIn = !!workspace;
    const personalThemeId = workspace?.preferences?.themeId;
    const colorMode = workspace?.preferences?.colorMode;
    useLayoutEffect(() => {
        if (signedIn) {
            const workspaceThemeId = resolveAppearance({ defaultThemeId }).themeId;
            lastWorkspaceTheme.current = workspaceThemeId;
            setAppearance({
                ...resolveAppearance({ defaultThemeId, personalThemeId, colorMode }),
                workspaceThemeId,
                signedIn: true,
            });
            return;
        }
        const workspaceThemeId = lastWorkspaceTheme.current;
        setAppearance(
            signedOut && workspaceThemeId
                ? { themeId: workspaceThemeId, workspaceThemeId, colorMode: 'system', signedIn: false }
                : undefined,
        );
    }, [setAppearance, signedIn, signedOut, defaultThemeId, personalThemeId, colorMode]);
    useLayoutEffect(() => () => setAppearance(undefined), [setAppearance]);
}

export function useThemeChoice() {
    const { choice, resolved, setAnonymousChoice } = useContext(ThemeContext);
    const shell = useContext(ShellContext);
    return {
        choice,
        resolved,
        setChoice(next: ThemeChoice) {
            if (shell) {
                void shell.mutate('/preferences', 'PATCH', { colorMode: next });
            } else {
                setAnonymousChoice(next);
            }
        },
    } as const;
}
