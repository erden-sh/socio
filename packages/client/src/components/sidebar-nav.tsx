import { createContext, useContext } from 'react';
import { NavLink, useMatch } from 'react-router';

import type { Dot } from '@socio/shared/types';

import type { ModuleContext } from '../modules/types';

import { SidebarMenuButton } from '@/components/ui/sidebar';

/**
 * What a module's sidebar group (`navGroups`) gets from the sidebar: the
 * user's context, the shell's actions, and `close` (closes the mobile sheet;
 * call it before every navigation).
 */
export interface SidebarNav {
    context: ModuleContext;
    /** The Dot the main area is chatting with, highlighted on chat routes. */
    activeDotId?: string;
    close: () => void;
    /** Wraps an action so it closes the mobile sheet first. */
    go: <Args extends unknown[]>(action: (...args: Args) => void) => (...args: Args) => void;
    onNewChat: () => void;
    onEditDot: (dot: Dot) => void;
    onCreateDot: () => void;
    onCreateSpace: () => void;
}

export const SidebarNavContext = createContext<SidebarNav | undefined>(undefined);

export function useSidebarNav() {
    const nav = useContext(SidebarNavContext);
    if (!nav) {
        throw new Error('useSidebarNav outside the sidebar');
    }
    return nav;
}

/**
 * A sidebar link to a route, active (highlighted, `aria-current`) while the
 * URL is exactly its path, or anywhere below it with `activeBelow`.
 */
export function NavButton({
    to,
    onNavigate,
    reloadDocument,
    activeBelow = false,
    ...props
}: Omit<React.ComponentProps<typeof SidebarMenuButton>, 'asChild'> & {
    to: string;
    reloadDocument?: boolean;
    /** Active on any address below `to` too, segment by segment (a plugin's deep links). */
    activeBelow?: boolean;
    onNavigate: () => void;
}) {
    const active = !!useMatch({ path: to, end: !activeBelow });
    const { children, title, ...button } = props;
    return (
        <SidebarMenuButton asChild isActive={active} {...button}>
            <NavLink to={to} reloadDocument={reloadDocument} end={!activeBelow} title={title} onClick={onNavigate}>
                {children}
            </NavLink>
        </SidebarMenuButton>
    );
}
