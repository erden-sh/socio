import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Pressable, Switch, View } from 'react-native';

import type { ChannelPreference, NotificationChannelView } from '@socio/shared/notifications';
import { roomsOn } from '@socio/shared/rooms/room-view';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { useNotificationAsk } from '../platform/notification-ask';
import { pushRegistration, showText, usePushStatus, useShowText } from '../platform/push';
import { settingsRow, ShowTextHandOverError } from '../push';
import {
    BLOCK_COPY,
    CHANNELS_NOTE,
    channelRows,
    CONTENT_CHOICES,
    INTRO,
    LOAD_FAILED,
    LOADING,
    outcomeCopy,
    PRESENCE_ROW,
    presenceHidden,
    SAVE_FAILED,
    SHOW_TEXT_PENDING,
    SHOW_TEXT_ROW,
    TEST_COPY,
    testLine,
    thisPhoneLabel,
    TRY_AGAIN,
    withChange,
} from '../shell/notification-settings';
import { shellQuery, shellRows } from '../shell/queries';
import type { NotificationSettings } from '../sync/notification-settings';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Button, AppSymbol, Screen, Text } from '../ui';

import { NotificationPermissionRow } from './notification-permission-row';
import { Section } from './shell-parts';

// Settings → Notifications, at the web's
// `/settings/notifications`, which the test notification links to. This phone
// first: the permission while it isn't on (the notification ask's row), "Show message text in
// notifications" (the phone's own, handed to the native side) and the name
// the workspace lists this phone by. Then the workspace's channels from
// `GET /api/notifications/channels`, each on or off and what it shows (for
// every device on it), "Hide my presence in rooms" while rooms are on, and the
// test. Every workspace change is online only (`scope.notificationSettings`):
// offline the controls say "Needs a connection" and send nothing. The words
// and rows are src/shell/notification-settings.ts's.

export function NotificationsScreen() {
    return (
        <Screen testID="notifications-screen" edges={['right', 'bottom', 'left']}>
            <ThisPhone />
            {useHasWorkspaceScope() ? <WorkspaceNotifications /> : null}
        </Screen>
    );
}

/** The scope's notification settings, with why they can't send and whether one is going. */
function useNotificationSettings(): { settings: NotificationSettings; blocked: string | null; busy: boolean } {
    const { notificationSettings: settings } = useWorkspaceScope();
    const reason = useSyncExternalStore(settings.subscribe, () => settings.blocked());
    const busy = useSyncExternalStore(settings.subscribe, () => settings.busy());
    return { settings, blocked: reason === null ? null : BLOCK_COPY[reason], busy };
}

function say(words: string | null, set: (words: string | null) => void) {
    set(words);
    if (words !== null) {
        AccessibilityInfo.announceForAccessibility(words);
    }
}

/** This phone: the permission while it isn't on, and the show-text setting. */
function ThisPhone() {
    const { availability, permission } = useNotificationAsk();
    const row = settingsRow(availability, permission);
    const shown = useShowText();
    const [notice, setNotice] = useState<string | null>(null);
    const toggle = () => {
        if (shown === null) {
            return;
        }
        setNotice(null);
        showText.set(!shown).catch((error: unknown) => {
            console.warn('[notifications] could not keep show-text', error);
            say(error instanceof ShowTextHandOverError ? SHOW_TEXT_PENDING : SAVE_FAILED, setNotice);
        });
    };
    return (
        <View className="gap-2">
            <Section title="This phone" testID="notifications-this-phone">
                {row === null ? null : <NotificationPermissionRow row={row} />}
                <ToggleRow
                    first={row === null}
                    testID={SHOW_TEXT_ROW.testID}
                    title={SHOW_TEXT_ROW.title}
                    subtitle={SHOW_TEXT_ROW.subtitle}
                    on={shown ?? true}
                    disabled={shown === null}
                    onToggle={toggle}
                />
            </Section>
            {notice === null ? null : (
                <Text variant="footnote" tone="muted" testID="notifications-this-phone-notice">
                    {notice}
                </Text>
            )}
        </View>
    );
}

/** The open workspace's channels, room presence and test. */
function WorkspaceNotifications() {
    const scope = useWorkspaceScope();
    const { settings, blocked, busy } = useNotificationSettings();
    const { data: shell } = useLiveQuery({ query: shellQuery(useCollections()) });
    const { state, workspace } = shellRows(shell);
    const [channels, setChannels] = useState<readonly NotificationChannelView[] | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [notice, setNotice] = useState<string | null>(null);
    const offline = blocked === BLOCK_COPY.offline;
    // Read as the screen opens, again when the connection comes back with none read, and on Try again.
    useEffect(() => {
        if (channels !== null || offline) {
            return undefined;
        }
        let live = true;
        settings
            .channels()
            .then((outcome) => {
                if (!live) {
                    return;
                }
                // A read waits for another request in flight, so it never answers `busy`.
                if (outcome.kind === 'done') {
                    setChannels(outcome.value.channels);
                    setProblem(null);
                } else {
                    setProblem(outcomeCopy(outcome, LOAD_FAILED));
                }
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [settings, channels, offline, attempt]);

    const subscription = usePhoneSubscription(scope.workspace.id);
    const save = (id: string, change: Partial<ChannelPreference>) => {
        if (channels === null) {
            return;
        }
        const before = channels;
        setNotice(null);
        setChannels(withChange(channels, id, change));
        settings
            .saveChannel(before, id, change)
            .then((outcome) => {
                if (outcome.kind !== 'done') {
                    setChannels(before);
                    say(outcomeCopy(outcome, SAVE_FAILED), setNotice);
                }
            })
            .catch(() => setChannels(before));
    };
    const hidden = presenceHidden(workspace?.preferences);
    const [pendingHidden, setPendingHidden] = useState<boolean | null>(null);
    const setPresence = () => {
        const next = !(pendingHidden ?? hidden);
        setNotice(null);
        setPendingHidden(next);
        settings
            .setRoomPresence(next)
            .then((outcome) => {
                setPendingHidden(null);
                if (outcome.kind !== 'done') {
                    say(outcomeCopy(outcome, SAVE_FAILED), setNotice);
                }
            })
            .catch(() => setPendingHidden(null));
    };
    const disabled = blocked !== null || busy;
    const label = channels === null ? null : thisPhoneLabel(channels, subscription);
    return (
        <>
            {label === null ? null : (
                <Text variant="footnote" tone="muted" testID="notifications-phone-label">
                    {`This phone is “${label}” in ${scope.workspace.name}’s devices.`}
                </Text>
            )}
            <Text variant="subheadline" tone="muted" testID="notifications-intro">
                {INTRO}
            </Text>
            {blocked === null ? null : (
                <Text variant="footnote" tone="muted" testID="notifications-blocked">
                    {blocked}
                </Text>
            )}
            {notice === null ? null : (
                <Text variant="footnote" tone="muted" testID="notifications-notice">
                    {notice}
                </Text>
            )}
            {channels === null ? (
                <View className="items-start gap-2">
                    <Text variant="subheadline" tone="muted" testID="notifications-loading">
                        {problem ?? (offline ? blocked : LOADING)}
                    </Text>
                    {problem === null ? null : (
                        <Button
                            variant="ghost"
                            label={TRY_AGAIN}
                            onPress={() => {
                                setProblem(null);
                                setAttempt((count) => count + 1);
                            }}
                            disabled={offline}
                            testID="notifications-retry"
                        />
                    )}
                </View>
            ) : (
                <>
                    {channelRows(channels).map((channel) => (
                        <View key={channel.id} className="gap-2">
                            <Section title={channel.label} testID={channel.testID}>
                                <ToggleRow
                                    first
                                    testID={`${channel.testID}-on`}
                                    title={channel.enabled ? 'On' : 'Off'}
                                    accessibilityLabel={`${channel.label} on`}
                                    subtitle={channel.reaches}
                                    on={channel.enabled}
                                    disabled={disabled}
                                    hint={blocked}
                                    onToggle={() => save(channel.id, { enabled: !channel.enabled })}
                                />
                                <View accessibilityRole="radiogroup" accessibilityLabel={`What ${channel.label} shows`}>
                                    {CONTENT_CHOICES.map((choice) => (
                                        <Pressable
                                            key={choice.value}
                                            testID={`${channel.testID}-${choice.value}`}
                                            accessibilityRole="radio"
                                            accessibilityLabel={choice.label}
                                            accessibilityHint={blocked ?? choice.note}
                                            accessibilityState={{ checked: channel.content === choice.value, disabled }}
                                            disabled={disabled}
                                            onPress={() =>
                                                channel.content === choice.value
                                                    ? undefined
                                                    : save(channel.id, { content: choice.value })
                                            }
                                            className="flex-row items-center gap-3 border-t border-border p-3 active:bg-accent disabled:opacity-50"
                                            style={{ minHeight: 56 }}
                                        >
                                            <View className="min-w-0 flex-1 gap-0.5">
                                                <Text weight="medium">{choice.label}</Text>
                                                <Text variant="footnote" tone="muted">
                                                    {choice.note}
                                                </Text>
                                            </View>
                                            <View className="w-5">
                                                {channel.content === choice.value ? (
                                                    <AppSymbol name="check" size={20} color="primary" />
                                                ) : null}
                                            </View>
                                        </Pressable>
                                    ))}
                                </View>
                            </Section>
                        </View>
                    ))}
                    <Text variant="footnote" tone="muted" testID="notifications-channels-note">
                        {CHANNELS_NOTE}
                    </Text>
                </>
            )}
            {state === null || !roomsOn(state) ? null : (
                <Section title="Rooms" testID="notifications-rooms">
                    <ToggleRow
                        first
                        testID={PRESENCE_ROW.testID}
                        title={PRESENCE_ROW.title}
                        subtitle={PRESENCE_ROW.subtitle}
                        on={pendingHidden ?? hidden}
                        disabled={disabled}
                        hint={blocked}
                        onToggle={setPresence}
                    />
                </Section>
            )}
            <TestSection settings={settings} channels={channels} blocked={blocked} busy={busy} />
        </>
    );
}

/** The test: one button, then what the server says it reached. */
function TestSection(props: {
    settings: NotificationSettings;
    channels: readonly NotificationChannelView[] | null;
    blocked: string | null;
    busy: boolean;
}) {
    const [sending, setSending] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const send = () => {
        setSending(true);
        setResult(null);
        props.settings
            .sendTest()
            .then((outcome) =>
                say(
                    outcome.kind === 'done'
                        ? testLine(outcome.value, props.channels ?? [])
                        : outcomeCopy(outcome, 'Couldn’t send the test notification.'),
                    setResult,
                ),
            )
            .catch(() => {})
            .finally(() => setSending(false));
    };
    return (
        <Section title="Test" testID="notifications-test">
            <View className="items-start gap-3 p-3">
                <Text variant="footnote" tone="muted">
                    {TEST_COPY.note}
                </Text>
                <Button
                    variant="secondary"
                    label={sending ? TEST_COPY.sending : TEST_COPY.title}
                    icon="send"
                    busy={sending}
                    disabled={props.blocked !== null || props.busy}
                    accessibilityHint={props.blocked ?? undefined}
                    onPress={send}
                    testID="notifications-send-test"
                />
                {result === null ? null : (
                    <Text variant="footnote" tone="muted" testID="notifications-test-result">
                        {result}
                    </Text>
                )}
            </View>
        </Section>
    );
}

/** The server's subscription id for this phone in the workspace (the registry's), read again as push's state changes. */
function usePhoneSubscription(id: string): string | null {
    const status = usePushStatus(id);
    const [subscription, setSubscription] = useState<string | null>(null);
    useEffect(() => {
        let current = true;
        pushRegistration(id).then(
            (row) => {
                if (current) {
                    setSubscription(row?.subscriptionId ?? null);
                }
            },
            (error: unknown) => console.warn('[notifications] could not read the push registration', error),
        );
        return () => {
            current = false;
        };
    }, [id, status]);
    return subscription;
}

/** A setting that is on or off: one switch for screen readers, the whole row its target. */
function ToggleRow(props: {
    testID: string;
    title: string;
    subtitle: string;
    accessibilityLabel?: string;
    on: boolean;
    disabled?: boolean;
    /** Why it is disabled, said as its hint. */
    hint?: string | null;
    first?: boolean;
    onToggle: () => void;
}) {
    const colors = colorsOf(useScheme());
    const disabled = props.disabled === true;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="switch"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            accessibilityHint={props.hint ?? props.subtitle}
            accessibilityState={{ checked: props.on, disabled }}
            disabled={disabled}
            onPress={props.onToggle}
            className={
                props.first === true
                    ? 'flex-row items-center gap-3 p-3 disabled:opacity-50'
                    : 'flex-row items-center gap-3 border-t border-border p-3 disabled:opacity-50'
            }
            // Its words wrap, so it grows with them: never a fixed height.
            style={{ minHeight: 56 }}
        >
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="medium">{props.title}</Text>
                <Text variant="footnote" tone="muted">
                    {props.subtitle}
                </Text>
            </View>
            {/* The row is the switch for screen readers; this one only shows the state. */}
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Switch
                    testID={`${props.testID}-switch`}
                    value={props.on}
                    disabled={disabled}
                    onValueChange={props.onToggle}
                    trackColor={{ false: colors.input, true: colors.primary }}
                    ios_backgroundColor={colors.input}
                />
            </View>
        </Pressable>
    );
}
