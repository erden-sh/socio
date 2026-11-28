import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, Switch, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';

import type { Appearance, DeviceSettings } from '../data/registry';
import {
    useCollections,
    useHasWorkspaceScope,
    useKeptSpaces,
    useLiveQuery,
    useSyncStatus,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { clearLocalCache, localCacheSize } from '../platform/active-scope';
import { BUILD_INFO } from '../platform/build-info';
import { deviceSettings, useDeviceSettings } from '../platform/device-settings';
import { useNotificationAsk } from '../platform/notification-ask';
import { settingsRow } from '../push';
import { accountView } from '../shell/account';
import { buildCopyText, originLine, versionLine } from '../shell/build-info';
import {
    KEEP_FAILED,
    KEEP_NEEDS_UPDATE,
    type KeptSpaceRow,
    keptSpaceRows,
    type KeptSpaceSizeLike,
    KEPT_SPACES_SECTION,
} from '../shell/keep-offline';
import { moduleEntry } from '../shell/modules';
import { NOTIFICATIONS_ROW } from '../shell/notification-settings';
import { shellQuery, shellRows, spacesQuery } from '../shell/queries';
import { parseServerBuild, SERVER_RELEASES_PATH, type ServerBuild, serverVersionLine } from '../shell/server-version';
import {
    ACCOUNT_NOTE,
    ACCOUNT_TITLE,
    accountRow,
    ADVANCED_ROW,
    APPEARANCE_CHOICES,
    APPEARANCE_HINT,
    APPEARANCE_TITLE,
    appearanceLabel,
    CACHE_NOTE,
    cacheLine,
    CLEAR_CACHE_FAILED,
    CLEAR_CACHE_QUESTION,
    HAPTICS_ROW,
    SETTINGS_HEADING,
    type SwitchRow,
    WEB_SETTINGS_ROW,
} from '../shell/settings';
import { TECHNICAL_DETAILS_ROW } from '../shell/technical-details';
import { REMOVE_SECTION_TITLE, REMOVE_WORKSPACE, removeWorkspaceNote } from '../shell/workspaces';
import { readAnswer } from '../sync/outbox-answers';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Button, AppSymbol, ROW_INSET, RowSeparator, Screen, SegmentedControl, separatorInset, Text } from '../ui';

import { LegalSection } from './legal-links';
import { MODULE_ICONS } from './module-icons';
import { NotificationPermissionRow } from './notification-permission-row';
import { useOpenLink } from './open-link';
import { askThenRemoveWorkspace } from './remove-workspace';
import { ListRow, PageIntro, Section } from './shell-parts';
import { SignInMethodsSection } from './sign-in-methods';

// Settings, from More and the
// drawer: "Settings" as the bar's large title in the module's tone (CB-420)
// and the web's line under it; Appearance (Light, Dark or System, applied app-wide by
// src/platform/device-settings.ts, then haptics); the person's name, read-only;
// Notifications; the open workspace's local cache with its size and Clear
// cache; Advanced mode; and "Everything else", the workspace's settings on the
// web. Appearance, haptics and Advanced mode are the phone's own
// (the registry, migrations 5 and 9), so they show with or without a
// workspace open; the rest are the open workspace's. Clear cache closes the
// workspace and opens it again on an empty cache, so the app mounts again on
// Home (src/sync/clear-cache.ts). Under it, the Spaces kept offline
// with what each holds, each a switch that stops keeping it; the section shows
// only while one is kept (the Space's header keeps one). At the bottom, which
// build is installed, ChatGPT's footer; a tap copies it. Notifications
// (src/push/permission-ask.ts) show while they aren't on: "Turn on
// notifications" before any ask (the system prompt), a row to the phone's
// Settings once denied, or the line saying this build can't have them; then,
// with a workspace open, the Notifications screen. Legal, with or
// without a workspace: socio.sh's privacy, terms, account deletion and support
// pages in the in-app browser (screens/legal-links.tsx), then who publishes it.

const SETTINGS_MODULE = moduleEntry(MODULE_IDS.settings);
/** Haptics' group, under Appearance. */
const FEEDBACK_TITLE = 'Feedback';

export function SettingsScreen() {
    const settings = useDeviceSettings();
    const open = useHasWorkspaceScope();
    useNativeBar({ title: SETTINGS_HEADING.title, tone: SETTINGS_MODULE.tone });
    return (
        // iOS's Settings: an inset grouped list on the system's grouped colors, no borders, the
        // notes under each section as its footer.
        <Screen testID="settings-screen" edges={['right', 'bottom', 'left']} grouped>
            <PageIntro
                subtitle={SETTINGS_HEADING.description}
                subtitleLines={0}
                tile={{ tone: SETTINGS_MODULE.tone, icon: MODULE_ICONS[SETTINGS_MODULE.icon] }}
                testID="settings-heading"
            />
            <Section title={APPEARANCE_TITLE} testID="settings-appearance" footer={APPEARANCE_HINT}>
                <AppearancePicker value={settings.appearance} />
            </Section>
            {/* Its own group, so each footer speaks for the rows above it (iOS's Settings). */}
            <Section title={FEEDBACK_TITLE} testID="settings-feedback" footer={HAPTICS_ROW.subtitle}>
                <SwitchRowView row={HAPTICS_ROW} settings={settings} first footer />
            </Section>
            {open ? <AccountSection /> : null}
            {open ? <SignInMethodsSection /> : null}
            <NotificationsSection />
            {open ? <LocalCache /> : null}
            {open ? <KeptSpacesSection /> : null}
            <Section title="Advanced" testID="settings-advanced-section" footer={ADVANCED_ROW.subtitle}>
                <SwitchRowView row={ADVANCED_ROW} settings={settings} first footer />
                {settings.advanced ? <TechnicalDetailsRow /> : null}
            </Section>
            {open ? <WebSettingsSection /> : null}
            {open ? <RemoveWorkspaceSection /> : null}
            <LegalSection />
            {open ? <WorkspaceBuildFooter /> : <BuildFooter server={null} />}
        </Screen>
    );
}

/** Light, Dark or System: the platform's segmented control, its hint the section's footer. */
function AppearancePicker({ value }: { value: Appearance }) {
    const choose = (appearance: Appearance) => {
        deviceSettings
            .set({ appearance })
            .catch((error: unknown) => console.warn('[settings] could not keep the appearance', error));
    };
    return (
        <View className="p-3">
            <SegmentedControl
                options={APPEARANCE_CHOICES.map((choice) => ({
                    ...choice,
                    accessibilityLabel: appearanceLabel(choice.value),
                }))}
                selected={value}
                onSelect={choose}
                accessibilityLabel={APPEARANCE_TITLE}
                testID="settings-appearance-picker"
            />
        </View>
    );
}

/** The person's name in the open workspace, read-only: it changes on the web. */
function AccountSection() {
    const scope = useWorkspaceScope();
    const { data: shell } = useLiveQuery({ query: shellQuery(useCollections()) });
    const { workspace, state } = shellRows(shell);
    const account = accountView(scope.workspace, workspace, state);
    const row = accountRow({ name: account.personName, email: account.personEmail });
    if (row === null) {
        return null;
    }
    return (
        <Section title={ACCOUNT_TITLE} testID="settings-account" footer={ACCOUNT_NOTE}>
            <View
                accessible
                accessibilityLabel={row.accessibilityLabel}
                className="gap-0.5 p-3"
                style={{ minHeight: 56 }}
                testID="settings-account-name"
            >
                <Text>{row.name}</Text>
                {row.email === null ? null : (
                    <Text variant="footnote" tone="muted">
                        {row.email}
                    </Text>
                )}
            </View>
        </Section>
    );
}

/** Remove from this device (CB-573): the open workspace, after the drawer's question. */
function RemoveWorkspaceSection() {
    const scope = useWorkspaceScope();
    const { data: shell } = useLiveQuery({ query: shellQuery(useCollections()) });
    const { workspace, state } = shellRows(shell);
    const name = accountView(scope.workspace, workspace, state).workspaceName;
    return (
        <Section title={REMOVE_SECTION_TITLE} testID="settings-remove-workspace" footer={removeWorkspaceNote(name)}>
            <Pressable
                testID="settings-remove-workspace-row"
                accessibilityRole="button"
                accessibilityLabel={`${REMOVE_WORKSPACE.label}, ${name}`}
                onPress={() => void askThenRemoveWorkspace(scope.workspace.id, name)}
                className="flex-row items-center gap-3 p-3 active:bg-accent"
                style={{ minHeight: 44 }}
            >
                <AppSymbol name="log-out" color="destructive" />
                <Text tone="destructive" className="min-w-0 flex-1">
                    {REMOVE_WORKSPACE.label}
                </Text>
            </Pressable>
        </Section>
    );
}

/** "Everything else": the workspace's own settings page, in the browser. */
function WebSettingsSection() {
    const openLink = useOpenLink();
    return (
        <Section title="On the web" testID="settings-web-section">
            <Pressable
                testID={WEB_SETTINGS_ROW.testID}
                accessibilityRole="link"
                accessibilityLabel={WEB_SETTINGS_ROW.title}
                accessibilityHint={`${WEB_SETTINGS_ROW.subtitle} ${WEB_SETTINGS_ROW.hint}`}
                onPress={() => openLink(WEB_SETTINGS_ROW.href, { web: true })}
                className="flex-row items-center gap-3 p-3 active:bg-accent"
                style={{ minHeight: 56 }}
            >
                <View className="min-w-0 flex-1 gap-0.5">
                    <Text>{WEB_SETTINGS_ROW.title}</Text>
                    <Text variant="footnote" tone="muted">
                        {WEB_SETTINGS_ROW.subtitle}
                    </Text>
                </View>
                <AppSymbol name="external-link" color="muted-foreground" />
            </Pressable>
        </Section>
    );
}

/**
 * Notifications: the phone's permission while they aren't on
 * (`settingsRow`), then the Notifications screen while a workspace is open.
 */
function NotificationsSection() {
    const navigation = useNavigation();
    const { availability, permission } = useNotificationAsk();
    const row = settingsRow(availability, permission);
    const open = useHasWorkspaceScope();
    if (row === null && !open) {
        return null;
    }
    return (
        <Section title="Notifications" testID="settings-notifications">
            {row === null ? null : <NotificationPermissionRow row={row} />}
            {open ? (
                // Its words wrap and the row grows with them, with no line limit as a ListRow's subtitle has.
                <Pressable
                    testID={NOTIFICATIONS_ROW.testID}
                    accessibilityRole="button"
                    accessibilityLabel={NOTIFICATIONS_ROW.title}
                    accessibilityHint={NOTIFICATIONS_ROW.subtitle}
                    onPress={() => navigation.navigate('Notifications' as never)}
                    className="flex-row items-center gap-3 p-3 active:bg-accent"
                    style={{ minHeight: 56 }}
                >
                    {row === null ? null : <RowSeparator inset={separatorInset(20)} />}
                    <AppSymbol name="sliders-horizontal" color="muted-foreground" />
                    <View className="min-w-0 flex-1 gap-0.5">
                        <Text>{NOTIFICATIONS_ROW.title}</Text>
                        <Text variant="footnote" tone="muted">
                            {NOTIFICATIONS_ROW.subtitle}
                        </Text>
                    </View>
                    <AppSymbol name="chevron-right" color="muted-foreground" />
                </Pressable>
            ) : null}
        </Section>
    );
}

/** How long the footer says "Copied" after a tap. */
const COPIED_MS = 2000;

/**
 * The connected workspace's server under the app's build (CB-501): the version the scope's version
 * rules hold (`/api/state`'s, kept in the registry), its commit from `/api/releases?limit=0`, read as
 * the footer shows, again when the version moves and when the server is back after being away.
 */
function WorkspaceBuildFooter() {
    const scope = useWorkspaceScope();
    const version = useSyncExternalStore(scope.versions.subscribe, scope.versions.highest);
    const { reconnecting } = useSyncStatus();
    const [build, setBuild] = useState<ServerBuild | null>(null);
    useEffect(() => {
        if (reconnecting) {
            return;
        }
        let live = true;
        scope
            .fetch(SERVER_RELEASES_PATH)
            .then((response) => readAnswer(response))
            .then((answer) => {
                const read = answer.status === 200 ? parseServerBuild(answer.body) : null;
                if (live && read !== null) {
                    setBuild(read);
                }
            })
            .catch(() => {
                // Offline or away: the version shows without its commit.
            });
        return () => {
            live = false;
        };
    }, [scope, version, reconnecting]);
    return <BuildFooter server={serverVersionLine(version, build, reconnecting)} />;
}

/**
 * Which build is installed, ChatGPT's settings footer: "Version 0.1.0 (2829) · Preview", then the
 * commit and build date when the build has them (src/shell/build-info.ts), then the server's line
 * (`server`, CB-501) while a workspace is open. Tapping it copies them all.
 */
function BuildFooter({ server }: { readonly server: string | null }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    const version = versionLine(BUILD_INFO);
    const origin = originLine(BUILD_INFO);
    const copy = () => {
        const text = buildCopyText(BUILD_INFO);
        Clipboard.setStringAsync(server === null ? text : `${text}\n${server}`).then(
            () => setCopied(true),
            (error: unknown) => console.warn('[settings] could not copy the version', error),
        );
    };
    return (
        <Pressable
            testID="settings-build"
            accessibilityRole="button"
            accessibilityLabel={[version, origin, server].filter((line) => line !== null).join('. ')}
            accessibilityHint="Copies the version"
            accessibilityValue={copied ? { text: 'Copied' } : undefined}
            onPress={copy}
            className="items-center gap-0.5 py-3"
        >
            {/* "Copied" beside the version, never in its place: the line just tapped stays readable. */}
            <View className="flex-row items-center justify-center">
                <Text variant="footnote" tone="muted" className="text-center" testID="settings-build-version">
                    {version}
                </Text>
                {copied ? (
                    <Text variant="footnote" tone="muted" testID="settings-build-copied">
                        {' · Copied'}
                    </Text>
                ) : null}
            </View>
            {origin === null ? null : (
                <Text variant="footnote" tone="muted" className="text-center" testID="settings-build-origin">
                    {origin}
                </Text>
            )}
            {server === null ? null : (
                <Text variant="footnote" tone="muted" className="text-center" testID="settings-build-server">
                    {server}
                </Text>
            )}
        </Pressable>
    );
}

/** Advanced mode's screen of versions, sync and the outbox, while it is on. */
function TechnicalDetailsRow() {
    const navigation = useNavigation();
    return (
        <ListRow
            testID={TECHNICAL_DETAILS_ROW.testID}
            title={TECHNICAL_DETAILS_ROW.title}
            subtitle={TECHNICAL_DETAILS_ROW.subtitle}
            subtitleLines={2}
            leadingSize={0}
            trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
            accessibilityLabel={TECHNICAL_DETAILS_ROW.title}
            accessibilityHint={TECHNICAL_DETAILS_ROW.subtitle}
            onPress={() => navigation.navigate('TechnicalDetails' as never)}
        />
    );
}

/** A setting that is on or off: one switch for screen readers, the whole row its target. */
function SwitchRowView({
    row,
    settings,
    first,
    footer,
}: {
    row: SwitchRow;
    settings: DeviceSettings;
    first?: boolean;
    /** Its words are the section's footer, so the row shows its title alone (iOS's Settings). */
    footer?: boolean;
}) {
    const colors = colorsOf(useScheme());
    const on = settings[row.key];
    const toggle = () => {
        deviceSettings
            .set({ [row.key]: !on })
            .catch((error: unknown) => console.warn('[settings] could not keep the setting', error));
    };
    return (
        <Pressable
            testID={row.testID}
            accessibilityRole="switch"
            accessibilityLabel={row.title}
            accessibilityHint={row.subtitle}
            accessibilityState={{ checked: on }}
            onPress={toggle}
            className="flex-row items-center gap-3 p-3"
            // Its words wrap, so it grows with them: never a fixed height.
            style={{ minHeight: footer === true ? 44 : 56 }}
        >
            {first === true ? null : <RowSeparator inset={ROW_INSET} />}
            <View className="min-w-0 flex-1 gap-0.5">
                <Text>{row.title}</Text>
                {footer === true ? null : (
                    <Text variant="footnote" tone="muted">
                        {row.subtitle}
                    </Text>
                )}
            </View>
            {/* The row is the switch for screen readers; this one only shows the state. */}
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Switch
                    testID={`${row.testID}-switch`}
                    value={on}
                    onValueChange={toggle}
                    trackColor={{ false: colors.input, true: colors.primary }}
                    ios_backgroundColor={colors.input}
                />
            </View>
        </Pressable>
    );
}

/** The open workspace's local cache: its size, and Clear cache after asking. */
function LocalCache() {
    const id = useWorkspaceScope().workspace.id;
    const [bytes, setBytes] = useState<number | null>(null);
    const [clearing, setClearing] = useState(false);
    useEffect(() => {
        let current = true;
        localCacheSize(id).then(
            (size) => {
                if (current) {
                    setBytes(size);
                }
            },
            (error: unknown) => console.warn('[settings] could not measure the cache', error),
        );
        return () => {
            current = false;
        };
    }, [id]);
    const clear = () => {
        Alert.alert(
            CLEAR_CACHE_QUESTION.title,
            CLEAR_CACHE_QUESTION.message,
            [
                { text: CLEAR_CACHE_QUESTION.cancel, style: 'cancel' },
                {
                    text: CLEAR_CACHE_QUESTION.confirm,
                    style: 'destructive',
                    onPress: () => {
                        setClearing(true);
                        // The workspace closes and opens again, so this screen is gone when it ends.
                        clearLocalCache(id).catch((error: unknown) => {
                            console.warn('[settings] could not clear the cache', error);
                            Alert.alert(CLEAR_CACHE_FAILED);
                        });
                    },
                },
            ],
            { cancelable: true },
        );
    };
    return (
        <Section title="Local cache" testID="settings-cache" footer={CACHE_NOTE}>
            <View className="flex-row items-center gap-3 p-3" style={{ minHeight: 68 }}>
                {/* The size is one element, the button another: a screen reader reaches both. */}
                <View
                    accessible
                    accessibilityLabel={`Local cache, ${cacheLine(bytes)}`}
                    className="min-w-0 flex-1 gap-0.5"
                    testID="settings-cache-size"
                >
                    <Text>This workspace</Text>
                    <Text variant="footnote" tone="muted">
                        {cacheLine(bytes)}
                    </Text>
                </View>
                <Button
                    variant="secondary"
                    label="Clear cache"
                    icon="trash-2"
                    busy={clearing}
                    onPress={clear}
                    testID="settings-clear-cache"
                />
            </View>
        </Section>
    );
}

/** The Spaces kept offline: each with its pages and size, and a switch that stops keeping it. */
function KeptSpacesSection() {
    const scope = useWorkspaceScope();
    const { ids, kept } = useKeptSpaces();
    const { data: spaces } = useLiveQuery({ query: spacesQuery(useCollections()) });
    const [sizes, setSizes] = useState<ReadonlyMap<string, KeptSpaceSizeLike> | null>(null);
    useEffect(() => {
        let current = true;
        scope.keepOffline.sizes(ids).then(
            (measured) => {
                if (current) {
                    setSizes(measured);
                }
            },
            (error: unknown) => console.warn('[settings] could not measure the kept spaces', error),
        );
        return () => {
            current = false;
        };
    }, [scope, ids]);
    const rows = keptSpaceRows(ids, spaces, sizes);
    if (rows.length === 0) {
        return null;
    }
    const stop = (row: KeptSpaceRow) => {
        if (!kept.writable) {
            Alert.alert(KEEP_NEEDS_UPDATE);
            return;
        }
        kept.set(row.id, false).catch((error: unknown) => {
            console.warn('[settings] could not stop keeping the space', error);
            Alert.alert(KEEP_FAILED);
        });
    };
    return (
        <Section title={KEPT_SPACES_SECTION.title} testID="settings-kept-spaces" footer={KEPT_SPACES_SECTION.note}>
            {rows.map((row, index) => (
                <KeptSpaceRowView key={row.id} row={row} first={index === 0} onStop={() => stop(row)} />
            ))}
        </Section>
    );
}

/** One kept Space: the row is the switch for screen readers, on while it is kept. */
function KeptSpaceRowView({ row, first, onStop }: { row: KeptSpaceRow; first: boolean; onStop: () => void }) {
    const colors = colorsOf(useScheme());
    return (
        <Pressable
            testID={row.testID}
            accessibilityRole="switch"
            accessibilityLabel={`${row.name}, kept offline, ${row.line}`}
            accessibilityState={{ checked: true }}
            onPress={onStop}
            className="flex-row items-center gap-3 p-3"
            style={{ minHeight: 56 }}
        >
            {first ? null : <RowSeparator inset={ROW_INSET} />}
            <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={1}>{row.name}</Text>
                <Text variant="footnote" tone="muted">
                    {row.line}
                </Text>
            </View>
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Switch
                    testID={`${row.testID}-switch`}
                    value
                    onValueChange={onStop}
                    trackColor={{ false: colors.input, true: colors.primary }}
                    ios_backgroundColor={colors.input}
                />
            </View>
        </Pressable>
    );
}
