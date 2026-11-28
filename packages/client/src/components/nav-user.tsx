import { ChevronsUpDown, KeyRound, LogOut, QrCode, ScrollText, Smartphone, X } from 'lucide-react';
import { useContext, useEffect, useState, type ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { roleLabel } from '@socio/shared/roles';
import type { User } from '@socio/shared/types';

import { onDemand } from '../i18n/on-demand';
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
                            {/* A release's number as it is written everywhere (v0.58.0), in every language. */}
                            <span data-slot="server-version" className="tabular-nums">{`v${version}`}</span>
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
/**
 * The sidebar's suggestion to add a passkey: one quiet row, dismissed with
 * its ×, instead of a boxed card. Shown in the browser only, after a check;
 * its words load on demand (shell.help).
 */
const PasskeyPrompt = onDemand(
    ['shell.help'],
    function PasskeyPrompt({ onAdd, onDismiss }: { onAdd: () => void; onDismiss: () => void }) {
        const { t } = useTranslation(['shell.help']);
        return (
            <SidebarMenuItem data-slot="passkey-prompt">
                <SidebarMenuButton
                    aria-label={t('shell.help:passkey.add')}
                    title={t('shell.help:passkey.hint')}
                    onClick={onAdd}
                >
                    <KeyRound />
                    <span>{t('shell.help:passkey.add')}</span>
                </SidebarMenuButton>
                <SidebarMenuAction
                    aria-label={t('shell.help:passkey.not-now')}
                    title={t('shell.help:passkey.not-now')}
                    onClick={onDismiss}
                >
                    <X />
                </SidebarMenuAction>
            </SidebarMenuItem>
        );
    },
);

/**
 * The account menu's own items, below the modules' (`account.items`): Get
 * the app, Release notes, Add a device, Account and Sign out. The menu
 * opens with a click, so their words load on demand (shell.help, with the
 * Theme submenu's); nothing shows until they're in.
 */
const AccountItems = onDemand(
    ['shell.help'],
    function AccountItems({
        appLink,
        onGetApp,
        onReleaseNotes,
        onAddDevice,
        onAccount,
        onSwitchUser,
        accounts,
    }: {
        appLink: boolean;
        onGetApp: () => void;
        onReleaseNotes?: () => void;
        /** Set where the Socio app can reach this workspace (CB-352). */
        onAddDevice?: () => void;
        onAccount?: () => void;
        onSwitchUser: () => void;
        /** Real accounts (Better Auth), with security settings and Sign out; mock users switch. */
        accounts: boolean;
    }) {
        const { t } = useTranslation(['shell.help']);
        return (
            <>
                {appLink && (
                    <DropdownMenuItem onSelect={onGetApp}>
                        <QrCode />
                        {t('shell.help:account.get-app')}
                    </DropdownMenuItem>
                )}
                {onReleaseNotes && (
                    <DropdownMenuItem onSelect={onReleaseNotes}>
                        <ScrollText />
                        {t('shell.help:account.release-notes')}
                    </DropdownMenuItem>
                )}
                {onAddDevice && (
                    <DropdownMenuItem onSelect={onAddDevice}>
                        <Smartphone />
                        {t('shell.help:account.add-device')}
                    </DropdownMenuItem>
                )}
                {onAccount && (
                    <DropdownMenuItem onSelect={onAccount}>
                        <KeyRound />
                        {accounts ? t('shell.help:account.account-security') : t('shell.help:account.account')}
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={onSwitchUser}>
                    <LogOut />
                    {accounts ? t('shell.help:account.sign-out') : t('shell.help:account.switch-user')}
                </DropdownMenuItem>
            </>
        );
    },
);

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
    const { t } = useTranslation(['shell']);
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
            {passkeyPrompt && state === 'expanded' && (
                <PasskeyPrompt
                    onAdd={() => {
                        dismissPasskeyPrompt();
                        onAccount?.();
                    }}
                    onDismiss={dismissPasskeyPrompt}
                />
            )}
            <SidebarMenuItem className="relative">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size="lg"
                            aria-label={t('shell:account-menu', { name: user.name })}
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
                        <AccountItems
                            appLink={!!appLink}
                            onGetApp={() => setGettingApp(true)}
                            onReleaseNotes={onReleaseNotes}
                            onAddDevice={reach.addDevice ? () => setAdding(true) : undefined}
                            onAccount={onAccount}
                            onSwitchUser={onSwitchUser}
                            accounts={!!methods}
                        />
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
