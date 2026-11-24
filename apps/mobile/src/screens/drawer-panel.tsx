import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import type { WorkspaceRow } from '../data/registry';
import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import type { MoreItem } from '../navigation/tabs';
import { listWorkspaces, startAdding, storeRoot, switchTo } from '../platform/active-scope';
import { OPENS_ON_THE_WEB } from '../shell/account';
import { moduleEntry } from '../shell/modules';
import { DRAWER_FOOTER, type DrawerFooterRow, type DrawerWorkspace, drawerWorkspaces } from '../shell/workspaces';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Button, AppSymbol, rowMinHeight, Text } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { useOpenLink } from './open-link';
import { CountBadge } from './shell-parts';
import { WorkspaceLogo } from './workspace-logo';

// What the workspace drawer shows (Slack's; src/shell/workspaces.ts):
// "Workspaces", then every workspace on the phone with its logo, name, host and
// unread, the open one highlighted; then Add a workspace, Settings and Help,
// the web's help center in the in-app browser, only while a workspace is
// open (the browser opens that workspace's).
// The header's Close is the way out VoiceOver can reach: the scrim is outside
// the panel's modal view.
// Tapping another workspace switches to it through the active scope:
// the app mounts again on that workspace's last screen. The list is read from
// the registry each time the drawer opens.

const FOOTER_ICONS: Readonly<Record<DrawerFooterRow['key'], SymbolName>> = {
    'add-workspace': 'plus',
    settings: 'settings',
    help: 'circle-help',
};

export interface DrawerPanelProps {
    readonly open: boolean;
    readonly onSettings: (id: MoreItem, label: string) => void;
    readonly onClose: () => void;
}

export function DrawerPanel(props: DrawerPanelProps) {
    return useHasWorkspaceScope() ? <ScopedPanel {...props} /> : <PanelBody {...props} openId={null} onWeb={null} />;
}

function ScopedPanel(props: DrawerPanelProps) {
    const openLink = useOpenLink();
    return (
        <PanelBody
            {...props}
            openId={useWorkspaceScope().workspace.id}
            onWeb={(href) => openLink(href, { web: true })}
        />
    );
}

function PanelBody(props: DrawerPanelProps & { openId: string | null; onWeb: ((href: string) => void) | null }) {
    const { onWeb } = props;
    const rows = useWorkspaces(props.open);
    const workspaces = rows === null ? [] : drawerWorkspaces(rows.list, props.openId, rows.root);
    const choose = (row: DrawerWorkspace) => {
        props.onClose();
        if (!row.active) {
            switchTo(row.id).catch((error: unknown) => console.warn('[drawer] could not switch', error));
        }
    };
    const footer = (row: DrawerFooterRow) => {
        switch (row.action.kind) {
            case 'add-workspace':
                props.onClose();
                startAdding();
                return;
            case 'settings':
                props.onSettings(row.action.id, moduleEntry(row.action.id).title);
                return;
            case 'web':
                props.onClose();
                onWeb?.(row.action.href);
                return;
        }
    };
    // A web row needs an open workspace: with none, it isn't shown.
    const footerRows = DRAWER_FOOTER.filter((row) => row.action.kind !== 'web' || onWeb !== null);
    return (
        <View className="flex-1" testID="drawer-panel">
            <ScrollView className="flex-1" contentContainerClassName="gap-1 px-2 pt-4 pb-3">
                <View className="flex-row items-center gap-1 pb-3 pl-2">
                    <Text
                        accessibilityRole="header"
                        variant="title1"
                        weight="semibold"

                        numberOfLines={1}
                        className="flex-1"
                    >
                        Workspaces
                    </Text>
                    <Button
                        variant="ghost"
                        iconOnly
                        icon="x"
                        label="Close workspaces"
                        onPress={props.onClose}
                        testID="close-drawer"
                    />
                </View>
                {workspaces.map((row) => (
                    <WorkspaceRowView key={row.id} row={row} onPress={() => choose(row)} />
                ))}
            </ScrollView>
            <View className="border-t border-tab-bar-border px-2 py-2" testID="drawer-footer">
                {footerRows.map((row) => (
                    <Pressable
                        key={row.key}
                        testID={row.testID}
                        accessibilityRole={row.action.kind === 'web' ? 'link' : 'button'}
                        accessibilityLabel={row.label}
                        accessibilityHint={row.action.kind === 'web' ? OPENS_ON_THE_WEB : undefined}
                        onPress={() => footer(row)}
                        className="min-h-11 flex-row items-center gap-3 rounded-md px-3 py-2 active:bg-tab-bar-active"
                    >
                        <AppSymbol name={FOOTER_ICONS[row.key]} size={20} color="tab-bar-muted-foreground" />
                        <Text className="min-w-0 flex-1">{row.label}</Text>
                        {row.action.kind === 'web' ? (
                            <AppSymbol name="external-link" size={16} color="tab-bar-muted-foreground" />
                        ) : null}
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

/** One workspace: its logo with its unread on the corner, its name and host; the open one highlighted. */
function WorkspaceRowView({ row, onPress }: { row: DrawerWorkspace; onPress: () => void }) {
    const colors = colorsOf(useScheme());
    return (
        <Pressable
            testID={row.testID}
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            accessibilityState={{ selected: row.active }}
            onPress={onPress}
            className={cx(
                'flex-row items-center gap-3 rounded-xl px-2 py-2',
                row.active ? 'bg-tab-bar-active' : 'active:bg-tab-bar-active',
            )}
            style={rowMinHeight(68)}
        >
            <View>
                {/* The 44 pt logo and its ring (52 pt), with 8 pt above and below, as at the sides. */}
                <WorkspaceLogo path={row.logoPath} size={44} ring={row.active ? colors.foreground : 'transparent'} />
                {row.unreadLabel === null ? null : (
                    <View className="absolute -top-1 -right-1">
                        <CountBadge label={row.unreadLabel} />
                    </View>
                )}
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="semibold" numberOfLines={1}>
                    {row.name}
                </Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                    {row.notice === null ? row.host : `${row.host} · ${row.notice}`}
                </Text>
            </View>
        </Pressable>
    );
}

/** The registry's workspaces and the store's root, read again each time the drawer opens. */
function useWorkspaces(open: boolean): { list: readonly WorkspaceRow[]; root: string } | null {
    const [rows, setRows] = useState<{ list: readonly WorkspaceRow[]; root: string } | null>(null);
    useEffect(() => {
        if (!open) {
            return;
        }
        let current = true;
        listWorkspaces().then(
            (list) => {
                if (current) {
                    setRows({ list, root: storeRoot() });
                }
            },
            (error: unknown) => console.warn('[drawer] could not list the workspaces', error),
        );
        return () => {
            current = false;
        };
    }, [open]);
    return rows;
}
