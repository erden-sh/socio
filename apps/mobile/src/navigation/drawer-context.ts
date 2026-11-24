import { createContext, useContext } from 'react';

// The workspace drawer's controls, for Home's header, whose
// workspace button opens it (screens/home.tsx). Only the drawer
// (shell-drawer.tsx) provides them, so a header outside the tabs has none.

export interface DrawerControls {
    open(): void;
    close(): void;
}

export const DrawerContext = createContext<DrawerControls | null>(null);

/** The drawer's controls inside the tabs, else null. */
export const useDrawer = () => useContext(DrawerContext);
