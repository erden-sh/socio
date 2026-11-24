import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useRef, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';

import { MODULE_IDS } from '@socio/shared/modules';
import { GOAL_COMMENT_MAX, type GoalView, type JobRunView } from '@socio/shared/schedule-types';

import { outboxStateStore } from '../chat/composer';
import {
    useCollections,
    useHasWorkspaceScope,
    useLiveQuery,
    useScheduleDetail,
    useSyncOnFocus,
    useWorkspaceScope,
} from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { issueAction, jobAction, scheduleAction } from '../navigation/tabs';
import { useFirstFrameWithData } from '../platform/cold-start';
import { randomId } from '../platform/crypto';
import { moduleEntry } from '../shell/modules';
import { goalsQuery, jobsQuery, scheduleLimitsQuery, schedulesQuery, shellQuery, shellRows } from '../shell/queries';
import {
    ANY_SCHEDULE,
    filterButtonLabel,
    type FilterOption,
    firstPageKey,
    type GoalRow,
    goalRows,
    JOB_ON_WEB,
    jobDetailView,
    jobRows,
    jobSignature,
    matchesSchedule,
    NO_JOBS,
    NO_RUNS,
    NO_SCHEDULES,
    NO_SCHEDULES_MATCH,
    OLDER_RUNS_OFFLINE,
    type OlderRuns,
    olderRunsFor,
    type RunRow,
    SCHEDULE_BUTTON_LABEL,
    type ScheduleButton,
    scheduleDetailView,
    scheduleLimitsLine,
    type ScheduleRow,
    scheduleRows,
    scheduleRunRows,
    scheduleSignature,
    SCHEDULE_SEARCH_LABEL,
    SCHEDULE_STATUS_OPTIONS,
    type ScheduleFilter,
    scheduleSocioOptions,
    SCHEDULES_INTRO,
    SCHEDULES_TITLE,
    jobRunRows,
    statusWord,
    scheduleTime,
    withOlderPage,
} from '../shell/schedules';
import { goalDraft } from '../sync/chat-drafts';
import { SCHEDULES_KIND } from '../sync/kinds';
import { overlaysOf } from '../sync/outbox-overlay';
import { readJobRun, readOlderJobRuns, readOlderScheduleRuns } from '../sync/schedule-details';
import {
    actOnSchedule,
    goalCommentWrite,
    newestGoalComment,
    runJobNow,
    runScheduleNow,
    SCHEDULE_WRITE_VIEWS,
    ScheduleWriteError,
    type ShownGoal,
    shownSchedules,
    stopJob,
} from '../sync/schedule-writes';
import { goalRow, jobRow, scheduleLimitsRow, scheduleRow } from '../sync/schedules';
import { Button, Field, AppSymbol, keyboardScroll, SearchField, SegmentedControl, Text } from '../ui';

import { ActionMenu, type MenuRequest } from './action-menu';
import { useDraft } from './chat-composer';
import { MODULE_ICONS } from './module-icons';
import {
    Age,
    Card,
    DetailEmpty,
    Fact,
    Notice,
    online,
    SectionTitle,
    StatusChip,
    useOnlineAction,
    useRefreshOnRowChange,
    WebRow,
} from './schedule-parts';
import { PageIntro, StatusBanners, useOpenChat, useRememberScreen } from './shell-parts';

// Schedules & jobs, the `Schedules` route at the web's
// /schedules, from More and Search, in the module's violet; a schedule's page
// at /schedules/:id (`Schedule`) and a job's (`Job`, the app's own, no path).
// The rows are the `schedules` kind with this device's writes laid over
// (`shownSchedules`), polled every 10 s while shown, as the web's page. Pause,
// Resume and Cancel go through the outbox, so they work offline; Run now and
// Stop are online only. Goals take comments through the `goal:<id>` draft.
// Details come from their bounded kinds (schedule-details.ts), shown offline
// with their age; older runs and a job run's logs are read online only. A
// job's code, versions and delete open the web (the owner's call): on the
// phone, a running job can only be stopped. Nothing is created or edited here.

const MODULE = moduleEntry(MODULE_IDS.schedules);
/** The menu action that clears a filter. */
const ANY = 'any';

type Tab = 'schedules' | 'jobs';
const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
    { id: 'schedules', label: 'Schedules' },
    { id: 'jobs', label: 'Jobs' },
];

function Unscoped({ title, testID }: { title: string; testID: string }) {
    useNativeBar({ title });
    return <View testID={testID} className="flex-1 bg-screen" collapsable={false}></View>;
}

/** The `schedules` kind with this device's writes laid over. */
function useShownSchedules() {
    const { outbox } = useWorkspaceScope();
    const collections = useCollections();
    const { data: scheduleData } = useLiveQuery({ query: schedulesQuery(collections) });
    const { data: goalData } = useLiveQuery({ query: goalsQuery(collections) });
    const { data: jobData } = useLiveQuery({ query: jobsQuery(collections) });
    const { data: limitData } = useLiveQuery({ query: scheduleLimitsQuery(collections) });
    const { data: shell } = useLiveQuery({ query: shellQuery(collections) });
    const [store] = useState(() => outboxStateStore(outbox));
    const writes = useSyncExternalStore(store.subscribe, store.get);
    const overlays = overlaysOf({
        rows: writes.rows,
        unsent: writes.unsent,
        kinds: SCHEDULE_WRITE_VIEWS,
        scope: outbox,
    });
    const stored = scheduleData.map((row) => scheduleRow(row.id, row));
    const storedGoals = goalData.map((row) => goalRow(row.id, row));
    const shown = shownSchedules(stored, storedGoals, overlays);
    const limits = limitData[0] === undefined ? null : scheduleLimitsRow(limitData[0].id, limitData[0]);
    return {
        shown,
        storedGoals,
        jobs: jobData.map((row) => jobRow(row.id, row)),
        limits,
        settings: shellRows(shell).state?.settings ?? null,
    };
}

export function SchedulesScreen() {
    return useHasWorkspaceScope() ? <Schedules /> : <Unscoped title={SCHEDULES_TITLE} testID="schedules-screen" />;
}

function Schedules() {
    const navigation = useNavigation();
    const { scheduleDetails } = useWorkspaceScope();
    useRememberScreen('Schedules');
    useSyncOnFocus(SCHEDULES_KIND.collections);
    const data = useShownSchedules();
    const [tab, setTab] = useState<Tab>('schedules');
    const action = useOnlineAction();
    useFirstFrameWithData('Schedules', data.limits !== null);
    const [filter, setFilter] = useState<ScheduleFilter>(ANY_SCHEDULE);
    const socios = scheduleSocioOptions(data.shown.schedules);
    const rows = scheduleRows(data.shown.schedules.filter((schedule) => matchesSchedule(schedule, filter)));
    // A pop-up button's menu: the choices, the one held checked.
    const pick = (
        title: string,
        options: readonly FilterOption[],
        value: string,
        onPick: (value: string) => void,
    ): MenuRequest => ({
        title,
        actions: options.map((option) => ({
            name: option.value || ANY,
            label: option.label,
            checked: option.value === value,
        })),
        onAction: (name) => onPick(name === ANY ? '' : name),
    });
    const goals = goalRows(data.shown.goals, data.shown.schedules);
    const jobs = jobRows(data.jobs);
    const openSchedule = (id: string) => {
        scheduleDetails.schedules.preload(id).catch((error: unknown) => console.warn('[schedules] not read', error));
        navigation.dispatch(scheduleAction(id));
    };
    const openJob = (id: string) => {
        scheduleDetails.jobs.preload(id).catch((error: unknown) => console.warn('[schedules] not read', error));
        navigation.dispatch(jobAction(id));
    };
    useNativeBar({ title: SCHEDULES_TITLE, tone: MODULE.tone });
    return (
        <View testID="schedules-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
                {...keyboardScroll(Platform.OS)}
            >
                <StatusBanners />
                <PageIntro
                    subtitle={SCHEDULES_INTRO}
                    subtitleLines={0}
                    tile={{ tone: MODULE.tone, icon: MODULE_ICONS[MODULE.icon] }}
                    testID="schedules-heading"
                />
                <SegmentedControl
                    options={TABS.map((item) => ({
                        value: item.id,
                        label: item.label,
                        testID: `schedules-tab-${item.id}`,
                    }))}
                    selected={tab}
                    onSelect={setTab}
                    accessibilityLabel="Show"
                    testID="schedules-tabs"
                />
                {data.limits === null ? (
                    <Text variant="subheadline" tone="muted" testID="schedules-loading">
                        Loading schedules…
                    </Text>
                ) : null}
                <Notice words={action.notice} testID="schedules-notice" />
                {tab === 'schedules' ? (
                    <>
                        {goals.length === 0 ? null : (
                            <View className="gap-2" testID="goal-list">
                                <SectionTitle>Goals</SectionTitle>
                                {goals.map((goal) => (
                                    <GoalCard
                                        key={goal.id}
                                        row={goal}
                                        stored={data.storedGoals.find((item) => item.id === goal.id) ?? null}
                                        onOpen={() => openSchedule(goal.goal.scheduleId)}
                                    />
                                ))}
                            </View>
                        )}
                        <View className="gap-2" testID="schedule-list">
                            <SectionTitle>Schedules</SectionTitle>
                            {data.limits === null ? null : (
                                <Text variant="footnote" tone="muted">
                                    {scheduleLimitsLine(data.limits.limits, data.limits.usage)}
                                </Text>
                            )}
                            {data.limits !== null && data.shown.schedules.length === 0 ? (
                                <Text variant="subheadline" tone="muted" testID="schedules-empty">
                                    {NO_SCHEDULES}
                                </Text>
                            ) : null}
                            {data.shown.schedules.length === 0 ? null : (
                                <View className="gap-2" testID="schedules-find">
                                    <SearchField
                                        label={SCHEDULE_SEARCH_LABEL}
                                        value={filter.query}
                                        onChangeText={(query) => setFilter({ ...filter, query })}
                                        testID="schedules-search"
                                    />
                                    <View className="flex-row flex-wrap gap-2">
                                        <FilterButton
                                            label={filterButtonLabel('Status', SCHEDULE_STATUS_OPTIONS, filter.status)}
                                            name="Status filter"
                                            menu={pick('Status', SCHEDULE_STATUS_OPTIONS, filter.status, (status) =>
                                                setFilter({
                                                    ...filter,
                                                    status: status as ScheduleFilter['status'],
                                                }),
                                            )}
                                            testID="schedules-status-filter"
                                        />
                                        <FilterButton
                                            label={filterButtonLabel('Socio', socios, filter.socio)}
                                            name="Socio filter"
                                            menu={pick('Socio', socios, filter.socio, (socio) =>
                                                setFilter({ ...filter, socio }),
                                            )}
                                            testID="schedules-socio-filter"
                                        />
                                    </View>
                                    {rows.length === 0 ? (
                                        <Text variant="subheadline" tone="muted" testID="schedules-no-match">
                                            {NO_SCHEDULES_MATCH}
                                        </Text>
                                    ) : null}
                                </View>
                            )}
                            {rows.map((row) => (
                                <ScheduleCard
                                    key={row.id}
                                    row={row}
                                    busy={action.busy}
                                    onOpen={() => openSchedule(row.id)}
                                    onRunNow={() =>
                                        action.run(`run:${row.id}`, (context) =>
                                            runScheduleNow(context, {
                                                scheduleId: row.id,
                                                settings: data.settings,
                                                status: row.status,
                                            }),
                                        )
                                    }
                                />
                            ))}
                        </View>
                    </>
                ) : (
                    <View className="gap-2" testID="job-list">
                        <SectionTitle>Jobs</SectionTitle>
                        {data.limits === null ? null : (
                            <Text variant="footnote" tone="muted">
                                {`Code your socios saved, run in their computer with a timeout of at most ${data.limits.limits.maxJobTimeoutSeconds} s. ${data.limits.usage.jobs} of ${data.limits.limits.maxJobs} jobs.`}
                            </Text>
                        )}
                        {data.limits !== null && jobs.length === 0 ? (
                            <Text variant="subheadline" tone="muted" testID="jobs-empty">
                                {NO_JOBS}
                            </Text>
                        ) : null}
                        {jobs.map((job) => (
                            <Card key={job.id} testID={job.testID}>
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={job.accessibilityLabel}
                                    accessibilityHint="Opens the job"
                                    onPress={() => openJob(job.id)}
                                    className="gap-1"
                                >
                                    <Text weight="medium">{job.name}</Text>
                                    <Text variant="footnote" tone="muted">
                                        {job.line}
                                    </Text>
                                    <Text variant="footnote" tone="muted">
                                        {job.last}
                                    </Text>
                                </Pressable>
                                <View className="flex-row flex-wrap gap-2">
                                    <Button
                                        variant="secondary"
                                        label={job.going ? 'Running' : 'Run now'}
                                        disabled={job.going || action.busy !== null}
                                        busy={action.busy === `job:${job.id}`}
                                        accessibilityHint="Needs a connection"
                                        onPress={() =>
                                            action.run(`job:${job.id}`, (context) =>
                                                runJobNow(context, { jobId: job.id, settings: data.settings }),
                                            )
                                        }
                                        testID={`${job.testID}-run`}
                                    />
                                </View>
                            </Card>
                        ))}
                    </View>
                )}
            </ScrollView>
        </View>
    );
}

/**
 * A filter, the web's "Status: any" select: a neutral button saying what it holds, which pops up
 * the system's menu of the choices, the one held checked (CB-421: a UIMenu on iOS, Material's
 * popup on Android).
 */
function FilterButton(props: { label: string; name: string; menu: MenuRequest; testID: string }) {
    return (
        <ActionMenu request={props.menu} trigger="press" label={`${props.name}, ${props.label}`} testID={props.testID}>
            <View className="min-h-11 flex-row items-center gap-2 rounded-md border border-input px-3">
                <Text>{props.label}</Text>
                <AppSymbol name="chevron-down" size={16} color="muted-foreground" />
            </View>
        </ActionMenu>
    );
}

/** A schedule's card: what it is, when it runs, where a write over it stands, and its buttons. */
function ScheduleCard(props: { row: ScheduleRow; busy: string | null; onOpen: () => void; onRunNow: () => void }) {
    const { outbox } = useWorkspaceScope();
    const { row } = props;
    return (
        <Card testID={row.testID}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={row.accessibilityLabel}
                accessibilityHint="Opens the schedule"
                onPress={props.onOpen}
                className="gap-1"
            >
                <Text weight="medium">{row.title}</Text>
                <StatusChip word={row.statusWord} testID={`${row.testID}-status`} />
                <Text variant="footnote" tone="muted">
                    {row.what}
                </Text>
                {[row.runs, row.next, row.last].map((line) =>
                    line === null ? null : (
                        <Text key={line} variant="footnote" tone="muted">
                            {line}
                        </Text>
                    ),
                )}
            </Pressable>
            {row.pending === null ? null : (
                <Text variant="footnote" tone="muted" testID={`${row.testID}-pending`}>
                    {row.pending}
                </Text>
            )}
            <ScheduleButtons
                id={row.id}
                buttons={row.buttons}
                busy={props.busy}
                testID={row.testID}
                onRunNow={props.onRunNow}
                onAct={(what) =>
                    void actOnSchedule(outbox, { scheduleId: row.id, action: what, newId: randomId }).catch(
                        (error: unknown) => console.warn('[schedules] not queued', error),
                    )
                }
            />
        </Card>
    );
}

function ScheduleButtons(props: {
    id: string;
    buttons: readonly ScheduleButton[];
    busy: string | null;
    testID: string;
    onRunNow: () => void;
    onAct: (what: 'pause' | 'resume' | 'cancel') => void;
}) {
    return props.buttons.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2">
            {props.buttons.map((button) => (
                <Button
                    key={button}
                    variant={button === 'run' || button === 'cancel' ? 'ghost' : 'secondary'}
                    label={SCHEDULE_BUTTON_LABEL[button]}
                    busy={button === 'run' && props.busy === `run:${props.id}`}
                    disabled={button === 'run' && props.busy !== null}
                    accessibilityHint={button === 'run' ? 'Needs a connection' : undefined}
                    onPress={() => (button === 'run' ? props.onRunNow() : props.onAct(button))}
                    testID={`${props.testID}-${button}`}
                />
            ))}
        </View>
    );
}

/** A goal: its progress, its comments (shown on request, as the web's), and the comment box while it is open. */
function GoalCard(props: { row: GoalRow; stored: GoalView | null; onOpen?: () => void }) {
    const { row } = props;
    const [open, setOpen] = useState(false);
    return (
        <Card testID={`goal-${row.id}`} dashed>
            <Pressable
                accessibilityRole={props.onOpen === undefined ? undefined : 'button'}
                accessibilityHint={props.onOpen === undefined ? undefined : 'Opens its schedule'}
                onPress={props.onOpen}
                disabled={props.onOpen === undefined}
                className="gap-1"
            >
                <Text weight="medium">{row.title}</Text>
                <StatusChip word={row.status} />
                <Text variant="footnote" tone="muted">
                    {row.line}
                </Text>
            </Pressable>
            <Button
                variant="ghost"
                label={open ? 'Hide comments' : row.commentsLabel}
                onPress={() => setOpen(!open)}
                testID={`goal-${row.id}-comments`}
            />
            {open ? <GoalComments row={row} stored={props.stored} /> : null}
        </Card>
    );
}

function GoalComments({ row, stored }: { row: GoalRow; stored: GoalView | null }) {
    const scope = useWorkspaceScope();
    const draftScope = goalDraft(row.id);
    const draft = useDraft(draftScope);
    const [error, setError] = useState<string | null>(null);
    const send = () => {
        setError(null);
        scope.drafts
            .enqueueFromDraft(draftScope, (text) =>
                goalCommentWrite({
                    localId: `pending-goal-comment-${randomId()}`,
                    goalId: row.id,
                    body: text,
                    idempotencyKey: randomId(),
                    after: newestGoalComment(stored),
                    serverAt: scope.serverClock.lastDate(),
                }),
            )
            .catch((caught: unknown) => {
                if (caught instanceof ScheduleWriteError) {
                    setError(caught.message);
                    return;
                }
                console.warn('[schedules] the comment was not queued', caught);
                setError('Couldn’t save. Try again.');
            });
    };
    return (
        <View className="gap-2" testID={`goal-${row.id}-thread`}>
            {row.comments.length === 0 ? (
                <Text variant="footnote" tone="muted">
                    No comments yet.
                </Text>
            ) : (
                row.comments.map((comment) => (
                    <View key={comment.id} accessible className="gap-0.5 rounded-lg border border-border p-3">
                        <Text variant="footnote" tone="muted">
                            {comment.who}
                        </Text>
                        <Text>{comment.body}</Text>
                        {comment.pending === null ? null : (
                            <Text variant="footnote" tone="muted">
                                {comment.pending}
                            </Text>
                        )}
                    </View>
                ))
            )}
            {row.open ? (
                <>
                    <Field
                        label="Add a comment"
                        placeholder={`Add context or a changed requirement for ${row.socio}`}
                        value={draft.text}
                        onChangeText={draft.setText}
                        multiline
                        maxLength={GOAL_COMMENT_MAX}
                        editable={!draft.locked}
                        error={error ?? undefined}
                        testID={`goal-${row.id}-box`}
                    />
                    <View className="flex-row justify-end">
                        <Button
                            label="Comment"
                            disabled={draft.text.trim() === '' || draft.locked || !scope.userDb.writable}
                            onPress={send}
                            testID={`goal-${row.id}-send`}
                        />
                    </View>
                </>
            ) : null}
        </View>
    );
}

// ---- A schedule's page ----------------------------------------------------------

export function ScheduleScreen({ route }: StaticScreenProps<{ scheduleId: string }>) {
    return useHasWorkspaceScope() ? (
        <Schedule id={route.params.scheduleId} />
    ) : (
        <Unscoped title="Schedule" testID="schedule-screen" />
    );
}

/**
 * Older runs read online with "Load more" (never kept), after the detail's
 * first page. They start again when the first page changes (a refresh), and a
 * second tap while one is read asks nothing.
 */
function useOlderRuns<T extends { id: string }>(
    firstPage: readonly T[],
    more: boolean,
    read: (before: string) => Promise<{ runs: T[]; more: boolean }>,
) {
    const key = firstPageKey(firstPage);
    const [kept, setOlder] = useState<OlderRuns<T>>({ after: key, runs: [], more: false });
    const older = olderRunsFor(kept, key);
    const loading = useRef(false);
    const [problem, setProblem] = useState<string | null>(null);
    const runs = [...firstPage, ...older.runs];
    const hasMore = older.runs.length > 0 ? older.more : more;
    const loadMore = () => {
        const last = runs.at(-1);
        if (last === undefined || loading.current) {
            return;
        }
        loading.current = true;
        setProblem(null);
        read(last.id)
            .then(
                (page) => setOlder((shown) => withOlderPage(olderRunsFor(shown, key), key, page)),
                () =>
                    void online(false).then((connected) =>
                        setProblem(connected === false ? OLDER_RUNS_OFFLINE : 'Couldn’t load older runs. Try again.'),
                    ),
            )
            .finally(() => {
                loading.current = false;
            });
    };
    return { runs, hasMore, loadMore, problem };
}

function Schedule({ id }: { id: string }) {
    const navigation = useNavigation();
    const scope = useWorkspaceScope();
    const { outbox, scheduleDetails } = scope;
    useSyncOnFocus(SCHEDULES_KIND.collections);
    const data = useShownSchedules();
    const item = useScheduleDetail('schedules', id);
    const shown = data.shown.schedules.find((schedule) => schedule.id === id) ?? null;
    const goalId = item.value?.goal?.id ?? null;
    const shownGoal: ShownGoal | null =
        data.shown.goals.find((goal) => goal.id === goalId || goal.scheduleId === id) ?? null;
    const view = scheduleDetailView(item, shown, shownGoal);
    const refresh = () => void scheduleDetails.schedules.item(id).refresh();
    const action = useOnlineAction(refresh);
    const openChat = useOpenChat();
    // The list's row moved on (its 10 s poll, a write): read the detail again, never on a timer of its own.
    useRefreshOnRowChange(scheduleSignature(shown), () => void scheduleDetails.schedules.peek(id)?.refresh());
    const older = useOlderRuns(
        scheduleRunRows(item.value?.runs ?? []),
        item.value?.moreRuns === true,
        async (before) => {
            const page = await readOlderScheduleRuns(scope.fetch, { scheduleId: id, before });
            return { runs: [...scheduleRunRows(page.runs)], more: page.more };
        },
    );
    const goalRowShown = view.goal === null ? null : (goalRows([view.goal], data.shown.schedules)[0] ?? null);
    useNativeBar({ title: view.title ?? 'Schedule' });
    return (
        <View testID="schedule-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
                {...keyboardScroll(Platform.OS)}
            >
                <StatusBanners />
                <DetailEmpty state={view.state} testID="schedule-detail" />
                {view.schedule === null ? null : (
                    <>
                        <Text variant="footnote" tone="muted">
                            {view.what}
                        </Text>
                        <Age age={view.age} testID="schedule-age" />
                        <Card testID="schedule-purpose">
                            <SectionTitle>Purpose</SectionTitle>
                            <Text selectable>{view.purpose}</Text>
                        </Card>
                        {goalRowShown === null ? null : (
                            <View className="gap-2" testID="schedule-goal">
                                <SectionTitle>Goal progress</SectionTitle>
                                <GoalCard row={goalRowShown} stored={item.value?.goal ?? null} />
                            </View>
                        )}
                        <Card testID="schedule-facts">
                            <SectionTitle>What it does</SectionTitle>
                            {view.facts.map((fact) => (
                                <Fact key={fact.label} label={fact.label} value={fact.value} />
                            ))}
                            {view.standing === null ? null : (
                                <Fact label="Status" value={`${view.standing.label}. ${view.standing.note}`} />
                            )}
                            {view.pending === null ? null : (
                                <Text variant="footnote" tone="muted" testID="schedule-pending">
                                    {view.pending}
                                </Text>
                            )}
                            <ScheduleButtons
                                id={id}
                                buttons={view.buttons}
                                busy={action.busy}
                                testID="schedule"
                                onRunNow={() =>
                                    action.run(`run:${id}`, (context) =>
                                        runScheduleNow(context, {
                                            scheduleId: id,
                                            settings: data.settings,
                                            status: view.schedule?.status ?? null,
                                        }),
                                    )
                                }
                                onAct={(what) =>
                                    void actOnSchedule(outbox, { scheduleId: id, action: what, newId: randomId }).catch(
                                        (error: unknown) => console.warn('[schedule] not queued', error),
                                    )
                                }
                            />
                            <Notice words={action.notice} testID="schedule-notice" />
                        </Card>
                        <View className="gap-2" testID="schedule-runs">
                            <SectionTitle>What it has done</SectionTitle>
                            {older.runs.length === 0 ? (
                                <Text variant="subheadline" tone="muted">
                                    {NO_RUNS}
                                </Text>
                            ) : null}
                            {older.runs.map((run) => (
                                <RunCard
                                    key={run.id}
                                    run={run}
                                    onChat={(path) => {
                                        const chat = /^\/chats\/([^/#?]+)/.exec(path)?.[1];
                                        if (chat !== undefined) {
                                            openChat({ id: decodeURIComponent(chat), room: false });
                                        }
                                    }}
                                    onIssue={(key) => navigation.dispatch(issueAction(key))}
                                />
                            ))}
                            {older.hasMore ? (
                                <Button
                                    variant="secondary"
                                    label="Load more"
                                    onPress={older.loadMore}
                                    testID="schedule-runs-more"
                                />
                            ) : null}
                            <Notice words={older.problem} testID="schedule-runs-problem" />
                        </View>
                    </>
                )}
            </ScrollView>
        </View>
    );
}

function RunCard(props: { run: RunRow; onChat: (path: string) => void; onIssue: (key: string) => void }) {
    const { run } = props;
    return (
        <Card testID={`run-${run.id}`}>
            <Text weight="medium">{run.head}</Text>
            {run.text === null ? null : (
                <Text variant="subheadline" tone="muted">
                    {run.text}
                </Text>
            )}
            {run.turnPath === null && run.board.length === 0 ? null : (
                <View className="flex-row flex-wrap gap-2">
                    {run.turnPath === null ? null : (
                        <Button variant="ghost" label="Open in chat" onPress={() => props.onChat(run.turnPath!)} />
                    )}
                    {run.board.map((entry) => (
                        <Button
                            key={entry.words}
                            variant="ghost"
                            label={entry.words}
                            onPress={() => props.onIssue(entry.issue)}
                        />
                    ))}
                </View>
            )}
        </Card>
    );
}

// ---- A job's page ---------------------------------------------------------------

export function JobScreen({ route }: StaticScreenProps<{ jobId: string }>) {
    return useHasWorkspaceScope() ? <Job id={route.params.jobId} /> : <Unscoped title="Job" testID="job-screen" />;
}

function Job({ id }: { id: string }) {
    const scope = useWorkspaceScope();
    const { scheduleDetails } = scope;
    useSyncOnFocus(SCHEDULES_KIND.collections);
    const data = useShownSchedules();
    const item = useScheduleDetail('jobs', id);
    const row = data.jobs.find((job) => job.id === id) ?? null;
    const view = jobDetailView(item, row);
    const refresh = () => void scheduleDetails.jobs.item(id).refresh();
    const action = useOnlineAction(refresh);
    useRefreshOnRowChange(jobSignature(row), () => void scheduleDetails.jobs.peek(id)?.refresh());
    const older = useOlderRuns<JobRunView>(item.value?.runs ?? [], item.value?.moreRuns === true, (before) =>
        readOlderJobRuns(scope.fetch, { jobId: id, before }),
    );
    const [logs, setLogs] = useState<{ readonly run: JobRunView | null; readonly problem: string | null }>({
        run: null,
        problem: null,
    });
    const showLogs = (runId: string) => {
        setLogs({ run: null, problem: null });
        readJobRun(scope.fetch, runId).then(
            (run) => setLogs({ run, problem: null }),
            () =>
                void online(false).then((connected) =>
                    setLogs({
                        run: null,
                        problem: connected === false ? 'Logs need a connection.' : 'Couldn’t load the logs. Try again.',
                    }),
                ),
        );
    };
    useNativeBar({ title: view.name ?? 'Job' });
    return (
        <View testID="job-screen" className="flex-1 bg-screen" collapsable={false}>
            <ScrollView
                contentInsetAdjustmentBehavior="automatic"
                className="flex-1"
                contentContainerClassName="gap-4 p-4"
                {...keyboardScroll(Platform.OS)}
            >
                <StatusBanners />
                <DetailEmpty state={view.state} testID="job-detail" />
                {view.name === null ? null : (
                    <>
                        <Text variant="footnote" tone="muted">
                            {view.line}
                        </Text>
                        <Age age={view.age} testID="job-age" />
                        <Card testID="job-progress">
                            <SectionTitle>Progress</SectionTitle>
                            <Text>{view.progress ?? 'Not running'}</Text>
                            <View className="flex-row flex-wrap gap-2">
                                {view.going ? (
                                    <Button
                                        variant="destructive"
                                        label="Stop"
                                        busy={action.busy === 'stop'}
                                        disabled={action.busy !== null}
                                        accessibilityHint="Stops the running job. Needs a connection"
                                        onPress={() => action.run('stop', (context) => stopJob(context, { jobId: id }))}
                                        testID="job-stop"
                                    />
                                ) : (
                                    <Button
                                        variant="secondary"
                                        label="Run now"
                                        busy={action.busy === 'run'}
                                        disabled={action.busy !== null}
                                        accessibilityHint="Needs a connection"
                                        onPress={() =>
                                            action.run('run', (context) =>
                                                runJobNow(context, { jobId: id, settings: data.settings }),
                                            )
                                        }
                                        testID="job-run"
                                    />
                                )}
                            </View>
                            <Notice words={action.notice} testID="job-notice" />
                        </Card>
                        {view.versions.length === 0 ? null : (
                            <Card testID="job-versions">
                                <SectionTitle>Versions</SectionTitle>
                                {view.versions.map((version) => (
                                    <Text key={version} variant="footnote" tone="muted">
                                        {version}
                                    </Text>
                                ))}
                            </Card>
                        )}
                        <View className="gap-2" testID="job-runs">
                            <SectionTitle>Runs</SectionTitle>
                            {older.runs.length === 0 ? (
                                <Text variant="subheadline" tone="muted">
                                    {NO_RUNS}
                                </Text>
                            ) : null}
                            {jobRunRows(older.runs).map((run) => (
                                <Card key={run.id} testID={`job-run-${run.id}`}>
                                    <Text weight="medium">{run.head}</Text>
                                    <Text variant="footnote" tone="muted">
                                        {run.line}
                                    </Text>
                                    <Button
                                        variant="ghost"
                                        label="Logs"
                                        accessibilityHint="Needs a connection"
                                        onPress={() => showLogs(run.id)}
                                    />
                                    {logs.run?.id === run.id ? <Logs run={logs.run} /> : null}
                                </Card>
                            ))}
                            {older.hasMore ? (
                                <Button
                                    variant="secondary"
                                    label="Load more"
                                    onPress={older.loadMore}
                                    testID="job-runs-more"
                                />
                            ) : null}
                            <Notice words={older.problem ?? logs.problem} testID="job-runs-problem" />
                        </View>
                        <WebRow label={JOB_ON_WEB} href="/schedules?tab=jobs" testID="job-web" />
                    </>
                )}
            </ScrollView>
        </View>
    );
}

function Logs({ run }: { run: JobRunView }) {
    return (
        <View className="gap-1" testID="job-logs">
            <Text variant="footnote" tone="muted">
                {`${statusWord(run.status)} · ${scheduleTime(run.startedAt ?? run.queuedAt)}${run.error ? ` · ${run.error}` : ''}`}
            </Text>
            {run.outputNotKept !== undefined ? (
                <Text variant="footnote" tone="muted">
                    {run.outputNotKept}
                </Text>
            ) : (
                <>
                    <Text variant="footnote" tone="muted">
                        stdout
                    </Text>
                    <Text variant="footnote" selectable className="rounded-md border border-border p-2">
                        {run.stdout || '(empty)'}
                    </Text>
                    <Text variant="footnote" tone="muted">
                        stderr
                    </Text>
                    <Text variant="footnote" selectable className="rounded-md border border-border p-2">
                        {run.stderr || '(empty)'}
                    </Text>
                </>
            )}
        </View>
    );
}
