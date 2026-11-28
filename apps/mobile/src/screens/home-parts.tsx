import { useNavigation } from '@react-navigation/native';
import { useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';

import { outboxStateStore } from '../chat/composer';
import { useCollections, useLiveQuery, useUnsent, useWorkspaceScope } from '../live';
import type { BarMenu } from '../navigation/bar-items';
import { useDrawer } from '../navigation/drawer-context';
import { moreItemAction, moreRows, tabAction } from '../navigation/tabs';
import {
    type HomeMenuName,
    homeMenu,
    PAUSE_ALL,
    PAUSE_FAILED,
    PAUSE_QUESTION,
    RESUME_ALL,
    setAllPaused,
    workspaceName,
} from '../shell/account';
import { openIssueCount } from '../shell/board';
import { type ChatListItem, chatListItem } from '../shell/chat-marks';
import { newChatWithLabel } from '../shell/first-run';
import { type HomeSection, type HomeTile, homeTiles } from '../shell/home';
import { waitingProposals } from '../shell/memories';
import { issuesQuery, memoriesQuery, memoryProfileQuery, shellQuery, shellRows, spacesQuery } from '../shell/queries';
import { NEW_ROOM, NEW_ROOM_HINT } from '../shell/room-invites';
import { unsentBadge } from '../shell/unsent';
import { MEMORY_WRITE_VIEWS } from '../sync/memory-writes';
import { overlaysOf } from '../sync/outbox-overlay';
import { BAR_TITLE_MAX_SCALE, GlassSurface, AppSymbol, Text, ToneTile } from '../ui';
import { cx } from '../ui/cx';

import { ChatListRow } from './chat-rows';
import { MODULE_ICONS } from './module-icons';
import { SymbolButton } from './platform-symbol';
import { CountBadge, ListRow, SocioAvatar, SocioStateLabel, useOpenChat } from './shell-parts';
import { useWorkspaceLogoPath, WorkspaceLogo } from './workspace-logo';

// Home's parts (screens/home.tsx): its bar's items (CB-431:
// the workspace button, the ⋯ menu with Report issue and, for an admin,
// Pause or Resume all socios, shell/account.ts `homeMenu`, and the account
// button), the row of tiles and a collapsible section. On iOS 26 the bar's
// items and the tiles are Liquid Glass, else the app's card surface
// (src/ui/glass.tsx).

/** What a socio row says it does (CB-431). */
export const SOCIO_ROW_HINT = 'Opens its page';

/** A socio row's new-chat button: Messages' and Mail's compose symbol on iOS (`square.and.pencil`), Material's edit icon on Android. */
export const SOCIO_NEW_CHAT_SYMBOL = 'square-pen';

/** A socio's mascot on Home, in points: the web's Home cards (`size-14`), larger than a chat row's 40. */
const HOME_SOCIO_SIZE = 56;

/**
 * Home's ⋯, a bar menu (CB-431): a UIMenu from the bar button on
 * iOS, Material's popup on Android. Report issue opens File an issue; Pause
 * all socios asks first, then sends the web's `PATCH /api/settings` (online
 * only) and pulls the shell again, so the paused state shows; Resume all
 * socios sends at once.
 */
export function useHomeMenu(): BarMenu {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { state, workspace } = shellRows(shell);
    const actions = homeMenu(workspace?.user.role ?? null, state?.settings.paused === true);
    const pause = (paused: boolean) => {
        void setAllPaused(scope.fetch, paused).then((done) => {
            if (done) {
                scope.scheduler.poke();
            } else {
                Alert.alert(paused ? PAUSE_ALL : RESUME_ALL, PAUSE_FAILED);
            }
        });
    };
    const act = (name: string) => {
        switch (name as HomeMenuName) {
            case 'report-issue':
                navigation.navigate('FileIssue');
                return;
            case 'pause-all':
                Alert.alert(PAUSE_QUESTION.title, PAUSE_QUESTION.message, [
                    { text: PAUSE_QUESTION.cancel, style: 'cancel' },
                    { text: PAUSE_QUESTION.confirm, style: 'destructive', onPress: () => pause(true) },
                ]);
                return;
            case 'resume-all':
                pause(false);
                return;
        }
    };
    return { actions, onAction: act };
}

/** The workspace's name for Home's large title, as the drawer and the web's header say it. */
export function useWorkspaceName(): string {
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    return workspaceName(shellRows(shell).state, scope.workspace);
}

/** The workspace's logo in glass, and its name with a chevron: opens the workspace drawer. */
export function WorkspaceButton({ withName, size = 44 }: { withName: boolean; size?: number }) {
    const drawer = useDrawer();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const name = workspaceName(shellRows(shell).state, scope.workspace);
    const logo = useWorkspaceLogoPath(scope);
    return (
        <Pressable
            testID="open-workspaces"
            accessibilityRole="button"
            accessibilityLabel={`${name}, workspaces`}
            accessibilityHint="Opens your workspaces"
            onPress={drawer?.open}
            className="min-h-11 min-w-11 shrink flex-row items-center justify-center gap-2.5 rounded-full active:opacity-70"
        >
            {/* The logo is its own squircle: no round glass behind it (owner, 2026-11-08). */}
            <WorkspaceLogo path={logo} size={size} />
            {withName ? (
                <>
                    <Text variant="title" numberOfLines={1} className="shrink">
                        {name}
                    </Text>
                    <AppSymbol name="chevron-down" size={18} color="muted-foreground" />
                </>
            ) : null}
        </Pressable>
    );
}

/**
 * Home's bar's leading item (CB-431): the workspace's logo, its name in a
 * semibold title size and the switcher's chevron, left-aligned on the bar's
 * row; the name truncates to leave the bar's end its items. Opens the
 * workspace drawer, as the old header's button did.
 */
export function WorkspaceBarButton() {
    const drawer = useDrawer();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const name = workspaceName(shellRows(shell).state, scope.workspace);
    const logo = useWorkspaceLogoPath(scope);
    const { width } = useWindowDimensions();
    return (
        <Pressable
            testID="open-workspaces"
            accessibilityRole="button"
            accessibilityLabel={`${name}, workspaces`}
            accessibilityHint="Opens your workspaces"
            onPress={drawer?.open}
            className="min-h-11 flex-row items-center gap-2 active:opacity-70"
            style={{ maxWidth: width - WORKSPACE_BAR_RESERVE }}
        >
            <WorkspaceLogo path={logo} size={32} />
            {/* A bar's title stops growing at the largest non-accessibility size, as UIKit's bar titles do. */}
            <Text
                variant="headline"
                numberOfLines={1}
                className="shrink"
                maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE}
                testID="home-workspace-name"
            >
                {name}
            </Text>
            <AppSymbol name="chevron-down" size={16} weight="semibold" color="muted-foreground" />
        </Pressable>
    );
}

/** What Home's bar keeps for its end (the account and ⋯ in their glass) and its margins, in points. */
export const WORKSPACE_BAR_RESERVE = 150;

/**
 * The person's avatar: opens the account sheet. In glass of its own on the
 * first run's top; in Home's bar (`inBar`) the bar's own glass holds it.
 */
export function AccountButton({ inBar = false }: { inBar?: boolean }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const person = shellRows(shell).workspace?.user.name ?? scope.workspace.personName ?? '';
    const initial = person.trim().slice(0, 1).toUpperCase() || '?';
    const unsent = unsentBadge(useUnsent().writes.length);
    return (
        <Pressable
            testID="open-account"
            accessibilityRole="button"
            accessibilityLabel={unsent === null ? 'Account' : `Account, ${unsent} unsent`}
            onPress={() => navigation.navigate('Account')}
            className={
                inBar
                    ? 'size-11 items-center justify-center rounded-full active:opacity-70'
                    : 'rounded-full active:opacity-70'
            }
        >
            {inBar ? (
                <View className="size-8 items-center justify-center rounded-full bg-primary">
                    <Text
                        variant="subheadline"
                        weight="semibold"
                        tone="on-primary"
                        maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE}
                    >
                        {initial}
                    </Text>
                </View>
            ) : (
                <GlassSurface
                    interactive
                    radius={24}
                    fallbackClassName="border border-border bg-card"
                    className="p-1.5"
                >
                    <View className="size-9 items-center justify-center rounded-full bg-primary">
                        <Text
                            variant="subheadline"
                            weight="semibold"
                            tone="on-primary"
                            maxFontSizeMultiplier={BAR_TITLE_MAX_SCALE}
                        >
                            {initial}
                        </Text>
                    </View>
                </GlassSurface>
            )}
            {unsent === null ? null : (
                <View
                    className={inBar ? 'absolute top-0 right-0' : 'absolute -top-1 -right-1'}
                    testID="account-unsent-badge"
                >
                    <CountBadge label={unsent} />
                </View>
            )}
        </Pressable>
    );
}

/** The row of tiles, scrolling sideways. */
export function Tiles() {
    const navigation = useNavigation();
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const { state, workspace } = shellRows(shell);
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const { data: memories } = useLiveQuery({
        query: memoriesQuery(collections),
    });
    const { data: profile } = useLiveQuery({
        query: memoryProfileQuery(collections),
    });
    // The proposals waiting as Memories counts them: this device's approvals and deletes laid over.
    const { outbox } = useWorkspaceScope();
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const tiles = homeTiles({
        spaces: spaces.length,
        state,
        openIssues: issues.length ? openIssueCount(issues) : null,
        waitingProposals: waitingProposals(
            memories,
            profile[0] ?? null,
            overlaysOf({
                rows: writes.rows,
                unsent: writes.unsent,
                kinds: MEMORY_WRITE_VIEWS,
                scope: outbox,
            }),
        ),
    });
    const more = moreRows(workspace?.user.role ?? null);
    const open = (tile: HomeTile) => {
        const { target } = tile;
        if (target.kind === 'page') {
            navigation.dispatch(tabAction(target.name));
            return;
        }
        const label = more.find((row) => row.id === target.id)?.label ?? tile.label;
        navigation.dispatch(moreItemAction(target.id, label));
    };
    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-4 grow-0"
            contentContainerClassName="gap-3 px-4"
            testID="home-tiles"
        >
            {tiles.map((tile) => (
                <Pressable
                    key={tile.key}
                    testID={tile.testID}
                    accessibilityRole="button"
                    accessibilityLabel={tile.accessibilityLabel}
                    onPress={() => open(tile)}
                    className="rounded-2xl active:opacity-70"
                >
                    <GlassSurface
                        interactive
                        radius={18}
                        fallbackClassName="border border-border bg-card"
                        className="w-36 gap-2 p-3"
                    >
                        <ToneTile tone={tile.tone} icon={MODULE_ICONS[tile.icon]} surface="card" />
                        <View className="gap-0.5">
                            <Text weight="medium" numberOfLines={1}>
                                {tile.label}
                            </Text>
                            <Text variant="footnote" tone="muted" numberOfLines={1}>
                                {tile.caption}
                            </Text>
                        </View>
                    </GlassSurface>
                </Pressable>
            ))}
        </ScrollView>
    );
}

/**
 * How far a collapsed section pulls the next one up, in points: its heading
 * keeps the 44-point touch height (min-h-11) with the label centred in it, so
 * without this the empty half under the label plus the screen's gap left a
 * hole below a collapsed heading. Pulled up by the 12 points under the label,
 * the next heading sits as far below it as an open section's card does.
 */
export const COLLAPSED_SECTION_PULL = 12;

/** A collapsible section: its heading (a button with its chevron), then its rows while open. */
export function SectionView(props: {
    section: HomeSection;
    /** The chat rows with their marks and times (chat-rows.tsx), by id. */
    items: ReadonlyMap<string, ChatListItem>;
    onToggle: () => void;
    onAllChats: () => void;
    /** Rooms: New room, which opens the web (room administration is the web's). */
    onNewRoom?: () => void;
    /** Socios: each row's new-chat button (the web's Home cards). */
    onNewChat?: (socioId: string) => void;
    /** Socios: the row itself opens the socio's page (CB-431). */
    onOpenSocio?: (socioId: string) => void;
}) {
    const { section } = props;
    const openChat = useOpenChat();
    const count = section.id === 'socios' ? section.socios.length : section.chats.length;
    return (
        <View
            className="gap-2"
            style={section.collapsed ? { marginBottom: -COLLAPSED_SECTION_PULL } : undefined}
            testID={`home-${section.id}`}
        >
            <Pressable
                testID={`home-${section.id}-toggle`}
                accessibilityRole="button"
                accessibilityLabel={section.title}
                accessibilityState={{ expanded: !section.collapsed }}
                onPress={props.onToggle}
                className="min-h-11 flex-row items-center gap-2 rounded-md active:opacity-70"
            >
                <Text accessibilityRole="header" variant="section" className="flex-1">
                    {section.title}
                </Text>
                <AppSymbol
                    name={section.collapsed ? 'chevron-down' : 'chevron-up'}
                    size={18}
                    color="muted-foreground"
                />
            </Pressable>
            {section.collapsed ? null : (
                <View className="rounded-xl border border-border bg-card">
                    {section.id === 'socios' ? (
                        section.socios.length === 0 ? (
                            <ListRow first title="No socios yet" accessibilityLabel="No socios yet" />
                        ) : (
                            section.socios.map((socio, index) => (
                                // The row, which opens the socio's page, then its own new-chat button beside it
                                // (CB-431): two hit areas side by side, never overlapping, and two elements for
                                // screen readers, as on the web.
                                <View
                                    key={socio.id}
                                    className={cx('flex-row items-center pr-1', index > 0 && 'border-t border-border')}
                                >
                                    <View className="min-w-0 flex-1">
                                        <ListRow
                                            first
                                            testID={`socio-${socio.id}`}
                                            leading={<SocioAvatar character={socio.character} size={HOME_SOCIO_SIZE} />}
                                            leadingSize={HOME_SOCIO_SIZE}
                                            title={socio.name}
                                            subtitle={socio.blurb}
                                            subtitleLines={2}
                                            trailing={<SocioStateLabel state={socio.state} label={socio.stateLabel} />}
                                            accessibilityLabel={socio.accessibilityLabel}
                                            accessibilityHint={SOCIO_ROW_HINT}
                                            {...(props.onOpenSocio === undefined
                                                ? {}
                                                : { onPress: () => props.onOpenSocio?.(socio.id) })}
                                        />
                                    </View>
                                    {props.onNewChat === undefined ? null : (
                                        <SymbolButton
                                            name={SOCIO_NEW_CHAT_SYMBOL}
                                            label={newChatWithLabel(socio.name)}
                                            onPress={() => props.onNewChat?.(socio.id)}
                                            testID={`socio-${socio.id}-new-chat`}
                                        />
                                    )}
                                </View>
                            ))
                        )
                    ) : (
                        <>
                            {count === 0 ? (
                                <ListRow
                                    first
                                    title={section.id === 'rooms' ? 'No rooms yet' : 'No chats yet'}
                                    accessibilityLabel={section.id === 'rooms' ? 'No rooms yet' : 'No chats yet'}
                                />
                            ) : null}
                            {section.chats.map((chat, index) => (
                                <ChatListRow
                                    key={chat.id}
                                    first={index === 0}
                                    item={props.items.get(chat.id) ?? chatListItem(chat, undefined, 0)}
                                    testID={`home-chat-${chat.id}`}
                                    onPress={() => openChat(chat)}
                                />
                            ))}
                            {section.more > 0 ? (
                                <ListRow
                                    testID="home-all-chats"
                                    title="All chats"
                                    subtitle={`${section.more} more`}
                                    trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
                                    accessibilityLabel={`All chats, ${section.more} more`}
                                    onPress={props.onAllChats}
                                />
                            ) : null}
                            {section.id === 'rooms' && props.onNewRoom !== undefined ? (
                                <ListRow
                                    testID="home-new-room"
                                    leadingSize={20}
                                    leading={<AppSymbol name="plus" color="muted-foreground" />}
                                    title={NEW_ROOM}
                                    subtitle={NEW_ROOM_HINT}
                                    accessibilityLabel={NEW_ROOM}
                                    accessibilityHint={NEW_ROOM_HINT}
                                    onPress={props.onNewRoom}
                                />
                            ) : null}
                        </>
                    )}
                </View>
            )}
        </View>
    );
}
