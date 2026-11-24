import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RoomNotifyLevel } from '@socio/shared/rooms/room-notices';

import { OPEN_IN_BROWSER } from '../chat/chat-view';
import { useHasWorkspaceScope } from '../live';
import {
    BLOCK_COPY,
    MEMBERS,
    notifyChoices,
    NOTIFY_OFFLINE,
    NOTIFY_RETRY,
    notifyReadRetry,
    NOTIFICATIONS_TITLE,
    roomActionCopy,
    roomWebHref,
    whenRoomFree,
} from '../shell/room-invites';
import { Button, AppSymbol, Text } from '../ui';
import type { SymbolName } from '../ui/symbols';

import { useOpenLink } from './open-link';
import { useRoomActions } from './room-invite';

// A room's menu, from the room header's menu button:
// the reader's notification level there (`GET` as it opens, `PUT` on a pick,
// both online only: offline it says so and takes no pick; a read that failed
// offers Try again), Members (the
// RoomMembers sheet in its place) and "Open in your browser" through
// useOpenLink, with its sign-in line: room administration is the web's.
// Its root is the ScrollView (iOS takes the first one as the sheet's).

export function RoomMenuScreen({ route }: StaticScreenProps<{ id: string }>) {
    return useHasWorkspaceScope() ? <RoomMenu id={route.params.id} /> : null;
}

function RoomMenu({ id }: { id: string }) {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const openLink = useOpenLink();
    const { actions, blocked, busy } = useRoomActions(id);
    const [level, setLevel] = useState<RoomNotifyLevel | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const offline = blocked === 'offline' || blocked === 'away';
    // A failed read offers Try again; a read that met another request for the room goes again once it ends.
    const [attempt, setAttempt] = useState(0);
    const [failed, setFailed] = useState(false);
    // Read as the menu opens, again once the connection comes back with none read, and on Try again.
    useEffect(() => {
        if (level !== null || offline) {
            return undefined;
        }
        let live = true;
        let waiting: (() => void) | null = null;
        actions
            .notifyLevel(id)
            .then((outcome) => {
                if (!live) {
                    return;
                }
                if (outcome.kind === 'done') {
                    setLevel(outcome.value);
                    setNotice(null);
                    setFailed(false);
                    return;
                }
                const retry = notifyReadRetry(outcome);
                if (retry === 'when-free') {
                    waiting = whenRoomFree(actions, id, () => setAttempt((count) => count + 1));
                    return;
                }
                setNotice(roomActionCopy(outcome, 'room'));
                setFailed(retry === 'button');
            })
            .catch(() => {});
        return () => {
            live = false;
            waiting?.();
        };
    }, [actions, id, level, offline, attempt]);
    const readAgain = () => {
        setFailed(false);
        setNotice(null);
        setAttempt((count) => count + 1);
    };
    const pick = (next: RoomNotifyLevel) => {
        if (next === level) {
            return;
        }
        setNotice(null);
        actions
            .setNotifyLevel(id, next)
            .then((outcome) => {
                if (outcome.kind === 'done') {
                    setLevel(outcome.value);
                    return;
                }
                const words = roomActionCopy(outcome, 'room');
                setNotice(words);
                if (words !== null) {
                    AccessibilityInfo.announceForAccessibility(words);
                }
            })
            .catch(() => {});
    };
    const blockedWords = blocked === null ? null : BLOCK_COPY[blocked];
    const choices = notifyChoices(level);
    const unread = level === null;
    return (
        <ScrollView
            testID="room-menu"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
        >
            <View className="gap-1">
                <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                    {NOTIFICATIONS_TITLE}
                </Text>
                <View className="rounded-xl border border-border bg-card" accessibilityRole="radiogroup">
                    {choices.map((choice, index) => (
                        <Pressable
                            key={choice.level}
                            testID={`room-notify-${choice.level}`}
                            accessibilityRole="radio"
                            accessibilityLabel={choice.accessibilityLabel}
                            accessibilityState={{
                                checked: choice.selected,
                                disabled: unread || blocked !== null || busy,
                            }}
                            accessibilityHint={blockedWords ?? undefined}
                            disabled={unread || blocked !== null || busy}
                            onPress={() => pick(choice.level)}
                            className={
                                index === 0
                                    ? 'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent disabled:opacity-50'
                                    : 'min-h-11 flex-row items-center gap-3 border-t border-border p-3 active:bg-accent disabled:opacity-50'
                            }
                        >
                            <View className="min-w-0 flex-1 gap-0.5">
                                <Text weight="medium">{choice.label}</Text>
                                <Text variant="footnote" tone="muted">
                                    {choice.note}
                                </Text>
                            </View>
                            <View className="w-5">
                                {choice.selected ? <AppSymbol name="check" size={20} color="primary" /> : null}
                            </View>
                        </Pressable>
                    ))}
                </View>
                {notice !== null || (unread && offline) ? (
                    <Text variant="footnote" tone="muted" testID="room-menu-notice">
                        {notice ?? NOTIFY_OFFLINE}
                    </Text>
                ) : null}
                {failed && unread ? (
                    <View className="items-start">
                        <Button
                            variant="ghost"
                            label={NOTIFY_RETRY}
                            onPress={readAgain}
                            disabled={blocked !== null || busy}
                            accessibilityHint={blockedWords ?? undefined}
                            testID="room-menu-retry"
                        />
                    </View>
                ) : null}
            </View>
            <View className="rounded-xl border border-border bg-card">
                <MenuRow
                    first
                    testID="room-menu-members"
                    icon="users"
                    label={MEMBERS}
                    onPress={() => {
                        navigation.goBack();
                        navigation.navigate('RoomMembers', { id });
                    }}
                />
                <MenuRow
                    testID="room-menu-browser"
                    icon="external-link"
                    label={OPEN_IN_BROWSER}
                    onPress={() => openLink(roomWebHref(id))}
                />
            </View>
        </ScrollView>
    );
}

function MenuRow(props: { first?: boolean; testID: string; icon: SymbolName; label: string; onPress: () => void }) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={props.label}
            onPress={props.onPress}
            className={
                props.first === true
                    ? 'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent'
                    : 'min-h-11 flex-row items-center gap-3 border-t border-border p-3 active:bg-accent'
            }
        >
            <AppSymbol name={props.icon} size={20} color="muted-foreground" />
            <Text weight="medium" className="min-w-0 flex-1">
                {props.label}
            </Text>
        </Pressable>
    );
}
