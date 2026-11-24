import { createContext, useContext, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';

import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

/**
 * The phone header's overflow menu (⋯): on phones the header shows the
 * page's title, one status indicator and this menu, which holds every
 * other header control (AppHeader).
 *
 * An item that opens something else (a dialog, the palette, a sheet, the
 * title box) calls `defer`: it runs once the menu has closed, with the
 * focus on the ⋯ button, so what it opens takes the focus and gives it
 * back there. Opened while the menu's layer is still up, a dialog or
 * popover would take the menu's own closing for a click outside.
 */
export interface HeaderMenu {
    /**
     * `open` gets the ⋯ button: a dialog it opens gives the focus back
     * there (DialogReturnFocus, components/ui/return-focus.ts).
     */
    defer: (open: (from: HTMLElement | null) => void) => void;
}

const HeaderMenuContext = createContext<HeaderMenu>({ defer: (open) => open(null) });

export const HeaderMenuProvider = HeaderMenuContext.Provider;

/** The open overflow menu's `defer`; outside it, runs at once. */
export const useHeaderMenu = () => useContext(HeaderMenuContext);

/**
 * The current page's own items in the overflow menu: the chat's or the
 * room's options, whose ⋯ beside the title is desktop only. One page at a
 * time; null when the page has none.
 */
let section: ReactNode = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
};
const publish = (next: ReactNode) => {
    section = next;
    for (const listener of listeners) {
        listener();
    }
};

/**
 * Puts `items` (menu items, rendered inside the overflow menu) in the
 * menu's page section until the returned cleanup runs: call it from an
 * effect.
 */
export function showInHeaderMenu(items: ReactNode) {
    publish(items);
    return () => {
        if (section === items) {
            publish(null);
        }
    };
}

/** The page section's items, null when the page has none. */
export const useHeaderMenuSection = () =>
    useSyncExternalStore(
        subscribe,
        () => section,
        () => null,
    );

/**
 * An overflow menu item that opens something else (the palette, a sheet,
 * a dialog): `open` runs once the menu has closed (`defer`).
 */
export function HeaderMenuItem({
    open,
    className,
    ...props
}: Omit<ComponentProps<typeof DropdownMenuItem>, 'onSelect'> & { open: (from: HTMLElement | null) => void }) {
    const { defer } = useHeaderMenu();
    return <DropdownMenuItem className={className ?? 'h-8.5'} onSelect={() => defer(open)} {...props} />;
}

/** The page's own items (`showInHeaderMenu`) under a separator. */
export function HeaderMenuPageSection() {
    const items = useHeaderMenuSection();
    if (!items) {
        return null;
    }
    return (
        <>
            <DropdownMenuSeparator className="mx-1 my-1.5" />
            {items}
        </>
    );
}
