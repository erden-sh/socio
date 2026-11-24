import { createContext, useContext } from 'react';

import { readSidebarOpen } from '@/components/ui/sidebar';

/**
 * What the shell's first render needs from the browser, read from the
 * page request so the server and the browser render the same: the
 * shortcut's key and whether the sidebar starts open.
 */
export interface UiHints {
    /** An Apple platform: shortcuts show ⌘ instead of Ctrl. */
    mac: boolean;
    /** The sidebar's saved state (its cookie); open when there is none. */
    sidebarOpen: boolean;
}

/** From the page request: its User-Agent and the sidebar cookie. */
export const uiHints = (request: Request): UiHints => ({
    mac: /Mac|iPhone|iPad/.test(request.headers.get('user-agent') ?? ''),
    sidebarOpen: readSidebarOpen(request.headers.get('cookie') ?? ''),
});

/** Without a page request (tests): not Apple, sidebar open. */
export const defaultUiHints: UiHints = { mac: false, sidebarOpen: true };

export const UiHintsContext = createContext<UiHints>(defaultUiHints);

export const useUiHints = () => useContext(UiHintsContext);

/** The command palette's shortcut: "⌘K" on Apple platforms, else "Ctrl K". */
export const paletteShortcut = ({ mac }: UiHints) => (mac ? '⌘K' : 'Ctrl K');
