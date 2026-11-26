import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native';
import type { StaticScreenProps } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import type { Space } from '@socio/shared/types';

import { OPEN_IN_BROWSER } from '../chat/chat-view';
import { outboxStateStore } from '../chat/composer';
import { pageChatScope, PageChatRequests } from '../chat/page-chat-requests';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    usePageBody,
    usePageConflicts,
    useSpacePages,
    useWorkspaceListed,
    useWorkspaceScope,
} from '../live';
import { useBarInset } from '../navigation/bar-inset';
import { type BarItem, useNativeBar } from '../navigation/native-bar';
import { pageAction, pageEditorAction, spaceAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { useEmbedPicture } from '../platform/image-cache';
import { pageScreen } from '../shell/last-screen';
import { moduleEntry } from '../shell/modules';
import {
    PAGE_CHAT_FAILED,
    PAGE_CHAT_HINT,
    PAGE_CHAT_LABEL,
    PAGE_CHAT_TITLE,
    PAGE_CHAT_UNSAVED,
    pageChatActions,
    pageChatCopy,
    pageChatEntry,
    socioOfAction,
} from '../shell/page-conversation';
import { readerBar } from '../shell/page-menus';
import {
    FOLDER_EMPTY,
    FOLDER_KEPT_TEXT,
    IN_THIS_FOLDER,
    OPEN_ONLINE,
    PAGE_NOT_FOUND,
    PAGE_NOT_FOUND_LINE,
    pageLink,
    pageParts,
    type PageRef,
    pageView,
    type PageView,
} from '../shell/page-reader';
import { pagesQuery, shellQuery, shellRows, sociosQuery, spacesQuery } from '../shell/queries';
import { SPACE_UNAVAILABLE, spaceHeading, spaceUnavailable } from '../shell/space-library';
import { pendingFolder } from '../sync/page-manage';
import { isLocalPage, pendingPageText } from '../sync/page-save';
import { AppSymbol, Button, Screen, Text } from '../ui';
import { EmptyState, NOT_SHARED_LINE, useWayBack } from '../ui/empty-state';

import { MarkdownBlock } from './chat-markdown';
import { useOpenLink } from './open-link';
import { DatasetViewBlock, EmbedCardBlock, PagePictureBlock, PageTableBlock } from './page-blocks';
import { PageConflictBanner, PageToasts } from './page-conflict';
import { usePageManage, usePageWrites } from './page-menus';
import { ListRow, Section, StatusBanners, useRememberScreen } from './shell-parts';

// Reading a page: the `Page` route
// at `/spaces/:spaceId/pages/:pageId`, pushed from its Space's library, another
// page's links and links from outside. The cover, the parents (the web's phone
// crumbs), the title, then the body through the chat replies' renderer (its image rule:
// nothing a page names is fetched) with the blocks the web draws from fences,
// then the subpages. From the phone's copy in the first frame (a cold start onto
// it reads both before: `preloadKeptPage`), then, online, the Space's list and
// the body if its revision moved (`usePageBody`). Offline with no body: the
// title and excerpt with "Open it once you're online". Links to the workspace's
// pages and Spaces open here; others keep the chat replies' rules. A page that moves to
// another Space follows (`onMoved`). Edit opens the page's editor
// (page-editor.tsx). While a save of it waits in a conflict, the banner shows over
// the page, which shows theirs (page-conflict.tsx). Ask about this page
// (CB-499, the web's Page conversation) opens the person's chat about it with a
// socio of its Space, in the chat screen (`useAskAboutPage` below; the view in
// src/shell/page-conversation.ts). A folder (CB-426) reads as what it holds: the
// pages and folders in it, New page and New folder in the bar's + menu, Turn into
// page in its ⋯, and nothing of its hidden body: no body or excerpt, no Edit, no
// Ask about this page, no Compare under a conflict.

const SPACES = moduleEntry(MODULE_IDS.spaces);
/** The page's chat, pushed over it in the tab the page is in (a NAVIGATE could go back to another chat). */
const pageChatAction = (id: string) => ({ type: 'PUSH', payload: { name: 'Chat', params: { id } } }) as const;
/** How much of the page's title has gone under the bar when the bar takes it (Notes': most of it). */
const TITLE_GONE_SHARE = 0.6;

export function PageScreen({ route }: StaticScreenProps<{ spaceId: string; pageId: string }>) {
    return useHasWorkspaceScope() ? <PageRoute spaceId={route.params.spaceId} pageId={route.params.pageId} /> : null;
}

function PageRoute({ spaceId, pageId }: { spaceId: string; pageId: string }) {
    const collections = useCollections();
    const listed = useWorkspaceListed();
    const { data: spaces } = useLiveQuery({ query: spacesQuery(collections) });
    if (spaceUnavailable(spaces, spaceId, listed)) {
        return <Missing title={SPACES.title} headline={SPACE_UNAVAILABLE} line={NOT_SHARED_LINE} />;
    }
    return (
        <Reader
            spaceId={spaceId}
            pageId={pageId}
            spaces={spaces}
            spaceName={spaceHeading(spaces, spaceId)?.name ?? SPACES.title}
        />
    );
}

/** A page or Space the person can't open here: said plainly (the shared empty state), nothing pulled. */
function Missing(props: { title: string; headline: string; line: string | null }) {
    const back = useWayBack('Page');
    useFirstFrameWithData('Page', true);
    useNativeBar({ title: props.title });
    return (
        <View testID="page-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']}>
                <StatusBanners />
                <EmptyState headline={props.headline} line={props.line} action={back} testID="page-missing" />
            </Screen>
        </View>
    );
}

function Reader({
    spaceId,
    pageId,
    spaces,
    spaceName,
}: {
    spaceId: string;
    pageId: string;
    spaces: readonly Space[];
    spaceName: string;
}) {
    const navigation = useNavigation();
    const { pages: store, workspace, outbox } = useWorkspaceScope();
    const openLink = useOpenLink();
    useRememberScreen(pageScreen(spaceId, pageId));
    const space = useSpacePages(spaceId);
    const { data: synced } = useLiveQuery({ query: pagesQuery(space.collection) });
    // This phone's page writes over the list: a page made in a folder shows in it at once (CB-426).
    const { shown: pages, refused } = usePageWrites(spaceId, synced);
    const body = usePageBody(spaceId, pageId);
    // A save still waiting shows its draft (the page save's overlay); a refused one leaves the server's under its banner.
    // Read from the store's snapshot, so the compiler's memo moves with every outbox change.
    const [writesStore] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(writesStore.subscribe, writesStore.get);
    const waiting = pendingPageText(
        {
            rows: () => [...writes.rows],
            unsent: () => [...writes.unsent],
            resolve: (kind, id) => outbox.resolve(kind, id),
        },
        pageId,
    );
    const pending = waiting?.state === 'pending' ? waiting : null;
    const marking = pendingFolder(
        {
            rows: () => [...writes.rows],
            unsent: () => [...writes.unsent],
            resolve: (kind, id) => outbox.resolve(kind, id),
        },
        pageId,
    );
    const conflicts = usePageConflicts(pageId);
    const ask = useAskAboutPage(spaceId, pageId, waiting !== null || conflicts.length > 0);
    const view = pageView(pages, spaceId, pageId, body.value, pending, marking);
    const here = new Set([pageId, ...(view?.children ?? []).map((child) => child.id)]);
    const manage = usePageManage(
        spaceId,
        spaces,
        pages,
        refused.filter((item) => here.has(item.pageId)),
        synced,
    );
    const bar = readerBar(view);
    const shownPage = pages.find((page) => page.id === pageId);
    const [notice, setNotice] = useState<string | null>(null);
    const hideNotice = useCallback(() => setNotice(null), []);
    // Only on screen: a merge that lands under the editor is the editor's toast, not a hidden one here.
    const focused = useIsFocused();

    // A move to another Space (the list's poll, then the body's 404 and its location): follow it.
    useEffect(
        () =>
            store.onMoved((move) => {
                if (move.pageId === pageId && move.from === spaceId) {
                    navigation.setParams({ spaceId: move.to } as never);
                }
            }),
        [store, navigation, spaceId, pageId],
    );

    // Not in the Space's list, and the server said the body is gone (a 410, or a 404 with no new place).
    const gone = view === null && body.gone;
    useFirstFrameWithData('Page', view !== null && body.loaded);
    const onLink = (url: string) => {
        const link = pageLink(url, workspace.origin);
        if (link === null) {
            openLink(url);
        } else if (link.kind === 'page') {
            navigation.dispatch(pageAction(link.spaceId, link.pageId));
        } else {
            navigation.dispatch(spaceAction(link.spaceId));
        }
    };
    // A page made here opens once the server has it (its create resolved, the row re-keys).
    const openPage = (id: string) => {
        if (!isLocalPage(id)) {
            navigation.dispatch(pageAction(spaceId, id));
        }
    };
    const onAdd = (name: string) => {
        if (name === 'new-folder') {
            manage.newFolder(pageId);
        } else if (name === 'new-page') {
            manage.newPage(pageId);
        }
    };
    const onMore = (name: string) => {
        if (shownPage !== undefined) {
            manage.act(shownPage, name);
        }
    };
    // The system's bar (CB-420; Notes' and Files'): no title while the page's own shows, then the page's
    // title once that has scrolled under the bar; Edit at its end, in glass on iOS.
    const barInset = useBarInset();
    // The page's own title, measured: once most of it is under the bar, the bar shows it.
    const [titleTop, setTitleTop] = useState<number | null>(null);
    const [titleHeight, setTitleHeight] = useState(0);
    const titleEnd = titleTop === null ? null : titleTop + titleHeight * TITLE_GONE_SHARE;
    // Only whether it has gone, so a scroll re-renders the page only as it crosses.
    const [titleGone, setTitleGone] = useState(false);
    const onScrollY = (y: number) => setTitleGone(titleEnd !== null && y + barInset > titleEnd);
    const right: BarItem[] = [];
    if (bar.edit) {
        right.push({
            id: 'page-edit',
            label: 'Edit',
            hint: "Opens the page's editor",
            symbol: 'pencil',
            icon: 'pencil',
            iconOnly: true,
            disabled: view === null,
            onPress: () => navigation.dispatch(pageEditorAction(spaceId, pageId)),
        });
    }
    if (bar.ask) {
        right.push({
            id: 'page-chat',
            label: PAGE_CHAT_LABEL,
            hint: PAGE_CHAT_HINT,
            symbol: 'bubble.left',
            icon: 'message-circle',
            iconOnly: true,
            disabled: view === null || ask.busy,
            onPress: ask.press,
            ...(ask.menu === null ? {} : { menu: ask.menu }),
        });
    }
    // A folder (CB-426): New page and New folder inside it.
    if (bar.add.length > 0) {
        right.push({
            id: 'page-folder-add',
            label: 'Add to this folder',
            symbol: 'plus',
            icon: 'plus',
            iconOnly: true,
            onPress: () => {},
            menu: { actions: bar.add, onAction: onAdd },
        });
    }
    // Turn into folder, or into page (CB-426).
    if (bar.more.length > 0 && shownPage !== undefined) {
        right.push({
            id: 'page-more',
            label: 'More',
            symbol: 'ellipsis',
            icon: 'ellipsis',
            iconOnly: true,
            onPress: () => {},
            menu: { actions: bar.more, onAction: onMore },
        });
    }
    useNativeBar({
        title: titleGone ? (view?.title ?? spaceName) : view === null ? spaceName : '',
        right,
    });

    if (gone) {
        return <Missing title={spaceName} headline={PAGE_NOT_FOUND} line={PAGE_NOT_FOUND_LINE} />;
    }
    return (
        <View testID="page-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} onScrollY={onScrollY}>
                <StatusBanners />
                <PageConflictBanner
                    spaceId={spaceId}
                    pageId={pageId}
                    current={body.value}
                    onNotice={setNotice}
                    folder={view?.folder === true}
                />
                {view === null ? (
                    <Text variant="subheadline" tone="muted" testID="page-loading">
                        Loading page…
                    </Text>
                ) : (
                    <>
                        {view.coverId === null ? null : <Cover coverId={view.coverId} />}
                        <Crumbs pages={view.ancestors} onOpen={openPage} />
                        <View className="gap-1" onLayout={(event) => setTitleTop(event.nativeEvent.layout.y)}>
                            <Text
                                accessibilityRole="header"
                                variant="document-title"
                                testID="page-title"
                                onLayout={(event) => setTitleHeight(event.nativeEvent.layout.height)}
                            >
                                {view.title}
                            </Text>
                            {view.edited === null ? null : (
                                <Text variant="meta" testID="page-edited">
                                    {view.edited}
                                </Text>
                            )}
                        </View>
                        {view.folder ? (
                            <FolderContents
                                view={view}
                                onOpen={openPage}
                                onNewPage={() => manage.newPage(pageId)}
                                onNewFolder={() => manage.newFolder(pageId)}
                            />
                        ) : (
                            <>
                                <Body
                                    view={view}
                                    spaceId={spaceId}
                                    pageId={pageId}
                                    waiting={!body.settled}
                                    onLink={onLink}
                                />
                                <Children pages={view.children} onOpen={openPage} />
                            </>
                        )}
                    </>
                )}
            </Screen>
            {focused ? <PageToasts pageId={pageId} notice={notice} onHide={hideNotice} /> : null}
            {manage.element}
        </View>
    );
}

/**
 * Ask about this page (CB-499): the bar button's press and menu. With one socio in the Space it opens
 * the chat at once, with several it is a menu of them (the web's picker), with none or no assistant it
 * says what to set up, as the web's ChatSetup. The open is the web's (`POST …/conversation`, online
 * only), tied to the page and socio that asked (`PageChatRequests`): an answer after another pick,
 * or after the person left the page, opens nothing. A save of the page still waiting holds it, as the
 * web saves first.
 */
function useAskAboutPage(spaceId: string, pageId: string, unsaved: boolean) {
    const navigation = useNavigation();
    const { pageChats, workspace } = useWorkspaceScope();
    const collections = useCollections();
    const openLink = useOpenLink();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const rows = shellRows(shell);
    const entry = pageChatEntry({ dots, spaceId, workspace: rows.workspace, role: rows.workspace?.user?.role });
    const [requests] = useState(() => new PageChatRequests());
    const [busy, setBusy] = useState(false);
    // Leaving the page drops an answer still coming (the web's unmount `select('')`).
    useFocusEffect(
        useCallback(
            () => () => {
                requests.select('');
                setBusy(false);
            },
            [requests],
        ),
    );
    const say = (line: string) => Alert.alert(PAGE_CHAT_TITLE, line);
    const open = (dotId: string) => {
        if (unsaved) {
            say(PAGE_CHAT_UNSAVED);
            return;
        }
        const scope = pageChatScope(pageId, dotId);
        requests.select(scope);
        setBusy(true);
        void requests.run(scope, () => pageChats.open(spaceId, pageId, dotId), {
            success: (outcome) => {
                if (outcome.kind === 'done') {
                    navigation.dispatch(pageChatAction(outcome.chat.id));
                    return;
                }
                say(pageChatCopy(outcome) ?? PAGE_CHAT_FAILED);
            },
            failure: () => say(PAGE_CHAT_FAILED),
            settled: () => setBusy(false),
        });
    };
    const press = () => {
        if (entry.kind === 'setup') {
            const web = `${workspace.origin}/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(pageId)}`;
            Alert.alert(
                PAGE_CHAT_TITLE,
                entry.line,
                entry.web
                    ? [
                          { text: 'Cancel', style: 'cancel' },
                          { text: OPEN_IN_BROWSER, onPress: () => openLink(web) },
                      ]
                    : [{ text: 'OK' }],
            );
            return;
        }
        const only = entry.socios.length === 1 ? entry.socios[0] : undefined;
        if (only !== undefined) {
            open(only.id);
        }
    };
    const menu =
        entry.kind === 'socios' && entry.socios.length > 1
            ? {
                  title: PAGE_CHAT_TITLE,
                  actions: pageChatActions(entry.socios),
                  onAction: (name: string) => {
                      const dotId = socioOfAction(name);
                      if (dotId !== null) {
                          open(dotId);
                      }
                  },
              }
            : null;
    return { busy, press, menu };
}

/** The cover across the page, as the web's (h-50, rounded-xl), from the image cache. */
function Cover({ coverId }: { coverId: string }) {
    const picture = useEmbedPicture(coverId);
    return (
        <View
            className="h-50 w-full overflow-hidden rounded-xl bg-muted"
            testID="page-cover"
            accessibilityElementsHidden
        >
            {picture.state === 'ready' ? (
                <Image source={{ uri: picture.uri }} cachePolicy="memory" contentFit="cover" style={{ flex: 1 }} />
            ) : null}
        </View>
    );
}

/** The parents, root first, each a 44 pt link (the web's phone crumbs). */
function Crumbs({ pages, onOpen }: { pages: readonly PageRef[]; onOpen: (id: string) => void }) {
    if (pages.length === 0) {
        return null;
    }
    return (
        <View
            className="flex-row flex-wrap items-center gap-x-1"
            accessibilityLabel="Parent pages"
            testID="page-crumbs"
        >
            {pages.map((page) => (
                <View key={page.id} className="max-w-full flex-row items-center gap-1">
                    <Pressable
                        accessibilityRole="link"
                        onPress={() => onOpen(page.id)}
                        className="min-h-11 justify-center rounded px-1 active:bg-accent"
                        testID={`page-crumb-${page.id}`}
                    >
                        <Text variant="footnote" tone="muted" numberOfLines={1}>
                            {page.title}
                        </Text>
                    </Pressable>
                    <AppSymbol name="chevron-right" size={12} color="muted-foreground" />
                </View>
            ))}
        </View>
    );
}

function Body(props: {
    view: PageView;
    spaceId: string;
    pageId: string;
    /** The body's first read hasn't settled yet. */
    waiting: boolean;
    onLink: (url: string) => void;
}) {
    const { view, spaceId, pageId, waiting, onLink } = props;
    const content = view.content;
    const parts = useMemo(() => (content === null ? [] : pageParts(content)), [content]);
    if (content === null) {
        return (
            <View className="gap-2" testID="page-no-body">
                {view.excerpt === '' ? null : (
                    <Text variant="subheadline" tone="muted">
                        {view.excerpt}
                    </Text>
                )}
                <Text weight="medium">{waiting ? 'Loading page…' : OPEN_ONLINE}</Text>
            </View>
        );
    }
    return (
        <View className="gap-3" testID="page-body">
            {parts.map((part) => {
                if (part.kind === 'markdown') {
                    return <MarkdownBlock key={part.key} markdown={part.text} onLink={onLink} prose="page" />;
                }
                const block = part.value;
                switch (block.kind) {
                    case 'dataset-view':
                        return <DatasetViewBlock key={part.key} spaceId={spaceId} pageId={pageId} spec={block.spec} />;
                    case 'embed':
                        return <EmbedCardBlock key={part.key} card={block.card} onOpen={onLink} />;
                    case 'image':
                        return <PagePictureBlock key={part.key} picture={block.picture} />;
                    case 'table':
                        return <PageTableBlock key={part.key} table={block.table} onLink={onLink} />;
                }
            })}
        </View>
    );
}

/** The subpages (the web's "Child pages"), or what a folder holds ("In this folder"), each folder with its icon. */
function Children({
    pages,
    onOpen,
    title = 'Child pages',
    testID = 'page-children',
}: {
    pages: readonly PageRef[];
    onOpen: (id: string) => void;
    title?: string;
    testID?: string;
}) {
    if (pages.length === 0) {
        return null;
    }
    return (
        <Section title={title} testID={testID}>
            {pages.map((page, index) => (
                <ListRow
                    key={page.id}
                    first={index === 0}
                    testID={`page-child-${page.id}`}
                    leadingSize={20}
                    leading={
                        <AppSymbol name={page.folder === true ? 'folder' : 'file-text'} color="muted-foreground" />
                    }
                    title={page.title}
                    accessibilityLabel={page.folder === true ? `${page.title}, Folder` : page.title}
                    accessibilityHint={page.folder === true ? 'Opens the folder' : 'Opens the page'}
                    onPress={() => onOpen(page.id)}
                />
            ))}
        </Section>
    );
}

/**
 * A folder's contents (CB-426, the web's `FolderContents`) where a page has its body: the pages and
 * folders in it, or "This folder is empty." with New page and New folder, and a muted line when it
 * still keeps text from when it was a page. Never the text itself.
 */
function FolderContents(props: {
    view: PageView;
    onOpen: (id: string) => void;
    onNewPage: () => void;
    onNewFolder: () => void;
}) {
    const { view } = props;
    return (
        <View className="gap-3" testID="page-folder">
            {view.children.length === 0 ? (
                <View className="gap-3" testID="page-folder-empty">
                    <Text variant="subheadline" tone="muted">
                        {FOLDER_EMPTY}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                        <Button label="New page" icon="plus" onPress={props.onNewPage} testID="page-folder-new-page" />
                        <Button
                            label="New folder"
                            icon="folder-plus"
                            variant="ghost"
                            onPress={props.onNewFolder}
                            testID="page-folder-new-folder"
                        />
                    </View>
                </View>
            ) : (
                <Children
                    pages={view.children}
                    onOpen={props.onOpen}
                    title={IN_THIS_FOLDER}
                    testID="page-folder-children"
                />
            )}
            {view.keptText ? (
                <Text variant="footnote" tone="muted" testID="page-folder-kept-text">
                    {FOLDER_KEPT_TEXT}
                </Text>
            ) : null}
        </View>
    );
}
