import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import { normalizeRole } from '@socio/shared/roles';
import type { AgentRunSummary } from '@socio/shared/types';

import {
    useCollections,
    useHasWorkspaceScope,
    useKindAnswered,
    useLiveQuery,
    useRunTrace,
    useSyncOnFocus,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { runAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { useAdvanced } from '../platform/device-settings';
import { openIssueFor } from '../shell/file-issue';
import { moduleEntry } from '../shell/modules';
import { runsQuery, shellQuery, shellRows } from '../shell/queries';
import {
    RUN_FILTERS,
    type RunFilter,
    type RunRow,
    runRow,
    runRows,
    RUNS_INTRO_ADMIN,
    RUNS_INTRO_MEMBER,
    RUNS_TITLE,
    runsEmpty,
    runsLimitLine,
    type RunTone,
    type TimelineStep,
    TRACE_MISSING,
    TRACE_NONE,
    TRACE_OFFLINE,
    TRACE_OLD,
    traceState,
} from '../shell/runs';
import { RUNS_KIND } from '../sync/kinds';
import { runRow as storedRun } from '../sync/runs';
import { useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { Button, AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';
import type { SymbolName } from '../ui/symbols';

import { ActionMenu } from './action-menu';
import { MODULE_ICONS } from './module-icons';
import { Age, Card, SectionTitle } from './schedule-parts';
import { PageIntro, StatusBanners, useOpenChat, useRememberScreen } from './shell-parts';
import { TRACE_ICONS } from './trace-icons';

// Runs, the `Runs` route at the web's /runs,
// from More, Home and Search, in the module's slate: the `runs` kind (a
// member's own turns, everyone's for an admin), newest first, with the web's
// status filter, polled every 10 s while shown. The list never asks for a
// trace: a tap on a run opens its page (`Run`, no path, never kept as the last
// screen), and that tap is what reads the trace (CB-188: an admin's read of
// someone else's writes the access log). The page shows the run's facts, opens
// its chat when the person can read it, and its steps in the chat trace's
// words; Advanced mode adds the rounds, raw codes and the run's detail. The
// person's own trace shows offline from disk; someone else's is never kept.

const MODULE = moduleEntry(MODULE_IDS.runs);
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const STEP_ICONS: Record<TimelineStep['icon'], SymbolName> = {
    ...TRACE_ICONS,
    hourglass: 'hourglass',
    'user-round': 'user-round',
    'rotate-cw': 'rotate-cw',
    'arrow-left-right': 'arrow-left-right',
    archive: 'archive',
    'notebook-pen': 'notebook-pen',
    'message-square-more': 'message-square-more',
};

function useRunsData() {
    const collections = useCollections();
    const { data } = useLiveQuery({ query: runsQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const role = shellRows(shell).workspace?.user.role;
    return {
        runs: data.map((row) => storedRun(row.runId, row)),
        // An older server may still send the retired `operator` role (CB-390).
        admin: normalizeRole(role) === 'admin',
    };
}

function Unscoped({ testID }: { testID: string }) {
    useNativeBar({ title: RUNS_TITLE, tone: MODULE.tone });
    return <View testID={testID} className="flex-1 bg-screen" collapsable={false}></View>;
}

export function RunsScreen() {
    return useHasWorkspaceScope() ? <Runs /> : <Unscoped testID="runs-screen" />;
}

function Runs() {
    const navigation = useNavigation();
    const { runTraces } = useWorkspaceScope();
    useRememberScreen('Runs');
    useSyncOnFocus(RUNS_KIND.collections);
    const { runs, admin } = useRunsData();
    const answered = useKindAnswered(RUNS_KIND.definition);
    const [filter, setFilter] = useState<RunFilter>('');
    const rows = runRows(runs, filter, admin, Date.now());
    const limit = runsLimitLine(runs.length, filter);
    useFirstFrameWithData('Runs', answered || runs.length > 0);
    const open = (id: string) => {
        // Disk only: the trace is read from the server by the page this tap opens.
        runTraces.preload(id).catch((error: unknown) => console.warn('[runs] not read', error));
        navigation.dispatch(runAction(id));
    };
    useNativeBar({ title: RUNS_TITLE, tone: MODULE.tone });
    return (
        <View testID="runs-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
            >
                <StatusBanners />
                <PageIntro
                    subtitle={admin ? RUNS_INTRO_ADMIN : RUNS_INTRO_MEMBER}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="runs-heading"
                />
                {/* Six choices are a menu, not a segmented control: a pull-down with the one shown checked. */}
                <View className="flex-row">
                    <ActionMenu
                        request={{
                            title: 'Filter by status',
                            actions: RUN_FILTERS.map((item) => ({
                                name: item.value || 'all',
                                label: item.label,
                                checked: filter === item.value,
                            })),
                            onAction: (name) => setFilter((name === 'all' ? '' : name) as typeof filter),
                        }}
                        trigger="press"
                        label={`Filter by status, ${RUN_FILTERS.find((item) => item.value === filter)?.label ?? ''}`}
                        testID="runs-filter"
                    >
                        <View className="min-h-11 flex-row items-center gap-2 rounded-full bg-secondary px-4">
                            <Text weight="medium">
                                {RUN_FILTERS.find((item) => item.value === filter)?.label ?? ''}
                            </Text>
                            <AppSymbol name="chevron-down" size={16} color="muted-foreground" />
                        </View>
                    </ActionMenu>
                </View>
                {limit === null ? null : (
                    <Text variant="footnote" tone="muted">
                        {limit}
                    </Text>
                )}
                <View className="gap-2" testID="run-list">
                    {rows.length === 0 ? (
                        <Text variant="subheadline" tone="muted" testID="runs-empty">
                            {runsEmpty(filter, answered)}
                        </Text>
                    ) : null}
                    {rows.map((row) => (
                        <Card key={row.id} testID={row.testID}>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityLabel={row.accessibilityLabel}
                                accessibilityHint={row.traceable ? 'Opens the turn and its trace' : 'Opens the turn'}
                                onPress={() => open(row.id)}
                                className="gap-1"
                            >
                                <RunHead row={row} />
                            </Pressable>
                        </Card>
                    ))}
                </View>
            </ScrollView>
        </View>
    );
}

/** A status word beside its dot (CB-308): the word always shows, never the color alone. */
function StatusWord({ word, tone, testID }: { word: string; tone: RunTone; testID?: string }) {
    const colors = theme[useScheme()];
    const dot = tone === 'ok' ? { backgroundColor: colors.tones.emerald.foreground } : undefined;
    return (
        <View className="flex-row items-center gap-1.5" testID={testID}>
            <View
                className={cx(
                    'size-2 rounded-full',
                    tone === 'bad' && 'bg-destructive',
                    tone === 'running' && 'bg-primary',
                    tone === 'muted' && 'bg-muted-foreground',
                )}
                style={dot}
            />
            <Text variant="footnote" weight="medium">
                {word}
            </Text>
        </View>
    );
}

function RunHead({ row }: { row: RunRow }) {
    return (
        <>
            <StatusWord word={row.status} tone={row.tone} testID={`${row.testID}-status`} />
            <Text weight="medium">{row.title}</Text>
            <Text variant="footnote" tone="muted">
                {row.meta}
            </Text>
            {row.error === null ? null : (
                <Text variant="footnote" tone="destructive" testID={`${row.testID}-error`}>
                    {row.error}
                </Text>
            )}
            {row.errorDetail === null ? null : (
                <Text variant="footnote" tone="destructive" style={{ fontFamily: MONO }}>
                    {row.errorDetail}
                </Text>
            )}
            {row.trace === null ? null : (
                <Text variant="footnote" tone={row.trace.trouble ? 'destructive' : 'muted'}>
                    {row.trace.text}
                </Text>
            )}
        </>
    );
}

// ---- A run's page --------------------------------------------------------------

export function RunScreen({ route }: StaticScreenProps<{ runId: string }>) {
    return useHasWorkspaceScope() ? <Run runId={route.params.runId} /> : <Unscoped testID="run-screen" />;
}

function Run({ runId }: { runId: string }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const openChat = useOpenChat();
    const { runs, admin } = useRunsData();
    useSyncOnFocus(RUNS_KIND.collections);
    const run: AgentRunSummary | undefined = runs.find((item) => item.runId === runId);
    const row = run === undefined ? null : runRow(run, admin, Date.now());
    useNativeBar({ title: row?.title ?? RUNS_TITLE });
    return (
        <View testID="run-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
            >
                <StatusBanners />
                {row === null ? (
                    <Text variant="subheadline" tone="muted" testID="run-gone">
                        This turn isn’t in the latest runs any more.
                    </Text>
                ) : (
                    <Card testID="run-facts">
                        <RunHead row={row} />
                        {run?.readable ? (
                            <Button
                                variant="secondary"
                                label="Open the chat"
                                onPress={() => openChat({ id: run.threadId, room: run.room === true })}
                                testID="run-open-chat"
                            />
                        ) : null}
                        {row.fileIssue ? (
                            <Button
                                variant="secondary"
                                icon="bug"
                                label="File issue"
                                onPress={() => {
                                    // Filled as the web's runIssueDraft fills its form; what was typed stays.
                                    openIssueFor(scope.drafts, runId, run);
                                    navigation.navigate('FileIssue', { runId });
                                }}
                                testID="run-file-issue"
                            />
                        ) : null}
                    </Card>
                )}
                {row?.traceable ? (
                    <RunTrace runId={runId} version={`${run?.status}:${run?.finishedAt}`} />
                ) : row === null ? null : (
                    <Text variant="subheadline" tone="muted" testID="run-trace-none">
                        {TRACE_NONE}
                    </Text>
                )}
            </ScrollView>
        </View>
    );
}

/** The trace, read as this page opens (the person's tap), and again if the run ends while it shows. */
function RunTrace({ runId, version }: { runId: string; version: string }) {
    const advanced = useAdvanced();
    const item = useRunTrace(runId);
    const { runTraces } = useWorkspaceScope();
    // A run that ends while its page shows is read once more, as the web's
    // RunTimeline reads again when its row's status and end change.
    const shown = useRef(version);
    useEffect(() => {
        if (shown.current !== version) {
            shown.current = version;
            runTraces
                .item(runId)
                .refresh()
                .catch((error: unknown) => console.warn('[runs] trace not read', error));
        }
    }, [runTraces, runId, version]);
    const state = traceState(item, true, advanced);
    return (
        <View className="gap-2" testID="run-trace">
            <SectionTitle>Trace</SectionTitle>
            {state.kind === 'loading' ? (
                <Text variant="subheadline" tone="muted">
                    Loading trace…
                </Text>
            ) : null}
            {state.kind === 'offline' ? (
                <View className="items-start gap-2">
                    <Text variant="subheadline" tone="muted" testID="run-trace-offline">
                        {TRACE_OFFLINE}
                    </Text>
                    <Button
                        variant="secondary"
                        label="Try again"
                        busy={state.retrying}
                        onPress={() =>
                            void runTraces
                                .item(runId)
                                .refresh()
                                .catch((error: unknown) => console.warn('[runs] trace not read', error))
                        }
                        testID="run-trace-retry"
                    />
                </View>
            ) : null}
            {state.kind === 'missing' ? (
                <Text variant="subheadline" tone="muted" testID="run-trace-missing">
                    {TRACE_MISSING}
                </Text>
            ) : null}
            {state.kind === 'old' ? (
                <Text variant="subheadline" tone="muted">
                    {TRACE_OLD}
                </Text>
            ) : null}
            {state.kind === 'ready' ? (
                <Card testID="run-timeline">
                    <Age age={state.age} testID="run-trace-age" />
                    <View accessible className="gap-0.5">
                        <Text weight="medium" tone={state.timeline.trouble ? 'destructive' : 'default'}>
                            {state.timeline.end}
                        </Text>
                        <Text variant="footnote" tone="muted">
                            {state.timeline.meta}
                        </Text>
                    </View>
                    {state.timeline.steps.length === 0 ? (
                        <Text variant="subheadline" tone="muted">
                            No steps recorded.
                        </Text>
                    ) : (
                        <View className="gap-1">
                            {state.timeline.steps.map((step) => (
                                <Step key={step.id} step={step} />
                            ))}
                        </View>
                    )}
                    {state.timeline.dropped === null ? null : (
                        <Text variant="footnote" tone="muted">
                            {state.timeline.dropped}
                        </Text>
                    )}
                </Card>
            ) : null}
            {state.kind === 'ready' && state.timeline.advanced !== null ? (
                <Card testID="run-advanced">
                    {state.timeline.advanced.rows.map((detail) => (
                        <DetailLine key={detail.name} name={detail.name} value={detail.value} copy={detail.copy} />
                    ))}
                </Card>
            ) : null}
        </View>
    );
}

function Step({ step }: { step: TimelineStep }) {
    const bad = step.tone === 'bad';
    return (
        <View accessible className="min-h-11 flex-row items-start gap-2 py-1.5" testID={`run-step-${step.id}`}>
            <AppSymbol name={STEP_ICONS[step.icon]} color={bad ? 'destructive' : 'muted-foreground'} />
            <View className="min-w-0 flex-1 gap-0.5">
                <Text tone={step.tone === 'muted' ? 'muted' : 'default'}>
                    {step.verb}
                    {step.detail ? <Text variant="subheadline" tone="muted">{` · ${step.detail}`}</Text> : null}
                </Text>
                {step.outcome ? (
                    <Text variant="footnote" tone={bad ? 'destructive' : 'muted'}>
                        {step.outcome}
                    </Text>
                ) : null}
                {step.tool ? (
                    <Text variant="footnote" tone="muted" selectable style={{ fontFamily: MONO }}>
                        {step.callId ? `${step.tool} · ${step.callId}` : step.tool}
                    </Text>
                ) : null}
            </View>
            {step.duration ? (
                <Text variant="footnote" tone="muted">
                    {step.duration}
                </Text>
            ) : null}
        </View>
    );
}

function DetailLine({ name, value, copy }: { name: string; value: string; copy?: boolean }) {
    return (
        <View className="min-h-6 flex-row items-center gap-3">
            <Text variant="footnote" tone="muted" className="w-28">
                {name}
            </Text>
            <Text variant="footnote" selectable className="flex-1" style={copy ? { fontFamily: MONO } : undefined}>
                {value}
            </Text>
            {copy ? (
                <Button
                    label={`Copy ${name.toLowerCase()} id`}
                    icon="copy"
                    iconOnly
                    variant="ghost"
                    onPress={() =>
                        Clipboard.setStringAsync(value).catch((error: unknown) =>
                            console.warn('[runs] not copied', error),
                        )
                    }
                />
            ) : null}
        </View>
    );
}
