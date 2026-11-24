import { type StaticScreenProps, useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
    AccessibilityInfo,
    Alert,
    Platform,
    Pressable,
    ScrollView,
    Switch,
    type TextInputInstance,
    View,
} from 'react-native';

import type { EpisodesState, ProfileField, ProfileFields, UserProfile } from '@socio/shared/memory';
import { MEMORY_TEXT_MAX } from '@socio/shared/memory';
import { MODULE_IDS } from '@socio/shared/modules';

import { outboxStateStore } from '../chat/composer';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useSyncOnFocus,
    useSyncRefresh,
    useSyncStatus,
    useUnsent,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import { network } from '../platform/network';
import {
    CONFIRMS,
    deleteAllConfirm,
    EMPTY_LINE,
    EMPTY_TITLE,
    EPISODES_FAILED,
    EPISODES_OFFLINE,
    type EpisodeRow,
    episodesView,
    MEMORIES_INTRO,
    MEMORY_NOTE,
    memoryChange,
    type MemoryNames,
    type MemoryProblem,
    type MemoryRow,
    memoriesView,
    type MemoriesView,
    type ProblemAction,
    PROFILE_EMPTY,
    PROFILE_FORM,
    PROFILE_NOTE,
    profileChange,
    TEAM_NOTE,
    timeZoneHint,
    type MemoriesParams,
} from '../shell/memories';
import { moduleEntry } from '../shell/modules';
import { chatsQuery, memoriesQuery, memoryProfileQuery, shellQuery, shellRows, sociosQuery } from '../shell/queries';
import { NEW_MEMORY_DRAFT } from '../sync/chat-drafts';
import { MEMORIES_KIND } from '../sync/kinds';
import {
    deleteAllEpisodes,
    deleteEpisode,
    EPISODE_QUERY_MAX,
    EPISODE_SEARCH_DELAY_MS,
    type EpisodeContext,
    type EpisodeDeleteResult,
    episodeDeleteCopy,
    readEpisodes,
} from '../sync/memory-episodes';
import {
    approveMemory,
    clearProfile,
    confirmMemory,
    deleteMemory,
    editMemory,
    keepMine,
    keepTheirs,
    markTimeZoneNoteSeen,
    MEMORY_WRITE_VIEWS,
    memoryAddWrite,
    MemoryWriteError,
    newestMemory,
    newLocalMemoryId,
    saveProfile,
    type ShownMemory,
} from '../sync/memory-writes';
import { overlaysOf } from '../sync/outbox-overlay';
import { useScheme } from '../theme/scheme';
import { colorsOf } from '../theme/theme';
import { Banner, Button, Field, AppSymbol, keyboardScroll, Text, usePullToRefresh } from '../ui';

import { useDraft } from './chat-composer';
import { MODULE_ICONS } from './module-icons';
import { useRouteSheet } from './route-sheet';
import { PageIntro, StatusBanners, useOpenChat, useRememberScreen } from './shell-parts';

// Memories, the `Memories` route at
// the web's /memories, pushed from More, Home's tile and Search, in the
// module's violet. Its view model is src/shell/memories.ts: the `memories`
// kind with this device's memory and profile writes laid over. What waits for the person comes first
// (Remember and Not now), then their profile, then the memories in use (Still
// true, Edit, Forget after a native confirm), then the episodes, read and
// deleted online only. Every write but an episode's goes through the outbox,
// so it works offline; what the server refused shows in place, with Keep
// mine and Keep theirs for a conflict. Add keeps its text in the
// `memory:new` draft. The list polls every 15 s while shown (the web's).

const MODULE = moduleEntry(MODULE_IDS.memories);

/** `add`: open with the Add sheet up (Search's Add memory, `addMemoryAction`). */
export function MemoriesScreen({ route }: StaticScreenProps<MemoriesParams | undefined>) {
    return useHasWorkspaceScope() ? <Memories add={route.params?.add === true} /> : <Unscoped />;
}

function Unscoped() {
    useNativeBar({ title: MODULE.title, tone: MODULE.tone });
    return <View testID="memories-screen" className="flex-1 bg-screen" />;
}

const failed = (what: string) => (error: unknown) => console.warn(`[memories] ${what}`, error);

type Editing = { kind: 'add' } | { kind: 'memory'; row: MemoryRow } | { kind: 'profile' };

function Memories({ add }: { add: boolean }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const { outbox } = scope;
    const collections = useCollections();
    useRememberScreen('Memories');
    useSyncOnFocus(MEMORIES_KIND.collections);
    const refreshControl = usePullToRefresh(useSyncRefresh(MEMORIES_KIND.collections));
    const { data: rows } = useLiveQuery({ query: memoriesQuery(collections) });
    const { data: profileRows } = useLiveQuery({ query: memoryProfileQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const { data: dots } = useLiveQuery({ query: sociosQuery(collections) });
    const { data: chats } = useLiveQuery({ query: chatsQuery(collections) });
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const unsent = useUnsent();
    const state = shellRows(shell).state;
    const names: MemoryNames = {
        dotName: (id) => dots.find((dot) => dot.id === id)?.name ?? null,
        chatTitle: (id) => chats.find((chat) => chat.id === id)?.title ?? null,
    };
    const view = memoriesView({
        rows,
        profileRow: profileRows[0] ?? null,
        overlays: overlaysOf({ rows: writes.rows, unsent: writes.unsent, kinds: MEMORY_WRITE_VIEWS, scope: outbox }),
        unsent: unsent.writes,
        groups: unsent.groups,
        names,
        memoryAllowed: state?.settings.memoryAllowed ?? null,
    });
    useFirstFrameWithData('Memories', view.loaded);
    const [editing, setEditing] = useState<Editing | null>(null);
    // Search's Add memory: the sheet opens once, and the param goes so Back to this screen doesn't open it again.
    useEffect(() => {
        if (add) {
            setEditing({ kind: 'add' });
            navigation.setParams({ add: undefined } as never);
        }
    }, [add, navigation]);
    const moved = useMovedNote(profileRows[0]?.timeZoneMoved ?? null, view.moved);
    // The system's bar (CB-420): the large title in the module's tone, Add memory at its end.
    useNativeBar({
        title: MODULE.title,
        tone: MODULE.tone,
        right: [
            {
                id: 'memories-add',
                label: 'Add memory',
                symbol: 'plus',
                icon: 'plus',
                iconOnly: true,
                onPress: () => setEditing({ kind: 'add' }),
            },
        ],
    });
    // Add, Edit and the profile in a native sheet (CB-421), medium then large: the keyboard takes it up.
    const close = () => setEditing(null);
    useRouteSheet(
        editing === null
            ? null
            : {
                  testID: 'memories-sheet',
                  tall: true,
                  body:
                      editing.kind === 'add' ? (
                          <AddSheet rows={rows} onClose={close} />
                      ) : editing.kind === 'memory' ? (
                          <EditSheet key={editing.row.memory.id} row={editing.row} onClose={close} />
                      ) : (
                          <ProfileSheet shown={view.profile.shown} stored={view.profile.stored} onClose={close} />
                      ),
              },
        close,
    );
    return (
        <View testID="memories-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                refreshControl={refreshControl}
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-6 p-4"
                {...keyboardScroll(Platform.OS)}
                testID="memories-scroll"
            >
                <StatusBanners />
                <PageIntro
                    subtitle={MEMORIES_INTRO}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="memories-heading"
                />
                {view.off === null ? null : (
                    <Banner tone="info" testID="memories-off">
                        {view.off}
                    </Banner>
                )}
                <Problems problems={view.problems} />
                <Proposals view={view} names={names} onEdit={(row) => setEditing({ kind: 'memory', row })} />
                <Profile view={view} moved={moved} onEdit={() => setEditing({ kind: 'profile' })} />
                <Remembered view={view} names={names} onEdit={(row) => setEditing({ kind: 'memory', row })} />
                {view.empty ? (
                    <View className="items-center gap-2 py-4" testID="memories-empty">
                        <Text variant="headline" className="text-center">
                            {EMPTY_TITLE}
                        </Text>
                        <Text tone="muted" variant="footnote" className="text-center">
                            {EMPTY_LINE}
                        </Text>
                    </View>
                ) : null}
                {view.loaded ? null : (
                    <Text variant="subheadline" tone="muted" testID="memories-loading">
                        Loading memories…
                    </Text>
                )}
                <Episodes names={names} />
            </ScrollView>
        </View>
    );
}

/**
 * The moved time zone's note (CB-176): shown for as long as the screen is,
 * once the server names a zone, and marked seen through the outbox, so
 * the next read no longer names it.
 */
function useMovedNote(zone: string | null, text: string | null): string | null {
    const { outbox } = useWorkspaceScope();
    const [note, setNote] = useState<string | null>(null);
    useEffect(() => {
        if (zone === null || text === null) {
            return;
        }
        setNote(text);
        markTimeZoneNoteSeen(outbox, { zone, newId: randomId }).catch(failed('the note was not marked seen'));
    }, [outbox, zone, text]);
    return note;
}

function SectionTitle({ children }: { children: string }) {
    return (
        <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
            {children}
        </Text>
    );
}

function Pending({ words }: { words: string | null }) {
    return words === null ? null : (
        <View className="flex-row items-center gap-1">
            <AppSymbol name="clock" size={12} color="muted-foreground" />
            <Text variant="footnote" tone="muted">
                {words}
            </Text>
        </View>
    );
}

/** Where a memory came from; the chat's name opens the chat. */
function Origin({ row }: { row: MemoryRow }) {
    const openChat = useOpenChat();
    const { threadId } = row;
    return threadId === null ? (
        <Text variant="footnote" tone="muted">
            {row.origin}
        </Text>
    ) : (
        <Pressable
            accessibilityRole="link"
            accessibilityHint="Opens the chat"
            onPress={() => openChat({ id: threadId, room: false })}
            className="min-h-6 justify-center"
        >
            <Text variant="footnote" tone="muted" className="underline">
                {row.origin}
            </Text>
        </Pressable>
    );
}

function Proposals(props: { view: MemoriesView; names: MemoryNames; onEdit: (row: MemoryRow) => void }) {
    const { outbox } = useWorkspaceScope();
    if (props.view.proposals.length === 0) {
        return null;
    }
    return (
        <View className="gap-2" testID="memory-proposals">
            <SectionTitle>Waiting for you</SectionTitle>
            {props.view.proposals.map((row) => (
                <View key={row.id} className="gap-3 rounded-xl border border-dashed border-border bg-card p-4">
                    <View accessible accessibilityLabel={row.accessibilityLabel} className="gap-2" testID={row.testID}>
                        <AppSymbol name="sparkles" size={18} color="muted-foreground" />
                        <Text>{row.text}</Text>
                        <Text variant="footnote" tone="muted">
                            {row.when}
                        </Text>
                    </View>
                    <Origin row={row} />
                    <Pending words={row.pending} />
                    <View className="flex-row flex-wrap items-center gap-2">
                        <Button
                            icon="check"
                            label="Remember"
                            accessibilityHint="Your socios start using it"
                            onPress={() =>
                                approveMemory(outbox, { memoryId: row.id, newId: randomId }).catch(
                                    failed('not approved'),
                                )
                            }
                            testID={`${row.testID}-approve`}
                        />
                        <Button
                            variant="secondary"
                            label="Edit"
                            onPress={() => props.onEdit(row)}
                            testID={`${row.testID}-edit`}
                        />
                        <Button
                            variant="ghost"
                            label="Not now"
                            accessibilityHint="Turns it down: your socios won’t use it"
                            onPress={() =>
                                deleteMemory(outbox, { memoryId: row.id, newId: randomId }).catch(
                                    failed('not turned down'),
                                )
                            }
                            testID={`${row.testID}-not-now`}
                        />
                    </View>
                </View>
            ))}
        </View>
    );
}

function Profile(props: { view: MemoriesView; moved: string | null; onEdit: () => void }) {
    const { outbox } = useWorkspaceScope();
    const { profile } = props.view;
    const clear = () =>
        Alert.alert(CONFIRMS.clearProfile.title, CONFIRMS.clearProfile.message, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: CONFIRMS.clearProfile.action,
                style: 'destructive',
                onPress: () => void clearProfile(outbox, { newId: randomId }).catch(failed('not cleared')),
            },
        ]);
    return (
        <View className="gap-2" testID="memory-profile">
            <SectionTitle>About you</SectionTitle>
            <View className="gap-3 rounded-xl border border-border bg-card p-4">
                <AppSymbol name="user-round" size={18} color="muted-foreground" />
                {props.moved === null ? null : (
                    <Text variant="footnote" tone="muted" accessibilityLiveRegion="polite" testID="time-zone-moved">
                        {props.moved}
                    </Text>
                )}
                {profile.rows.length === 0 ? (
                    profile.empty ? (
                        <Text variant="subheadline" tone="muted">
                            {PROFILE_EMPTY}
                        </Text>
                    ) : null
                ) : (
                    profile.rows.map((field) => (
                        <View key={field.label} accessible className="gap-0.5">
                            <Text variant="footnote" tone="muted">
                                {field.label}
                            </Text>
                            <Text>
                                {field.value}
                                {field.detected ? (
                                    <Text variant="subheadline" tone="muted">
                                        {' · detected from your browser'}
                                    </Text>
                                ) : null}
                            </Text>
                        </View>
                    ))
                )}
                {profile.line === null ? null : (
                    <Text variant="footnote" tone="muted" testID="memory-profile-line">
                        {profile.line}
                    </Text>
                )}
                <Pending words={profile.pending} />
                {/* Nothing to add or clear before /api/memories says what there is. */}
                {profile.editable ? (
                    <View className="flex-row flex-wrap items-center justify-end gap-2">
                        {profile.shown === null ? null : (
                            <Button
                                variant="ghost"
                                iconOnly
                                icon="trash-2"
                                label="Clear profile"
                                onPress={clear}
                                testID="memory-profile-clear"
                            />
                        )}
                        <Button
                            variant="secondary"
                            label={profile.shown === null ? 'Add profile' : 'Edit profile'}
                            onPress={props.onEdit}
                            testID="memory-profile-edit"
                        />
                    </View>
                ) : null}
            </View>
        </View>
    );
}

function Remembered(props: { view: MemoriesView; names: MemoryNames; onEdit: (row: MemoryRow) => void }) {
    const { outbox } = useWorkspaceScope();
    if (props.view.memories.length === 0) {
        return null;
    }
    const forget = (row: MemoryRow) =>
        Alert.alert(CONFIRMS.forget.title, CONFIRMS.forget.message, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: CONFIRMS.forget.action,
                style: 'destructive',
                onPress: () =>
                    void deleteMemory(outbox, { memoryId: row.id, newId: randomId }).catch(failed('not forgotten')),
            },
        ]);
    return (
        <View className="gap-2" testID="memory-list">
            <SectionTitle>Remembered</SectionTitle>
            {props.view.memories.map((row) => (
                <View key={row.id} className="gap-3 rounded-xl border border-border bg-card p-4">
                    <View accessible accessibilityLabel={row.accessibilityLabel} className="gap-2" testID={row.testID}>
                        <View className="flex-row items-center justify-between gap-2">
                            <AppSymbol name="book-open" size={18} color="muted-foreground" />
                            {row.shareable ? (
                                <View className="rounded-sm bg-secondary px-1.5">
                                    <Text variant="footnote" tone="on-secondary">
                                        Team chats too
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                        <Text>{row.text}</Text>
                    </View>
                    <Origin row={row} />
                    <Pending words={row.pending} />
                    {/* The icon buttons' 44 pt targets reach into the card's padding, so it looks even. */}
                    <View className="-mr-3 -mb-3 flex-row items-center gap-1">
                        <Text variant="footnote" tone="muted" className="mr-auto">
                            {row.when}
                        </Text>
                        <Button
                            variant="ghost"
                            iconOnly
                            icon="check"
                            label="Still true"
                            accessibilityHint="Confirms the memory still holds"
                            onPress={() =>
                                confirmMemory(outbox, { memoryId: row.id, newId: randomId }).catch(
                                    failed('not confirmed'),
                                )
                            }
                            testID={`${row.testID}-confirm`}
                        />
                        <Button
                            variant="ghost"
                            iconOnly
                            icon="pencil"
                            label="Edit memory"
                            onPress={() => props.onEdit(row)}
                            testID={`${row.testID}-edit`}
                        />
                        <Button
                            variant="ghost"
                            iconOnly
                            icon="trash-2"
                            label="Forget memory"
                            onPress={() => forget(row)}
                            testID={`${row.testID}-forget`}
                        />
                    </View>
                </View>
            ))}
        </View>
    );
}

const PROBLEM_LABELS: Readonly<Record<ProblemAction, string>> = {
    'keep-mine': 'Keep mine',
    'keep-theirs': 'Keep theirs',
    retry: 'Retry',
    copy: 'Copy',
    discard: 'Discard',
};

/** What the server refused on Memories or the profile, in place: why, and what the person can do. */
function Problems({ problems }: { problems: readonly MemoryProblem[] }) {
    const { outbox } = useWorkspaceScope();
    if (problems.length === 0) {
        return null;
    }
    const act = (problem: MemoryProblem, action: ProblemAction) => {
        switch (action) {
            case 'keep-mine':
                keepMine(outbox, { id: problem.id, current: problem.current, newId: randomId }).catch(
                    failed('not sent again'),
                );
                return;
            case 'keep-theirs':
                keepTheirs(outbox, problem.id).catch(failed('not discarded'));
                return;
            case 'retry':
                outbox.retryUnsent(problem.id, randomId()).catch(failed('not sent again'));
                return;
            case 'copy':
                Clipboard.setStringAsync(problem.text ?? '').catch(failed('not copied'));
                return;
            case 'discard':
                Alert.alert('Discard this?', 'It won’t be sent.', [
                    { text: 'Cancel', style: 'cancel' },
                    {
                        text: 'Discard',
                        style: 'destructive',
                        onPress: () => void outbox.discardUnsent(problem.id).catch(failed('not discarded')),
                    },
                ]);
                return;
        }
    };
    return (
        <View className="gap-2" testID="memory-problems">
            {problems.map((problem) => (
                <View key={problem.id} className="gap-2 rounded-xl border border-destructive/40 bg-card p-4">
                    <View accessible accessibilityLabel={problem.accessibilityLabel} className="gap-1">
                        <Text variant="footnote" tone="muted">
                            {`${problem.what} · ${problem.where}`}
                        </Text>
                        {problem.text === null ? null : <Text numberOfLines={4}>{problem.text}</Text>}
                        <Text variant="footnote" tone="destructive">
                            {problem.why}
                        </Text>
                    </View>
                    <View className="flex-row flex-wrap justify-end gap-2">
                        {problem.actions.map((action) => (
                            <Button
                                key={action}
                                variant={action === 'keep-mine' || action === 'retry' ? 'secondary' : 'ghost'}
                                label={PROBLEM_LABELS[action]}
                                onPress={() => act(problem, action)}
                                testID={`memory-problem-${action}`}
                            />
                        ))}
                    </View>
                </View>
            ))}
        </View>
    );
}

// ---- Episodes ------------------------------------------------------------------

/** Whether a request can go now: NetInfo says connected and the server isn't away. */
async function online(reconnecting: boolean): Promise<boolean | null> {
    if (reconnecting) {
        return false;
    }
    try {
        return (await network.current()).connected;
    } catch {
        return null;
    }
}

type EpisodesRead =
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready'; readonly state: EpisodesState }
    | { readonly kind: 'offline' }
    | { readonly kind: 'failed' };

/** The episodes, read online only, as the person searches; deleted online only after a confirm. */
function Episodes({ names }: { names: MemoryNames }) {
    const scope = useWorkspaceScope();
    const { reconnecting } = useSyncStatus();
    // Read when a confirm is tapped, which may be long after the render that showed it.
    const reconnectingNow = useRef(reconnecting);
    useEffect(() => {
        reconnectingNow.current = reconnecting;
    }, [reconnecting]);
    const [query, setQuery] = useState('');
    const [read, setRead] = useState<EpisodesRead>({ kind: 'loading' });
    const [asked, setAsked] = useState(0);
    const [notice, setNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Asked again each time the screen comes into view.
    useFocusEffect(useCallback(() => setAsked((n) => n + 1), []));
    useEffect(() => {
        const controller = new AbortController();
        const timer = setTimeout(
            () => {
                readEpisodes(scope.fetch, query, controller.signal).then(
                    (state) => {
                        if (!controller.signal.aborted) {
                            setRead({ kind: 'ready', state });
                        }
                    },
                    () => {
                        void online(false).then((connected) => {
                            if (!controller.signal.aborted) {
                                setRead({ kind: connected === false ? 'offline' : 'failed' });
                            }
                        });
                    },
                );
            },
            query === '' ? 0 : EPISODE_SEARCH_DELAY_MS,
        );
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [scope, query, asked]);
    const say = (words: string | null) => {
        setNotice(words);
        if (words !== null) {
            AccessibilityInfo.announceForAccessibility(words);
        }
    };
    /** Online only: offline nothing is asked or sent ("Needs a connection"). */
    const remove = (
        confirm: { title: string; message: string; action: string },
        run: (context: EpisodeContext) => Promise<EpisodeDeleteResult>,
    ) => {
        say(null);
        void online(reconnectingNow.current).then((connected) => {
            if (connected === false) {
                say(episodeDeleteCopy({ outcome: 'offline' }));
                return;
            }
            Alert.alert(confirm.title, confirm.message, [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: confirm.action,
                    style: 'destructive',
                    onPress: () => {
                        setBusy(true);
                        void online(reconnectingNow.current)
                            .then((now) => run({ fetch: scope.fetch, connected: now }))
                            .then((result: EpisodeDeleteResult) => {
                                say(episodeDeleteCopy(result));
                                setAsked((n) => n + 1);
                            })
                            .finally(() => setBusy(false));
                    },
                },
            ]);
        });
    };
    const view = episodesView(read.kind === 'ready' ? read.state : null, names);
    const total = read.kind === 'ready' ? read.state.total : 0;
    return (
        <View className="gap-3" testID="memory-episodes">
            <SectionTitle>From your chats</SectionTitle>
            <Text variant="footnote" tone="muted">
                {view.intro}
            </Text>
            {notice === null ? null : (
                <Text variant="footnote" tone="destructive" testID="episodes-notice">
                    {notice}
                </Text>
            )}
            {view.count === null && query === '' ? null : (
                <View className="gap-2">
                    <Field
                        label="Search episodes"
                        value={query}
                        onChangeText={setQuery}
                        placeholder="Search episodes"
                        maxLength={EPISODE_QUERY_MAX}
                        autoCapitalize="none"
                        autoCorrect={false}
                        returnKeyType="search"
                        testID="episodes-search"
                    />
                    <View className="flex-row items-center gap-2">
                        <Text variant="footnote" tone="muted" className="mr-auto" testID="episodes-count">
                            {view.count ?? ''}
                        </Text>
                        {total > 0 ? (
                            <Button
                                variant="ghost"
                                label="Delete all"
                                busy={busy}
                                onPress={() => remove(deleteAllConfirm(total), (context) => deleteAllEpisodes(context))}
                                testID="episodes-delete-all"
                            />
                        ) : null}
                    </View>
                </View>
            )}
            {read.kind === 'offline' || read.kind === 'failed' ? (
                <View className="gap-2 rounded-xl border border-dashed border-border p-4" testID="episodes-unavailable">
                    <Text variant="footnote" tone="muted">
                        {read.kind === 'offline' ? EPISODES_OFFLINE : EPISODES_FAILED}
                    </Text>
                    <Button
                        variant="secondary"
                        label="Try again"
                        onPress={() => setAsked((n) => n + 1)}
                        testID="episodes-retry"
                    />
                </View>
            ) : null}
            {view.rows.length > 0 ? (
                <View className="rounded-xl border border-border bg-card" testID="episode-list">
                    {view.rows.map((row, index) => (
                        <EpisodeRowView
                            key={row.id}
                            row={row}
                            first={index === 0}
                            busy={busy}
                            onDelete={() => remove(CONFIRMS.episode, (context) => deleteEpisode(context, row.id))}
                        />
                    ))}
                </View>
            ) : view.empty === null ? null : (
                <View className="rounded-xl border border-dashed border-border p-4" testID="episodes-empty">
                    <Text variant="footnote" tone="muted">
                        {view.empty}
                    </Text>
                </View>
            )}
        </View>
    );
}

function EpisodeRowView(props: { row: EpisodeRow; first: boolean; busy: boolean; onDelete: () => void }) {
    const { row } = props;
    return (
        <View
            className={
                props.first ? 'flex-row items-start gap-3 p-4' : 'flex-row items-start gap-3 border-t border-border p-4'
            }
            testID={`episode-${row.id}`}
        >
            <View className="pt-0.5">
                <AppSymbol name="history" size={16} color="muted-foreground" />
            </View>
            <View accessible accessibilityLabel={row.accessibilityLabel} className="min-w-0 flex-1 gap-1">
                {row.badge === null ? null : (
                    <View className="self-start rounded-sm bg-secondary px-1.5">
                        <Text variant="footnote" tone="on-secondary">
                            {row.badge}
                        </Text>
                    </View>
                )}
                <Text>{row.text}</Text>
                <Text variant="footnote" tone="muted">
                    {row.line}
                </Text>
            </View>
            <View className="-mt-3 -mr-3">
                <Button
                    variant="ghost"
                    iconOnly
                    icon="trash-2"
                    label="Delete episode"
                    disabled={props.busy}
                    onPress={props.onDelete}
                    testID={`episode-${row.id}-delete`}
                />
            </View>
        </View>
    );
}

// ---- The sheets ----------------------------------------------------------------

/** A memory form in its native sheet (CB-421): its title, its fields, an error and Cancel and Save. */
function Sheet(props: {
    title: string;
    onCancel: () => void;
    onSave: () => void;
    saveDisabled?: boolean;
    error: string | null;
    children: ReactNode;
    testID: string;
}) {
    return (
        <View testID={props.testID} className="gap-4 pt-5">
            <Text accessibilityRole="header" variant="headline">
                {props.title}
            </Text>
            {props.children}
            {props.error === null ? null : (
                <Text variant="footnote" tone="destructive" accessibilityLiveRegion="polite">
                    {props.error}
                </Text>
            )}
            <View className="flex-row justify-end gap-3">
                <Button label="Cancel" variant="ghost" onPress={props.onCancel} />
                <Button
                    label="Save"
                    onPress={props.onSave}
                    disabled={props.saveDisabled === true}
                    testID={`${props.testID}-save`}
                />
            </View>
        </View>
    );
}

/** "Use in team chats": one switch for screen readers, the whole row its target. */
function TeamSwitch(props: { on: boolean; onChange: (on: boolean) => void; testID: string }) {
    const colors = colorsOf(useScheme());
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="switch"
            accessibilityLabel="Use in team chats"
            accessibilityHint={TEAM_NOTE}
            accessibilityState={{ checked: props.on }}
            onPress={() => props.onChange(!props.on)}
            className="flex-row items-center gap-3"
            style={{ minHeight: 44 }}
        >
            <View className="min-w-0 flex-1 gap-0.5">
                <Text weight="medium">Use in team chats</Text>
                <Text variant="footnote" tone="muted">
                    {TEAM_NOTE}
                </Text>
            </View>
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
                <Switch
                    value={props.on}
                    onValueChange={props.onChange}
                    trackColor={{ false: colors.input, true: colors.primary }}
                    ios_backgroundColor={colors.input}
                />
            </View>
        </Pressable>
    );
}

const wordsOf = (error: unknown, what: string) => {
    if (error instanceof MemoryWriteError) {
        return error.message;
    }
    failed(what)(error);
    return 'Couldn’t save. Try again.';
};

/** Add a memory: its text is the `memory:new` draft, so it survives a kill; sent through the outbox. */
function AddSheet(props: { rows: readonly { readonly createdAt?: unknown }[]; onClose: () => void }) {
    const scope = useWorkspaceScope();
    const draft = useDraft(NEW_MEMORY_DRAFT);
    const [shareable, setShareable] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const save = () => {
        setError(null);
        const localId = newLocalMemoryId(randomId);
        scope.drafts
            .enqueueFromDraft(NEW_MEMORY_DRAFT, (text) =>
                memoryAddWrite({
                    localId,
                    text,
                    shareable,
                    idempotencyKey: randomId(),
                    after: newestMemory(props.rows),
                    serverAt: scope.serverClock.lastDate(),
                }),
            )
            .then(props.onClose, (caught: unknown) => setError(wordsOf(caught, 'the memory was not added')));
    };
    return (
        <Sheet
            title="Something to remember."
            onCancel={props.onClose}
            onSave={save}
            saveDisabled={draft.text.trim() === '' || draft.locked || !scope.userDb.writable}
            error={error}
            testID="memory-add-sheet"
        >
            <Field
                label="Preference or context"
                value={draft.text}
                onChangeText={draft.setText}
                multiline
                maxLength={MEMORY_TEXT_MAX}
                autoFocus
                editable={!draft.locked}
                testID="memory-add-text"
            />
            <TeamSwitch on={shareable} onChange={setShareable} testID="memory-add-team" />
            <Text variant="footnote" tone="muted">
                {MEMORY_NOTE}
            </Text>
        </Sheet>
    );
}

/** Edit a memory (a proposal too, before approving it): only what changed is queued, on the stored row's base. */
function EditSheet(props: { row: MemoryRow; onClose: () => void }) {
    const { outbox } = useWorkspaceScope();
    const memory: ShownMemory = props.row.memory;
    const [text, setText] = useState(memory.text);
    const [shareable, setShareable] = useState(memory.shareable);
    const [error, setError] = useState<string | null>(null);
    const save = () => {
        const change = memoryChange(memory, { text, shareable });
        if (change === null) {
            props.onClose();
            return;
        }
        const stored = props.row.stored ?? memory;
        editMemory(outbox, {
            memoryId: memory.id,
            change,
            base: { text: stored.text, shareable: stored.shareable },
            newId: randomId,
        }).then(props.onClose, (caught: unknown) => setError(wordsOf(caught, 'the memory was not saved')));
    };
    return (
        <Sheet
            title="Keep it accurate."
            onCancel={props.onClose}
            onSave={save}
            saveDisabled={text.trim() === ''}
            error={error}
            testID="memory-edit-sheet"
        >
            <Field
                label="Preference or context"
                value={text}
                onChangeText={(next) => {
                    setText(next);
                    setError(null);
                }}
                multiline
                maxLength={MEMORY_TEXT_MAX}
                autoFocus
                testID="memory-edit-text"
            />
            <TeamSwitch on={shareable} onChange={setShareable} testID="memory-edit-team" />
        </Sheet>
    );
}

/** The profile: each field edited or cleared; the time zone checked before it is queued (`saveProfile`). */
function ProfileSheet(props: { shown: UserProfile | null; stored: UserProfile | null; onClose: () => void }) {
    const { outbox } = useWorkspaceScope();
    const [fields, setFields] = useState<ProfileFields>(props.shown?.fields ?? {});
    const [shareable, setShareable] = useState(props.shown?.shareable ?? false);
    const [error, setError] = useState<string | null>(null);
    // Each one-line field's Next moves to the field after it (`PROFILE_FORM`'s `next`), keeping the keyboard up.
    const inputs = useRef<Partial<Record<ProfileField, TextInputInstance | null>>>({});
    const save = () => {
        const change = profileChange(props.shown, { fields, shareable });
        if (change === null) {
            props.onClose();
            return;
        }
        saveProfile(outbox, { ...change, base: props.stored, newId: randomId }).then(props.onClose, (caught: unknown) =>
            setError(wordsOf(caught, 'the profile was not saved')),
        );
    };
    const zone = fields.timezone ?? '';
    const zoneHint = timeZoneHint(
        zone,
        props.shown?.timezoneDetected === true && zone === (props.shown.fields.timezone ?? ''),
    );
    return (
        <Sheet
            title="Tell your socios about you."
            onCancel={props.onClose}
            onSave={save}
            error={error}
            testID="memory-profile-sheet"
        >
            <Text variant="footnote" tone="muted">
                {PROFILE_NOTE}
            </Text>
            {PROFILE_FORM.map((field) => (
                <Field
                    key={field.name}
                    ref={(input) => {
                        inputs.current[field.name] = input;
                    }}
                    label={field.label}
                    value={fields[field.name] ?? ''}
                    onChangeText={(value) => {
                        setFields({ ...fields, [field.name]: value });
                        setError(null);
                    }}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    multiline={field.long}
                    {...(field.long
                        ? {}
                        : field.next === null
                          ? { returnKeyType: 'done' as const }
                          : {
                                returnKeyType: 'next' as const,
                                submitBehavior: 'submit' as const,
                                onSubmitEditing: () => inputs.current[field.next!]?.focus(),
                            })}
                    autoCapitalize={field.name === 'timezone' ? 'none' : 'sentences'}
                    autoCorrect={field.name !== 'timezone'}
                    {...(field.name !== 'timezone'
                        ? {}
                        : zoneHint.error
                          ? { error: zoneHint.text }
                          : { hint: zoneHint.text })}
                    testID={`memory-profile-${field.name}`}
                />
            ))}
            <TeamSwitch on={shareable} onChange={setShareable} testID="memory-profile-team" />
            <Text variant="footnote" tone="muted">
                It shapes how socios talk with you. It can’t change what they may do: permissions and approvals stay as
                they are.
            </Text>
        </Sheet>
    );
}
