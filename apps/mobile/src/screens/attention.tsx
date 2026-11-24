import { useNavigation } from '@react-navigation/native';
import { useEffect } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';

import { inboxDecisionView } from '../chat/approval-card';
import { useAllPageConflicts, useCollections, useHasWorkspaceScope, useLiveQuery, useWorkspaceScope } from '../live';
import { approvalAction, approvalsAction, ATTENTION_PARAM, type BADGED_TABS, pageAction } from '../navigation/tabs';
import { randomId } from '../platform/crypto';
import { useNotificationAsk } from '../platform/notification-ask';
import { notificationsDenied } from '../push';
import { SEE_ALL } from '../shell/approvals';
import {
    attentionCount,
    type InboxSection,
    type InboxView,
    inboxView,
    NOTIFICATIONS_OFF,
    NOTIFICATIONS_OFF_HINT,
    pageConflictRows,
    PAGES_CHANGED,
    spacesAttention,
    spacesAttentionView,
} from '../shell/inbox';
import { moduleEntry } from '../shell/modules';
import { chatsQuery, noticesQuery, shellQuery, shellRows, sociosQuery, spacesQuery } from '../shell/queries';
import { INVITES_TITLE, inviteRows } from '../shell/room-invites';
import { SWIPE_READ } from '../shell/swipe-actions';
import { markRoomReadFromList } from '../sync/room-send';
import { AppSymbol, RowSeparator, separatorInset, Text, ToneTile, useGroupedColor, useOnGroupedPage } from '../ui';

import { ActionRow, useChatApprovals } from './approval-card';
import { MODULE_ICONS } from './module-icons';
import { InviteRows } from './room-invite';
import { CountBadge, ListRow, Section, SocioAvatar, useOpenChat } from './shell-parts';
import { SwipeRow } from './swipe-row';

// What needs the person's attention, at the top of Chats (CB-455: the owner
// dropped the Inbox tab, 2026-11-19; src/shell/inbox.ts says what shows, in
// what order): the approvals waiting first (each row opens the request's page,
// with Deny and Approve under it where the request page's rules let it decide
// in place; See all the list), the day's notices, the room invites (each opens its sheet, with the
// disclosure, Decline and Join), the rooms with unread (each opens its room)
// and, while the phone's notifications are denied, a row to the
// phone's Settings. With nothing in it, nothing shows. The Chats tab's badge
// counts the same items (`attentionCount`; TabBadge, shell-tabs.tsx).

/** What the attention section reads: Chats keeps these pulled. */
export const ATTENTION_SYNCED = ['shell', 'conversations', 'dots', 'notices', 'approvals', 'room-invites'] as const;
const APPROVALS = moduleEntry(MODULE_IDS.approvals);
const SPACES = moduleEntry(MODULE_IDS.spaces);

/** What needs attention in the open workspace, live (src/shell/inbox.ts's `inboxView`). */
export function useAttention(): InboxView {
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const { data: notices } = useLiveQuery({ query: noticesQuery(collections) });
    const { data: approvals } = useLiveQuery({
        query: (q) => q.from({ approval: collections.approvals }),
    });
    const { data: invites } = useLiveQuery({
        query: (q) => q.from({ invite: collections.roomInvites }),
    });
    const denied = notificationsDenied(useNotificationAsk());
    const state = shellRows(shell).state;
    return inboxView(approvals, notices, chats, dots, state, {
        invites: inviteRows(invites, state),
        notificationsDenied: denied,
        now: Date.now(),
    });
}

/** What TabBadge dispatches on the tab navigator (shell-tabs.tsx's layout). */
export interface TabsHandle {
    /** The tab navigator's state key, and the badged tab's route key and params. */
    readonly navigator: string;
    readonly route: { readonly key: string; readonly params?: object } | undefined;
    readonly dispatch: (action: { type: string; payload?: object; source?: string; target?: string }) => void;
}

/**
 * A tab's badge, set on its route's params, which its options read (tabs.ts's `tabBadge`). It sits
 * in the tabs' layout, so the badge shows before the tab is ever opened:
 * - Chats (CB-455): the count of what needs attention (`attentionCount`);
 * - Spaces (CB-459): the pages changed elsewhere while the person's edits waited (the page saves' conflicts,
 *   which the top of the Spaces list shows: `SpacesAttention`), and nothing else, so no page counts
 *   on Chats too.
 */
export function TabBadge({ tab, handle }: { tab: (typeof BADGED_TABS)[number]; handle: TabsHandle }) {
    if (!useHasWorkspaceScope()) {
        return null;
    }
    return tab === 'Chats' ? <ChatsBadgeCount handle={handle} /> : <SpacesBadgeCount handle={handle} />;
}

function ChatsBadgeCount({ handle }: { handle: TabsHandle }) {
    useTabBadge(handle, attentionCount(useAttention()));
    return null;
}

function SpacesBadgeCount({ handle }: { handle: TabsHandle }) {
    useTabBadge(handle, spacesAttention(useAllPageConflicts()));
    return null;
}

/** Puts `count` on the tab's route's params when it differs from what they hold. */
function useTabBadge({ route, navigator, dispatch }: TabsHandle, count: number) {
    const shown = (route?.params as Record<string, unknown> | undefined)?.[ATTENTION_PARAM];
    const key = route?.key;
    useEffect(() => {
        if (key !== undefined && shown !== count) {
            dispatch({
                type: 'SET_PARAMS',
                payload: { params: { [ATTENTION_PARAM]: count } },
                source: key,
                target: navigator,
            });
        }
    }, [key, shown, count, navigator, dispatch]);
}

/** The attention section's parts, each a grouped section, at the top of Chats; nothing when it's empty. */
export function AttentionSections({ view }: { view: InboxView }) {
    if (view.empty) {
        return null;
    }
    return (
        <View className="gap-4 pb-2" testID="attention">
            {view.sections.map((section) => (
                <AttentionPart key={section} section={section} view={view} />
            ))}
        </View>
    );
}

/**
 * The approvals waiting: each row opens its request's page,
 * with Deny and Approve under it as the web's cards have, through the scope's `approvals.decide`
 * (online only; `useChatApprovals` watches each while Chats shows and says what a tap came to). A
 * request whose details must be opened first, or that asks for more than a yes, has no buttons and
 * says so: its row opens it. Then See all, with the count.
 */
function AttentionApprovals({ view }: { view: InboxView }) {
    const navigation = useNavigation();
    const rows = view.approvals.rows;
    const open = (id: string) => navigation.dispatch(approvalAction(id));
    const approvals = useChatApprovals(
        rows.map((row) => row.id),
        open,
        open,
    );
    return (
        <Section title={APPROVALS.title} testID="attention-approvals">
            {rows.map((row, index) => {
                const request = approvals.views.get(row.id);
                const decision =
                    request === undefined
                        ? null
                        : inboxDecisionView(request, approvals.context(row.id), approvals.notice(row.id));
                return (
                    <View key={row.id}>
                        {index === 0 ? null : <RowSeparator inset={separatorInset(44)} />}
                        <Pressable
                            testID={`attention-approval-${row.id}`}
                            accessibilityRole="button"
                            accessibilityLabel={row.accessibilityLabel}
                            accessibilityHint="Opens the request"
                            onPress={() => open(row.id)}
                            className="flex-row items-center gap-3 p-3 active:bg-accent"
                            style={{ minHeight: 68 }}
                        >
                            <ToneTile tone={APPROVALS.tone} icon={MODULE_ICONS[APPROVALS.icon]} surface="card" />
                            <View className="min-w-0 flex-1 gap-0.5">
                                <Text variant="row-title" numberOfLines={2}>
                                    {row.title}
                                </Text>
                                {row.summary === null ? null : (
                                    <Text variant="footnote" tone="muted" numberOfLines={2}>
                                        {row.summary}
                                    </Text>
                                )}
                            </View>
                            <AppSymbol name="chevron-right" color="muted-foreground" />
                        </Pressable>
                        {decision === null || (decision.actions.length === 0 && decision.note === null) ? null : (
                            // Under the words, past the tile: 12 pt of padding, the 44 pt tile, a 12 pt gap.
                            <View className="gap-2 pr-3 pb-3" style={{ paddingLeft: 68 }}>
                                {decision.note === null ? null : (
                                    <Text
                                        variant="footnote"
                                        tone="muted"
                                        accessibilityLiveRegion="polite"
                                        testID={`attention-approval-${row.id}-note`}
                                    >
                                        {decision.note}
                                    </Text>
                                )}
                                {decision.actions.length === 0 ? null : (
                                    <ActionRow
                                        actions={decision.actions}
                                        onAction={(key) => approvals.act(row.id, key)}
                                        testID={`attention-approval-${row.id}`}
                                    />
                                )}
                            </View>
                        )}
                    </View>
                );
            })}
            <ListRow
                testID="attention-approvals-all"
                title={SEE_ALL}
                trailing={
                    <View className="flex-row items-center gap-2">
                        <CountBadge label={String(view.approvals.waiting)} />
                        <AppSymbol name="chevron-right" color="muted-foreground" />
                    </View>
                }
                accessibilityLabel={view.approvals.seeAllLabel}
                onPress={() => navigation.dispatch(approvalsAction())}
            />
        </Section>
    );
}

function AttentionPart({ section, view }: { section: InboxSection; view: InboxView }) {
    const openChat = useOpenChat();
    switch (section) {
        case 'approvals':
            return <AttentionApprovals view={view} />;
        case 'notices':
            return (
                <Section title="Notices" testID="attention-notices">
                    {view.notices.map((notice, index) => (
                        <ListRow
                            key={notice.id}
                            first={index === 0}
                            testID={`notice-${notice.id}`}
                            title={notice.title}
                            subtitle={notice.body}
                            subtitleLines={2}
                            accessibilityLabel={notice.accessibilityLabel}
                        />
                    ))}
                </Section>
            );
        case 'invites':
            return (
                <Section title={INVITES_TITLE} testID="attention-invites">
                    <InviteRows rows={view.invites} testID="attention-invite" />
                </Section>
            );
        case 'rooms':
            return (
                <Section title="Rooms" testID="attention-rooms">
                    {view.rooms.map((room, index) => (
                        <AttentionRoomRow key={room.id} room={room} first={index === 0} onOpen={() => openChat(room)} />
                    ))}
                </Section>
            );
        case 'notifications':
            return (
                <Section title="Notifications" testID="attention-notifications">
                    {/* Its words wrap and the row grows with them, with no line limit as a ListRow's subtitle has. */}
                    <Pressable
                        testID="attention-notifications-off"
                        accessibilityRole="button"
                        accessibilityLabel={NOTIFICATIONS_OFF}
                        accessibilityHint={NOTIFICATIONS_OFF_HINT}
                        onPress={() => void Linking.openSettings()}
                        className="flex-row items-center gap-3 p-3 active:bg-accent"
                        style={{ minHeight: 56 }}
                    >
                        <AppSymbol name="bell-off" color="muted-foreground" />
                        <View className="min-w-0 flex-1 gap-0.5">
                            <Text weight="medium">{NOTIFICATIONS_OFF}</Text>
                            <Text variant="footnote" tone="muted">
                                {NOTIFICATIONS_OFF_HINT}
                            </Text>
                        </View>
                        <AppSymbol name="chevron-right" color="muted-foreground" />
                    </Pressable>
                </Section>
            );
    }
}

/**
 * A room with unread: it opens the room; swiped toward the leading edge, or through its
 * accessibility action, Mark read, the room screen's own read mark.
 */
function AttentionRoomRow({
    room,
    first,
    onOpen,
}: {
    room: InboxView['rooms'][number];
    first: boolean;
    onOpen: () => void;
}) {
    const { histories, outbox } = useWorkspaceScope();
    const cell = useGroupedColor(useOnGroupedPage() ? 'cell' : 'plainCell');
    const markRead = () =>
        markRoomReadFromList({ histories, outbox, newId: randomId }, room.id).catch((error: unknown) =>
            console.warn('[chats] the room was not marked read', error),
        );
    const read =
        room.unreadLabel === null
            ? []
            : [
                  {
                      ...SWIPE_READ,
                      icon: 'message-square-check' as const,
                      testID: `attention-room-${room.id}-read`,
                      onPress: markRead,
                  },
              ];
    return (
        <SwipeRow leading={read}>
            <View style={{ backgroundColor: cell }}>
                <ListRow
                    first={first}
                    testID={`attention-room-${room.id}`}
                    leading={<SocioAvatar character={room.character} />}
                    title={room.title}
                    subtitle={room.socio}
                    trailing={room.unreadLabel === null ? null : <CountBadge label={room.unreadLabel} />}
                    accessibilityLabel={room.accessibilityLabel}
                    onPress={onOpen}
                    accessibilityActions={read.map(({ name, label }) => ({ name, label }))}
                    onAccessibilityAction={(name) => {
                        if (name === SWIPE_READ.name) {
                            markRead();
                        }
                    }}
                />
            </View>
        </SwipeRow>
    );
}

/**
 * What the Inbox held about Spaces, at the top of the Spaces tab's list (the owner, 2026-11-20), in
 * the attention section's style: the pages changed elsewhere while the person's edits waited,
 * each opening the page under its conflict banner in the Spaces tab. Nothing while it's empty.
 * The Spaces tab's badge counts the same pages (TabBadge's `spacesAttention`).
 */
export function SpacesAttention() {
    const navigation = useNavigation();
    const collections = useCollections();
    const { pages } = useWorkspaceScope();
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const names = new Map(spaces.map((space) => [space.id, space.name]));
    const view = spacesAttentionView(pageConflictRows(useAllPageConflicts(), (id) => names.get(id) ?? null));
    if (view.empty) {
        return null;
    }
    return (
        <Section title={PAGES_CHANGED} testID="spaces-attention-pages">
            {view.pageConflicts.map((row, index) => (
                <ListRow
                    key={row.id}
                    first={index === 0}
                    testID={`spaces-attention-page-${row.id}`}
                    leadingSize={44}
                    leading={<ToneTile tone={SPACES.tone} icon="file-text" surface="card" />}
                    title={row.title}
                    subtitle={row.subtitle}
                    trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
                    accessibilityLabel={row.accessibilityLabel}
                    accessibilityHint="Opens the page"
                    onPress={() => {
                        // The body from disk first, so the reader draws it in its first frame.
                        pages
                            .preload(row.spaceId, row.id)
                            .catch((error: unknown) => console.warn('[pages] not read from disk', error));
                        navigation.dispatch(pageAction(row.spaceId, row.id));
                    }}
                />
            ))}
        </Section>
    );
}
