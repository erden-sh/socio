import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import type { Conversation } from '@socio/shared/types';

import { useCollections, useLiveQuery } from '../live';
import type { ChatRow } from '../shell/chat-list';
import { type ChatListItem, chatListItem, chatMarks } from '../shell/chat-marks';
import { moduleEntry } from '../shell/modules';
import { runsQuery } from '../shell/queries';
import { useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { AppSymbol, Squircle, Text } from '../ui';

import { CountBadge, ListRow, SocioAvatar, SocioStateLabel } from './shell-parts';

// The chat list's rows on the Chats tab and Home's Rooms and Recent chats (MA
// 8.1; src/shell/chat-marks.ts): the title with when the chat was last active,
// the socio (or "Room" and the reader's role) with the marks, "Needs your
// approval" on the Approvals module's amber tile as the Inbox draws it and
// "Working" with the socio state's dot, and a room drawn as a room, the web's
// speech bubbles on the Chat module's tone, in place of a socio's mascot. One
// element for screen readers, its label saying every mark and the time.

/** What the rows' marks read: the `runs` and `approvals` kinds, which a screen showing them keeps pulled. */
export const CHAT_MARK_KINDS = ['runs', 'approvals'] as const;

const APPROVALS_TONE = moduleEntry(MODULE_IDS.approvals).tone;
const ROOM_TONE = moduleEntry(MODULE_IDS.chat).tone;

/** The phone's clock, once a minute: the list's times move on while it shows. */
function useMinute(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

/** The rows with their marks, from the scope's runs and approvals. */
export function useChatListItems(
    rows: readonly ChatRow[],
    chats: readonly Conversation[],
): ReadonlyMap<string, ChatListItem> {
    const collections = useCollections();
    const { data: runs } = useLiveQuery({ query: runsQuery(collections) });
    const { data: approvals } = useLiveQuery({ query: (q) => q.from({ approval: collections.approvals }) });
    const now = useMinute();
    const marks = chatMarks({ chats, runs, approvals });
    return new Map(rows.map((row) => [row.id, chatListItem(row, marks.get(row.id), now)]));
}

/** A room's tile: the web's RoomIcon on the Chat module's tone, the size of a chat row's mascot. */
function RoomTile() {
    const { foreground, tiles } = theme[useScheme()].tones[ROOM_TONE];
    return (
        <Squircle size={40} color={tiles.card}>
            <AppSymbol name="messages-square" size={20} weight="medium" color={{ value: foreground }} />
        </Squircle>
    );
}

/** "Needs your approval" on the Approvals module's tile, with its shield: the words always beside the color. */
function ApprovalMark({ label }: { label: string }) {
    const { foreground, tiles } = theme[useScheme()].tones[APPROVALS_TONE];
    return (
        <View
            className="shrink-0 flex-row items-center gap-1 rounded-sm px-1.5"
            style={{ backgroundColor: tiles.card }}
        >
            <AppSymbol name="shield-check" size={12} weight="medium" color={{ value: foreground }} />
            <Text variant="footnote" weight="medium" style={{ color: foreground }}>
                {label}
            </Text>
        </View>
    );
}

/** One chat or room of the list. */
export function ChatListRow(props: {
    item: ChatListItem;
    first: boolean;
    testID: string;
    onPress: () => void;
    onLongPress?: () => void;
    accessibilityActions?: readonly { readonly name: string; readonly label: string }[];
    onAccessibilityAction?: (name: string) => void;
}) {
    const { item } = props;
    const { row } = item;
    const marks =
        item.approval === null && item.working === null ? undefined : (
            <View className="shrink-0 flex-row items-center gap-2">
                {item.working === null ? null : <SocioStateLabel state="working" label={item.working} />}
                {item.approval === null ? null : <ApprovalMark label={item.approval} />}
            </View>
        );
    return (
        <ListRow
            first={props.first}
            testID={props.testID}
            leading={row.room ? <RoomTile /> : <SocioAvatar character={row.character} />}
            title={row.title}
            titleVariant="chat-title"
            titleTrailing={
                item.time === null ? undefined : (
                    <Text variant="footnote" tone="muted" className="shrink-0" testID={`${props.testID}-time`}>
                        {item.time.short}
                    </Text>
                )
            }
            subtitle={item.subtitle}
            subtitleTrailing={marks}
            trailing={row.unreadLabel === null ? null : <CountBadge label={row.unreadLabel} />}
            accessibilityLabel={item.accessibilityLabel}
            onPress={props.onPress}
            {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
            {...(props.accessibilityActions === undefined ? {} : { accessibilityActions: props.accessibilityActions })}
            {...(props.onAccessibilityAction === undefined
                ? {}
                : { onAccessibilityAction: props.onAccessibilityAction })}
        />
    );
}
