import { useNavigation } from '@react-navigation/native';
import { useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Conversation } from '@socio/shared/types';
import { MAX_CHAT_TITLE } from '@socio/shared/types';

import {
    accessibilityActionsOf,
    CANCEL,
    CHAT_ARCHIVED,
    chatRowMenu,
    DELETE,
    DELETE_TITLE,
    deleteSentence,
    type NotSaved,
    RENAME_LABEL,
    RENAME_TITLE,
    UNDO,
} from '../chat/long-press';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSyncOnFocus,
    useSyncRefresh,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { newChatAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import { type ChatRow, chatList } from '../shell/chat-list';
import { chatListItem } from '../shell/chat-marks';
import { defaultSocioId } from '../shell/first-run';
import { LONG_PRESS_TO_MENU } from '../shell/native-menu';
import { COMPOSE_LABEL, composeMenu, NEW_ROOM_ITEM } from '../shell/new-room';
import { shellQuery, shellRows, sociosQuery } from '../shell/queries';
import { chatSwipeActions, type SwipeActionView, SWIPE_READ } from '../shell/swipe-actions';
import { archiveChat, chatTitle, deleteChat, renameChat } from '../sync/chat-manage';
import { markRoomReadFromList } from '../sync/room-send';
import { Text, usePullToRefresh } from '../ui';
import type { SymbolName } from '../ui/symbols';

import { ActionMenu, type MenuRequest, NotSavedNotice, TextPrompt, UndoToast } from './action-menu';
import { ATTENTION_SYNCED, AttentionSections, useAttention } from './attention';
import { CHAT_MARK_KINDS, ChatListRow, useChatListItems } from './chat-rows';
import { StatusBanners, useOpenChat, useRememberScreen } from './shell-parts';
import { useChatWrites } from './shown-chats';
import { type SwipeAction, SwipeGroupProvider, SwipeRow, useSwipeGroup } from './swipe-row';

// The chat list, the Chats tab: every chat that
// isn't archived, newest first, with its socio and a room's unread
// (src/shell/chat-list.ts), its marks and when it was last active, a room
// drawn as a room (chat-rows.tsx), all in one grouped card as Home's sections.
// A row opens its chat (screens/chat.tsx).
// A private chat's row has a long-press menu, also its accessibility
// actions: Rename (a prompt), Archive ("Chat archived" with Undo) and Delete
// (a native confirm), each through the outbox, shown at once (useChatWrites);
// one the server refused says so, with Retry and Discard (NotSavedNotice).
// Over the chats, what needs the person's attention (CB-455, the Inbox tab's
// content since the owner dropped it: approvals waiting, pages changed
// elsewhere, the day's notices, invites, rooms with unread), hidden while
// there's none (attention.tsx); the tab's badge counts it.

const SYNCED = [...new Set([...ATTENTION_SYNCED, ...CHAT_MARK_KINDS])];
/** The chats' heading under the attention section. */
const ALL_CHATS = 'All chats';
const SWIPE_ICONS: Readonly<Record<string, SymbolName>> = {
    archive: 'archive',
    delete: 'trash-2',
    read: 'message-square-check',
};

export function ChatsScreen() {
    return useHasWorkspaceScope() ? <Chats /> : null;
}

function Chats() {
    const collections = useCollections();
    useRememberScreen('Chats');
    useSyncOnFocus(SYNCED);
    const refreshControl = usePullToRefresh(useSyncRefresh(SYNCED));
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { chats, refused } = useChatWrites();
    const { state } = shellRows(shell);
    const rows = chatList(chats, dots, state);
    const items = useChatListItems(rows, chats);
    const navigation = useNavigation();
    const newChatWith = defaultSocioId(dots, state);
    const manage = useChatManage(chats, refused);
    const attention = useAttention();
    useFirstFrameWithData('Chats', rows.length > 0);
    const insets = useSafeAreaInsets();
    const openChat = useOpenChat();
    // One open row at a time; a scroll or a tap on another row closes it (CB-453, Mail's).
    const swipes = useSwipeGroup();
    // The tab's bar (its own stack, CB-420): "Chats" as a large title, and Compose, always there
    // (ChatGPT's and T3 Code's): New chat with the default socio; while rooms are on, a native
    // menu of New chat and New room (CB-470), as Messages' compose offers a group.
    const composeItems = composeMenu({ canChat: newChatWith !== null, state });
    const compose = (name: string) => {
        if (name === NEW_ROOM_ITEM.name) {
            navigation.navigate('NewRoom');
        } else if (newChatWith !== null) {
            navigation.dispatch(newChatAction(newChatWith));
        }
    };
    const firstItem = composeItems[0];
    useNativeBar({
        right:
            firstItem === undefined
                ? []
                : [
                      {
                          id: 'chats-new-chat',
                          label: composeItems.length > 1 ? COMPOSE_LABEL : firstItem.label,
                          symbol: 'square.and.pencil',
                          icon: 'square-pen',
                          iconOnly: true,
                          onPress: () => compose(firstItem.name),
                          ...(composeItems.length > 1 ? { menu: { actions: composeItems, onAction: compose } } : {}),
                      },
                  ],
    });
    return (
        <View
            testID="chats-screen"
            className="flex-1 bg-screen"
            collapsable={false}
            style={{ paddingLeft: insets.left, paddingRight: insets.right }}
        >
            <SwipeGroupProvider value={swipes.value}>
                <FlatList
                    data={rows}
                    {...swipes.handlers}
                    keyExtractor={(row) => row.id}
                    accessibilityRole="list"
                    // Under the tab's bar and over the tab bar, both iOS's: UIKit insets it by them.
                    contentInsetAdjustmentBehavior="automatic"
                    refreshControl={refreshControl}
                    contentContainerClassName="py-2"
                    ListHeaderComponent={
                        <View className="gap-3 px-4 pb-2">
                            <StatusBanners />
                            <AttentionSections view={attention} />
                            {attention.empty || rows.length === 0 ? null : (
                                // Under the attention section, the chats: Home's section heading.
                                <Text accessibilityRole="header" variant="section" className="px-3" testID="chats-all">
                                    {ALL_CHATS}
                                </Text>
                            )}
                        </View>
                    }
                    ListEmptyComponent={
                        <Text variant="subheadline" tone="muted" className="px-4 py-4 text-center" testID="chats-empty">
                            No chats yet.
                        </Text>
                    }
                    renderItem={({ item, index }) => (
                        // Full-width rows with hairlines inset to the text, as Messages': no card.
                        <SwipeRow {...manage.swipes(item)} testID={`chat-${item.id}-swipe`}>
                            <View className="bg-screen">
                                <ActionMenu request={manage.menu(item)} trigger="longPress">
                                    <ChatListRow
                                        first={index === 0}
                                        item={items.get(item.id) ?? chatListItem(item, undefined, 0)}
                                        testID={`chat-${item.id}`}
                                        onPress={() => {
                                            if (!swipes.closeOpen()) {
                                                openChat(item);
                                            }
                                        }}
                                        {...(item.room ? {} : { onLongPress: LONG_PRESS_TO_MENU })}
                                        accessibilityActions={accessibilityActionsOf(manage.actions(item))}
                                        onAccessibilityAction={(name) => manage.act(item, name)}
                                    />
                                </ActionMenu>
                            </View>
                        </SwipeRow>
                    )}
                />
            </SwipeGroupProvider>
            {manage.element}
        </View>
    );
}

/** A chat row's Rename, Archive with its undo toast, Delete after a native confirm, and what was refused. */
function useChatManage(chats: readonly Conversation[], refused: readonly NotSaved[]) {
    const { outbox, histories } = useWorkspaceScope();
    const [renaming, setRenaming] = useState<ChatRow | null>(null);
    const [archived, setArchived] = useState<ChatRow | null>(null);
    const failed = (error: unknown) => console.warn('[chats] the change was not saved', error);
    const act = (row: ChatRow, name: string) => {
        if (row.room) {
            if (name === SWIPE_READ.name) {
                markRoomReadFromList({ histories, outbox, newId: randomId }, row.id).catch(failed);
            }
            return;
        }
        if (name === 'rename') {
            setRenaming(row);
        } else if (name === 'archive') {
            archiveChat(outbox, { threadId: row.id, archived: true, newId: randomId }).then(
                () => setArchived(row),
                failed,
            );
        } else if (name === 'delete') {
            Alert.alert(DELETE_TITLE, deleteSentence(row.title), [
                { text: CANCEL, style: 'cancel' },
                {
                    text: DELETE.label,
                    style: 'destructive',
                    onPress: () => {
                        deleteChat(outbox, { threadId: row.id, newId: randomId }).catch(failed);
                    },
                },
            ]);
        }
    };
    const current = renaming === null ? undefined : chats.find((chat) => chat.id === renaming.id);
    const element = (
        <>
            {renaming === null ? null : (
                <TextPrompt
                    title={RENAME_TITLE}
                    label={RENAME_LABEL}
                    initial={typeof current?.title === 'string' ? current.title : ''}
                    maxLength={MAX_CHAT_TITLE}
                    onCancel={() => setRenaming(null)}
                    onSave={(text) => {
                        if (chatTitle(text) === null) {
                            return `A title has 1 to ${MAX_CHAT_TITLE} characters.`;
                        }
                        setRenaming(null);
                        renameChat(outbox, { threadId: renaming.id, title: text, newId: randomId }).catch(failed);
                    }}
                    testID="chat-rename"
                />
            )}
            {archived === null && refused[0] !== undefined ? (
                <View pointerEvents="box-none" className="absolute right-0 bottom-0 left-0 p-4">
                    <NotSavedNotice
                        item={refused[0]}
                        onRetry={(id) => {
                            outbox.retryUnsent(id, randomId()).catch(failed);
                        }}
                        onDiscard={(id) => {
                            outbox.discardUnsent(id).catch(failed);
                        }}
                        testID="chat-not-saved"
                    />
                </View>
            ) : null}
            {archived === null ? null : (
                <UndoToast
                    key={archived.id}
                    text={CHAT_ARCHIVED}
                    action={UNDO}
                    onHide={() => setArchived(null)}
                    onAction={() => {
                        setArchived(null);
                        archiveChat(outbox, { threadId: archived.id, archived: false, newId: randomId }).catch(failed);
                    }}
                />
            )}
        </>
    );
    return {
        element,
        act,
        /** A row's accessibility actions: its menu's, and a room's Mark read while it has unread. */
        actions: (row: ChatRow) =>
            row.room ? chatSwipeActions(row).leading.map(({ name, label }) => ({ name, label })) : chatRowMenu(row),
        /** A row's swipe actions: Archive (a full swipe) and Delete (asks first); a room's Mark read. */
        swipes: (row: ChatRow) => {
            const views = chatSwipeActions(row);
            const of = (view: SwipeActionView): SwipeAction => ({
                ...view,
                icon: SWIPE_ICONS[view.name] ?? 'archive',
                testID: `chat-${row.id}-swipe-${view.name}`,
                onPress: () => act(row, view.name),
            });
            return { trailing: views.trailing.map(of), leading: views.leading.map(of) };
        },
        /** A row's long-press menu (CB-421: the system's, with the row as its preview). */
        menu: (row: ChatRow): MenuRequest => ({
            title: row.title,
            actions: chatRowMenu(row),
            onAction: (name) => act(row, name),
        }),
    };
}
