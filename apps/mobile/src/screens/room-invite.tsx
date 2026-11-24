import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { chatAction } from '../navigation/tabs';
import { askForNotifications } from '../platform/notification-ask';
import type { InviteRow } from '../shell/inbox';
import { BLOCK_COPY, DECLINE, INVITE_GONE, inviteDetail, JOIN, JOIN_HINT, roomActionCopy } from '../shell/room-invites';
import { Button, AppSymbol, Text, ToneTile } from '../ui';

import { ListRow } from './shell-parts';

// A room invite, the web's InviteCard as a sheet
// over the Inbox or Home: the room's name, who asked and how many are in it,
// then what joining shares (the invite's disclosure, shown before Join, whose
// version Join posts), then Decline and Join. Both are online only ("Needs a
// connection", nothing sent); an invite the server no longer has reads the
// invites again and says so. Joining opens the room once the chat list holds
// it, then asks for notifications (the notification ask's 'invite' trigger, which shows its
// explanation over the room when the rules say so). Its root is the
// ScrollView (iOS takes the first one as the sheet's).
// `InviteRows` draws the invites as rows, for the Inbox and Home.

export function RoomInviteScreen({ route }: StaticScreenProps<{ roomId: string }>) {
    return useHasWorkspaceScope() ? <RoomInvite roomId={route.params.roomId} /> : null;
}

/** The scope's room actions as React state: what blocks a request now, and whether this room's is going. */
export function useRoomActions(roomId: string) {
    const { roomActions } = useWorkspaceScope();
    const blocked = useSyncExternalStore(roomActions.subscribe, () => roomActions.blocked());
    const busy = useSyncExternalStore(roomActions.subscribe, () => roomActions.busy(roomId));
    return { actions: roomActions, blocked, busy };
}

function RoomInvite({ roomId }: { roomId: string }) {
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const collections = useCollections();
    const { data: invites } = useLiveQuery({ query: (q) => q.from({ invite: collections.roomInvites }) });
    const invite = invites.find((item) => item.roomId === roomId);
    const { actions, blocked, busy } = useRoomActions(roomId);
    const [notice, setNotice] = useState<string | null>(null);
    const [working, setWorking] = useState<'join' | 'decline' | null>(null);
    const say = (words: string | null) => {
        setNotice(words);
        if (words !== null) {
            AccessibilityInfo.announceForAccessibility(words);
        }
    };
    if (invite === undefined) {
        return (
            <ScrollView
                testID="room-invite"
                className="bg-sheet"
                contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
            >
                <Text variant="subheadline" tone="muted" testID="room-invite-gone">
                    {INVITE_GONE}
                </Text>
            </ScrollView>
        );
    }
    const detail = inviteDetail(invite);
    const blockedWords = blocked === null ? null : BLOCK_COPY[blocked];
    const join = () => {
        setWorking('join');
        say(null);
        actions
            .accept(roomId, detail.disclosureVersion)
            .then((outcome) => {
                if (outcome.kind === 'done') {
                    AccessibilityInfo.announceForAccessibility(`You joined ${detail.title}.`);
                    navigation.goBack();
                    navigation.dispatch(chatAction(roomId));
                    void askForNotifications('invite');
                    return;
                }
                say(roomActionCopy(outcome, 'invite'));
            })
            .finally(() => setWorking(null));
    };
    const decline = () => {
        setWorking('decline');
        say(null);
        actions
            .decline(roomId)
            .then((outcome) => {
                if (outcome.kind === 'done') {
                    AccessibilityInfo.announceForAccessibility(`Declined ${detail.title}.`);
                    navigation.goBack();
                    return;
                }
                say(roomActionCopy(outcome, 'invite'));
            })
            .finally(() => setWorking(null));
    };
    return (
        <ScrollView
            testID="room-invite"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
        >
            <View className="gap-1">
                <Text accessibilityRole="header" variant="headline">
                    {detail.title}
                </Text>
                <Text variant="subheadline" tone="muted">
                    {detail.line}
                </Text>
            </View>
            <View className="rounded-xl bg-muted p-4" testID="room-invite-disclosure">
                <Text>{detail.disclosure}</Text>
            </View>
            {notice === null && blockedWords === null ? null : (
                <Text variant="subheadline" tone="muted" testID="room-invite-notice">
                    {notice ?? blockedWords}
                </Text>
            )}
            <View className="flex-row gap-3">
                <View className="flex-1">
                    <Button
                        variant="secondary"
                        label={DECLINE}
                        onPress={decline}
                        disabled={blocked !== null || ((busy || working !== null) && working !== 'decline')}
                        busy={working === 'decline'}
                        accessibilityHint={blockedWords ?? undefined}
                        testID="room-invite-decline"
                    />
                </View>
                <View className="flex-1">
                    <Button
                        label={JOIN}
                        onPress={join}
                        disabled={blocked !== null || ((busy || working !== null) && working !== 'join')}
                        busy={working === 'join'}
                        accessibilityHint={blockedWords ?? JOIN_HINT}
                        testID="room-invite-join"
                    />
                </View>
            </View>
        </ScrollView>
    );
}

/** The invites as rows of a card, each opening its sheet. */
export function InviteRows({ rows, testID }: { rows: readonly InviteRow[]; testID: string }) {
    const navigation = useNavigation();
    return rows.map((invite, index) => (
        <ListRow
            key={invite.id}
            first={index === 0}
            testID={`${testID}-${invite.id}`}
            leadingSize={44}
            leading={<ToneTile tone="mint" icon="mail" surface="card" />}
            title={invite.title}
            subtitle={invite.subtitle}
            subtitleLines={2}
            trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
            accessibilityLabel={invite.accessibilityLabel}
            accessibilityHint="Shows the invite"
            onPress={() => navigation.navigate('RoomInvite', { roomId: invite.id })}
        />
    ));
}
