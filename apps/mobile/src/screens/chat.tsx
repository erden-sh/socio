import { KeyboardAwareLegendList } from '@legendapp/list/keyboard';
import type { LegendListRef } from '@legendapp/list/react-native';
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    AccessibilityInfo,
    type AccessibilityActionEvent,
    ActivityIndicator,
    Platform,
    Pressable,
    Share,
    View,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type { ReactionKind } from '@socio/shared/chat/reactions';
import type { ModelChoice, ModelOptions } from '@socio/shared/inference';
import type { LocalId } from '@socio/shared/mascot';
import type { LiveTurn } from '@socio/shared/rooms/live-turn';
import { roomsOn } from '@socio/shared/rooms/room-view';
import { type CallReceipt, MAX_CHAT_TITLE } from '@socio/shared/types';

import { carriedFiles } from '../chat/attachment-tray';
import { approvalCardIds } from '../chat/cards';
import { CHAT_MENU_LABEL, chatInputLabel, chatPlaceholder, socioStatus } from '../chat/chat-header';
import { chatSource, holdChat, type OwnTurn } from '../chat/chat-source';
import {
    chatSocioId,
    chatView,
    chatWebUrl,
    emptyTranscriptLine,
    CONVERSATION_NOT_FOUND,
    MISSING_CHAT_CAPTION,
    ROOM_GONE_CAPTION,
    ROOM_GONE_TITLE,
    sendableChatId,
} from '../chat/chat-view';
import {
    type BubbleAction,
    bubbleAction,
    candidateSaid,
    chatLiveTurn,
    type OutboxState,
    outboxStateStore,
    composerView,
    type PendingBubble,
    missingChatBubbles,
    nextCandidate,
    pendingBubbles,
    pendingChatOf,
    readOnlyLine,
    scrollAnimated,
    SEND_FAILED,
    sendChatMessage,
    type StatusPill,
    liveLineInView,
    shownPill,
    statusPill,
    steeringStore,
    type SteeringSnapshot,
    STOP_FAILED,
} from '../chat/composer';
import { createFollowSession, isAtEnd, returnsToEndAfterTurn, TURN_END_SETTLE_MS } from '../chat/follow-session';
import {
    accessibilityActionsOf,
    COPY,
    messageMenu,
    type MessageRowActions,
    messageRowActions,
    notSaved,
    reactionOf,
} from '../chat/long-press';
import { holdsLink } from '../chat/markdown-links';
import { modelPickerView } from '../chat/model-picker';
import {
    readNameSuggestion,
    settleNameSuggestion,
    SUGGESTION_FAILED,
    type SuggestionAction,
} from '../chat/name-suggestion';
import { createPacedText, type PacedText } from '../chat/paced-text';
import { type PageReviewCard, reviewCardView, reviewDecision, reviewDraftShown } from '../chat/page-review';
import { quotedDraft, quoteOf, replyAuthor, replyBox as replyDraft } from '../chat/quote-reply';
import { reactionButtons, reactionSaid, reactionsShown } from '../chat/reactions';
import { ownWaiting, type RoomStarter } from '../chat/room-composer';
import { roomHeader } from '../chat/room-people';
import {
    cancelAnswer,
    cancelOthersQueued,
    newestSeq,
    type OthersBubble,
    othersBubbles,
    type RoomContext,
    type RoomNoteRow,
    roomBubbles,
    roomReplier,
    roomRows,
    roomRunningNote,
    shouldMarkRead,
} from '../chat/room-transcript';
import { createStreamHaptics } from '../chat/stream-haptics';
import {
    deliveredInTurn,
    bubbleLabel,
    messageFullTime,
    messageText,
    type ReplyRow,
    repliedAnnouncement,
    replyFinished,
    rowTime,
    type TraceRow,
    type TranscriptRow,
    type UserRow,
    transcriptDrawn,
    transcriptRows,
} from '../chat/transcript';
import {
    useBoundedState,
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSyncOnFocus,
    useSyncStatus,
    useViewState,
    useWorkspaceScope,
} from '../live';
import { useBarInset } from '../navigation/bar-inset';
import { useNativeBar } from '../navigation/native-bar';
import { createRunClient } from '../net/run-client';
import { appState } from '../platform/app-state';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import { useHaptics } from '../platform/device-settings';
import { chatScreen, LAST_SCREEN_KEY } from '../shell/last-screen';
import { LONG_PRESS_TO_MENU, MENU_TAKES_TAP } from '../shell/native-menu';
import { shellQuery, shellRows, sociosQuery } from '../shell/queries';
import { chatDraft, DraftError } from '../sync/chat-drafts';
import { CHAT_MANAGE_VIEWS, react } from '../sync/chat-manage';
import { CHAT_MESSAGE_VIEW } from '../sync/chat-send';
import { isLocalChat } from '../sync/local-ids';
import type { Outbox, OutboxRow } from '../sync/outbox';
import { type OverlayItem, overlaysOf } from '../sync/outbox-overlay';
import type { OwnTurns } from '../sync/own-turns';
import type { PageChatContext } from '../sync/page-conversation';
import { openReviews, PAGE_REVIEW_VIEW } from '../sync/page-review';
import type { ReactionsState } from '../sync/reactions';
import { markRoomRead, ROOM_MESSAGE_VIEW } from '../sync/room-send';
import { roomReadOnly } from '../sync/rooms';
import type { WorkspaceScope } from '../sync/scope';
import { keyboardScroll, Screen, Text } from '../ui';
import { cx } from '../ui/cx';
import { EmptyState, useWayBack } from '../ui/empty-state';

import { ActionMenu, type MenuRequest, NotSavedNotice, TextPrompt } from './action-menu';
import { ApprovalBar, ApprovalCardItem, type ChatApprovals, useChatApprovals } from './approval-card';
import { MessageAttachments, useTray } from './attachments';
import { CardView, MessageActionRow, NameSuggestionCard, ReviewCard } from './chat-cards';
import { Composer, PendingBubbleView, ReadOnlyLine, StatusPillView, useDraft, useQuotedDraft } from './chat-composer';
import { ChatTitle, useChatMenu, useModelOptions } from './chat-header';
import { ReplyMarkdown } from './chat-markdown';
import { MessageText } from './message-text';
import { useOpenLink } from './open-link';
import { PageContextBanner, usePageChatContext, usePageRefreshAfterTurn } from './page-chat-context';
import { RoomComposer } from './room-composer';
import { OthersBubbleView, RoomBar, RoomNote, SpeakerLine, useRoomFailures } from './room-parts';
import { StatusBanners } from './shell-parts';
import { useShownChats } from './shown-chats';
import { RunNote, TraceDisclosure } from './turn-disclosure';

// The chat screen: the `Chat` route at `/chats/:id`,
// pushed over the tabs from the chat list, Home and Search, or opened by a link.
// - A private chat draws its transcript (src/chat/transcript.ts): the stored
//   runs from the scope's history, then the running turn from its follow
//   stream, both held (`use`) while the screen shows. The history is read from
//   disk before the first frame on a row press or a cold start onto the chat
//   (`preload`), so its runs draw at once, offline too.
// - The list is T3 Code's: one KeyboardAwareLegendList that starts at the end
//   (a chat shorter than the screen starts at the top, as on the web and in
//   ChatGPT: owner, 2026-11-18),
//   follows it while the person hasn't scrolled away (src/chat/follow-session.ts,
//   T3's follow machine) and pages older runs in from the top.
// - The socio's replies are Markdown at full width (chat-markdown.tsx);
//   the person's messages are bubbles on the right. A reply being written shows a few words at a
//   time (paced-text.ts, CB-365). Screen readers hear "<socio> replied" once per turn.
// - Each stored turn that did work has its trace row, a disclosure
//   folded until the person opens it (CB-434, turn-disclosure.tsx), its step
//   lines opening the TurnTrace sheet at their step; a running turn says
//   "Working · 3 steps" from its events. A run's notes beyond its stream (the
//   background, its report: run-lifecycle.ts) come last.
// - A room (src/chat/room-transcript.ts, room-parts.tsx) is the same
//   transcript with who wrote each message, handoffs and unanswered turns as
//   lines, another person's running turn only as its note in the pill, its
//   own header (status, presence, the socios opening Members), a room admin's
//   view of everyone's queued messages with Cancel, and its read mark while
//   its newest run shows and the app is active. Its composer is the room's
//   (room-composer.tsx): mentions, who answers, Stop for whom may.
// - A chat or room keeps itself as the workspace's last screen (`Chat/<id>`).
// - The composer (chat-composer.tsx, src/chat/composer.ts) floats over
//   the keyboard (KeyboardStickyView) under the status pill: Send through the
//   outbox (a new chat's local id until its create resolves, and
//   the route then swaps to the server id), Stop while a turn runs, and the
//   person's messages not yet in the transcript as pending bubbles after it.
//   A run this device started streams from its own POST (the scope's `turns`).
//   A Telegram chat or team topic shows its line in place of the composer.
// - Cards (src/chat/cards.ts, chat-cards.tsx): approvals as "Needs your
//   approval", coding sessions, the computer's screenshot and voice receipts,
//   read-only, opening the web through useOpenLink. A long-press on a message
//   opens Copy, Share and a stored reply's reactions, each also an
//   accessibility action. Every message has the web's action row under it
//   (owner, 2026-11-18): Copy, a stored reply's four reactions, then the
//   time; the person's own messages Copy and the time. Every
//   message's whole date is its long-press menu's title, and the person's
//   bubble says its time to screen readers. The server's suggested name for the chat
//   sits above the composer.

const SYNCED = ['shell', 'conversations', 'dots'] as const;

export function ChatScreen({ route }: StaticScreenProps<{ id: string }>) {
    return useHasWorkspaceScope() ? <Chat id={route.params.id} /> : null;
}

function Chat({ id }: { id: string }) {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    useSyncOnFocus(SYNCED);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const chats = useShownChats();
    const writes = useOutboxState(scope.outbox);
    // A new chat isn't listed until its create resolves and a pull brings it: its writes name it.
    const pending = pendingChatOf([...writes.rows, ...writes.unsent], scope.outbox.resolve, id);
    const view = chatView(chats, dots, id, shellRows(shell).workspace !== null, pending);
    useRememberChat(view.kind === 'private' || view.kind === 'room' ? id : null);
    useResolvedChat(id);
    // The header's "…" (Save as page, Schedule a task) and the model picker's choices (the web's socio bar),
    // neither choosable while a reply is still being written: the transcript says when one runs.
    const [running, setRunning] = useState(false);
    const menu = useChatMenu(id, view.title, running);
    // A page chat's page (CB-499): its banner, and its Space pulled as each turn ends.
    const page = usePageChatContext(view.kind === 'private' ? id : null);
    usePageRefreshAfterTurn(page, running);
    const models = useModelOptions();
    const barInset = useBarInset();
    if (view.kind === 'room') {
        return (
            <Room
                key={id}
                id={id}
                title={view.title}
                socio={view.socio}
                writes={writes}
                calls={shellRows(shell).workspace?.calls ?? NO_CALLS}
            />
        );
    }
    const sendTo = view.kind === 'private' ? sendableChatId(chats, id, pending) : null;
    const composer: ChatComposer = {
        sendTo,
        dotId: chatSocioId(chats, id, pending),
        readOnly: readOnlyLine(chats.find((chat) => chat.id === id)),
        room: false,
        roomId: null,
    };
    const chat = chats.find((known) => known.id === id);
    const dot = dots.find((known) => known.id === composer.dotId);
    return (
        <View testID="chat-screen" className="flex-1 bg-screen" collapsable={false}>
            <PrivateChatBar
                chatId={id}
                title={view.title}
                socio={view.kind === 'private' ? { name: view.socio, character: view.character } : null}
                paused={shellRows(shell).state?.settings.paused === true}
                value={chat?.inference}
                dotDefault={dot?.inference}
                models={models}
                running={running}
                menu={menu.menu}
            />
            {view.kind === 'private' ? (
                <Transcript
                    key={id}
                    id={id}
                    socio={view.socio}
                    onRunning={setRunning}
                    page={page ?? null}
                    composer={composer}
                    writes={writes}
                    calls={shellRows(shell).workspace?.calls ?? NO_CALLS}
                />
            ) : view.kind === 'missing' ? (
                <MissingChat id={id} writes={writes} />
            ) : (
                <View
                    testID="chat-waiting"
                    className="flex-1 items-center justify-center p-4"
                    style={{ marginTop: barInset }}
                >
                    <ActivityIndicator accessibilityLabel="Opening the chat" />
                </View>
            )}
            {view.kind === 'private' ? menu.overlay : null}
        </View>
    );
}

/**
 * A private chat's bar (CB-420): one system bar over the transcript, its title the socio with the
 * model it runs on (the model picker, ChatTitle), the "…" menu at its end (Save as page and
 * Schedule a task). While the chat is missing or opening, its title alone.
 */
function PrivateChatBar(props: {
    chatId: string;
    title: string;
    socio: { readonly name: string | null; readonly character: LocalId } | null;
    paused: boolean;
    value: ModelChoice | null | undefined;
    dotDefault: ModelChoice | null | undefined;
    models: ModelOptions | null;
    running: boolean;
    /** The ⋯'s native menu (CB-421), or none. */
    menu: MenuRequest | null;
}) {
    const navigation = useNavigation();
    const status = socioStatus(props.paused);
    const picker = modelPickerView({ value: props.value, dotDefault: props.dotDefault, models: props.models });
    const socio = props.socio;
    const menu = props.menu;
    useNativeBar({
        title: props.title,
        edge: 'hard',
        ...(socio === null
            ? {}
            : {
                  titleView: {
                      signature: JSON.stringify([socio, status, props.paused, picker.label, props.running]),
                      element: () => (
                          <ChatTitle
                              chatId={props.chatId}
                              socio={socio.name}
                              character={socio.character}
                              status={status}
                              paused={props.paused}
                              value={props.value}
                              dotDefault={props.dotDefault}
                              models={props.models}
                              running={props.running}
                              onPick={() => navigation.navigate('ChatModel', { id: props.chatId })}
                          />
                      ),
                  },
              }),
        right:
            socio === null || menu === null
                ? []
                : [
                      {
                          id: 'chat-menu',
                          label: CHAT_MENU_LABEL,
                          symbol: 'ellipsis',
                          icon: 'ellipsis',
                          iconOnly: true,
                          onPress: MENU_TAKES_TAP,
                          menu,
                      },
                  ],
    });
    return null;
}

/**
 * A room: its view held and polled with its presence while it shows
 * (`rooms.show`), its header, then its transcript; a room the server says the
 * reader left shows that, with what the phone still holds for it.
 */
function Room({
    id,
    title,
    socio,
    writes,
    calls,
}: {
    id: string;
    title: string;
    socio: string | null;
    writes: OutboxState;
    calls: readonly CallReceipt[];
}) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const chats = useShownChats();
    useEffect(() => scope.rooms.show(id), [scope, id]);
    const roomView = useBoundedState(scope.roomViews.item(id));
    const presence = useRoomPresence(id);
    const chat = chats.find((known) => known.id === id);
    const state = shellRows(shell).state;
    // Before the first state answer, Rooms count as on: a room never flashes read-only.
    const readOnly = roomReadOnly(chat ?? {}, roomView.value, state === null || roomsOn(state));
    const me = scope.workspace.appUserId;
    const header = roomHeader({
        title,
        view: roomView.value,
        dots,
        paused: state?.settings.paused === true,
        present: presence.people,
        me,
    });
    const room: RoomScreen = {
        context: {
            view: roomView.value,
            leadId: chat?.dotId ?? roomView.value?.dotId ?? '',
            dots,
            me,
            failure: scope.runFailures.codeOf,
        },
        admin: roomView.value?.role === 'admin',
        unread: chat?.unread ?? 0,
    };
    const composer: ChatComposer = {
        sendTo: null,
        dotId: room.context.leadId,
        readOnly: readOnly ?? null,
        room: true,
        roomId: id,
    };
    return (
        <View testID="chat-screen" className="flex-1 bg-screen" collapsable={false}>
            <RoomBar
                header={header}
                onMembers={roomView.value === null ? null : () => navigation.navigate('RoomMembers', { id })}
                onMenu={() => navigation.navigate('RoomMenu', { id })}
            />
            {roomView.gone ? (
                <MissingChat id={id} writes={writes} headline={ROOM_GONE_TITLE} caption={ROOM_GONE_CAPTION} />
            ) : (
                <Transcript id={id} socio={socio} composer={composer} writes={writes} calls={calls} room={room} />
            )}
        </View>
    );
}

/** Who else is looking at the room, polled while it shows (`rooms.presence`). */
function useRoomPresence(id: string) {
    const { rooms } = useWorkspaceScope();
    const presence = rooms.presence(id);
    return useSyncExternalStore(presence.subscribe, () => presence.state);
}

/** What the transcript needs for a room. */
interface RoomScreen {
    readonly context: RoomContext;
    /** The reader is one of its admins: everyone's queued messages show, with Cancel. */
    readonly admin: boolean;
    /** The room's unread count as the list holds it, when it opened. */
    readonly unread: number;
}

/** Whether the app is in the foreground and this screen is the one shown. */
function useShownAndActive(): boolean {
    const focused = useIsFocused();
    const active = useSyncExternalStore(appState.subscribe, () => appState.current() === 'active');
    return focused && active;
}

/**
 * The room's read mark (the `room-read` write): its newest stored run, once it is
 * on screen (the list follows its end) while the app is active, each newer run
 * again. A room opened with nothing unread counts its newest run as marked.
 */
function useRoomRead(id: string, room: RoomScreen | undefined, runs: readonly HistoryRun[], following: boolean) {
    const scope = useWorkspaceScope();
    const active = useShownAndActive();
    const marked = useRef<number | null | undefined>(undefined);
    const seq = newestSeq(runs);
    const unread = room?.unread ?? 0;
    const isRoom = room !== undefined;
    useEffect(() => {
        if (!isRoom || seq === null) {
            return;
        }
        if (marked.current === undefined && unread === 0) {
            marked.current = seq;
            return;
        }
        if (!shouldMarkRead({ seq, marked: marked.current ?? null, following, active })) {
            return;
        }
        marked.current = seq;
        markRoomRead(scope.outbox, id, seq, randomId).catch((error: unknown) =>
            console.warn('[chat] the room was not marked read', error),
        );
    }, [scope, id, isRoom, seq, unread, following, active]);
}

/** "This chat isn’t here", with the person's messages still on the phone for it (Delete only, no composer). */
function MissingChat({
    id,
    writes,
    headline = CONVERSATION_NOT_FOUND,
    caption = MISSING_CHAT_CAPTION,
}: {
    id: string;
    writes: OutboxState;
    headline?: string;
    caption?: string;
}) {
    const scope = useWorkspaceScope();
    const back = useWayBack('Chat');
    const bubbles = missingChatBubbles(
        pendingBubbles({
            threadId: id,
            overlays: overlaysOf({
                rows: writes.rows,
                unsent: writes.unsent,
                kinds: ROOM_VIEW_KINDS,
                scope: scope.outbox,
            }),
            queued: [],
            stored: () => false,
            inTurn: NO_MESSAGES,
            socio: 'your socio',
            heldForSignIn: writes.heldForSignIn,
            offline: false,
            now: Date.now(),
        }),
    );
    const onAction = (bubble: PendingBubble, action: BubbleAction) =>
        act(scope, bubble, action, { sendTo: null, dotId: null, readOnly: null, room: false, roomId: null });
    return (
        <Screen centered edges={['right', 'bottom', 'left']}>
            <EmptyState headline={headline} line={caption} action={back} testID="chat-missing" />
            {bubbles.length === 0 ? null : (
                <View className="gap-3 self-stretch">
                    {bubbles.map((bubble) => (
                        <PendingBubbleView key={bubble.id} bubble={bubble} onAction={onAction} />
                    ))}
                </View>
            )}
        </Screen>
    );
}

const NO_MESSAGES: ReadonlySet<string> = new Set();
const NO_CALLS: readonly CallReceipt[] = [];

/** What the composer sends to, or why it can't: from the chat route's view. */
interface ChatComposer {
    /** `sendableChatId`'s: never a room's. */
    readonly sendTo: string | null;
    readonly dotId: string | null;
    /** A Telegram chat's or team topic's line, or a read-only room's, in place of the composer. */
    readonly readOnly: string | null;
    /** A room: its own composer, no name suggestion. */
    readonly room: boolean;
    /** A room's id, its box's draft scope: never `sendTo`, so never the chat's send path. */
    readonly roomId: string | null;
}

/** The outbox's rows, refused writes and sign-in hold, for React. */
function useOutboxState(outbox: Outbox): OutboxState {
    const [store] = useState(() => outboxStateStore(outbox));
    return useSyncExternalStore(store.subscribe, store.get);
}

/** A new chat's screen swaps its local id for the server's once the create resolves. */
function useResolvedChat(id: string) {
    const navigation = useNavigation();
    const { chats } = useWorkspaceScope();
    useEffect(() => {
        const swap = (serverId: string) => navigation.setParams({ id: serverId } as never);
        const known = chats.resolve(id);
        if (known !== id) {
            swap(known);
            return undefined;
        }
        return chats.subscribe((localId, serverId) => {
            if (localId === id) {
                swap(serverId);
            }
        });
    }, [chats, id, navigation]);
}

/** Keeps a chat or room as the workspace's last screen each time it comes into view. */
function useRememberChat(id: string | null) {
    const viewState = useViewState();
    useFocusEffect(
        useCallback(() => {
            if (id !== null) {
                viewState.set(LAST_SCREEN_KEY, chatScreen(id));
            }
        }, [viewState, id]),
    );
}

type ListRow = TranscriptRow | RoomNoteRow | PendingBubble | OthersBubble;

const CHAT_VIEW_KINDS = [CHAT_MESSAGE_VIEW];
/** A room's messages are `room-message` rows; a chat's sent before it became a room still show. */
const ROOM_VIEW_KINDS = [CHAT_MESSAGE_VIEW, ROOM_MESSAGE_VIEW];
const REVIEW_KINDS = [PAGE_REVIEW_VIEW];

/** What a chat's page review cards need: the reviews open, the calls stored, the decisions queued. */
interface ChatReviews {
    readonly open: ReadonlySet<string>;
    readonly stored: ReadonlySet<string>;
    readonly decisions: readonly OverlayItem[];
}

/** The tool call ids of the stored runs. */
function storedCalls(runs: readonly HistoryRun[]): ReadonlySet<string> {
    return new Set(
        runs.flatMap((run) =>
            run.messages.flatMap((message) =>
                message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : [],
            ),
        ),
    );
}

/** A page review's card: Review opens its sheet over the chat. */
function ReviewCardItem({
    card,
    testID,
    chat,
    dot,
    reviews,
    openLink,
}: {
    card: PageReviewCard;
    testID: string;
    chat: string;
    dot: string | null;
    reviews: ChatReviews;
    openLink: (href: string) => void;
}) {
    const navigation = useNavigation();
    const view = reviewCardView(card, {
        open: reviews.open.has(card.toolCallId),
        stored: reviews.stored.has(card.toolCallId),
        decision: reviewDecision(reviews.decisions, card.toolCallId),
    });
    return (
        <ReviewCard
            title={reviewDraftShown(card.args).title}
            view={dot === null && view.action?.kind === 'review' ? { ...view, action: null } : view}
            testID={testID}
            onReview={() => {
                if (dot !== null) {
                    navigation.navigate('PageReview', { chat, call: card.toolCallId, dot });
                }
            }}
            openLink={openLink}
        />
    );
}

function Transcript({
    id,
    socio,
    composer,
    writes,
    calls,
    room,
    onRunning,
    page = null,
}: {
    id: string;
    socio: string | null;
    composer: ChatComposer;
    writes: OutboxState;
    calls: readonly CallReceipt[];
    /** A room's: who wrote what, its notes, its admins' view of the queue. */
    room?: RoomScreen;
    /** Told whether a turn runs (the footer's `running`), for the private chat's header. */
    onRunning?: (running: boolean) => void;
    /** The page a page chat is about (CB-499), its banner under the bar. */
    page?: PageChatContext | null;
}) {
    const scope = useWorkspaceScope();
    const navigation = useNavigation();
    const insets = useSafeAreaInsets();
    const bar = useBarInset();
    // The page banner sits under the bar, so the transcript and its banners start below both.
    const [bannerHeight, setBannerHeight] = useState(0);
    const barInset = bar + (page === null ? 0 : bannerHeight);
    const reduceMotion = useReducedMotion();
    // Asked in render, so the first frame draws what memory holds (a preload's runs);
    // held from the first effect on, so nothing evicts it while it shows. Between
    // render and the effect another chat may have retired this one (the store's
    // hold rule: `history()` and `use()` in the same turn), so the effect asks again
    // and holds what it gets in the same synchronous step, rebuilding if it changed.
    const [source, setSource] = useState(() =>
        chatSource(scope.histories.history(id), scope.follows.follow(id), ownTurn(scope.turns, id)),
    );
    useEffect(() => {
        const history = scope.histories.history(id);
        if (history !== source.history) {
            setSource(chatSource(history, scope.follows.follow(id), ownTurn(scope.turns, id)));
            return undefined;
        }
        return holdChat(source);
    }, [scope, id, source]);
    const snapshot = useSyncExternalStore(source.subscribe, source.get);
    const steering = useSteering(id);
    const syncStatus = useSyncStatus();
    const turn = chatLiveTurn(snapshot.own, snapshot.follow.turn);
    const running = turn.running || steering.running;
    useEffect(() => {
        onRunning?.(running);
    }, [onRunning, running]);
    const { history } = snapshot;
    const lifecycle = useRunLifecycle(id);
    const extras = { calls, threadId: id, earlier: history.earlier, socio, lifecycle };
    // The traces the person opened (CB-434): folded until then, kept while the chat shows.
    const [openTraces, setOpenTraces] = useState<ReadonlySet<string>>(() => new Set());
    const toggleTrace = (traceId: string) => {
        // The row stays where it is and opens below (CB-437): the list stops following its end, unless a reply streams,
        // and keeps the row's distance from the top of the view until it settles (`keepHeldRow`).
        const state = list.current?.getState();
        const top = state?.positionByKey(traceId);
        heldRow.current =
            state === undefined || top === undefined ? null : { key: traceId, offset: top - state.scroll };
        session.disclosure(running, () => list.current?.getState().isAtEnd ?? false);
        if (session.holding && state !== undefined) {
            // A scroll of the app's own, to where the list is: for two seconds after a chat opens, LegendList
            // otherwise keeps its end in view as rows resize (its initial scroll's preserved target).
            list.current?.scrollToOffset({ offset: state.scroll, animated: false }).catch(() => {});
        }
        setOpenTraces((known) => {
            const next = new Set(known);
            if (!next.delete(traceId)) {
                next.add(traceId);
            }
            return next;
        });
    };
    const failure = useRoomFailures(room === undefined ? null : id, snapshot.runs);
    const rows =
        room === undefined
            ? transcriptRows(snapshot.runs, turn, extras)
            : roomRows(snapshot.runs, turn, { ...room.context, failure }, extras);
    const reactions = useReactions(id, snapshot.runs.length);
    const manageOverlays = overlaysOf({
        rows: writes.rows,
        unsent: writes.unsent,
        kinds: CHAT_MANAGE_VIEWS,
        scope: scope.outbox,
    });
    const shownReactions = reactionsShown(reactions.view, manageOverlays, id);
    const reviews: ChatReviews = {
        open: new Set(openReviews(snapshot.runs).map((call) => call.toolCallId)),
        stored: storedCalls(snapshot.runs),
        decisions: overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: REVIEW_KINDS, scope: scope.outbox }),
    };
    const refusedReaction = notSaved(manageOverlays, { threadId: id })[0];
    const openLink = useOpenLink();
    const webUrl = chatWebUrl(scope.workspace.origin, id);
    const reactionFailed = (error: unknown) => console.warn('[chat] the reaction was not saved', error);
    const toggle = (messageId: string, kind: ReactionKind, on: boolean) => {
        AccessibilityInfo.announceForAccessibility(reactionSaid(kind, on));
        react(scope.outbox, { threadId: id, messageId, reaction: kind, on: !on, newId: randomId }).catch(
            reactionFailed,
        );
    };
    const onMessageAction = (row: UserRow | ReplyRow, name: string) => {
        const kind = reactionOf(name);
        if (kind !== null) {
            const button = reactionButtons(shownReactions, row.id).find((item) => item.kind === kind);
            toggle(row.id, kind, button?.on === true);
        } else if (name === 'copy') {
            Clipboard.setStringAsync(row.text).catch(() => {});
        } else if (name === 'share') {
            Share.share({ message: row.text }).catch(() => {});
        } else if (name === 'reply') {
            quoteInBox(row);
        }
    };
    // Reply (CB-571): the box this chat or room sends from, and who a quote names.
    // None where the chat shows a read-only line (Telegram, a team topic, a read-only room).
    const replyBox = replyDraft(composer);
    const authorOf = (row: UserRow | ReplyRow) =>
        replyBox === null
            ? null
            : replyAuthor(row, {
                  socio,
                  ...(room === undefined ? {} : { room: { view: room.context.view, me: room.context.me } }),
              });
    const quoteInBox = (row: UserRow | ReplyRow) => {
        const author = authorOf(row);
        if (replyBox === null || author === null) {
            return;
        }
        try {
            scope.drafts.write(replyBox, quotedDraft(scope.drafts.read(replyBox).text, quoteOf(author, row.text)));
        } catch (error) {
            // A newer build's draft, or the scope closing: the box keeps what it holds.
            if (!(error instanceof DraftError)) {
                throw error;
            }
        }
    };
    const messageActions = (row: UserRow | ReplyRow) =>
        messageMenu(
            row.kind === 'reply' && row.stored ? reactionButtons(shownReactions, row.id) : null,
            authorOf(row) !== null,
        );
    useFirstFrameWithData('Chat', transcriptDrawn(rows.length, history));
    useRepliedAnnouncement(turn, room === undefined ? socio : roomReplier(turn, room.context));
    useStreamHaptics(turn);

    const inTurn = deliveredInTurn(turn);
    const bubbles = pendingBubbles({
        threadId: id,
        overlays: overlaysOf({
            rows: writes.rows,
            unsent: writes.unsent,
            kinds: room === undefined ? CHAT_VIEW_KINDS : ROOM_VIEW_KINDS,
            scope: scope.outbox,
        }),
        queued: steering.queued,
        stored: (messageId) => source.history.has(messageId),
        inTurn,
        socio: socio ?? 'your socio',
        heldForSignIn: writes.heldForSignIn,
        offline: syncStatus.reconnecting,
        now: Date.now(),
        files: (writeId) => carriedFiles(scope.attachments.carried(writeId)),
        candidates: writes.candidates,
    });
    // A read-only room has no box for Edit to fill (the room's rule); a room with its composer edits as a chat.
    const pending = room === undefined || composer.readOnly === null ? bubbles : roomBubbles(bubbles);
    const others =
        room?.admin === true
            ? othersBubbles(
                  steering.others,
                  { stored: (messageId) => source.history.has(messageId), inTurn },
                  Date.now(),
                  // A read-only room (archived, rooms off) refuses a cancel: no Cancel there.
                  composer.readOnly === null,
              )
            : NO_OTHERS;
    const items: ListRow[] = [...rows, ...pending, ...others];
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [cancelNotice, setCancelNotice] = useState<string | null>(null);
    const cancelOthers = (bubble: OthersBubble) => {
        setCancelling(bubble.messageId);
        setCancelNotice(null);
        cancelOthersQueued(scope.fetch, id, bubble.messageId)
            .then((outcome) => {
                const answer = cancelAnswer(outcome);
                if (answer.refresh) {
                    scope.steering
                        .steering(id)
                        .refresh()
                        .catch(() => {});
                }
                if (answer.notice !== null) {
                    setCancelNotice(answer.notice);
                    AccessibilityInfo.announceForAccessibility(answer.notice);
                }
            })
            .finally(() => setCancelling(null));
    };

    const [session] = useState(() => createFollowSession());
    useEffect(() => () => session.dispose(), [session]);
    const following = useSyncExternalStore(session.subscribe, () => session.following);
    useRoomRead(id, room, snapshot.runs, following);
    const list = useRef<LegendListRef>(null);
    // The running turn's own line in view (`liveLineInView`): one stable callback, as a list wants it.
    const [lineInView, setLineInView] = useState(false);
    const [onViewable] = useState(
        () =>
            ({ viewableItems }: { viewableItems: readonly { key: string; isViewable: boolean }[] }) =>
                setLineInView(liveLineInView(viewableItems)),
    );
    // The row opened or closed last and its distance from the top of the view then (CB-437).
    const heldRow = useRef<{ key: string; offset: number } | null>(null);
    // T3's size-change anchor: while that row settles, a change in size leaves it where it was on screen.
    const keepHeldRow = () => {
        const held = heldRow.current;
        const top = held === null || !session.holding ? undefined : list.current?.getState().positionByKey(held.key);
        return held === null || top === undefined ? undefined : top - held.offset;
    };
    const viewing = useViewCandidate();

    // A turn that ends while the list follows (Stop included) goes back to the end once it settles.
    const wasRunning = useRef(turn.running);
    useEffect(() => {
        const back = returnsToEndAfterTurn(wasRunning.current, turn.running, session.following);
        wasRunning.current = turn.running;
        if (!back) {
            return undefined;
        }
        const timer = setTimeout(() => {
            list.current?.scrollToEnd({ animated: false }).catch(() => {});
        }, TURN_END_SETTLE_MS);
        return () => clearTimeout(timer);
    }, [turn.running, session]);

    const loadEarlier = () => {
        if (history.earlier && !history.loadingEarlier) {
            source.history.loadEarlier().catch((error: unknown) => console.warn('[chat] older runs not loaded', error));
        }
    };
    const toEnd = () => {
        session.reset();
        list.current?.scrollToEnd({ animated: scrollAnimated(reduceMotion) }).catch(() => {});
    };
    // View on "Couldn’t confirm this was sent": the next row that may be the message, in the middle, marked.
    const view = (bubble: PendingBubble) => {
        const candidates = bubble.candidates ?? [];
        const key = nextCandidate(candidates, viewing.shown?.write === bubble.writeId ? viewing.shown.key : null);
        const index = key === null ? -1 : items.findIndex((item) => item.id === key);
        if (key === null || index < 0) {
            return;
        }
        // The person's own scroll, as far as following goes: it stops until Jump to latest.
        session.dragBegin();
        session.dragEnd(false);
        viewing.show(bubble.writeId, key);
        AccessibilityInfo.announceForAccessibility(candidateSaid(candidates, key));
        list.current
            ?.scrollToIndex({ index, animated: scrollAnimated(reduceMotion), viewPosition: 0.5 })
            .catch(() => {});
    };
    // The bar's Show request: the request's card in the middle, followed no more (as View does).
    const showApproval = (approvalId: string) => {
        const index = items.findIndex(
            (item) => item.kind === 'card' && item.card.kind === 'approval' && item.card.id === approvalId,
        );
        if (index < 0) {
            return;
        }
        session.dragBegin();
        session.dragEnd(false);
        list.current
            ?.scrollToIndex({ index, animated: scrollAnimated(reduceMotion), viewPosition: 0.5 })
            .catch(() => {});
    };
    const approvals = useChatApprovals(approvalCardIds(rows), showApproval, (approvalId) =>
        navigation.navigate('ApprovalDetails', { id: approvalId }),
    );
    const onBubble = (bubble: PendingBubble, action: BubbleAction) =>
        action === 'view' ? view(bubble) : act(scope, bubble, action, composer);
    // A send scrolls to the end; a short chat's end is its last row, at the top (owner, 2026-11-18).
    const onSent = () => toEnd();

    return (
        <View className="flex-1" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
            {items.length === 0 ? (
                <EmptyTranscript
                    ready={history.ready || history.settled}
                    failed={history.failed}
                    room={room !== undefined}
                    inset={barInset}
                />
            ) : (
                <KeyboardAwareLegendList
                    ref={list}
                    testID="chat-transcript"
                    data={items}
                    keyExtractor={(row) => row.id}
                    getItemType={(row) => row.kind}
                    renderItem={({ item }) =>
                        item.kind === 'card' && item.card.kind === 'page-review' ? (
                            <ReviewCardItem
                                card={item.card}
                                testID={`chat-${item.id.replace(':', '-')}`}
                                chat={id}
                                dot={composer.dotId}
                                reviews={reviews}
                                openLink={openLink}
                            />
                        ) : item.kind === 'card' && item.card.kind === 'approval' ? (
                            <ApprovalCardItem
                                fallback={item.card}
                                approvals={approvals}
                                plain={
                                    <CardView
                                        card={item.card}
                                        testID={`chat-${item.id.replace(':', '-')}`}
                                        webUrl={webUrl}
                                        openLink={openLink}
                                    />
                                }
                                testID={`chat-${item.id.replace(':', '-')}`}
                            />
                        ) : item.kind === 'card' ? (
                            <CardView
                                card={item.card}
                                testID={`chat-${item.id.replace(':', '-')}`}
                                webUrl={webUrl}
                                openLink={openLink}
                            />
                        ) : item.kind === 'room-note' ? (
                            <RoomNote row={item} />
                        ) : item.kind === 'run-note' ? (
                            <RunNote row={item} socio={socio} onOpen={(link) => openLink(link, { app: true })} />
                        ) : item.kind === 'others' ? (
                            <OthersBubbleView
                                bubble={item}
                                busy={cancelling !== null || syncStatus.reconnecting}
                                onCancel={cancelOthers}
                            />
                        ) : item.kind === 'user' || item.kind === 'reply' ? (
                            <MessageItem
                                row={item}
                                actions={messageActions(item)}
                                menu={{
                                    // The whole date, the web's tooltip on a message's time.
                                    ...(item.at === undefined ? {} : { title: messageFullTime(item.at) }),
                                    actions: messageActions(item),
                                    onAction: (name) => onMessageAction(item, name),
                                }}
                                onAction={(name) => onMessageAction(item, name)}
                                rowActions={messageRowActions(item, () => reactionButtons(shownReactions, item.id))}
                                onToggle={(button) => toggle(item.id, button.kind, button.on)}
                                marked={viewing.shown?.key === item.id}
                            />
                        ) : (
                            <TranscriptItem
                                row={item}
                                chat={id}
                                onAction={onBubble}
                                marked={viewing.shown?.key === item.id}
                                open={openTraces.has(item.id)}
                                onToggle={toggleTrace}
                            />
                        )
                    }
                    extraData={`${JSON.stringify(viewing.shown)} ${approvals.version} ${[...openTraces].join(' ')}`}
                    estimatedItemSize={120}
                    // A long chat opens at its end; a short one starts at the top, as on the web and in
                    // ChatGPT (owner, 2026-11-18): the list isn't aligned to its end.
                    initialScrollAtEnd
                    keyboardOffset={insets.bottom}
                    // A downward swipe hides the keyboard (the composer rides it down on iOS), a tap
                    // in the transcript doesn't (CB-418). The list isn't inverted, so a swipe down
                    // is the finger moving down, toward the composer, as on every other screen.
                    {...keyboardScroll(Platform.OS)}
                    maintainScrollAtEnd={
                        following
                            ? { animated: false, on: { dataChange: true, itemLayout: true, layout: true } }
                            : false
                    }
                    maintainVisibleContentPosition={!following}
                    // A row opened or closed settles once the list has its new size (CB-437).
                    onItemSizeChanged={() => session.resized()}
                    sizeChangeAnchor={keepHeldRow}
                    onStartReached={loadEarlier}
                    onStartReachedThreshold={0.5}
                    onScrollBeginDrag={() => session.dragBegin()}
                    onScrollEndDrag={(event) => session.dragEnd(isAtEnd(event.nativeEvent))}
                    onMomentumScrollBegin={() => session.momentumBegin()}
                    onMomentumScrollEnd={(event) => session.momentumEnd(isAtEnd(event.nativeEvent))}
                    onScroll={(event) => session.scroll(isAtEnd(event.nativeEvent))}
                    // Whether the running turn's own line shows: the pills then leave the phase out.
                    viewabilityConfig={LIVE_LINE_VIEWABILITY}
                    onViewableItemsChanged={onViewable}
                    ListHeaderComponent={history.loadingEarlier ? <EarlierLoading /> : null}
                    ItemSeparatorComponent={RowGap}
                    // It scrolls under iOS's bar (CB-420), which lies over it: its first row starts below.
                    // Padded by hand, since UIKit's inset would move the end the list keeps in view.
                    contentInsetAdjustmentBehavior="never"
                    contentContainerStyle={{ padding: 16, paddingTop: 16 + barInset }}
                />
            )}
            {page === null ? null : (
                <View className="absolute right-0 left-0" style={{ top: bar }}>
                    <PageContextBanner page={page} onLayout={setBannerHeight} />
                </View>
            )}
            {/* Over the transcript, under the bar, as the page editor's notices (CB-417). */}
            <View pointerEvents="box-none" className="absolute right-0 left-0 gap-3 px-4" style={{ top: barInset }}>
                <StatusBanners />
            </View>
            <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
                {cancelNotice === null ? null : (
                    <View className="px-4 pb-3">
                        <Text variant="footnote" tone="destructive" testID="chat-cancel-failed">
                            {cancelNotice}
                        </Text>
                    </View>
                )}
                {refusedReaction === undefined ? null : (
                    <View className="px-4 pb-3">
                        <NotSavedNotice
                            item={refusedReaction}
                            onRetry={(writeId) => {
                                scope.outbox.retryUnsent(writeId, randomId()).catch(reactionFailed);
                            }}
                            onDiscard={(writeId) => {
                                scope.outbox.discardUnsent(writeId).catch(reactionFailed);
                            }}
                            testID="chat-reaction-not-saved"
                        />
                    </View>
                )}
                <ChatFooter
                    id={id}
                    composer={composer}
                    room={room}
                    started={room === undefined ? NOT_A_ROOM : roomStarted(snapshot.runs, turn, pending)}
                    approvals={approvals}
                    turn={turn}
                    running={running}
                    heldForSignIn={writes.heldForSignIn}
                    pill={shownPill(
                        roomPill(
                            statusPill(turn, following || items.length === 0, reduceMotion),
                            room === undefined ? null : roomRunningNote(turn, room.context),
                        ),
                        lineInView,
                    )}
                    onJump={toEnd}
                    onSent={onSent}
                    socio={socio}
                />
            </KeyboardStickyView>
        </View>
    );
}

/** The running turn's line counts as shown once half of it is on screen. */
const LIVE_LINE_VIEWABILITY = { itemVisiblePercentThreshold: 50 };

/** How long View's mark stays on the row it scrolled to. */
const CANDIDATE_MARK_MS = 4000;

/** The row View shows (`write` is the unconfirmed row's id), marked for a few seconds. */
function useViewCandidate() {
    const [shown, setShown] = useState<{ write: string; key: string; at: number } | null>(null);
    useEffect(() => {
        if (shown === null) {
            return undefined;
        }
        const timer = setTimeout(() => setShown(null), CANDIDATE_MARK_MS);
        return () => clearTimeout(timer);
    }, [shown]);
    return { shown, show: (write: string, key: string) => setShown({ write, key, at: Date.now() }) };
}

/** The chat's reactions, held while it shows and asked again as its stored runs change. */
function useReactions(id: string, runs: number): ReactionsState {
    const { reactions } = useWorkspaceScope();
    const [chat] = useState(() => reactions.reactions(id));
    useEffect(() => chat.use(), [chat]);
    const first = useRef(true);
    useEffect(() => {
        if (first.current) {
            first.current = false;
            return;
        }
        void chat.refresh();
    }, [chat, runs]);
    return useSyncExternalStore(chat.subscribe.bind(chat), () => chat.state);
}

/**
 * The person's bubble or a socio's reply, whose long-press menu is also its accessibility actions,
 * with the action row under it (owner, 2026-11-18: under every message, as on the web).
 */
function MessageItem({
    row,
    actions,
    menu,
    onAction,
    rowActions,
    onToggle,
    marked = false,
}: {
    row: UserRow | ReplyRow;
    actions: ReturnType<typeof messageMenu>;
    /** Its long-press menu (CB-421: the system's context menu, the bubble lifted as its preview). */
    menu: MenuRequest;
    onAction: (name: string) => void;
    /** The row under it (`messageRowActions`), or null while it streams or has no words. */
    rowActions: MessageRowActions | null;
    onToggle: (button: ReturnType<typeof reactionButtons>[number]) => void;
    /** View on an unconfirmed message scrolled here: ringed in the primary tone. */
    marked?: boolean;
}) {
    const actionRow = (align: 'start' | 'end') =>
        rowActions === null ? null : (
            <MessageActionRow
                buttons={rowActions.reactions}
                onToggle={onToggle}
                onCopy={() => onAction(COPY.name)}
                actions={actions}
                onAction={onAction}
                time={rowTime(row)}
                align={align}
                testID={`chat-actions-${row.id}`}
            />
        );
    if (row.kind === 'user') {
        // In a room, another person's message is on the left, under their name.
        const theirs = row.speaker !== undefined && row.speaker.kind !== 'you';
        return (
            <View
                testID={`chat-user-${row.id}`}
                accessibilityState={marked ? { selected: true } : undefined}
                className={cx(
                    'max-w-[80%] gap-1',
                    theirs ? 'self-start' : 'self-end',
                    marked && 'rounded-3xl border-2 border-primary p-1',
                )}
            >
                {row.speaker === undefined ? null : <SpeakerLine speaker={row.speaker} />}
                <MessageAttachments files={row.files} testID={`chat-user-${row.id}-files`} />
                {row.text.trim() === '' ? null : (
                    <ActionMenu request={menu} trigger="longPress">
                        <Pressable
                            onLongPress={LONG_PRESS_TO_MENU}
                            // With a link in it, not one accessible element (on iOS that hides its links); its
                            // menu is the row's Copy button's actions then, as a reply's (CB-415).
                            {...(holdsLink(row.text)
                                ? { accessible: false }
                                : {
                                      accessibilityActions: accessibilityActionsOf(actions),
                                      onAccessibilityAction: (event: AccessibilityActionEvent) =>
                                          onAction(event.nativeEvent.actionName),
                                      accessibilityLabel: bubbleLabel(row),
                                      accessibilityHint: 'Long-press for Copy, Share and more',
                                  })}
                            className={
                                theirs
                                    ? 'self-start rounded-2xl rounded-bl-sm bg-muted p-3'
                                    : 'self-end rounded-2xl rounded-br-sm bg-user-bubble p-3'
                            }
                        >
                            <MessageText text={row.text} surface={theirs ? 'other' : 'own'} />
                        </Pressable>
                    </ActionMenu>
                )}
                {actionRow(theirs ? 'start' : 'end')}
            </View>
        );
    }
    // Not one accessible element: on iOS that would hide the reply's links and
    // issue chips from VoiceOver. Its menu is the row's Copy button's actions instead.
    return (
        <View className="gap-1">
            {row.speaker === undefined ? null : <SpeakerLine speaker={row.speaker} />}
            <ActionMenu request={row.streaming ? null : menu} trigger="longPress">
                <Pressable accessible={false} onLongPress={row.streaming ? undefined : LONG_PRESS_TO_MENU}>
                    <Reply text={row.text} streaming={row.streaming} testID={`chat-reply-${row.id}`} />
                </Pressable>
            </ActionMenu>
            {actionRow('start')}
        </View>
    );
}

/** One chat's turns of runs this device started, from the scope's `turns`. */
const ownTurn = (turns: OwnTurns, id: string): OwnTurn => ({
    turn: () => turns.turn(id),
    subscribe: (listener) => turns.subscribe(id, listener),
});

/** The chat's steering snapshot, held while the chat shows: its queued messages and whether a turn runs. */
function useSteering(id: string): SteeringSnapshot {
    const { steering } = useWorkspaceScope();
    const [chat] = useState(() => steering.steering(id));
    useEffect(() => chat.use(), [chat]);
    const [store] = useState(() => steeringStore(chat));
    return useSyncExternalStore(store.subscribe, store.get);
}

/** A light tick as a reply starts streaming, then at most every 320 ms while it grows. */
function useStreamHaptics(turn: Parameters<typeof replyFinished>[1]) {
    const on = useHaptics();
    const [haptics] = useState(() =>
        createStreamHaptics(() => {
            Haptics.selectionAsync().catch(() => {});
        }),
    );
    const streaming = turn.streamingId === undefined ? undefined : turn.messages.find((m) => m.id === turn.streamingId);
    const mark = streaming === undefined ? null : { id: streaming.id, textLength: messageText(streaming).length };
    const markId = mark?.id ?? null;
    const markLength = mark?.textLength ?? 0;
    useEffect(() => {
        if (on) {
            haptics.observe(markId === null ? null : { id: markId, textLength: markLength });
        }
    }, [haptics, on, markId, markLength]);
}

/** The draft the chat's or room's box writes to, or null where there is no box. */
function composerBox(composer: ChatComposer): string | null {
    const target = composer.sendTo ?? (composer.readOnly === null ? composer.roomId : null);
    return target === null ? null : chatDraft(target);
}

/** A pending bubble's button, through the outbox (`bubbleAction`). */
function act(scope: WorkspaceScope, bubble: PendingBubble, action: BubbleAction, composer: ChatComposer) {
    const box = composerBox(composer);
    bubbleAction(scope, bubble, action, box, randomId).catch((error: unknown) =>
        console.warn('[chat] the message did not change', error),
    );
}

/** The status pill and the composer (or the read-only line), floating over the keyboard. */
function ChatFooter(props: {
    id: string;
    composer: ChatComposer;
    approvals: ChatApprovals;
    turn: Parameters<typeof replyFinished>[1];
    running: boolean;
    heldForSignIn: boolean;
    pill: StatusPill | null;
    onJump: () => void;
    onSent: (row: OutboxRow) => void;
    /** A room's: its context and who started its running turn, for its composer. */
    room?: RoomScreen;
    started: RoomStarter;
    /** The socio's name, for the box's "Message Sebas…". */
    socio: string | null;
}) {
    const { composer } = props;
    const { bar } = props.approvals;
    const scope = useWorkspaceScope();
    const draft = useDraft(composer.sendTo === null ? null : chatDraft(composer.sendTo));
    const quoted = useQuotedDraft(draft);
    const tray = useTray(composer.sendTo === null || composer.readOnly !== null ? null : chatDraft(composer.sendTo));
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    if (composer.readOnly !== null) {
        return <ReadOnlyLine line={composer.readOnly} />;
    }
    if (composer.room) {
        // The room's composer, under its bar and the pill.
        return (
            <View>
                {bar === null ? null : <ApprovalBar bar={bar} onAction={(key) => props.approvals.act(bar.id, key)} />}
                {props.pill === null ? null : <StatusPillView pill={props.pill} onJump={props.onJump} />}
                {props.room === undefined ? null : (
                    <RoomComposer
                        id={props.id}
                        context={props.room.context}
                        admin={props.room.admin}
                        running={props.running}
                        heldForSignIn={props.heldForSignIn}
                        started={props.started}
                        onSent={props.onSent}
                    />
                )}
            </View>
        );
    }
    const view = composerView({
        // A quote alone isn't a message (CB-571): Send waits for words or files.
        text: quoted.text,
        running: props.running,
        locked: draft.locked || !scope.userDb.writable || composer.sendTo === null,
        heldForSignIn: props.heldForSignIn,
        busy,
        files: tray.items.filter((item) => !item.failed).length,
    });
    const send = () => {
        const { sendTo, dotId } = composer;
        if (sendTo === null || dotId === null) {
            return;
        }
        setNotice(null);
        setBusy(true);
        sendChatMessage({
            drafts: scope.drafts,
            outbox: scope.outbox,
            history: scope.histories.history(sendTo),
            steering: scope.steering.steering(sendTo),
            threadId: sendTo,
            dotId,
            newId: randomId,
            serverAt: scope.serverClock.lastDate(),
            attachments: scope.attachments,
        })
            .then((row) => {
                if (row !== null) {
                    props.onSent(row);
                }
            })
            .catch((error: unknown) => {
                console.warn('[chat] the message was not saved', error);
                setNotice(SEND_FAILED);
            })
            .finally(() => setBusy(false));
    };
    const stop = () => {
        const { dotId } = composer;
        if (dotId === null || isLocalChat(props.id)) {
            return;
        }
        setNotice(null);
        setBusy(true);
        createRunClient({ fetch: scope.fetch, newId: randomId })
            .stop(dotId, props.id)
            .then((outcome) => {
                if (!outcome.ok) {
                    setNotice(STOP_FAILED);
                }
            })
            .catch(() => setNotice(STOP_FAILED))
            .finally(() => setBusy(false));
    };
    return (
        <View>
            {bar === null ? null : <ApprovalBar bar={bar} onAction={(key) => props.approvals.act(bar.id, key)} />}
            {isLocalChat(props.id) ? null : <NameSuggestion id={props.id} />}
            {props.pill === null ? null : <StatusPillView pill={props.pill} onJump={props.onJump} />}
            <Composer
                text={quoted.text}
                onChangeText={quoted.setText}
                quote={quoted.quote === null ? null : { quote: quoted.quote, onRemove: quoted.removeQuote }}
                view={view}
                onSend={send}
                onStop={stop}
                notice={notice}
                tray={tray}
                placeholder={chatPlaceholder(props.socio)}
                inputLabel={chatInputLabel(props.socio)}
                stacked
                testID="chat-composer"
            />
        </View>
    );
}

/** The server's suggested name for the chat (CB-292), read as it opens; settled online only. */
function NameSuggestion({ id }: { id: string }) {
    const scope = useWorkspaceScope();
    const [name, setName] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [customizing, setCustomizing] = useState(false);
    useEffect(() => {
        const controller = new AbortController();
        readNameSuggestion(scope.fetch, id, controller.signal)
            .then((suggested) => {
                if (!controller.signal.aborted) {
                    setName(suggested);
                }
            })
            .catch(() => {});
        return () => controller.abort();
    }, [scope, id]);
    if (name === null) {
        return null;
    }
    // Gives back the failure for the name prompt to say (Customize); the card says it otherwise.
    const settle = (action: SuggestionAction, custom?: string): Promise<string | undefined> => {
        setBusy(true);
        setNotice(null);
        const failed = () => {
            if (action === 'customize') {
                return SUGGESTION_FAILED;
            }
            setNotice(SUGGESTION_FAILED);
            return undefined;
        };
        return settleNameSuggestion(scope.fetch, id, action, custom)
            .then((outcome) => {
                if (outcome === 'done') {
                    setName(null);
                    setCustomizing(false);
                    scope.scheduler.poke();
                    return undefined;
                }
                return failed();
            }, failed)
            .finally(() => setBusy(false));
    };
    return (
        <View className="px-4 pb-3">
            <NameSuggestionCard
                name={name}
                busy={busy}
                notice={notice}
                onAccept={() => void settle('accept')}
                onReject={() => void settle('reject')}
                onCustomize={() => setCustomizing(true)}
            />
            {customizing ? (
                <TextPrompt
                    title="Name this chat"
                    label="Chat title"
                    initial={name}
                    maxLength={MAX_CHAT_TITLE}
                    onSave={(text) => settle('customize', text)}
                    onCancel={() => setCustomizing(false)}
                    testID="chat-name-prompt"
                />
            ) : null}
        </View>
    );
}

/** Says "<socio> replied" once, as a turn ends with a reply while the chat shows. */
function useRepliedAnnouncement(turn: Parameters<typeof replyFinished>[1], socio: string | null) {
    const previous = useRef(turn);
    useEffect(() => {
        if (replyFinished(previous.current, turn)) {
            AccessibilityInfo.announceForAccessibility(repliedAnnouncement(socio));
        }
        previous.current = turn;
    }, [turn, socio]);
}

function RowGap() {
    return <View className="h-4" />;
}

function EarlierLoading() {
    return (
        <View className="items-center p-4">
            <ActivityIndicator accessibilityLabel="Loading earlier messages" />
        </View>
    );
}

function EmptyTranscript({
    ready,
    failed,
    room,
    inset,
}: {
    ready: boolean;
    failed: boolean;
    room: boolean;
    /** The native bar over it (iOS). */
    inset: number;
}) {
    if (ready && room) {
        // The web's room: its line at the top, left, in the meta size.
        return (
            <View testID="chat-empty" className="flex-1 px-4 pt-4" style={{ marginTop: inset }}>
                <Text variant="footnote" tone="muted">
                    {emptyTranscriptLine(true)}
                </Text>
            </View>
        );
    }
    return (
        <View testID="chat-empty" className="flex-1 items-center justify-center p-4" style={{ marginTop: inset }}>
            {ready ? (
                <Text variant="subheadline" tone="muted" className="text-center">
                    {emptyTranscriptLine(false)}
                </Text>
            ) : failed ? (
                <Text variant="subheadline" tone="muted" className="text-center">
                    This chat shows once you’re online.
                </Text>
            ) : (
                <ActivityIndicator accessibilityLabel="Loading the chat" />
            )}
        </View>
    );
}

function TranscriptItem({
    row,
    chat,
    onAction,
    marked,
    open,
    onToggle,
}: {
    row: TraceRow | PendingBubble;
    chat: string;
    onAction: (bubble: PendingBubble, action: BubbleAction) => void;
    marked: boolean;
    /** A trace the person opened (CB-434). */
    open: boolean;
    onToggle: (traceId: string) => void;
}) {
    const navigation = useNavigation();
    if (row.kind === 'pending') {
        return <PendingBubbleView bubble={row} onAction={onAction} marked={marked} />;
    }
    const { turn } = row;
    return (
        <TraceDisclosure
            row={row}
            open={open}
            onToggle={() => onToggle(row.id)}
            onStep={(step) => {
                if (turn !== null) {
                    navigation.navigate('TurnTrace', { chat, turn, step });
                }
            }}
        />
    );
}

/** The chat's runs beyond their streams (run-lifecycle.ts, CB-434), from the follow store's adapter. */
function useRunLifecycle(id: string) {
    const { follows } = useWorkspaceScope();
    const { lifecycle } = follows;
    return useSyncExternalStore(
        (listener) => lifecycle.subscribe(id, listener),
        () => lifecycle.state(id),
    );
}

/** A socio's reply, Markdown at full width; while it is written, a few words at a time (CB-365). */
function Reply({ text, streaming, testID }: { text: string; streaming: boolean; testID: string }) {
    const shown = usePacedText(text, streaming);
    return <ReplyMarkdown text={shown} testID={testID} issueCards />;
}

function usePacedText(text: string, streaming: boolean): string {
    const [shown, setShown] = useState(streaming ? '' : text);
    const paced = useRef<PacedText | null>(null);
    useEffect(() => {
        if (!streaming) {
            paced.current?.finish();
            paced.current = null;
            return;
        }
        if (paced.current === null) {
            paced.current = createPacedText({ onRelease: setShown });
        }
        paced.current.push(text);
    }, [text, streaming]);
    useEffect(() => () => paced.current?.dispose(), []);
    return streaming ? shown : text;
}

const NO_OTHERS: readonly OthersBubble[] = [];

const NOT_A_ROOM: RoomStarter = { running: null, before: [], mine: false };

/**
 * The running run's messages (stored, then live), every stored one before it,
 * and whether the reader's own message waits (`pending`): who started the turn.
 */
function roomStarted(runs: readonly HistoryRun[], turn: LiveTurn, pending: readonly PendingBubble[]): RoomStarter {
    const at = runs.findIndex((run) => run.status === 'running');
    const stored = at < 0 ? [] : runs[at]!.messages;
    const before = (at < 0 ? runs : runs.slice(0, at)).flatMap((run) => run.messages);
    const mine = ownWaiting(pending);
    if (turn.running) {
        return { running: [...stored, ...turn.messages], before, mine };
    }
    // No run known yet: a send before its RUN_STARTED (or someone else's, which the phone hasn't seen).
    return { running: at < 0 ? null : stored, before, mine };
}

/** A room's pill says what its socio does now (`runningNote`), never the private chat's phase words. */
function roomPill(pill: StatusPill | null, note: string | null): StatusPill | null {
    return pill === null || note === null || pill.status === null ? pill : { ...pill, status: note };
}
