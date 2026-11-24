import { StackActions, useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { type LeaveCheck, readLeaveCheck } from '../data/leave-workspace';
import type { WorkspaceRow } from '../data/registry';
import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { hostParts } from '../net/address';
import type { AuthedFetch } from '../net/authed-fetch';
import { listWorkspaces, startAdding, switchTo } from '../platform/active-scope';
import { leave, signOut, unsentItems } from '../platform/sign-out';
import {
    ACCOUNT_LINKS,
    type AccountLink,
    accountView,
    LEAVE_REFUSED_TITLE,
    LEAVE_WORKSPACE,
    leaveQuestion,
    leaveRow,
    OPENS_ON_THE_WEB,
    signOutQuestion,
    type SwitcherRow,
    switcherRows,
} from '../shell/account';
import { shellQuery, shellRows } from '../shell/queries';
import { Button, AppSymbol, rowMinHeight, Text } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { useOpenLink } from './open-link';
import { CountBadge, Section } from './shell-parts';
import { UnsentList } from './unsent-list';

// The account sheet: the open workspace, its host, and the person signed in
// (src/shell/account.ts), and Sign out, which asks first only when the
// workspace has unsent items, then wipes it (src/platform/sign-out.ts).
// Between them, the Unsent list (unsent-list.tsx). The workspace list moved to
// the drawer (screens/drawer-panel.tsx). `Switcher` stays for a workspace that didn't
// open (workspace-failed.tsx): a switch makes the workspace active, the open
// scope closes, the new one opens and the app opens on that workspace's last
// screen (src/platform/active-scope.ts).
//
// Leave workspace (CB-383) sits under Sign out: the server's check
// (`GET /api/account/leave`) as the sheet opens decides the row (hidden on a
// server without it, off with the server's reason when refused), a system
// alert asks first, and only the server's 200 runs the sign-out's wipe
// (src/platform/sign-out.ts `leave`). A refusal or no answer says why in an
// alert and keeps everything.
//
// Above them, the web's person menu (shell/account.ts ACCOUNT_LINKS):
// Report issue, which replaces the sheet with File an issue, then Getting
// started & guides, Release notes and Account & security, each the web's page
// in the in-app browser (useOpenLink) while the app has no screen of its own.

export function AccountScreen() {
    return useHasWorkspaceScope() ? <Account /> : null;
}

function Account() {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { state, workspace } = shellRows(shell);
    const view = accountView(scope.workspace, workspace, state);
    return (
        <View testID="account-sheet" className="gap-4 bg-sheet px-4 pt-6 pb-10">
            <View accessible accessibilityLabel={`${view.workspaceName}, ${view.host}`} className="gap-0.5">
                <Text accessibilityRole="header" variant="headline">
                    {view.workspaceName}
                </Text>
                <Text variant="footnote" tone="muted">
                    {view.host}
                </Text>
            </View>
            <View
                accessible
                accessibilityLabel={[view.personName, view.personEmail, view.role].filter(Boolean).join(', ')}
                className="gap-0.5 rounded-xl border border-border bg-card p-3"
                testID="account-person"
            >
                <Text weight="medium">{view.personName ?? 'Signed in'}</Text>
                {view.personEmail === null ? null : (
                    <Text variant="footnote" tone="muted">
                        {view.personEmail}
                    </Text>
                )}
                {view.role === null ? null : (
                    <Text variant="footnote" tone="muted">
                        {view.role}
                    </Text>
                )}
            </View>
            <UnsentList />
            <AccountLinks />
            <Button
                variant="ghost"
                label="Sign out"
                icon="log-out"
                onPress={() => void askThenSignOut(scope.workspace.id)}
                testID="sign-out"
            />
            <LeaveWorkspace workspaceName={view.workspaceName} />
        </View>
    );
}

const LINK_ICONS: Readonly<Record<AccountLink['key'], SymbolName>> = {
    'report-issue': 'bug',
    guides: 'compass',
    'release-notes': 'scroll-text',
    'account-security': 'key-round',
};

/** The web's person menu: Report issue, then the web's guides, release notes and account pages. */
function AccountLinks() {
    const navigation = useNavigation();
    const openLink = useOpenLink();
    const go = (link: AccountLink) => {
        if (link.target.kind === 'file-issue') {
            navigation.dispatch(StackActions.replace('FileIssue'));
            return;
        }
        openLink(link.target.href, { web: true });
    };
    return (
        <View className="rounded-xl border border-border bg-card" testID="account-links">
            {ACCOUNT_LINKS.map((link, index) => {
                const web = link.target.kind === 'web';
                return (
                    <Pressable
                        key={link.key}
                        testID={link.testID}
                        accessibilityRole={web ? 'link' : 'button'}
                        accessibilityLabel={link.label}
                        accessibilityHint={web ? OPENS_ON_THE_WEB : undefined}
                        onPress={() => go(link)}
                        className={cx(
                            'flex-row items-center gap-3 px-3 py-2 active:bg-accent',
                            index > 0 && 'border-t border-border',
                        )}
                        style={rowMinHeight(44)}
                    >
                        <AppSymbol name={LINK_ICONS[link.key]} color="muted-foreground" />
                        <Text className="min-w-0 flex-1">{link.label}</Text>
                        {web ? <AppSymbol name="external-link" size={16} color="muted-foreground" /> : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

/** The Leave workspace row (CB-383), by the server's check. */
function LeaveWorkspace({ workspaceName }: { workspaceName: string }) {
    const scope = useWorkspaceScope();
    const [check, setCheck] = useState<LeaveCheck | { kind: 'checking' }>({ kind: 'checking' });
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        void readLeaveCheck(scope.fetch, controller.signal).then((next) => {
            if (!controller.signal.aborted) {
                setCheck(next);
            }
        });
        return () => controller.abort();
    }, [scope]);
    const row = leaveRow(check);
    if (row === null) {
        return null;
    }
    const press = () => {
        setBusy(true);
        void askThenLeave(scope.workspace.id, workspaceName, scope.fetch)
            .then((refusal) => {
                if (refusal !== null) {
                    setCheck({ kind: 'refused', message: refusal });
                }
            })
            .finally(() => setBusy(false));
    };
    const disabled = !row.enabled || busy;
    return (
        <View className="gap-1">
            <Pressable
                testID="leave-workspace"
                accessibilityRole="button"
                accessibilityLabel={LEAVE_WORKSPACE}
                accessibilityHint={row.note ?? undefined}
                accessibilityState={{ disabled, busy }}
                disabled={disabled}
                onPress={press}
                className={cx(
                    'min-h-11 flex-row items-center justify-center gap-2 rounded-md px-4 py-2 active:bg-destructive/10',
                    disabled && 'opacity-50',
                )}
            >
                <AppSymbol name="door-open" color="destructive" />
                <Text weight="medium" tone="destructive">
                    {LEAVE_WORKSPACE}
                </Text>
            </Pressable>
            {row.note === null ? null : (
                <Text variant="footnote" tone="muted" className="text-center" testID="leave-workspace-note">
                    {row.note}
                </Text>
            )}
        </View>
    );
}

/**
 * Asks, then leaves workspace `id`. Cancel, back and a tap outside keep it.
 * Resolves the server's refusal (409) so the row shows it, else null.
 */
async function askThenLeave(id: string, name: string, fetch: AuthedFetch): Promise<string | null> {
    const question = leaveQuestion(name, await unsentItems(id));
    const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
            question.title,
            question.message,
            [
                { text: question.cancel, style: 'cancel', onPress: () => resolve(false) },
                { text: question.confirm, style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
        );
    });
    if (!confirmed) {
        return null;
    }
    const outcome = await leave(id, fetch);
    if (outcome.kind === 'left') {
        return null;
    }
    Alert.alert(LEAVE_REFUSED_TITLE, outcome.message);
    return outcome.kind === 'refused' ? outcome.message : null;
}

/** Signs out of workspace `id`, asking first when it has unsent items. Cancel, back and a tap outside keep it. */
async function askThenSignOut(id: string): Promise<void> {
    const question = signOutQuestion(await unsentItems(id));
    if (question !== null) {
        const confirmed = await new Promise<boolean>((resolve) => {
            Alert.alert(
                question.title,
                question.message,
                [
                    { text: question.cancel, style: 'cancel', onPress: () => resolve(false) },
                    { text: question.confirm, style: 'destructive', onPress: () => resolve(true) },
                ],
                { cancelable: true, onDismiss: () => resolve(false) },
            );
        });
        if (!confirmed) {
            return;
        }
    }
    await signOut(id);
}

/**
 * The switcher and Add a workspace, from the registry: the one a workspace
 * that didn't open offers (workspace-failed.tsx, with `failed` and no scope). Tapping workspace `openId` calls `onOpen`; any other
 * switches to it.
 */
export function Switcher({ openId, onOpen, failed }: { openId: string; onOpen: () => void; failed?: boolean }) {
    const rows = switcherRows(useWorkspaces(), openId, { failed });
    const choose = (row: SwitcherRow) => {
        if (row.open) {
            onOpen();
            return;
        }
        switchTo(row.id).catch((error: unknown) => console.warn('[switcher] could not switch', error));
    };
    return (
        <>
            {rows.length === 0 ? null : (
                <Section title="Workspaces" testID="switcher">
                    {rows.map((row, index) => (
                        <WorkspaceChoice key={row.id} row={row} first={index === 0} onPress={() => choose(row)} />
                    ))}
                </Section>
            )}
            <Button
                variant="secondary"
                label="Add a workspace"
                icon="plus"
                onPress={startAdding}
                testID="add-another-workspace"
            />
        </>
    );
}

/** The workspaces on the phone, read from the registry each time the sheet opens. */
function useWorkspaces(): readonly WorkspaceRow[] {
    const [rows, setRows] = useState<readonly WorkspaceRow[]>([]);
    useEffect(() => {
        let current = true;
        listWorkspaces().then(
            (list) => {
                if (current) {
                    setRows(list);
                }
            },
            (error: unknown) => console.warn('[switcher] could not list the workspaces', error),
        );
        return () => {
            current = false;
        };
    }, []);
    return rows;
}

/** One workspace in the switcher: its name, host (the registrable domain emphasized), person, state and unread. */
function WorkspaceChoice({ row, first, onPress }: { row: SwitcherRow; first: boolean; onPress: () => void }) {
    const { lead, domain, port } = hostParts(row.host);
    const person = [row.personName, row.personEmail].filter((part) => part !== null && part !== '').join(' · ');
    return (
        <Pressable
            testID={`switch-${row.host}`}
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            accessibilityState={{ selected: row.open }}
            onPress={onPress}
            className={cx('flex-row items-center gap-3 p-3 active:bg-accent', !first && 'border-t border-border')}
            style={rowMinHeight(76)}
        >
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="medium" numberOfLines={1}>
                    {row.name}
                </Text>
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                    {lead}
                    <Text variant="footnote" weight="semibold">
                        {domain}
                    </Text>
                    {port}
                </Text>
                {person === '' ? null : (
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {person}
                    </Text>
                )}
            </View>
            <View className="items-end gap-1">
                <Text variant="footnote" tone="muted" testID={`switch-badge-${row.host}`}>
                    {row.waitingLabel === null ? row.badgeLabel : `${row.badgeLabel} · ${row.waitingLabel}`}
                </Text>
                {row.unreadLabel === null ? null : <CountBadge label={row.unreadLabel} />}
            </View>
        </Pressable>
    );
}
