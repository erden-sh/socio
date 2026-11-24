import { LegendList, type LegendListRef } from '@legendapp/list/react-native';
import { useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    Alert,
    Platform,
    Pressable,
    ScrollView,
    type ScrollViewInstance,
    StyleSheet,
    useWindowDimensions,
    View,
} from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { canTriage, NO_FILTERS, toggleDotRequests } from '@socio/shared/issues/issue-board';
import type { IssueStatus } from '@socio/shared/issues/issue-types';
import { MODULE_IDS } from '@socio/shared/modules';
import { foldText } from '@socio/shared/pages/page-search';

import { outboxStateStore } from '../chat/composer';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSyncOnFocus,
    useSyncRefresh,
    useViewState,
    useWorkspaceScope,
} from '../live';
import { useBarInset } from '../navigation/bar-inset';
import { barSearch } from '../navigation/bar-items';
import { useNativeBar } from '../navigation/native-bar';
import { issueAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import {
    BLOCKED_TONE,
    BOARD_FACETS,
    type BoardIssueRow,
    type BoardLayout,
    COLLAPSED_BY_DEFAULT,
    BOARD_PREFS_KEY,
    BOARD_VIEWS,
    COMPONENT_FACET_LABEL,
    type BoardColumn,
    type BoardPeek,
    type BoardPendingRow,
    type BoardPrefs,
    type BoardRow,
    boardPrefsText,
    type BoardSectionRow,
    type BoardView,
    boardView,
    DEMAND_TONE,
    ISSUE_SEARCH_LABEL,
    ISSUE_SEARCH_PLACEHOLDER,
    pendingAnnouncement,
    readBoardPrefs,
    STATUS_RING,
    toggleComponentFacet,
    toggleFacet,
} from '../shell/board';
import {
    allSelected,
    applyBatch,
    type BatchChoice,
    type BatchMenu,
    selectionTitle,
    toggleSelected,
} from '../shell/board-select';
import { ACTIVE_OFFSET, backSwipeDistance, FAIL_OFFSET, landingScroll, pageShift, peekTop } from '../shell/board-swipe';
import { PENDING_ACTION_LABELS } from '../shell/file-issue';
import { filingCandidates, nextIssueCandidate, type PendingIssueAction } from '../shell/issue-filing';
import { moduleEntry } from '../shell/modules';
import { issueComponentsQuery, issueUsersQuery, issuesQuery, shellQuery, shellRows } from '../shell/queries';
import { editIssue } from '../sync/issue-edit';
import { ISSUE_SEARCH_DELAY_MS, type KeptIssueMatches, searchIssues, shownIssueMatches } from '../sync/issue-search';
import { ISSUES } from '../sync/issues';
import { overlaysOf } from '../sync/outbox-overlay';
import { useScheme } from '../theme/scheme';
import { theme, type ToneName } from '../theme/theme';
import {
    Button,
    AppSymbol,
    keyboardScroll,
    SearchField,
    SegmentedControl,
    type SegmentedOption,
    Squircle,
    Text,
    usePullToRefresh,
} from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';
import { useAnnouncement } from '../ui/use-announcement';

import { BatchBar, batchSheet, SelectMark } from './board-select';
import { type BoardSwipe, boardSwipeCallbacks } from './board-swipe-gesture';
import { ComponentChips } from './issue-components';
import { MODULE_ICONS } from './module-icons';
import { type RouteSheetContent, useRouteSheet } from './route-sheet';
import { PageIntro, StatusBanners, useRememberScreen } from './shell-parts';

// The Board, a page over the
// tabs from Home's tile or Search, at the web's /issues. Its view model is
// src/shell/board.ts (shared's filters and order, this device's writes laid
// over). Its heading is the web's words in the system's bar (CB-420): "Issues"
// as the large title, the counts as the first line under it, and on iOS the
// bar's own search field. One column at a time: the status chips
// read as tabs, each with its status's hollow ring and its count, and one
// vertical LegendList shows the chosen column; a sideways swipe on the cards
// turns to the next or previous column as a page view does (CB-468,
// board-swipe.ts). Search is the bar's field on iOS and the app's own on Android (an icon, no label), with the
// server's matches once they answer; the filter sheet holds the five facets,
// "Socio requests", "Most votes" and won't fix, and the Component facet (CB-442)
// when a listed issue has a component; each card and row has the web's small
// component chips, named by the list's label map. The choices are kept per
// workspace (the scope's kv). The issues come from the phone's copy in the
// first frame (a kept Board reads them before it) and poll every 15 s
// while it shows. A row opens the issue's screen, its detail read from
// disk first, so it draws at once.
//
// The owner's call (2026-11-18) adds the web's three other pieces: the
// board/list toggle (the list is the web's IssueList: status sections, done
// and won't fix folded at first), kept with the other choices; Select for
// admins (the web shows it only to them), iOS Mail's and Files' way: Select
// in the header, a round check on each row, Select all and Done on top and
// the web's batch menus in a bar at the bottom (board-select.tsx); and the
// vote count on every row, "👍 0" included, as the web's cards show it.

const ISSUES_MODULE = moduleEntry(MODULE_IDS.issues);
/** A row grows with its lines, never under a 44 pt target. */
const MIN_ROW = { minHeight: 44 } as const;
/** The board polls the issues every 15 s while in view (the web's ISSUES_POLL_MS). */
const SYNCED = [ISSUES];

export function BoardScreen() {
    return useHasWorkspaceScope() ? <Board /> : <Unscoped />;
}

function Unscoped() {
    useNativeBar({ title: ISSUES_MODULE.title, tone: ISSUES_MODULE.tone });
    return <View testID="board-screen" className="flex-1 bg-screen" />;
}

/**
 * The server's matches for the search text, asked 250 ms after the last
 * keystroke, once per text and list. The answer is kept by its text only: a
 * changed list asks again and the new answer replaces it.
 */
function useIssueSearch(query: string, version: number): ReadonlySet<number> | undefined {
    const scope = useWorkspaceScope();
    const folded = foldText(query);
    const [answer, setAnswer] = useState<KeptIssueMatches | null>(null);
    useEffect(() => {
        if (folded === '') {
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            searchIssues(scope.fetch, query, controller.signal).then(
                (matches) => {
                    if (!controller.signal.aborted) {
                        setAnswer({ query: folded, matches });
                    }
                },
                // Offline or refused: the board keeps filtering what it holds.
                () => {},
            );
        }, ISSUE_SEARCH_DELAY_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [folded, version, query, scope]);
    return shownIssueMatches(answer, query);
}

function Board() {
    const navigation = useNavigation();
    const collections = useCollections();
    const viewState = useViewState();
    const { outbox, issueDetails } = useWorkspaceScope();
    useRememberScreen('Board');
    useSyncOnFocus(SYNCED);
    const refreshControl = usePullToRefresh(useSyncRefresh(SYNCED));
    const { data: issues } = useLiveQuery({ query: issuesQuery(collections) });
    const { data: users } = useLiveQuery({ query: issueUsersQuery(collections) });
    const { data: componentLabels } = useLiveQuery({ query: issueComponentsQuery(collections) });
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const [prefs, setPrefsState] = useState(() => readBoardPrefs(viewState.get(BOARD_PREFS_KEY)));
    const setPrefs = (next: BoardPrefs) => {
        setPrefsState(next);
        viewState.set(BOARD_PREFS_KEY, boardPrefsText(next));
    };
    const [query, setQuery] = useState('');
    const [filtering, setFiltering] = useState(false);
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const user = shellRows(shell).workspace?.user ?? null;
    // The web offers Select only to admins (its batch actions are theirs); the server decides.
    const admin = user !== null && canTriage(user);
    const [selection, setSelection] = useState<ReadonlySet<number> | null>(null);
    const [collapsed, setCollapsed] = useState<ReadonlySet<IssueStatus>>(() => new Set(COLLAPSED_BY_DEFAULT));
    const [menu, setMenu] = useState<BatchMenu | null>(null);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<string | null>(null);
    const version = issues.reduce((newest, issue) => Math.max(newest, issue.updatedAt), 0);
    const matches = useIssueSearch(query, version);
    const overlays = overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: BOARD_VIEWS, scope: outbox });
    const selecting = selection !== null && admin;
    const view = boardView({
        issues,
        users: users[0]?.value ?? {},
        components: componentLabels[0]?.value ?? null,
        overlays,
        candidates: filingCandidates(outbox.holds()),
        prefs,
        query,
        collapsed,
        ...(matches === undefined ? {} : { matches }),
        ...(selecting ? { selection } : {}),
    });
    const picked = selecting ? selection.size : 0;
    const exitSelect = () => {
        setSelection(null);
        setMenu(null);
        setResult(null);
    };
    const choose = (choice: BatchChoice) => {
        setMenu(null);
        if (!selecting) {
            return;
        }
        setBusy(true);
        applyBatch({
            choice,
            selection,
            issues,
            overlays,
            edit: (input) => editIssue(outbox, input),
            newId: randomId,
        })
            .then(setResult, (error: unknown) => console.warn('[board] the batch was not applied', error))
            .finally(() => setBusy(false));
    };
    useAnnouncement(result ?? undefined, { onAppear: true });
    useFirstFrameWithData('Board', issues.length > 0);
    // No view shows this line (the rows carry the marks), so Android is told it too.
    useAnnouncement(pendingAnnouncement(view.pendingCount), { onAppear: false, shown: false });
    const insets = useSafeAreaInsets();
    // The system's bar (CB-420): "Issues" as a large title in the module's tone, New issue and
    // Select at its end and iOS's search field under the title; while selecting, Mail's: the count
    // as the title, Done and Select all, no Back.
    useNativeBar(
        selecting
            ? {
                  title: selectionTitle(picked),
                  back: false,
                  right: [
                      { id: 'board-select-done', label: 'Done', prominent: true, onPress: exitSelect },
                      allSelected(selection, view.selectable)
                          ? { id: 'board-select-none', label: 'Deselect all', onPress: () => setSelection(new Set()) }
                          : {
                                id: 'board-select-all',
                                label: `Select all ${view.selectable.length}`,
                                disabled: view.selectable.length === 0,
                                onPress: () => setSelection(new Set(view.selectable)),
                            },
                  ],
              }
            : {
                  title: ISSUES_MODULE.title,
                  tone: ISSUES_MODULE.tone,
                  right: [
                      {
                          id: 'board-new-issue',
                          label: 'New issue',
                          symbol: 'plus',
                          icon: 'plus',
                          iconOnly: true,
                          onPress: () => navigation.navigate('FileIssue'),
                      },
                      ...(admin
                          ? [{ id: 'board-select', label: 'Select', onPress: () => setSelection(new Set()) }]
                          : []),
                  ],
                  search: { placeholder: ISSUE_SEARCH_PLACEHOLDER, onChange: setQuery },
              },
    );
    const open = (row: BoardRow) => {
        if (row.type === 'section') {
            setCollapsed(toggleSelectedStatus(collapsed, row.status));
            return;
        }
        if (row.type === 'issue' && selecting) {
            setSelection(toggleSelected(selection, row.number));
            return;
        }
        if (row.type !== 'issue') {
            // A filing not yet numbered: the issue's screen shows it under `CB-?`.
            navigation.dispatch(issueAction(row.key));
            return;
        }
        // Its detail from disk first, so the issue's screen draws it at once.
        issueDetails.preload(row.key).catch((error: unknown) => console.warn('[board] not read from disk', error));
        navigation.dispatch(issueAction(row.key));
    };
    const [viewing, setViewing] = useState<Readonly<Record<string, string>>>({});
    const act = (row: BoardPendingRow, action: PendingIssueAction) => {
        const failed = (what: string) => (error: unknown) => console.warn(`[board] ${what}`, error);
        switch (action) {
            case 'view': {
                // Each issue that may be it, in turn.
                const next = nextIssueCandidate(row.candidates, viewing[row.key] ?? null);
                if (next !== null) {
                    setViewing({ ...viewing, [row.key]: next });
                    issueDetails.preload(next).catch(failed('not read from disk'));
                    navigation.dispatch(issueAction(next));
                }
                return;
            }
            case 'send-again':
                outbox.sendNow(row.key).catch(failed('not sent again'));
                return;
            case 'edit':
                navigation.navigate('FileIssue', { edit: row.key });
                return;
            case 'copy':
                Clipboard.setStringAsync(row.text).catch(failed('not copied'));
                return;
            case 'discard':
                Alert.alert(
                    'Discard this?',
                    'It won’t be sent, and what you wrote is gone. Copy it first to keep it.',
                    [
                        { text: 'Cancel', style: 'cancel' },
                        {
                            text: 'Discard',
                            style: 'destructive',
                            onPress: () => void outbox.discardUnsent(row.key).catch(failed('not discarded')),
                        },
                    ],
                    { cancelable: true },
                );
                return;
        }
    };
    // The batch bar's choices and the Filters, each in a native sheet (CB-421).
    useRouteSheet(menu !== null && selecting ? batchSheet(menu, picked, choose) : null, () => setMenu(null));
    useRouteSheet(
        filtering ? filterSheet({ view, prefs, onPrefs: setPrefs, onClose: () => setFiltering(false) }) : null,
        () => setFiltering(false),
    );

    // The sideways swipe between columns (CB-468, board-swipe.ts): the cards follow the finger and
    // the neighbor's first cards come in beside them; a release lands on one column, chosen here.
    const width = useWindowDimensions().width;
    const barTop = useBarInset();
    const reduceMotion = useReducedMotion();
    const list = useRef<LegendListRef>(null);
    const columnIndex = Math.max(
        0,
        view.columns.findIndex((column) => column.status === view.column),
    );
    const swiping = view.layout === 'board' && view.columns.length > 1;
    const swipe: BoardSwipe = {
        position: useSharedValue(0),
        moving: useSharedValue(0),
        start: useSharedValue(0),
        current: useSharedValue(columnIndex),
        count: useSharedValue(view.columns.length),
        width: useSharedValue(width),
        offsetY: useSharedValue(0),
        rowsStart: useSharedValue(0),
    };
    const barTopShared = useSharedValue(barTop);
    const landing = useSharedValue<number | null>(null);
    useEffect(() => {
        barTopShared.set(barTop);
    }, [barTop, barTopShared]);
    useEffect(() => {
        swipe.count.set(view.columns.length);
        swipe.width.set(width);
    }, [view.columns.length, width, swipe.count, swipe.width]);
    useEffect(() => {
        swipe.current.set(columnIndex);
        // The chosen column is drawn where it rests: its neighbors go.
        swipe.moving.set(0);
    }, [columnIndex, swipe.current, swipe.moving]);
    const land = (index: number) => {
        const status = view.columns[index]?.status;
        if (status === undefined || status === view.column) {
            swipe.moving.set(0);
            return;
        }
        landing.set(landingScroll(swipe.rowsStart.get(), swipe.offsetY.get(), barTop));
        setPrefs({ ...prefs, column: status });
    };
    // The new column's first card where its peek drew it: just under the bar when scrolled past the heading.
    useLayoutEffect(() => {
        const offset = landing.get();
        if (offset !== null) {
            landing.set(null);
            list.current?.scrollToOffset({ offset, animated: false });
        }
    }, [view.column, landing]);
    // Worklets from board-swipe-gesture.ts, named one by one: the worklets plugin reads this object.
    const callbacks = boardSwipeCallbacks({ swipe, os: Platform.OS, reduceMotion, onLand: land });
    const pan = usePanGesture({
        enabled: swiping,
        activeOffsetX: [-ACTIVE_OFFSET, ACTIVE_OFFSET],
        failOffsetY: [-FAIL_OFFSET, FAIL_OFFSET],
        onBegin: callbacks.onBegin,
        onActivate: callbacks.onActivate,
        onUpdate: callbacks.onUpdate,
        onDeactivate: callbacks.onDeactivate,
    });
    // On the board, iOS's back swipe keeps to the left edge: a swipe right on the cards is the previous column.
    useEffect(() => {
        navigation.setOptions({ gestureResponseDistance: backSwipeDistance(swiping) });
    }, [navigation, swiping]);

    return (
        <View testID="board-screen" className="flex-1 bg-screen" collapsable={false}>
            <GestureDetector gesture={pan}>
                <LegendList
                    ref={list}
                    onScroll={(event) => swipe.offsetY.set(event.nativeEvent.contentOffset.y)}
                    scrollEventThrottle={16}
                    data={view.rows}
                    keyExtractor={(row) => row.key}
                    extraData={`${view.column}:${view.layout}`}
                    recycleItems={false}
                    estimatedItemSize={112}
                    {...keyboardScroll(Platform.OS)}
                    // Under iOS's bar, which lies over it: UIKit insets it by the bar and the home indicator,
                    // and the large title collapses as it scrolls (CB-420).
                    contentInsetAdjustmentBehavior="automatic"
                    refreshControl={refreshControl}
                    // LegendList lays its rows out itself: even padding here, and 12 pt under each row.
                    contentContainerStyle={{
                        paddingHorizontal: 16,
                        paddingTop: 16,
                        paddingBottom: 4 + (selecting || Platform.OS === 'ios' ? 0 : insets.bottom),
                    }}
                    ListHeaderComponent={
                        <BoardHead
                            onHeight={(height) => swipe.rowsStart.set(HEAD_TOP + height)}
                            view={view}
                            query={query}
                            onQuery={setQuery}
                            onFilter={() => setFiltering(true)}
                            onColumn={(column) => setPrefs({ ...prefs, column })}
                            onLayout={(layout) => setPrefs({ ...prefs, view: layout })}
                        />
                    }
                    ListEmptyComponent={
                        <SwipePage swipe={swipe} index={columnIndex}>
                            <Text variant="subheadline" tone="muted" className="py-8 text-center" testID="board-empty">
                                {view.empty}
                            </Text>
                        </SwipePage>
                    }
                    renderItem={({ item, index }) =>
                        view.layout === 'list' ? (
                            <ListItem row={item} last={index === view.rows.length - 1} onOpen={open} onAction={act} />
                        ) : (
                            <SwipePage swipe={swipe} index={columnIndex}>
                                <View className="pb-3">
                                    <BoardRowView row={item} onOpen={open} onAction={act} />
                                </View>
                            </SwipePage>
                        )
                    }
                    testID="board-list"
                />
            </GestureDetector>
            {swiping ? (
                <>
                    <ColumnPeek
                        peek={view.neighbors.before}
                        index={columnIndex - 1}
                        swipe={swipe}
                        barTop={barTopShared}
                        empty={view.empty}
                    />
                    <ColumnPeek
                        peek={view.neighbors.after}
                        index={columnIndex + 1}
                        swipe={swipe}
                        barTop={barTopShared}
                        empty={view.empty}
                    />
                </>
            ) : null}
            {selecting ? <BatchBar picked={picked} busy={busy} result={result} onMenu={setMenu} /> : null}
        </View>
    );
}

/** Where the list's heading starts in its content: its top padding. */
const HEAD_TOP = 16;

/** A card (or the empty line) of the chosen column, moved sideways with the swipe (CB-468). */
function SwipePage({ swipe, index, children }: { swipe: BoardSwipe; index: number; children: ReactNode }) {
    const style = useAnimatedStyle(() => ({
        transform: [
            {
                translateX: swipe.moving.get() === 0 ? 0 : pageShift(index, swipe.position.get(), swipe.width.get()),
            },
        ],
    }));
    return <Animated.View style={style}>{children}</Animated.View>;
}

/**
 * A neighbor column's first cards, beside the chosen one's while a swipe moves them (CB-468): drawn
 * over the page where the chosen column's first card is, or under the bar once scrolled past the
 * heading, so the swipe's landing finds them in place. Only a picture: it takes no touch and screen
 * readers skip it (the chips choose the column for them).
 */
function ColumnPeek({
    peek,
    index,
    swipe,
    barTop,
    empty,
}: {
    peek: BoardPeek | null;
    index: number;
    swipe: BoardSwipe;
    barTop: BoardSwipe['offsetY'];
    empty: string;
}) {
    const style = useAnimatedStyle(() => ({
        opacity: swipe.moving.get() === 0 ? 0 : 1,
        top: peekTop(swipe.rowsStart.get(), swipe.offsetY.get(), barTop.get()),
        transform: [{ translateX: pageShift(index, swipe.position.get(), swipe.width.get()) }],
    }));
    if (peek === null) {
        return null;
    }
    return (
        <Animated.View
            style={[styles.peek, style]}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID={`board-peek-${peek.status}`}
        >
            {peek.empty ? (
                <Text variant="subheadline" tone="muted" className="py-8 text-center">
                    {empty}
                </Text>
            ) : (
                peek.rows.map((row) => (
                    <View key={row.key} className="pb-3">
                        <BoardRowView row={row} onOpen={ignoreRow} onAction={ignoreRow} />
                    </View>
                ))
            )}
        </Animated.View>
    );
}

/** A peek's cards are a picture: their taps go nowhere. */
const ignoreRow = () => {};

const styles = StyleSheet.create({
    peek: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, overflow: 'hidden' },
});

/** What sits over the rows: the banners, the counts, search, the filter button and the column picker. */
function BoardHead(props: {
    onHeight: (height: number) => void;
    view: BoardView;
    query: string;
    onQuery: (text: string) => void;
    onFilter: () => void;
    onColumn: (column: BoardColumn['status']) => void;
    onLayout: (layout: BoardLayout) => void;
}) {
    const { view } = props;
    return (
        <View className="gap-3 pb-3" onLayout={(event) => props.onHeight(event.nativeEvent.layout.height)}>
            <StatusBanners />
            <PageIntro
                subtitle={view.subtitle}
                tile={{ tone: ISSUES_MODULE.tone, icon: MODULE_ICONS[ISSUES_MODULE.icon] }}
                testID="board-heading"
            />
            {barSearch(Platform.OS) ? null : (
                <SearchField
                    label={ISSUE_SEARCH_LABEL}
                    placeholder={ISSUE_SEARCH_PLACEHOLDER}
                    value={props.query}
                    onChangeText={props.onQuery}
                    testID="board-search"
                />
            )}
            <View className="flex-row items-center gap-3">
                <Button
                    variant={view.facetCount > 0 ? 'secondary' : 'ghost'}
                    icon="sliders-horizontal"
                    label={view.facetCount > 0 ? `Filters · ${view.facetCount}` : 'Filters'}
                    onPress={props.onFilter}
                    testID="board-filters"
                />
                <Text variant="footnote" tone="muted" className="ml-auto" testID="board-count-line">
                    {view.countLine}
                </Text>
                <LayoutToggle layout={view.layout} onLayout={props.onLayout} />
            </View>
            {view.layout === 'board' ? <ColumnPicker columns={view.columns} onColumn={props.onColumn} /> : null}
        </View>
    );
}

/** The status chips: tabs, each with its count in its label; the chosen one filled. */
function ColumnPicker({
    columns,
    onColumn,
}: {
    columns: readonly BoardColumn[];
    onColumn: (column: BoardColumn['status']) => void;
}) {
    const tones = theme[useScheme()].tones;
    const reduceMotion = useReducedMotion();
    // The chosen chip scrolls into view, centered when it can be (CB-468: a swipe chooses one off screen).
    const scroller = useRef<ScrollViewInstance>(null);
    const spots = useRef(new Map<IssueStatus, { x: number; width: number }>());
    const [viewport, setViewport] = useState(0);
    const chosen = columns.find((column) => column.selected)?.status;
    useEffect(() => {
        const spot = chosen === undefined ? undefined : spots.current.get(chosen);
        if (spot === undefined || viewport === 0) {
            return;
        }
        scroller.current?.scrollTo({
            x: Math.max(0, spot.x + spot.width / 2 - viewport / 2),
            animated: !reduceMotion,
        });
    }, [chosen, viewport, reduceMotion]);
    return (
        <ScrollView
            ref={scroller}
            onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-4 grow-0"
            contentContainerClassName="gap-2 px-4"
            accessibilityRole="tablist"
            testID="board-columns"
        >
            {columns.map((column) => (
                <Pressable
                    key={column.status}
                    onLayout={(event) => {
                        const { x, width } = event.nativeEvent.layout;
                        spots.current.set(column.status, { x, width });
                    }}
                    testID={column.testID}
                    accessibilityRole="tab"
                    accessibilityLabel={column.accessibilityLabel}
                    accessibilityState={{ selected: column.selected }}
                    onPress={() => onColumn(column.status)}
                    className={cx(
                        'min-h-11 flex-row items-center gap-2 rounded-full border px-4',
                        column.selected ? 'border-transparent bg-accent' : 'border-border active:bg-accent/50',
                    )}
                >
                    <View
                        className="rounded-full"
                        style={{
                            width: STATUS_RING.size,
                            height: STATUS_RING.size,
                            borderWidth: STATUS_RING.borderWidth,
                            borderColor: tones[column.tone].foreground,
                        }}
                    />
                    <Text variant="subheadline" weight="medium" tone={column.selected ? 'default' : 'muted'}>
                        {column.label}
                    </Text>
                    <Text variant="meta">{column.count}</Text>
                </Pressable>
            ))}
        </ScrollView>
    );
}

/** Words on a tone's tile: the priority pill, the demand and the blocked marks. */
function TonePill({ tone, children, icon }: { tone: ToneName; children: string; icon?: SymbolName }) {
    const { foreground, tiles } = theme[useScheme()].tones[tone];
    return (
        <View className="flex-row items-center gap-1 rounded-sm px-1.5" style={{ backgroundColor: tiles.card }}>
            {icon === undefined ? null : (
                <AppSymbol name={icon} size={12} weight="medium" color={{ value: foreground }} />
            )}
            <Text variant="footnote" weight="medium" style={{ color: foreground }}>
                {children}
            </Text>
        </View>
    );
}

function BoardRowView({
    row,
    onOpen,
    onAction,
}: {
    row: BoardRow;
    onOpen: (row: BoardRow) => void;
    onAction: (row: BoardPendingRow, action: PendingIssueAction) => void;
}) {
    if (row.type === 'pending') {
        return (
            <View className="rounded-xl border border-dashed border-border bg-card" style={MIN_ROW}>
                <Pressable
                    testID={row.testID}
                    accessibilityRole="button"
                    accessibilityLabel={row.accessibilityLabel}
                    accessibilityHint="Opens the issue"
                    onPress={() => onOpen(row)}
                    className="gap-1 rounded-xl p-3 active:bg-accent"
                >
                    <Text variant="footnote" tone="muted">
                        {row.label}
                    </Text>
                    <Text variant="row-title" numberOfLines={2}>
                        {row.title}
                    </Text>
                    <View className="flex-row items-center gap-1">
                        <AppSymbol name="clock" size={12} color="muted-foreground" />
                        <Text variant="footnote" tone={row.state === 'unsent' ? 'destructive' : 'muted'}>
                            {row.words}
                        </Text>
                    </View>
                </Pressable>
                {row.actions.length === 0 ? null : (
                    <View className="flex-row flex-wrap justify-end gap-2 px-3 pb-3">
                        {row.actions.map((action) => (
                            <Button
                                key={action}
                                variant={action === 'edit' || action === 'send-again' ? 'secondary' : 'ghost'}
                                label={PENDING_ACTION_LABELS[action]}
                                onPress={() => onAction(row, action)}
                                testID={`${row.testID}-${action}`}
                            />
                        ))}
                    </View>
                )}
            </View>
        );
    }
    if (row.type === 'section') {
        return null;
    }
    return (
        <Pressable
            testID={row.testID}
            {...rowRole(row)}
            onPress={() => onOpen(row)}
            className={cx(
                'gap-2 rounded-xl border bg-card p-3 active:bg-accent',
                row.selected === true ? 'border-primary bg-primary/5' : 'border-border',
            )}
            style={MIN_ROW}
        >
            <View className="min-h-6 flex-row items-center gap-2">
                {row.selected === null ? null : <SelectMark selected={row.selected} />}
                <Text variant="meta">{row.label}</Text>
                <TonePill tone={row.priorityTone}>{row.priorityLabel}</TonePill>
                <View className="ml-auto flex-row items-center gap-2">
                    <Votes row={row} />
                    <AssigneeMark row={row} />
                </View>
            </View>
            <Text variant="row-title" numberOfLines={3}>
                {row.title}
            </Text>
            <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                <Text variant="footnote" tone="muted">
                    {row.kindArea}
                </Text>
                {row.tags.map((tag) => (
                    <View key={tag} className="flex-row items-center gap-1 rounded-sm bg-muted px-1.5">
                        {tag === 'Socio request' ? <AppSymbol name="bot" size={12} color="muted-foreground" /> : null}
                        <Text variant="footnote" tone="muted">
                            {tag}
                        </Text>
                    </View>
                ))}
                <ComponentChips view={row.components} testID={`${row.testID}-component`} />
                {row.demand === null ? null : <TonePill tone={DEMAND_TONE}>{row.demand}</TonePill>}
                {row.blocked === null ? null : (
                    <TonePill tone={BLOCKED_TONE} icon="lock">
                        {row.blocked}
                    </TonePill>
                )}
            </View>
            {row.pending === null ? null : (
                <View className="flex-row items-center gap-1">
                    <AppSymbol name="clock" size={12} color="muted-foreground" />
                    <Text variant="footnote" tone="muted">
                        {row.pending}
                    </Text>
                </View>
            )}
        </Pressable>
    );
}

/** What a row is to a screen reader: a checkbox in Select, a button that opens the issue otherwise. */
function rowRole(row: BoardIssueRow) {
    return row.selected === null
        ? ({
              accessibilityRole: 'button',
              accessibilityLabel: row.accessibilityLabel,
              accessibilityHint: 'Opens the issue',
          } as const)
        : ({
              accessibilityRole: 'checkbox',
              accessibilityLabel: row.accessibilityLabel,
              accessibilityState: { checked: row.selected },
          } as const);
}

/** A list section folded or opened. */
function toggleSelectedStatus(collapsed: ReadonlySet<IssueStatus>, status: IssueStatus): ReadonlySet<IssueStatus> {
    const next = new Set(collapsed);
    if (!next.delete(status)) {
        next.add(status);
    }
    return next;
}

/** The vote count, always shown, "👍 0" too (the web's VoteButton on a card); the primary once the person voted. */
function Votes({ row }: { row: BoardIssueRow }) {
    return (
        <View className="flex-row items-center gap-1" testID={`${row.testID}-votes`}>
            <AppSymbol name="thumbs-up" size={14} color={row.voted ? 'primary' : 'muted-foreground'} />
            <Text variant="meta" tone={row.voted ? 'primary' : 'muted'}>
                {String(row.votes)}
            </Text>
        </View>
    );
}

/** The assignee's initials in a squircle. */
function AssigneeMark({ row }: { row: BoardIssueRow }) {
    const colors = theme[useScheme()].colors;
    return row.assignee === null ? null : (
        <Squircle size={24} color={colors.secondary}>
            <Text variant="footnote" weight="medium" tone="on-secondary">
                {row.assignee.initials}
            </Text>
        </Squircle>
    );
}

/** The web's view toggle, Board or List: the platform's segmented control. */
function LayoutToggle({ layout, onLayout }: { layout: BoardLayout; onLayout: (layout: BoardLayout) => void }) {
    return (
        <View style={{ minWidth: 132 }}>
            <SegmentedControl
                options={LAYOUT_OPTIONS}
                selected={layout}
                onSelect={onLayout}
                accessibilityLabel="View"
                testID="board-layout"
            />
        </View>
    );
}

const LAYOUT_OPTIONS = [
    { value: 'board', label: 'Board', accessibilityLabel: 'Board view', testID: 'board-layout-board' },
    { value: 'list', label: 'List', accessibilityLabel: 'List view', testID: 'board-layout-list' },
] as const satisfies readonly SegmentedOption<BoardLayout>[];

/** The web's priority edge on a list row (PRIORITY_BAR): the priority's tone; low is muted. */
function PriorityEdge({ row }: { row: BoardIssueRow }) {
    const { foreground } = theme[useScheme()].tones[row.priorityTone];
    return (
        <View
            className="w-1 self-stretch rounded-full"
            style={{ backgroundColor: foreground, opacity: row.priority === 'low' ? 0.3 : 1 }}
        />
    );
}

/**
 * One item of the list (the web's IssueList): all of them read as one card,
 * a section's header (chevron, ring, status, count) then its rows, each the
 * web's list row: the priority's edge, key and title, the excerpt, then the
 * labels, votes and assignee. A filing not yet numbered keeps its card.
 */
function ListItem({
    row,
    last,
    onOpen,
    onAction,
}: {
    row: BoardRow;
    last: boolean;
    onOpen: (row: BoardRow) => void;
    onAction: (row: BoardPendingRow, action: PendingIssueAction) => void;
}) {
    const edge = cx('border-x border-border bg-card', last && 'mb-3 rounded-b-xl border-b');
    if (row.type === 'section') {
        return <SectionHeader row={row} edge={edge} onOpen={onOpen} />;
    }
    if (row.type === 'pending') {
        return (
            <View className={cx(edge, 'border-t p-2')}>
                <BoardRowView row={row} onOpen={onOpen} onAction={onAction} />
            </View>
        );
    }
    return (
        <Pressable
            testID={row.testID}
            {...rowRole(row)}
            onPress={() => onOpen(row)}
            className={cx(
                edge,
                'flex-row gap-3 border-t px-3 py-3 active:bg-accent',
                row.selected === true && 'bg-primary/5',
            )}
            style={MIN_ROW}
        >
            <PriorityEdge row={row} />
            {row.selected === null ? null : <SelectMark selected={row.selected} />}
            <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row items-baseline gap-2">
                    <Text variant="meta">{row.label}</Text>
                    <Text variant="row-title" numberOfLines={1} className="min-w-0 flex-1">
                        {row.title}
                    </Text>
                </View>
                {row.excerpt === '' ? null : (
                    <Text variant="row-subtitle" numberOfLines={1}>
                        {row.excerpt}
                    </Text>
                )}
                <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                    <TonePill tone={row.priorityTone}>{row.priorityLabel}</TonePill>
                    {[...row.kindTags, ...row.tags].map((tag) => (
                        <View key={tag} className="rounded-sm bg-muted px-1.5">
                            <Text variant="footnote" tone="muted">
                                {tag}
                            </Text>
                        </View>
                    ))}
                    <ComponentChips view={row.components} testID={`${row.testID}-component`} />
                    {row.demand === null ? null : <TonePill tone={DEMAND_TONE}>{row.demand}</TonePill>}
                    {row.blocked === null ? null : (
                        <TonePill tone={BLOCKED_TONE} icon="lock">
                            {row.blocked}
                        </TonePill>
                    )}
                    <Votes row={row} />
                    <AssigneeMark row={row} />
                </View>
                {row.pending === null ? null : (
                    <View className="flex-row items-center gap-1">
                        <AppSymbol name="clock" size={12} color="muted-foreground" />
                        <Text variant="footnote" tone="muted">
                            {row.pending}
                        </Text>
                    </View>
                )}
            </View>
        </Pressable>
    );
}

/** A list section's header (the web's: chevron, the status's badge, count): folds or opens its rows. The first one rounds the card's top. */
function SectionHeader({ row, edge, onOpen }: { row: BoardSectionRow; edge: string; onOpen: (row: BoardRow) => void }) {
    return (
        <Pressable
            testID={row.testID}
            accessibilityRole="button"
            accessibilityLabel={row.accessibilityLabel}
            accessibilityState={{ expanded: row.open }}
            onPress={() => onOpen(row)}
            className={cx(edge, 'min-h-11 flex-row items-center gap-2 border-t px-3 active:bg-accent/50')}
            style={row.first ? FIRST_SECTION : undefined}
        >
            <View style={{ transform: [{ rotate: row.open ? '90deg' : '0deg' }] }}>
                <AppSymbol name="chevron-right" size={16} color="muted-foreground" />
            </View>
            <TonePill tone={row.tone}>{row.label}</TonePill>
            <Text variant="meta">{row.count}</Text>
        </Pressable>
    );
}

const FIRST_SECTION = { borderTopLeftRadius: 12, borderTopRightRadius: 12 } as const;

/** A choice in the filter sheet: a chip that toggles, its state said to screen readers. */
function Chip(props: { label: string; on: boolean; onPress: () => void; testID: string; count?: number }) {
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: props.on }}
            accessibilityLabel={props.count === undefined ? props.label : `${props.label}, ${props.count}`}
            onPress={props.onPress}
            className={cx(
                'min-h-11 flex-row items-center gap-2 rounded-full border px-4',
                props.on ? 'border-primary bg-primary/10' : 'border-border active:bg-accent/50',
            )}
        >
            <Text variant="subheadline" weight={props.on ? 'medium' : 'normal'} tone={props.on ? 'default' : 'muted'}>
                {props.label}
            </Text>
            {props.count === undefined ? null : (
                <Text variant="footnote" tone="muted">
                    {props.count}
                </Text>
            )}
        </Pressable>
    );
}

/**
 * The filter sheet (CB-421: a native sheet, medium then large): the lane, Most votes, won't fix,
 * then the five facets and the Component facet (CB-442, only while a listed issue has one); Clear
 * and Done in its title row.
 */
function filterSheet(props: {
    view: BoardView;
    prefs: BoardPrefs;
    onPrefs: (prefs: BoardPrefs) => void;
    onClose: () => void;
}): RouteSheetContent {
    const { view, prefs, onPrefs } = props;
    return {
        testID: 'board-filter-sheet',
        title: 'Filters',
        tall: true,
        actions: (
            <>
                {view.facetCount > 0 || prefs.byVotes ? (
                    <Button
                        variant="ghost"
                        label="Clear"
                        onPress={() => onPrefs({ ...prefs, filters: NO_FILTERS, byVotes: false, components: [] })}
                        testID="board-filter-clear"
                    />
                ) : null}
                <Button label="Done" onPress={props.onClose} testID="board-filter-done" />
            </>
        ),
        body: (
            <>
                <View className="flex-row flex-wrap gap-2">
                    <Chip
                        label="Socio requests"
                        count={view.dotRequests}
                        on={view.dotRequestsOnly}
                        onPress={() => onPrefs({ ...prefs, filters: toggleDotRequests(prefs.filters) })}
                        testID="board-filter-socio-requests"
                    />
                    <Chip
                        label="Most votes"
                        on={prefs.byVotes}
                        onPress={() => onPrefs({ ...prefs, byVotes: !prefs.byVotes })}
                        testID="board-filter-votes"
                    />
                    {view.wontFix.offered && view.wontFix.count > 0 ? (
                        <Chip
                            label="Show won’t fix"
                            count={view.wontFix.count}
                            on={prefs.wontFix}
                            onPress={() => onPrefs({ ...prefs, wontFix: !prefs.wontFix })}
                            testID="board-filter-wont-fix"
                        />
                    ) : null}
                </View>
                {BOARD_FACETS.map((facet) => (
                    <View key={facet.name} className="gap-2">
                        <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                            {facet.label}
                        </Text>
                        <View className="flex-row flex-wrap gap-2">
                            {facet.options.map((option) => (
                                <Chip
                                    key={option.value}
                                    label={option.label}
                                    on={(prefs.filters[facet.name] as readonly string[]).includes(option.value)}
                                    onPress={() =>
                                        onPrefs({
                                            ...prefs,
                                            filters: toggleFacet(prefs.filters, facet.name, option.value),
                                        })
                                    }
                                    testID={`board-filter-${facet.name}-${option.value}`}
                                />
                            ))}
                        </View>
                    </View>
                ))}
                {view.componentFacet.length === 0 ? null : (
                    <View className="gap-2" testID="board-filter-components">
                        <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                            {COMPONENT_FACET_LABEL}
                        </Text>
                        <View className="flex-row flex-wrap gap-2">
                            {view.componentFacet.map((option) => (
                                <Chip
                                    key={option.ref}
                                    label={option.label}
                                    on={option.selected}
                                    onPress={() =>
                                        onPrefs({
                                            ...prefs,
                                            components: toggleComponentFacet(prefs.components, option.ref),
                                        })
                                    }
                                    testID={option.testID}
                                />
                            ))}
                        </View>
                    </View>
                )}
            </>
        ),
    };
}
