import { useNavigation } from '@react-navigation/native';
import { Fragment, useEffect, useState } from 'react';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useSyncOnFocus, useViewState } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { routeInVariant } from '../navigation/routes';
import {
    restoreAction,
    restoreChatAction,
    restoreIssueAction,
    restorePageAction,
    newChatAction,
    restoreSpaceAction,
    socioAction,
    tabAction,
} from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { BUILD_VARIANT } from '../platform/variant';
import { HOME_MENU_LABEL } from '../shell/account';
import { chatList } from '../shell/chat-list';
import { type HomeSectionId, homeSections, homeSocios, toggleSection } from '../shell/home';
import { keptChat, keptIssue, keptPage, keptSpace, LAST_SCREEN_KEY, lastScreen } from '../shell/last-screen';
import { shellQuery, sociosQuery, shellRows } from '../shell/queries';
import { INVITES_TITLE, inviteRows } from '../shell/room-invites';
import { Button, Screen } from '../ui';

import { CHAT_MARK_KINDS, useChatListItems } from './chat-rows';
import { FirstRun, useFirstRun } from './first-run';
import {
    AccountButton,
    SectionView,
    Tiles,
    useHomeMenu,
    useWorkspaceName,
    WorkspaceBarButton,
    WorkspaceButton,
} from './home-parts';
import { Placeholder } from './placeholder';
import { InviteRows } from './room-invite';
import { Section, StatusBanners, useRememberScreen } from './shell-parts';
import { useShownChats } from './shown-chats';
import { TAB_ROOT_KEYBOARD, TAB_STACK_EDGES } from './tab-edges';

// Home, Slack's, in its tab's own stack (tab-stack.tsx) with
// the system's bar (CB-431), one row as the old Home's top: the
// workspace's logo, name and chevron at its start (which open the workspace
// drawer), and at its end the person's avatar (the account sheet) and the ⋯
// menu. No New chat pill and no Compose here (the owner, 2026-11-19): each
// socio row starts a chat; a row of tiles (the Board, the Spaces, Scheduled and Memories,
// with counts where the scope has them); then the collapsible sections:
// Socios, Rooms (while they're on; the room invites above it, and
// New room, which opens the web, at its end) and Recent chats (src/shell/home.ts). On
// iOS 26 the bar's items and the tiles are Liquid Glass (src/ui/glass.tsx). A
// socio row opens the socio's page; its compose button starts a chat with it.
// It opens the workspace's last screen once per scope. With no chats yet it is
// the first run instead (first-run.tsx), with the tiles under it: New
// chat's own screen, so the bar hides and the first run keeps its top.
// Without an open scope (nothing opens one before sign-in does) it stays a
// placeholder.

const SYNCED = ['shell', 'conversations', 'spaces', 'dots', 'room-invites', ...CHAT_MARK_KINDS] as const;
const HAS_DIAGNOSTICS = routeInVariant('Diagnostics', BUILD_VARIANT);

export function HomeScreen() {
    return useHasWorkspaceScope() ? <Home /> : <HomePlaceholder />;
}

function HomePlaceholder() {
    useNativeBar({ hidden: true });
    return (
        <Placeholder
            testID="home-screen"
            title="Socio"
            caption="Your workspace opens here once you sign in."
            icon="house"
            tone="mint"
            diagnostics
        />
    );
}

/**
 * Home's bar (CB-431): one row, as the old Home's top was (the owner,
 * 2026-11-19): the workspace's logo, name and chevron at its start, which open
 * the workspace drawer, and from its end the account and ⋯. No title of its
 * own and no Compose: each socio row starts a chat. Hidden for the first run,
 * which draws its own top.
 */
function useHomeBar(firstRun: boolean) {
    const name = useWorkspaceName();
    const menu = useHomeMenu();
    useNativeBar({
        title: '',
        hidden: firstRun,
        left: [
            {
                kind: 'custom',
                id: 'open-workspaces',
                signature: name,
                bare: true,
                element: () => <WorkspaceBarButton />,
            },
        ],
        right: [
            { kind: 'custom', id: 'open-account', signature: 'account', element: () => <AccountButton inBar /> },
            {
                id: 'home-menu',
                label: HOME_MENU_LABEL,
                symbol: 'ellipsis',
                icon: 'ellipsis',
                iconOnly: true,
                onPress: () => {},
                menu,
            },
        ],
    });
}

function Home() {
    const firstRun = useFirstRun();
    useHomeBar(firstRun.view !== null);
    useRememberScreen('Home');
    useSyncOnFocus(SYNCED);
    return firstRun.view === null ? (
        <HomeLists />
    ) : (
        <FirstRun
            view={firstRun.view}
            pick={firstRun.pick}
            leading={<WorkspaceButton withName={false} />}
            action={<AccountButton />}
        >
            <Tiles />
            <Diagnostics />
        </FirstRun>
    );
}

function Diagnostics() {
    const navigation = useNavigation();
    return HAS_DIAGNOSTICS ? (
        <Button
            variant="ghost"
            label="Diagnostics"
            icon="stethoscope"
            onPress={() => navigation.navigate('Diagnostics')}
            testID="open-diagnostics"
        />
    ) : null;
}

/**
 * Home's header, tiles and sections. It opens the kept last screen as it
 * mounts: its effect runs before Home's, which keeps Home as the last screen.
 * After a first run, Home is the one kept, and a first chat arriving while
 * Home isn't focused (another tab, a page or a sheet) opens nothing
 * (restoreAction), so it doesn't move the person.
 */
function HomeLists() {
    const navigation = useNavigation();
    const collections = useCollections();
    const viewState = useViewState();
    // Before the screen keeps itself as the last one: the one kept, read once. A kept
    // chat opens over Home; launch read its history before the first frame.
    const [chatKept] = useState(() => keptChat(viewState.get(LAST_SCREEN_KEY)));
    // A kept Space opens over Home too; launch read its pages before the first frame.
    const [spaceKept] = useState(() => keptSpace(viewState.get(LAST_SCREEN_KEY)));
    // A kept page too; launch read its Space's list and body before the first frame.
    const [pageKept] = useState(() => keptPage(viewState.get(LAST_SCREEN_KEY)));
    // A kept issue too; launch read its detail before the first frame.
    const [issueKept] = useState(() => keptIssue(viewState.get(LAST_SCREEN_KEY)));
    useEffect(() => {
        const action =
            restoreAction(lastScreen(viewState.get(LAST_SCREEN_KEY)), navigation.isFocused()) ??
            restoreChatAction(chatKept, navigation.isFocused()) ??
            restoreSpaceAction(spaceKept, navigation.isFocused()) ??
            restorePageAction(pageKept, navigation.isFocused()) ??
            restoreIssueAction(issueKept, navigation.isFocused());
        if (action) {
            navigation.dispatch(action);
        }
    }, [viewState, navigation, chatKept, spaceKept, pageKept, issueKept]);
    const [collapsed, setCollapsed] = useState<ReadonlySet<HomeSectionId>>(new Set());
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const chats = useShownChats();
    const { state } = shellRows(shell);
    const socios = homeSocios(dots, state);
    const chatRows = chatList(chats, dots, state);
    const items = useChatListItems(chatRows, chats);
    // Opening onto a kept chat, Space, page, the Board, Memories, Activity or Schedules, Learning or Runs or an issue, its first frame is the one timed.
    const [pageScreenKept] = useState(() => {
        const kept = lastScreen(viewState.get(LAST_SCREEN_KEY));
        return (
            kept === 'Board' ||
            kept === 'Memories' ||
            kept === 'Activity' ||
            kept === 'Schedules' ||
            kept === 'Learning' ||
            kept === 'Runs' ||
            kept === 'Media'
        );
    });
    const opensPage = spaceKept !== null || pageKept !== null || pageScreenKept || issueKept !== null;
    useFirstFrameWithData('Home', chatKept === null && !opensPage && socios.length + chatRows.length > 0);
    const sections = homeSections({ socios, chats: chatRows, state, collapsed });
    const { data: invites } = useLiveQuery({ query: (q) => q.from({ invite: collections.roomInvites }) });
    const invited = inviteRows(invites, state);
    return (
        <Screen testID="home-screen" edges={TAB_STACK_EDGES} keyboardAware={TAB_ROOT_KEYBOARD}>
            <StatusBanners />
            <Tiles />
            {sections.map((section) => (
                <Fragment key={section.id}>
                    {section.id === 'rooms' && invited.length > 0 ? (
                        <Section title={INVITES_TITLE} testID="home-invites">
                            <InviteRows rows={invited} testID="home-invite" />
                        </Section>
                    ) : null}
                    <SectionView
                        section={section}
                        items={items}
                        onToggle={() => setCollapsed(toggleSection(collapsed, section.id))}
                        onAllChats={() => navigation.dispatch(tabAction('Chats'))}
                        onNewRoom={() => navigation.navigate('NewRoom')}
                        onNewChat={(socioId) => navigation.dispatch(newChatAction(socioId))}
                        onOpenSocio={(socioId) => navigation.dispatch(socioAction(socioId))}
                    />
                </Fragment>
            ))}
            <Diagnostics />
        </Screen>
    );
}
