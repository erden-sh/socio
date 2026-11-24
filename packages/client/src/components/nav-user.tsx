import { ChevronsUpDown, KeyRound, LogOut, QrCode, ScrollText, Smartphone, X } from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';

import { roleLabel } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { AddDeviceDialog } from '../shell/AddDeviceDialog';
import { useAppReach } from '../shell/app-reach';
import { listPasskeys, passkeyCheck } from '../shell/auth-client';
import { ConnectionDot } from '../shell/ConnectionBadge';
import { SignInSetup } from '../shell/current-user';
import { GetTheAppDialog, useAppLink } from '../shell/GetTheApp';

import { ThemeSubmenu } from '@/components/theme-toggle';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from '@/components/ui/sidebar';

const initials = (name: string) =>
    name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]!.toUpperCase())
        .join('') || '?';

/**
 * Who is signed in: initials, name, and their role with the server's
 * version (CB-308: the version moved here from under the logo, for
 * everyone).
 */
function Identity({ user, version }: { user: User; version?: string }) {
    return (
        <>
            <Avatar className="size-8 rounded-lg">
                <AvatarFallback className="rounded-lg bg-sidebar-accent text-xs font-medium">
                    {initials(user.name)}
                </AvatarFallback>
            </Avatar>
            <span className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs text-sidebar-muted-foreground">
                    {roleLabel(user.role)}
                    {version && (
                        <>
                            {' · '}
                            <span data-slot="server-version" className="tabular-nums">
                                v{version}
                            </span>
                        </>
                    )}
                </span>
            </span>
        </>
    );
}

/**
 * After a sign-in without a passkey (by a link or a password), suggests
 * adding one in the sidebar footer, until the person adds one or says not
 * now. Returns whether to show it, and how to put it away. The list is
 * asked for once after that sign-in, not on every page load (CB-68).
 */
function usePasskeyPrompt(userId: string, passkeys: boolean) {
    const key = `socio-passkey-prompt:${userId}`;
    const [show, setShow] = useState(false);
    useEffect(() => {
        if (!passkeys || localStorage.getItem(key)) {
            return;
        }
        const check = passkeyCheck.get();
        if (check === `show:${userId}`) {
            return setShow(true);
        }
        if (check !== 'pending') {
            return;
        }
        let cancelled = false;
        listPasskeys()
            .then((list) => {
                passkeyCheck.set(list.length === 0 ? `show:${userId}` : null);
                if (!cancelled) {
                    setShow(list.length === 0);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [key, userId, passkeys]);
    const dismiss = () => {
        localStorage.setItem(key, 'dismissed');
        passkeyCheck.set(null);
        setShow(false);
    };
    return [show, dismiss] as const;
}

/**
 * The sidebar footer: who is signed in, with the connection's dot beside
 * them, and the account menu. The account dialog itself belongs to the
 * shell (`onAccount`), so the chat can open it. `items` are the modules'
 * menu items (the `account.items` slot).
 */
export function NavUser({
    user,
    version,
    onSwitchUser,
    onAccount,
    onReleaseNotes,
    items,
}: {
    user: User;
    /** The running server release, shown after the role. */
    version?: string;
    onSwitchUser: () => void;
    onAccount?: () => void;
    /** Opens the release notes (CB-168). */
    onReleaseNotes?: () => void;
    items?: ReactNode;
}) {
    const { isMobile, state } = useSidebar();
    // Real accounts (Better Auth) have security settings; mock users don't.
    const methods = useContext(SignInSetup);
    const [passkeyPrompt, dismissPasskeyPrompt] = usePasskeyPrompt(user.id, !!methods?.passkey);
    // Add a device (CB-352): where the Socio app can reach this workspace.
    const reach = useAppReach(!!methods);
    const [adding, setAdding] = useState(false);
    // "Get the app" (CB-352): where the workspace sends app links.
    const appLink = useAppLink();
    const [gettingApp, setGettingApp] = useState(false);
    return (
        <SidebarMenu>
            {/* One quiet row, dismissed with its ×, instead of a boxed card. */}
            {passkeyPrompt && state === 'expanded' && (
                <SidebarMenuItem data-slot="passkey-prompt">
                    <SidebarMenuButton
                        aria-label="Add a passkey"
                        title="Next time, sign in with your fingerprint, face or PIN"
                        onClick={() => {
                            dismissPasskeyPrompt();
                            onAccount?.();
                        }}
                    >
                        <KeyRound />
                        <span>Add a passkey</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction aria-label="Not now" title="Not now" onClick={dismissPasskeyPrompt}>
                        <X />
                    </SidebarMenuAction>
                </SidebarMenuItem>
            )}
            <SidebarMenuItem className="relative">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            aria-label={`Account: ${user.name}`}
                            tooltip={state === 'collapsed' ? user.name : undefined}
                            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                        >
                            <Identity user={user} version={version} />
                            {/* Room for the connection's dot, a sibling button. */}
                            <span aria-hidden className="size-6 shrink-0" />
                            <ChevronsUpDown className="ml-auto" />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                        side={isMobile ? 'bottom' : 'right'}
                        align="end"
                        sideOffset={4}
                    >
                        <DropdownMenuLabel className="p-0 font-normal">
                            <span className="flex items-center gap-2 px-1 py-1.5">
                                <Identity user={user} version={version} />
                            </span>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <ThemeSubmenu />
                        <DropdownMenuSeparator />
                        {items}
                        {appLink && (
                            <DropdownMenuItem onSelect={() => setGettingApp(true)}>
                                <QrCode />
                                Get the app
                            </DropdownMenuItem>
                        )}
                        {onReleaseNotes && (
                            <DropdownMenuItem onSelect={onReleaseNotes}>
                                <ScrollText />
                                Release notes
                            </DropdownMenuItem>
                        )}
                        {reach.addDevice && (
                            <DropdownMenuItem onSelect={() => setAdding(true)}>
                                <Smartphone />
                                Add a device
                            </DropdownMenuItem>
                        )}
                        {onAccount && (
                            <DropdownMenuItem onSelect={onAccount}>
                                <KeyRound />
                                {methods ? <>Account &amp; security</> : 'Account'}
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={onSwitchUser}>
                            <LogOut />
                            {methods ? 'Sign out' : 'Switch user'}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
                {/* Beside the trigger, not in it: a button can't hold a button.
            Collapsed to icons, the header's badge speaks for it. */}
                <ConnectionDot className="absolute top-1/2 right-8 -translate-y-1/2 group-data-[collapsible=icon]:hidden" />
                {adding && <AddDeviceDialog onClose={() => setAdding(false)} />}
                {gettingApp && appLink && <GetTheAppDialog link={appLink} onClose={() => setGettingApp(false)} />}
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
