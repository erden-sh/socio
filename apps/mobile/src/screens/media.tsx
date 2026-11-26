import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, useWindowDimensions, View } from 'react-native';

import type { MediaItem, MediaKind, MediaListing } from '@socio/shared/media-types';
import { MODULE_IDS } from '@socio/shared/modules';

import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useMediaListing,
    useViewState,
    useWorkspaceScope,
} from '../live';
import { barSearch } from '../navigation/bar-items';
import { useNativeBar } from '../navigation/native-bar';
import { mediaFileAction, mediaFolderAction } from '../navigation/tabs';
import { useMediaPicture } from '../platform/image-cache';
import {
    fileRow,
    folderLabel,
    folderParam,
    folderRows,
    kindLabel,
    LOAD_MORE,
    MEDIA_KINDS,
    MEDIA_LAYOUT_KEY,
    MEDIA_LAYOUTS,
    MEDIA_MORE_FAILED,
    MEDIA_TITLE,
    type MediaFileRow,
    type MediaFolderRow,
    mediaIntro,
    type MediaLayout,
    mediaLayout,
    mediaListState,
    searchLabel,
    TRY_AGAIN,
    usageView,
} from '../shell/media';
import { moduleEntry } from '../shell/modules';
import { sociosQuery } from '../shell/queries';
import { readMediaListing } from '../sync/media-library';
import { useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { AppSymbol, Button, Screen, SearchField, SegmentedControl, Squircle, Text, usePullToRefresh } from '../ui';
import { EmptyState } from '../ui/empty-state';

import { ActionMenu } from './action-menu';
import { MODULE_ICONS } from './module-icons';
import { ListRow, PageIntro, Section, StatusBanners, useRememberScreen } from './shell-parts';

// Media (CB-558), the `Media` route at the web's /media, from More and Search,
// in the module's sky: one folder of the person's own files as `/api/media`
// answers it, its subfolders first, then its files newest first, in the web's
// grid or list, with its kind filter, search (under the whole folder, online)
// and "Load more". A subfolder pushes the route again, so Back is the
// breadcrumb; the first line says where the folder is. A file opens its page
// (`MediaFile`). The folder's first page is kept for offline (the
// `media-listing` bounded kind); a search and later pages are read online.
// Upload, move, rename, delete, new folders and folder access stay the web's
// for now.

const MODULE = moduleEntry(MODULE_IDS.media);

/** The web's search waits this long after typing stops. */
const SEARCH_DELAY_MS = 250;
/** A grid cell is at least this wide (the web's 8.5rem cards). */
const GRID_MIN = 136;
const GRID_GAP = 12;
const PAGE_PADDING = 16;

export function MediaScreen({ route }: StaticScreenProps<{ folder?: string } | undefined>) {
    const folder = folderParam(route.params?.folder);
    return useHasWorkspaceScope() ? <Media folder={folder} /> : <Unscoped />;
}

function Unscoped() {
    useNativeBar({ title: MEDIA_TITLE, tone: MODULE.tone });
    return <View testID="media-screen" className="flex-1 bg-screen" collapsable={false}></View>;
}

/** What a search holds: the query and kind it answered, and its listing, or that it failed. */
interface Found {
    readonly key: string;
    readonly listing: MediaListing | null;
    readonly failed: boolean;
}

/** The pages loaded after the first, for the listing they follow. */
interface More {
    readonly key: string;
    readonly items: readonly MediaItem[];
    readonly cursor: string | null;
    readonly failed: boolean;
    readonly loading: boolean;
}

function useSocioName() {
    const collections = useCollections();
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    return (id: string) => dots.find((dot) => dot.id === id)?.name;
}

function Media({ folder }: { folder: string }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const viewState = useViewState();
    const socioName = useSocioName();
    const [kind, setKind] = useState<MediaKind | ''>('');
    const [layout, setLayout] = useState<MediaLayout>(() => mediaLayout(viewState.get(MEDIA_LAYOUT_KEY)));
    const [typed, setTyped] = useState('');
    const [query, setQuery] = useState('');
    const [found, setFound] = useState<Found | null>(null);
    const [searches, setSearches] = useState(0);
    const [more, setMore] = useState<More | null>(null);
    const held = useMediaListing(folder, kind);
    // Kept as the last screen whatever the folder: a relaunch opens Media at its root.
    useRememberScreen('Media');

    // The search follows typing, a moment after it stops (the web's 250 ms).
    useEffect(() => {
        const next = typed.trim();
        if (next === query) {
            return undefined;
        }
        const timer = setTimeout(() => setQuery(next), SEARCH_DELAY_MS);
        return () => clearTimeout(timer);
    }, [typed, query]);

    const searching = query !== '';
    const searchKey = `${kind}|${query}|${searches}`;
    useEffect(() => {
        if (query === '') {
            return undefined;
        }
        const controller = new AbortController();
        readMediaListing(scope.fetch, { folder, q: query, kind }, controller.signal)
            .then((listing) => {
                if (!controller.signal.aborted) {
                    setFound({ key: searchKey, listing, failed: false });
                }
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    console.warn('[media] the search did not answer', error);
                    setFound({ key: searchKey, listing: null, failed: true });
                }
            });
        return () => controller.abort();
    }, [scope, folder, query, kind, searchKey]);

    const answer = searching ? (found?.key === searchKey ? found : null) : null;
    const listing = searching ? (answer?.listing ?? null) : held.value;
    // The pages after the first belong to one answer: a new first page drops them.
    const listingKey = `${searching ? searchKey : `${kind}|${held.fetchedAt ?? ''}`}`;
    const extra = more?.key === listingKey ? more : null;
    const cursor = extra === null ? (listing?.nextCursor ?? null) : extra.cursor;
    const items = [...(listing?.items ?? []), ...(extra?.items ?? [])];
    const state = mediaListState({
        listing,
        settled: searching ? answer !== null : held.settled,
        failed: searching ? answer?.failed === true : held.failed,
        searching,
        kind,
        files: items.length,
    });

    const loadMore = () => {
        if (cursor === null || extra?.loading === true) {
            return;
        }
        const before = extra?.items ?? [];
        setMore({ key: listingKey, items: before, cursor, failed: false, loading: true });
        readMediaListing(scope.fetch, { folder, q: query, kind, cursor }, scope.signal)
            .then((next) =>
                setMore({
                    key: listingKey,
                    items: [...before, ...next.items],
                    cursor: next.nextCursor ?? null,
                    failed: false,
                    loading: false,
                }),
            )
            .catch((error: unknown) => {
                console.warn('[media] more files did not load', error);
                setMore({ key: listingKey, items: before, cursor, failed: true, loading: false });
            });
    };

    const reload = () => {
        if (searching) {
            setSearches((count) => count + 1);
            return Promise.resolve();
        }
        return held.refresh();
    };
    const refreshControl = usePullToRefresh(reload);
    const chooseLayout = (next: MediaLayout) => {
        setLayout(next);
        viewState.set(MEDIA_LAYOUT_KEY, next);
    };
    const openFolder = (path: string) => navigation.dispatch(mediaFolderAction(path));
    const openFile = (item: MediaItem) =>
        navigation.dispatch(
            mediaFileAction({
                item: item.id,
                name: item.name,
                mediaType: item.mediaType,
                size: item.size,
                updatedAt: item.updatedAt,
            }),
        );

    const label = searchLabel(folder);
    useNativeBar({
        title: folder === '' ? MEDIA_TITLE : folderLabel(folder, socioName),
        tone: MODULE.tone,
        search: { placeholder: label, onChange: setTyped },
    });
    const inBar = barSearch(Platform.OS);
    const folders = folderRows(searching ? [] : (listing?.folders ?? []), socioName);
    const files = items.map((item) => fileRow(item));
    const usage = held.value === null ? null : usageView(held.value);

    return (
        <View testID="media-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped refreshControl={refreshControl}>
                <StatusBanners />
                <PageIntro
                    subtitle={mediaIntro(folder, socioName)}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="media-heading"
                />
                {usage === null ? null : <UsageBar share={usage.share} line={usage.line} />}
                {inBar ? null : (
                    <SearchField label={label} value={typed} onChangeText={setTyped} testID="media-search" />
                )}
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                    {/* Five choices are a menu, not a segmented control: a pull-down with the one shown checked. */}
                    <ActionMenu
                        request={{
                            title: 'Kind',
                            actions: MEDIA_KINDS.map((entry) => ({
                                name: entry.value || 'all',
                                label: entry.label,
                                checked: kind === entry.value,
                            })),
                            onAction: (name) => setKind((name === 'all' ? '' : name) as MediaKind | ''),
                        }}
                        trigger="press"
                        label={`Kind, ${kindLabel(kind)}`}
                        testID="media-kind"
                    >
                        <View className="min-h-11 flex-row items-center gap-2 rounded-full bg-secondary px-4">
                            <Text weight="medium">{kindLabel(kind)}</Text>
                            <AppSymbol name="chevron-down" size={16} color="muted-foreground" />
                        </View>
                    </ActionMenu>
                    <View className="w-40">
                        <SegmentedControl
                            options={MEDIA_LAYOUTS}
                            selected={layout}
                            onSelect={chooseLayout}
                            accessibilityLabel="View"
                            testID="media-layout"
                        />
                    </View>
                </View>
                {state.state === 'loading' ? (
                    <View className="items-center py-10" testID="media-loading">
                        <ActivityIndicator accessibilityLabel="Loading your files" />
                    </View>
                ) : state.state === 'failed' ? (
                    <View className="items-center gap-3 py-10" testID="media-failed">
                        <Text variant="subheadline" tone="muted" className="text-center">
                            {state.line}
                        </Text>
                        <Button
                            label={TRY_AGAIN}
                            variant="secondary"
                            onPress={() => void reload()}
                            testID="media-retry"
                        />
                    </View>
                ) : state.state === 'empty' ? (
                    <EmptyState
                        tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                        headline={state.line}
                        testID="media-empty"
                    />
                ) : layout === 'grid' ? (
                    <MediaGrid folders={folders} files={files} onOpenFolder={openFolder} onOpenFile={openFile} />
                ) : (
                    <MediaList folders={folders} files={files} onOpenFolder={openFolder} onOpenFile={openFile} />
                )}
                {state.state === 'rows' && extra?.failed === true ? (
                    <Text variant="footnote" tone="destructive" className="text-center" testID="media-more-failed">
                        {MEDIA_MORE_FAILED}
                    </Text>
                ) : null}
                {state.state === 'rows' && cursor !== null ? (
                    <View className="items-center">
                        <Button
                            label={LOAD_MORE}
                            variant="secondary"
                            busy={extra?.loading === true}
                            onPress={loadMore}
                            testID="media-load-more"
                        />
                    </View>
                ) : null}
            </Screen>
        </View>
    );
}

/** The web's usage bar: how much of the person's space is used, the words under it. */
function UsageBar({ share, line }: { share: number; line: string }) {
    return (
        <View className="gap-1" testID="media-usage" accessible accessibilityLabel={line}>
            <View className="h-2 overflow-hidden rounded-full bg-border">
                <View className="h-2 rounded-full bg-primary" style={{ width: `${share}%` }} />
            </View>
            <Text variant="footnote" tone="muted">
                {line}
            </Text>
        </View>
    );
}

interface RowsProps {
    readonly folders: readonly MediaFolderRow[];
    readonly files: readonly MediaFileRow[];
    readonly onOpenFolder: (path: string) => void;
    readonly onOpenFile: (item: MediaItem) => void;
}

/** A file's picture from the image cache, or its type's icon while it loads, fails or isn't a picture. */
function Thumbnail({ file, size }: { file: MediaFileRow; size: number }) {
    return file.picture ? (
        <Picture file={file} size={size} />
    ) : (
        <AppSymbol name={file.symbol} size={Math.min(40, size / 2)} color="muted-foreground" />
    );
}

function Picture({ file, size }: { file: MediaFileRow; size: number }) {
    const picture = useMediaPicture(file.id, file.updatedAt);
    return picture.state === 'ready' ? (
        <Image
            source={{ uri: picture.uri }}
            cachePolicy="memory"
            contentFit="cover"
            style={{ width: size, height: size }}
            accessible={false}
        />
    ) : (
        <AppSymbol
            name={picture.state === 'loading' ? 'image' : 'image-off'}
            size={Math.min(40, size / 2)}
            color="muted-foreground"
        />
    );
}

/** Subfolders, then files, as the web's cards: a square picture or icon, the name and the size. */
function MediaGrid({ folders, files, onOpenFolder, onOpenFile }: RowsProps) {
    const { width } = useWindowDimensions();
    const inner = width - PAGE_PADDING * 2;
    const columns = Math.max(2, Math.floor((inner + GRID_GAP) / (GRID_MIN + GRID_GAP)));
    const cell = Math.floor((inner - GRID_GAP * (columns - 1)) / columns);
    const tones = theme[useScheme()].tones[MODULE.tone];
    return (
        <View className="flex-row flex-wrap" style={{ gap: GRID_GAP }} testID="media-grid">
            {folders.map((folder) => (
                <Pressable
                    key={folder.path}
                    testID={folder.testID}
                    accessibilityRole="button"
                    accessibilityLabel={`${folder.label}, folder`}
                    onPress={() => onOpenFolder(folder.path)}
                    className="min-h-11 flex-row items-center gap-2 rounded-xl bg-card p-3 active:opacity-70"
                    style={{ width: cell }}
                >
                    <AppSymbol name="folder" size={20} color={{ value: tones.foreground }} />
                    <Text weight="medium" numberOfLines={1} className="min-w-0 flex-1">
                        {folder.label}
                    </Text>
                </Pressable>
            ))}
            {files.map((file) => (
                <Pressable
                    key={file.id}
                    testID={file.testID}
                    accessibilityRole="button"
                    accessibilityLabel={file.accessibilityLabel}
                    onPress={() => onOpenFile(file.item)}
                    className="overflow-hidden rounded-xl bg-card active:opacity-70"
                    style={{ width: cell }}
                >
                    {/* On the card's own surface: the page behind is the muted gray in Light. */}
                    <View
                        className="items-center justify-center overflow-hidden border-b border-border"
                        style={{ width: cell, height: cell }}
                    >
                        <Thumbnail file={file} size={cell} />
                    </View>
                    <View className="gap-0.5 p-2">
                        <Text variant="subheadline" weight="medium" numberOfLines={1}>
                            {file.name}
                        </Text>
                        <Text variant="footnote" tone="muted" numberOfLines={1}>
                            {file.size}
                        </Text>
                    </View>
                </Pressable>
            ))}
        </View>
    );
}

/** A row's leading tile, 44 pt: a file's picture or icon. */
const ROW_TILE = 44;

/** Subfolders, then files, as rows: the web's table, its columns folded into each row's lines. */
function MediaList({ folders, files, onOpenFolder, onOpenFile }: RowsProps) {
    const colors = theme[useScheme()];
    const tones = colors.tones[MODULE.tone];
    return (
        <View className="gap-4" testID="media-list">
            {folders.length === 0 ? null : (
                <Section title="Folders" testID="media-folders">
                    {folders.map((folder, index) => (
                        <ListRow
                            key={folder.path}
                            first={index === 0}
                            testID={folder.testID}
                            leadingSize={ROW_TILE}
                            leading={
                                <Squircle size={ROW_TILE} color={tones.tint}>
                                    <AppSymbol name="folder" size={22} color={{ value: tones.foreground }} />
                                </Squircle>
                            }
                            title={folder.label}
                            trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
                            accessibilityLabel={`${folder.label}, folder`}
                            onPress={() => onOpenFolder(folder.path)}
                        />
                    ))}
                </Section>
            )}
            {files.length === 0 ? null : (
                <Section title="Files" testID="media-files">
                    {files.map((file, index) => (
                        <ListRow
                            key={file.id}
                            first={index === 0}
                            testID={file.testID}
                            leadingSize={ROW_TILE}
                            leading={
                                <View
                                    className="items-center justify-center overflow-hidden rounded-lg bg-muted"
                                    style={{ width: ROW_TILE, height: ROW_TILE }}
                                >
                                    <Thumbnail file={file} size={ROW_TILE} />
                                </View>
                            }
                            title={file.name}
                            subtitle={file.line}
                            meta={
                                file.note === null ? undefined : (
                                    <Text variant="meta" numberOfLines={1}>
                                        {file.note}
                                    </Text>
                                )
                            }
                            trailing={<AppSymbol name="chevron-right" color="muted-foreground" />}
                            accessibilityLabel={file.accessibilityLabel}
                            onPress={() => onOpenFile(file.item)}
                        />
                    ))}
                </Section>
            )}
        </View>
    );
}
