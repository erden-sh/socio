import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import type { Space } from '@socio/shared/types';

import { fileUrl } from '../chat/attachment-tray';
import {
    useAllPageConflicts,
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSpaceItems,
    useSpacePages,
    useSyncStatus,
    useWorkspaceListed,
    useWorkspaceScope,
} from '../live';
import { barSearch } from '../navigation/bar-items';
import { useNativeBar } from '../navigation/native-bar';
import { datasetAction, pageAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { useEmbedPicture } from '../platform/image-cache';
import { spaceScreen } from '../shell/last-screen';
import { moduleEntry } from '../shell/modules';
import { LONG_PRESS_TO_MENU } from '../shell/native-menu';
import { NEW_PAGE } from '../shell/page-menus';
import { itemsQuery, pagesQuery, shellQuery, shellRows, spacesQuery } from '../shell/queries';
import {
    canPlaceIn,
    datasetCount,
    datasetsInSpaces,
    type ItemRow,
    libraryTree,
    spaceItemRows,
} from '../shell/space-items';
import {
    IN_PAGE_TEXT,
    LIBRARY_VIEWS,
    librarySearch,
    type LibrarySearchView,
    type LibraryView,
    PAGE_SEARCH_LABEL,
    pageCount,
    recentPages,
    type RecentPageRow,
    SPACE_UNAVAILABLE,
    spaceHeading,
    spaceIntro,
    WAITING,
    spaceUnavailable,
    toggleExpanded,
    type TreeRow,
} from '../shell/space-library';
import type { SpaceTab } from '../shell/space-sections';
import { isLocalPage } from '../sync/page-save';
import { createServerSearch } from '../sync/server-search';
import { spaceSection } from '../sync/space-sections';
import {
    AppSymbol,
    RowSeparator,
    rowMinHeight,
    Screen,
    SearchField,
    SegmentedControl,
    SquircleImage,
    Text,
    ToneTile,
    usePullToRefresh,
} from '../ui';
import { EmptyState, NOT_SHARED_LINE, useWayBack } from '../ui/empty-state';

import { ActionMenu, type MenuRequest } from './action-menu';
import { MOVE_ACTION, useDatasetMove } from './dataset-move';
import { KeepOfflineToggle } from './keep-offline-toggle';
import { MODULE_ICONS } from './module-icons';
import { usePageManage, usePageWrites } from './page-menus';
import { ListRow, PageIntro, Section, StatusBanners, useRememberScreen } from './shell-parts';
import { MemoryTab, RadarTab, SpaceTabs } from './space-sections';

// A Space's library, read-only:
// the `Space` route at `/spaces/:spaceId`, pushed from the Spaces, Search and
// links. New page and each row's long-press menu (Move, the cover, Delete)
// are the page menus' (screens/page-menus.tsx), laid over the rows at once. Its pages come from the phone's copy in the first frame (a cold start
// onto it reads them before: `preloadKeptSpace`), then the Space's pull and its
// 15 s poll while it shows (`useSpacePages`). Recent lists them by most recent
// change with the excerpt and cover, as the web's library does; All pages is the
// tree from shared's `pageHierarchy`, each parent expanded and collapsed, its
// state said to screen readers. Its header names the Space and holds Keep
// offline. A page opens in the reader. A Space the
// person lost (deleted, or access removed) says so, with no toggle, no pull and
// no poll, and isn't kept as the last screen. Under its heading are the web's
// tabs, Pages, Memory and Radar (screens/space-sections.tsx): the
// `SpaceMemory` and `SpaceRadar` routes, at the web's paths, open it on theirs.
// Its heading is the web's: the Space's name as the big title beside the
// Spaces-tone folder tile ("module tones stay on page headers"), so the
// header says "Spaces". On Pages, "Search pages" filters the pages the phone
// holds by title and excerpt and, from two characters online, adds the
// server's matches in the Space's page text (`/api/spaces/search?space=`,
// shared/space-library.ts's `librarySearch`); offline it says that needs a
// connection.

/** The web's empty library (SpaceLibrary's LibraryEmpty): its heading and line, over New page. */
const NO_PAGES = 'No pages yet';
const NO_PAGES_LINE = 'Create your first page to start organizing this Space.';

const SPACES = moduleEntry(MODULE_IDS.spaces);
const DATA = moduleEntry(MODULE_IDS.data);

export function SpaceScreen({ route }: StaticScreenProps<{ spaceId: string }>) {
    return useHasWorkspaceScope() ? <Space spaceId={route.params.spaceId} tab="pages" /> : null;
}

/** `/spaces/:spaceId/memory`: the Space on its Memory tab. */
export function SpaceMemoryScreen({ route }: StaticScreenProps<{ spaceId: string }>) {
    return useHasWorkspaceScope() ? <Space spaceId={route.params.spaceId} tab="memory" /> : null;
}

/** `/spaces/:spaceId/radar`: the Space on its Radar tab. */
export function SpaceRadarScreen({ route }: StaticScreenProps<{ spaceId: string }>) {
    return useHasWorkspaceScope() ? <Space spaceId={route.params.spaceId} tab="radar" /> : null;
}

function Space({ spaceId, tab }: { spaceId: string; tab: SpaceTab }) {
    const collections = useCollections();
    const listed = useWorkspaceListed();
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    return spaceUnavailable(spaces, spaceId, listed) ? (
        <Unavailable />
    ) : (
        <Library spaceId={spaceId} spaces={spaces} initialTab={tab} />
    );
}

/** A Space the workspace no longer lists: said plainly, nothing pulled or offered. */
function Unavailable() {
    const back = useWayBack('Space');
    useFirstFrameWithData('Space', true);
    useNativeBar({ title: SPACES.title, tone: SPACES.tone });
    return (
        <View testID="space-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']}>
                <StatusBanners />
                <EmptyState
                    headline={SPACE_UNAVAILABLE}
                    line={NOT_SHARED_LINE}
                    action={back}
                    testID="space-unavailable"
                />
            </Screen>
        </View>
    );
}

function Library(props: { spaceId: string; spaces: readonly Space[]; initialTab: SpaceTab }) {
    const { spaceId, spaces } = props;
    const [tab, setTab] = useState<SpaceTab>(props.initialTab);
    const navigation = useNavigation();
    const { pages: store } = useWorkspaceScope();
    useRememberScreen(spaceScreen(spaceId));
    const space = useSpacePages(spaceId);
    const { data: synced } = useLiveQuery({
        query: pagesQuery(space.collection),
    });
    const { shown: pages, refused } = usePageWrites(spaceId, synced);
    const manage = usePageManage(spaceId, spaces, pages, refused, synced);
    const [view, setView] = useState<LibraryView>('recent');
    const [query, setQuery] = useState('');
    const search = usePageSearch(spaceId, query);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const heading = spaceHeading(spaces, spaceId);
    // CB-469: with the web's flag, the Space's datasets among its pages (`/items`), Move for its editors.
    const collections = useCollections();
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const datasets = datasetsInSpaces(shellRows(shell).workspace);
    const itemList = useSpaceItems(spaceId, datasets);
    const { data: heldItems } = useLiveQuery({ query: itemsQuery(itemList.collection) });
    const items = datasets ? heldItems : [];
    const datasetRows = spaceItemRows(items);
    const places = canPlaceIn(spaces.find((item) => item.id === spaceId));
    const move = useDatasetMove(spaces);
    const openItem = (item: ItemRow) => {
        if (item.opens) {
            navigation.dispatch(datasetAction(item.id, spaceId));
        }
    };
    const itemMenu = (item: ItemRow) => ({
        request: item.opens ? move.menu({ id: item.id, title: item.title, from: spaceId }, places) : null,
        actions: item.opens && places ? [MOVE_ACTION] : [],
        act: () => move.open({ id: item.id, title: item.title, from: spaceId }),
    });
    // A page whose save waits as a conflict gets a badge.
    const conflicts = useAllPageConflicts();
    const conflicted = new Set(conflicts.map((conflict) => conflict.pageId));
    const recent = recentPages(pages, spaceId, conflicted);
    useFirstFrameWithData('Space', recent.length > 0);
    const found = librarySearch({ query, spaceId, rows: recent, pages, server: search });
    const byId = new Map(pages.map((page) => [page.id, page]));
    const rowMenu = (id: string, title: string) => {
        const page = byId.get(id);
        return page === undefined
            ? {}
            : {
                  request: manage.menu(page, title),
                  onLongPress: LONG_PRESS_TO_MENU,
                  accessibilityActions: manage.accessibilityActions(page),
                  onAccessibilityAction: (name: string) => manage.act(page, name),
              };
    };
    // The page's body from disk first, so the reader draws it in its first frame.
    // A page made here opens once the server has it (its create resolved, the row re-keys).
    const open = (pageId: string) => {
        if (isLocalPage(pageId)) {
            return;
        }
        store.preload(spaceId, pageId).catch((error: unknown) => console.warn('[pages] not read from disk', error));
        navigation.dispatch(pageAction(spaceId, pageId));
    };
    // The system's bar (CB-420): the Space's name as the large title, New page and Keep offline at
    // its end, and on iOS the bar's search field while the pages show (Files' and Notes').
    const searches = tab === 'pages' && (recent.length > 0 || query !== '');
    // Pull to refresh: the Space's pages now, or the tab's radar or memory read again.
    const refreshControl = usePullToRefresh(() =>
        tab === 'pages'
            ? Promise.all([space.pull(), datasets ? itemList.pull() : null])
            : spaceSection(store.sections, spaceId, tab).refresh(),
    );
    useNativeBar({
        title: heading?.name ?? SPACES.title,
        tone: SPACES.tone,
        right: [
            {
                kind: 'custom',
                id: 'space-keep-offline',
                signature: spaceId,
                element: () => <KeepOfflineToggle spaceId={spaceId} />,
            },
            ...(tab === 'pages'
                ? [
                      {
                          id: 'space-new-page',
                          label: NEW_PAGE,
                          symbol: 'plus',
                          icon: 'plus' as const,
                          iconOnly: true,
                          onPress: manage.newPage,
                      },
                  ]
                : []),
        ],
        ...(searches ? { search: { placeholder: PAGE_SEARCH_LABEL, onChange: setQuery } } : {}),
    });
    return (
        <View testID="space-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped refreshControl={refreshControl}>
                <StatusBanners />
                <PageIntro
                    subtitle={spaceIntro(heading, recent.length)}
                    subtitleLines={2}
                    tile={{ tone: SPACES.tone, icon: MODULE_ICONS[SPACES.icon] }}
                    testID="space-heading"
                />
                <SpaceTabs tab={tab} onTab={setTab} />
                {tab === 'memory' ? (
                    <MemoryTab spaceId={spaceId} isPrivate={heading?.private === true} />
                ) : tab === 'radar' ? (
                    <RadarTab spaceId={spaceId} onOpen={open} />
                ) : recent.length === 0 && datasetRows.length === 0 && query === '' ? (
                    <EmptyState
                        tile={{ tone: SPACES.tone, icon: 'file-text' }}
                        headline={NO_PAGES}
                        line={NO_PAGES_LINE}
                        action={{
                            label: NEW_PAGE,
                            onPress: manage.newPage,
                            variant: 'primary',
                            testID: 'space-empty-new-page',
                        }}
                        testID="space-empty"
                    />
                ) : (
                    <>
                        {barSearch(Platform.OS) ? null : (
                            <SearchField
                                label={PAGE_SEARCH_LABEL}
                                value={query}
                                onChangeText={setQuery}
                                testID="space-search"
                            />
                        )}
                        {found.searching ? (
                            <SearchResults found={found} onOpen={open} rowMenu={rowMenu} />
                        ) : (
                            <>
                                <ViewPicker view={view} onView={setView} />
                                <Section title={pageCount(recent.length)} testID={`space-${view}`}>
                                    {view === 'recent'
                                        ? recent.map((page, index) => (
                                              <RecentRow
                                                  key={page.id}
                                                  page={page}
                                                  first={index === 0}
                                                  onOpen={open}
                                                  menu={rowMenu(page.id, page.title)}
                                              />
                                          ))
                                        : libraryTree(pages, items, spaceId, expanded, conflicted).map((entry, index) =>
                                              entry.kind === 'page' ? (
                                                  <TreeRowView
                                                      key={entry.row.id}
                                                      row={entry.row}
                                                      first={index === 0}
                                                      onOpen={open}
                                                      menu={rowMenu(entry.row.id, entry.row.title)}
                                                      onToggle={() =>
                                                          setExpanded(toggleExpanded(expanded, entry.row.id))
                                                      }
                                                  />
                                              ) : (
                                                  <TreeItemView
                                                      key={entry.item.id}
                                                      item={entry.item}
                                                      depth={entry.depth}
                                                      first={index === 0}
                                                      onOpen={openItem}
                                                      menu={itemMenu(entry.item)}
                                                  />
                                              ),
                                          )}
                                </Section>
                                {view === 'recent' && datasetRows.length > 0 ? (
                                    <Section title={datasetCount(datasetRows.length)} testID="space-datasets">
                                        {datasetRows.map((item, index) => (
                                            <DatasetRow
                                                key={item.id}
                                                item={item}
                                                first={index === 0}
                                                onOpen={openItem}
                                                menu={itemMenu(item)}
                                            />
                                        ))}
                                    </Section>
                                ) : null}
                            </>
                        )}
                    </>
                )}
            </Screen>
            {manage.element}
        </View>
    );
}

/** A row's long-press menu and its accessibility actions, none for a page the phone lacks. */
interface RowMenu {
    /** The system's menu on a long-press (CB-421), the row lifted as its preview. */
    readonly request?: MenuRequest;
    readonly onLongPress?: () => void;
    readonly accessibilityActions?: readonly {
        readonly name: string;
        readonly label: string;
    }[];
    readonly onAccessibilityAction?: (name: string) => void;
}

/**
 * The server's half of the library's search (server-search.ts with the Space's filter), asked while
 * the library shows and the person has typed two characters; nothing offline. Leaving drops it.
 */
function usePageSearch(spaceId: string, query: string) {
    const scope = useWorkspaceScope();
    const offline = useSyncStatus().reconnecting;
    const focused = useIsFocused();
    const [server] = useState(() => createServerSearch({ fetch: scope.fetch, space: spaceId }));
    useEffect(() => () => server.dispose(), [server]);
    useEffect(() => {
        if (focused) {
            server.search(query, offline);
        } else {
            server.forget();
        }
    }, [server, query, offline, focused]);
    return useSyncExternalStore(server.subscribe, server.state);
}

/** What a search found: the phone's matches as Recent's rows, then the server's in the pages' text. */
function SearchResults(props: {
    found: LibrarySearchView;
    onOpen: (id: string) => void;
    rowMenu: (id: string, title: string) => RowMenu;
}) {
    const { found, onOpen, rowMenu } = props;
    return (
        <>
            {found.local.length === 0 ? null : (
                <Section title={pageCount(found.local.length)} testID="space-search-results">
                    {found.local.map((page, index) => (
                        <RecentRow
                            key={page.id}
                            page={page}
                            first={index === 0}
                            onOpen={onOpen}
                            menu={rowMenu(page.id, page.title)}
                        />
                    ))}
                </Section>
            )}
            {found.text.length === 0 ? null : (
                <Section title={IN_PAGE_TEXT} testID="space-search-text">
                    {found.text.map((hit, index) => (
                        <ListRow
                            key={hit.id}
                            first={index === 0}
                            testID={`space-search-hit-${hit.id}`}
                            leadingSize={44}
                            leading={<ToneTile tone={SPACES.tone} icon="file-text" surface="card" />}
                            title={hit.title}
                            subtitle={hit.snippet === '' ? null : hit.snippet}
                            subtitleLines={2}
                            meta={
                                <Text variant="meta" numberOfLines={1}>
                                    {hit.fresh}
                                </Text>
                            }
                            accessibilityLabel={hit.accessibilityLabel}
                            accessibilityHint="Opens the page"
                            onPress={() => onOpen(hit.id)}
                        />
                    ))}
                </Section>
            )}
            {found.line === null ? null : (
                <Text variant="subheadline" tone="muted" className="text-center" testID="space-search-line">
                    {found.line}
                </Text>
            )}
            {found.empty === null ? null : (
                <Text variant="subheadline" tone="muted" className="text-center" testID="space-search-empty">
                    {found.empty}
                </Text>
            )}
        </>
    );
}

/** Recent or All pages: the platform's segmented control. */
function ViewPicker({ view, onView }: { view: LibraryView; onView: (view: LibraryView) => void }) {
    return (
        <SegmentedControl
            options={LIBRARY_VIEWS.map((item) => ({
                value: item.id,
                label: item.label,
                testID: `space-view-${item.id}`,
            }))}
            selected={view}
            onSelect={onView}
            accessibilityLabel="Pages"
            testID="space-view"
        />
    );
}

function RecentRow(props: { page: RecentPageRow; first: boolean; onOpen: (id: string) => void; menu: RowMenu }) {
    const { page, first, onOpen, menu } = props;
    const rest = [page.trail, page.waiting ? WAITING : null].filter(Boolean).join(' · ');
    return (
        <ActionMenu request={menu.request ?? null} trigger="longPress">
            <ListRow
                first={first}
                testID={`space-page-${page.id}`}
                leadingSize={44}
                leading={<Cover coverId={page.coverId} coverUpload={page.coverUpload} />}
                title={page.title}
                subtitle={page.excerpt}
                subtitleLines={2}
                meta={
                    // The page's meta: the date in tabular figures, the parents' trail beside it.
                    <Text variant="footnote" tone="muted" numberOfLines={1} testID={`space-page-${page.id}-meta`}>
                        <Text variant="meta">{page.edited}</Text>
                        {rest === '' ? '' : ` · ${rest}`}
                    </Text>
                }
                trailing={page.conflict ? <ConflictBadge /> : null}
                accessibilityLabel={page.accessibilityLabel}
                accessibilityHint={isLocalPage(page.id) ? WAITING : 'Opens the page'}
                onPress={() => onOpen(page.id)}
                {...(menu.onLongPress === undefined ? {} : { onLongPress: menu.onLongPress })}
                {...(menu.accessibilityActions === undefined
                    ? {}
                    : { accessibilityActions: menu.accessibilityActions })}
                {...(menu.onAccessibilityAction === undefined
                    ? {}
                    : { onAccessibilityAction: menu.onAccessibilityAction })}
            />
        </ActionMenu>
    );
}

/**
 * A page with a conflict: the conflict banner's warning, in its colors, beside the page menus'
 * "Waiting to send". The row's label says "Changed elsewhere", so the badge is hidden from screen readers.
 */
function ConflictBadge() {
    return (
        <View
            testID="space-page-conflict"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="rounded-full border border-paused-banner-border bg-paused-banner p-1"
        >
            <AppSymbol name="triangle-alert" size={14} color="paused-banner-foreground" />
        </View>
    );
}

/**
 * A page's cover as a 44 pt squircle, through the image cache; a new one from the phone's copy while it
 * uploads; the page tile in the Spaces tone without one.
 */
function Cover({ coverId, coverUpload }: { coverId: string | null; coverUpload: string | null }) {
    if (coverUpload !== null) {
        return <UploadPicture uploadId={coverUpload} />;
    }
    return coverId === null ? (
        <ToneTile tone={SPACES.tone} icon="file-text" surface="card" />
    ) : (
        <CoverPicture coverId={coverId} />
    );
}

function CoverPicture({ coverId }: { coverId: string }) {
    const picture = useEmbedPicture(coverId);
    return picture.state === 'ready' ? (
        <SquircleImage size={44} source={{ uri: picture.uri }} testID="space-page-cover" />
    ) : (
        <ToneTile tone={SPACES.tone} icon="file-text" surface="card" />
    );
}

function UploadPicture({ uploadId }: { uploadId: string }) {
    const { uploads } = useWorkspaceScope();
    const upload = useSyncExternalStore(uploads.subscribe, () => uploads.get(uploadId));
    return upload === null ? (
        <ToneTile tone={SPACES.tone} icon="file-text" surface="card" />
    ) : (
        <SquircleImage size={44} source={{ uri: fileUrl(upload.path) }} testID="space-page-cover-upload" />
    );
}

/** The step of each level of the tree, in points. */
const INDENT = 20;

function TreeRowView(props: {
    row: TreeRow;
    first: boolean;
    onOpen: (id: string) => void;
    onToggle: () => void;
    menu: RowMenu;
}) {
    const { row, first, onOpen, onToggle, menu } = props;
    const parent = row.children > 0;
    const toggleName = row.expanded ? 'collapse' : 'expand';
    return (
        <View className="flex-row items-center" style={[rowMinHeight(44), { paddingLeft: row.depth * INDENT }]}>
            {/* At the title, past the toggle's 44 pt and the icon. */}
            {first ? null : <RowSeparator inset={row.depth * INDENT + 44 + 20 + 12} />}
            {parent ? (
                // Screen readers reach the toggle as the row's action, with its expanded state.
                <Pressable
                    testID={`space-tree-toggle-${row.id}`}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    onPress={onToggle}
                    className="size-11 items-center justify-center active:bg-accent"
                >
                    <AppSymbol name={row.expanded ? 'chevron-down' : 'chevron-right'} color="muted-foreground" />
                </Pressable>
            ) : (
                <View className="size-11" />
            )}
            <ActionMenu request={menu.request ?? null} trigger="longPress" style={TREE_ROW_MENU}>
                <Pressable
                    testID={`space-tree-${row.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={row.accessibilityLabel}
                    accessibilityHint="Opens the page"
                    accessibilityState={parent ? { expanded: row.expanded } : undefined}
                    accessibilityActions={[
                        ...(parent
                            ? [
                                  {
                                      name: toggleName,
                                      label: row.expanded ? 'Hide subpages' : 'Show subpages',
                                  },
                              ]
                            : []),
                        ...(menu.accessibilityActions ?? []),
                    ]}
                    onAccessibilityAction={(event) => {
                        const name = event.nativeEvent.actionName;
                        if (name === toggleName) {
                            onToggle();
                        } else {
                            menu.onAccessibilityAction?.(name);
                        }
                    }}
                    onPress={() => onOpen(row.id)}
                    onLongPress={menu.onLongPress}
                    className="min-h-11 min-w-0 flex-1 flex-row items-center gap-3 py-3 pr-3 active:bg-accent"
                >
                    <AppSymbol name="file-text" color="muted-foreground" />
                    <Text numberOfLines={1} className="min-w-0 flex-1">
                        {row.title}
                    </Text>
                    {row.conflict ? <ConflictBadge /> : null}
                    {parent ? (
                        <Text variant="footnote" tone="muted">
                            {row.children}
                        </Text>
                    ) : null}
                </Pressable>
            </ActionMenu>
        </View>
    );
}

/** The tree row's menu takes the row's width beside its toggle. */
const TREE_ROW_MENU = { flex: 1, minWidth: 0 } as const;

/** An item's menu (CB-469): Move for the Space's editors, none for others. */
interface ItemMenu {
    readonly request: MenuRequest | null;
    readonly actions: readonly { readonly name: string; readonly label: string }[];
    readonly act: () => void;
}

/** A dataset, or an item of a kind this version doesn't know, in Recent's Datasets section. */
function DatasetRow(props: { item: ItemRow; first: boolean; onOpen: (item: ItemRow) => void; menu: ItemMenu }) {
    const { item, first, onOpen, menu } = props;
    return (
        <ActionMenu request={menu.request} trigger="longPress">
            <ListRow
                first={first}
                testID={`space-dataset-${item.id}`}
                leadingSize={44}
                leading={
                    <ToneTile
                        tone={item.opens ? DATA.tone : SPACES.tone}
                        icon={item.opens ? 'table' : 'circle-help'}
                        surface="card"
                    />
                }
                title={item.title}
                subtitle={[item.subtitle, item.badge].filter(Boolean).join(' · ')}
                accessibilityLabel={item.accessibilityLabel}
                {...(item.opens ? { accessibilityHint: 'Opens the dataset', onPress: () => onOpen(item) } : {})}
                {...(menu.request === null
                    ? {}
                    : {
                          onLongPress: LONG_PRESS_TO_MENU,
                          accessibilityActions: menu.actions,
                          onAccessibilityAction: menu.act,
                      })}
            />
        </ActionMenu>
    );
}

/** A dataset in the tree, at its depth under its page: its own icon, no toggle (nothing sits under it). */
function TreeItemView(props: {
    item: ItemRow;
    depth: number;
    first: boolean;
    onOpen: (item: ItemRow) => void;
    menu: ItemMenu;
}) {
    const { item, depth, first, onOpen, menu } = props;
    return (
        <View className="flex-row items-center" style={[rowMinHeight(44), { paddingLeft: depth * INDENT }]}>
            {first ? null : <RowSeparator inset={depth * INDENT + 44 + 20 + 12} />}
            <View className="size-11" />
            <ActionMenu request={menu.request} trigger="longPress" style={TREE_ROW_MENU}>
                <Pressable
                    testID={`space-tree-item-${item.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={item.accessibilityLabel}
                    {...(item.opens ? { accessibilityHint: 'Opens the dataset' } : {})}
                    accessibilityActions={menu.actions}
                    onAccessibilityAction={() => menu.act()}
                    onPress={() => onOpen(item)}
                    {...(menu.request === null ? {} : { onLongPress: LONG_PRESS_TO_MENU })}
                    className="min-h-11 min-w-0 flex-1 flex-row items-center gap-3 py-3 pr-3 active:bg-accent"
                >
                    <AppSymbol
                        name={item.opens ? 'table' : 'circle-help'}
                        color={item.opens ? 'primary' : 'muted-foreground'}
                    />
                    <Text numberOfLines={1} className="min-w-0 flex-1">
                        {item.title}
                    </Text>
                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                        {item.subtitle}
                    </Text>
                </Pressable>
            </ActionMenu>
        </View>
    );
}
