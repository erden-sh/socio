import type { NativeBottomTabNavigationProp } from '@react-navigation/bottom-tabs/unstable';
import { type ParamListBase, useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, type TextInputInstance, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { SearchBarCommands } from 'react-native-screens';

import { useCollections, useHasWorkspaceScope, useLiveQuery, useSyncStatus, useWorkspaceScope } from '../live';
import { barSearch } from '../navigation/bar-items';
import { useNativeBar } from '../navigation/native-bar';
import { issueAction, moreItemAction, newChatAction, pageAction, spaceAction, tabAction } from '../navigation/tabs';
import { chatList } from '../shell/chat-list';
import { chatListItem } from '../shell/chat-marks';
import { defaultSocioId } from '../shell/first-run';
import { homeSocios } from '../shell/home';
import { issuesQuery, shellQuery, shellRows, sociosQuery, spacesQuery } from '../shell/queries';
import { addMemoryAction, type SearchIconName, type SearchItem, type SearchTarget, searchView } from '../shell/search';
import { spaceList } from '../shell/spaces';
import { heldFolder } from '../sync/page-manage';
import { createServerSearch } from '../sync/server-search';
import { AppSymbol, Screen, SearchField, Text, ToneTile } from '../ui';
import { SearchEmptyState, useEmptyFill } from '../ui/empty-state';
import { searchEmpty } from '../ui/search-empty';
import type { SymbolName } from '../ui/symbols';

import { ChatListRow } from './chat-rows';
import { MODULE_ICONS } from './module-icons';
import { ListRow, Section, SocioAvatar, SocioStateLabel, useOpenChat } from './shell-parts';
import { useShownChats } from './shown-chats';
import { TAB_STACK_EDGES } from './tab-edges';

// The Search tab (src/shell/search.ts): iOS 26 draws its tab
// as the tab bar's separate glass button. It opens as the web's ⌘K palette
// does, on Actions then Go to. It is the root of the Search tab's own
// stack, under the system's bar titled Search, and what it opens is
// pushed in that tab. Its field is the system's on iOS: the bar's search
// field (`useNativeBar`'s `search`, UISearchController), which iOS 26 puts at
// the bottom in the glass Search button's place, over the keyboard, as Music's
// and the App Store's are; Android draws `SearchField` under its Material top
// app bar (`barSearch`). The field ranks the socios, the chats and rooms,
// the Spaces, the issues and the modules as the person types, and from two
// characters adds the server's issue and page matches (src/sync/server-search.ts,
// each keystroke aborting the last). A chat or room is the chat list's row
// (chat-rows.tsx, a room drawn as a room) and opens its screen, an issue
// its screen, a page the page reader, "File an issue" FileIssue;
// New chat the new chat with the default socio, Add memory Memories with its Add sheet open; a socio's
// comes later. It isn't kept as the last screen: a workspace never
// opens on Search. Tapping its tab (or iOS's glass Search button) again while
// Search shows puts the focus in its field, as iOS's own apps do (CB-418).
// A search that finds nothing shows "No results for “…”" centered in what
// shows of the screen, with Clear search (CB-552; ui/search-empty.ts).

/** The field's placeholder, the bar's on iOS and the drawn field's on Android. */
const SEARCH_PLACEHOLDER = 'Chats, issues, pages and more';

/** The line under "No results for “…”" (CB-552), after the web library's "Try a different title or phrase.". */
export const SEARCH_EMPTY_LINE = 'Try a different word, name or issue key.';

export function SearchScreen() {
    return useHasWorkspaceScope() ? <ScopedSearch /> : null;
}

function ScopedSearch() {
    const navigation = useNavigation();
    const collections = useCollections();
    const [query, setQuery] = useState('');
    const field = useRef<TextInputInstance>(null);
    const barField = useRef<SearchBarCommands>(null);
    useRetapFocus(field);
    // iOS: the system's search field, in the bar (at the bottom on iOS 26); Android draws its own below.
    const inBar = barSearch(Platform.OS);
    useNativeBar({ title: 'Search', search: { placeholder: SEARCH_PLACEHOLDER, onChange: setQuery, ref: barField } });
    // No results centers in what shows, between the bar and the bottom field or the keyboard (CB-552).
    const fill = useEmptyFill(true);
    // Clear search: the field emptied (the bar's, which sends no change for it), the focus kept in it.
    const clearSearch = () => {
        barField.current?.clearText();
        setQuery('');
        (inBar ? barField : field).current?.focus();
    };
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const chats = useShownChats();
    const { state, workspace } = shellRows(shell);
    const scope = useWorkspaceScope();
    const offline = useSyncStatus().reconnecting;
    const [server] = useState(() => createServerSearch({ fetch: scope.fetch }));
    useEffect(() => () => server.dispose(), [server]);
    // Answers are kept only while Search shows: leaving it drops them, and coming back asks again.
    const focused = useIsFocused();
    useFocusEffect(useCallback(() => () => server.forget(), [server]));
    useEffect(() => {
        if (focused) {
            server.search(query, offline);
        }
    }, [server, query, offline, focused]);
    const serverState = useSyncExternalStore(server.subscribe, server.state);
    const newChatWith = defaultSocioId(dots, state);
    const newChatName = dots.find((dot) => dot.id === newChatWith)?.name ?? null;
    const view = searchView({
        query,
        newChatWith: newChatWith === null || newChatName === null ? null : { id: newChatWith, name: newChatName },
        chats: chatList(chats, dots, state),
        socios: homeSocios(dots, state),
        spaces: spaceList(spaces),
        issues,
        server: serverState,
        isFolder: (spaceId, pageId) => heldFolder(scope.cache, spaceId, pageId),
        role: workspace?.user.role ?? null,
    });
    const go = (target: SearchTarget) => {
        switch (target.kind) {
            case 'chats':
                navigation.dispatch(tabAction('Chats'));
                return;
            case 'page':
                navigation.dispatch(tabAction(target.name));
                return;
            case 'space':
                navigation.dispatch(spaceAction(target.id));
                return;
            case 'space-page':
                navigation.dispatch(pageAction(target.spaceId, target.pageId));
                return;
            case 'issue':
                navigation.dispatch(issueAction(target.key));
                return;
            case 'file-issue':
                navigation.navigate('FileIssue');
                return;
            case 'new-chat':
                navigation.dispatch(newChatAction(target.socioId));
                return;
            case 'add-memory':
                navigation.dispatch(addMemoryAction());
                return;
            case 'more':
                navigation.dispatch(moreItemAction(target.id, target.label));
                return;
        }
    };
    return (
        <SearchTabInsets>
            <Screen
                testID="search-screen"
                edges={TAB_STACK_EDGES}
                // The field is the bar's on iOS: the screen pads by the keyboard itself (CB-552).
                {...(inBar ? { barKeyboard: fill } : {})}
                // Its empty state fills what shows itself: grown to the frame, it would scroll (CB-552).
                fit={inBar}
            >
                {inBar ? null : (
                    <SearchField
                        ref={field}
                        label="Search Socio"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={SEARCH_PLACEHOLDER}
                        testID="search-field"
                    />
                )}
                {view.sections.map((section) => (
                    <Section key={section.id} title={section.title} testID={`search-${section.id}`}>
                        {section.items.map((item, index) => (
                            <SearchRow key={item.key} item={item} first={index === 0} onGo={go} />
                        ))}
                    </Section>
                ))}
                {view.serverLine === null ? null : (
                    <Text variant="subheadline" tone="muted" className="text-center" testID="search-server-line">
                        {view.serverLine}
                    </Text>
                )}
                {view.noMatches ? (
                    <SearchEmptyState
                        view={searchEmpty({ query, line: SEARCH_EMPTY_LINE })}
                        onClearSearch={clearSearch}
                        fill={fill}
                        testID="search-no-matches"
                    />
                ) : null}
            </Screen>
        </SearchTabInsets>
    );
}

/**
 * Search's safe area on iOS: its own provider, measured by UIKit, whose bottom holds the home
 * indicator and iOS 26's bottom search row (as a pushed page's holds the tab bar, tab-stack.tsx), so
 * the empty state centers above the row (CB-552). Android keeps the window's.
 */
function SearchTabInsets(props: { readonly children: ReactNode }) {
    return Platform.OS === 'ios' ? <SafeAreaProvider>{props.children}</SafeAreaProvider> : props.children;
}

/**
 * Focuses `field` (Android's; iOS's bar field is the system's, which focuses itself) when Search's
 * tab is tapped while Search already shows. The native tabs emit
 * `tabPress` before they switch to a tab, so on the first tap the screen isn't focused yet and the
 * field is left alone.
 */
function useRetapFocus(field: RefObject<TextInputInstance | null>) {
    // Search's root is the first screen of the Search tab's own stack: the tab's events are its parent's.
    const tab = useNavigation().getParent<NativeBottomTabNavigationProp<ParamListBase>>();
    useEffect(
        () =>
            tab?.addListener('tabPress', () => {
                if (tab.isFocused()) {
                    field.current?.focus();
                }
            }),
        [tab, field],
    );
}

/** The rows' icons: the modules', and the actions' Plus and Bug (the web palette's). */
const SEARCH_ICONS: Readonly<Record<SearchIconName, SymbolName>> = { ...MODULE_ICONS, Plus: 'plus', Bug: 'bug' };

function SearchRow(props: { item: SearchItem; first: boolean; onGo: (target: SearchTarget) => void }) {
    const { item, first } = props;
    const openChat = useOpenChat();
    switch (item.kind) {
        case 'socio':
            return (
                <ListRow
                    first={first}
                    testID={`search-socio-${item.socio.id}`}
                    leading={<SocioAvatar character={item.socio.character} />}
                    title={item.socio.name}
                    trailing={<SocioStateLabel state={item.socio.state} label={item.socio.stateLabel} />}
                    accessibilityLabel={item.socio.accessibilityLabel}
                />
            );
        case 'chat':
            // The chat list's row (a room's tile and "Room · Admin"), without its marks and time.
            return (
                <ChatListRow
                    first={first}
                    item={chatListItem(item.chat, undefined, 0)}
                    testID={`search-chat-${item.chat.id}`}
                    onPress={() => openChat(item.chat)}
                />
            );
        case 'link':
            return (
                <ListRow
                    first={first}
                    testID={item.testID}
                    leadingSize={44}
                    leading={
                        item.tone === null ? (
                            <View className="size-11 items-center justify-center">
                                <AppSymbol name={SEARCH_ICONS[item.icon]} size={20} color="muted-foreground" />
                            </View>
                        ) : (
                            <ToneTile tone={item.tone} icon={SEARCH_ICONS[item.icon]} surface="card" />
                        )
                    }
                    title={item.label}
                    subtitle={item.subtitle}
                    subtitleLines={item.subtitleLines}
                    accessibilityLabel={item.accessibilityLabel}
                    onPress={() => props.onGo(item.target)}
                />
            );
    }
}
