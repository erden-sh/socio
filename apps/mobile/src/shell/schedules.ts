import { compareText, lowerText } from '@socio/shared/locale';
import type {
    JobDetail,
    JobRunView,
    JobView,
    LongRunView,
    ScheduleDetail,
    ScheduleRunView,
    ScheduleView,
} from '@socio/shared/schedule-types';
import type { Detail, Settings, Status, Task } from '@socio/shared/types';

import type { BoundedItemState } from '../sync/bounded-kind';
import { OUTBOX_COPY } from '../sync/outbox';
import type { OverlayItem } from '../sync/outbox-overlay';
import { runNowBlocked, type ShownGoal, type ShownSchedule, type TaskAction } from '../sync/schedule-writes';
import type { ToneName } from '../theme/theme';
import { searchEmpty, type SearchEmptyView } from '../ui/search-empty';

import { UNSENT_FALLBACK, UNSENT_REASON_COPY } from './unsent';

// Scheduled & activity and Schedules, the web's ActivityPage, SchedulesPage
// and SchedulePage on a phone, with no React Native: tests/shell runs them under
// Node.
//
// - Scheduled & activity: the shell's `state.tasks` (newest first, as the
//   server lists them), searched over the prompt as the web does; a task's
//   detail from the `task-details` bounded kind.
// - Schedules & jobs: the `schedules`, `goals` and `jobs` collections with
//   the schedule writes laid over (`shownSchedules`), in the server's orders
//   (schedules and goals newest first, jobs by `updatedAt`), since a
//   collection keeps none; a schedule's and a job's detail from their bounded
//   kinds, offline with their age.
// - What the phone may do (the owner, 2026-11-08): a schedule's Pause,
//   Resume and Cancel through the outbox; Run now, a task's Pause and Cancel
//   and Stop on a running job online only; a job's code, versions and delete,
//   and a task's repeat interval, open the web. Nothing is created or edited.
// Never "Dot" in copy: the person's agents are socios.

export const ACTIVITY_TITLE = 'Scheduled & activity';
/** Scheduled & activity's big title, the web ActivityPage's. */
export const ACTIVITY_HEADING = 'A little follow-through.';
export const ACTIVITY_INTRO = 'Scheduled turns run on the server in their original conversation.';
export const ACTIVITY_EMPTY_TITLE = 'Let a thought come back around.';
export const ACTIVITY_EMPTY_LINE = 'Open a conversation and use the clock button to schedule a server-side task.';
export const SCHEDULES_TITLE = 'Schedules & jobs';
export const SCHEDULES_INTRO =
    'Recurring work your socios do for you. A schedule runs a socio turn or a job: code a socio saved, run in its computer without the model. You can pause or cancel any of them here.';
export const NO_SCHEDULES =
    'No schedules yet. Ask a socio to do something regularly, or use the clock button in a conversation.';
export const NO_JOBS =
    'No jobs yet. A socio saves one with your approval when it needs to collect something regularly.';
export const NO_RUNS = 'No runs yet.';
export const OPENS_IN_BROWSER = 'Opens in your browser';
export const DETAIL_OFFLINE = 'This shows once you’re online.';
export const DETAIL_GONE = 'It may have been deleted, or it isn’t yours.';
export const OLDER_RUNS_OFFLINE = 'Older runs need a connection.';
/** What opens the web from a job: the one job action on the phone is Stop. */
export const JOB_ON_WEB = 'Code, versions and delete';
/** What opens the web from a task: its repeat interval. */
export const TASK_REPEAT_ON_WEB = 'Repeat interval';

const DEFAULT_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** "Nov 8, 2026, 3:45 PM", the web's `dateTime`. */
export const scheduleTime = (ms: number, timeZone?: string): string =>
    new Date(ms).toLocaleString('en-US', { ...DEFAULT_TIME, ...(timeZone === undefined ? {} : { timeZone }) });

/** "Just now", "5m ago", "3h ago", else the date: the web's task row's `relative`. */
export function relativeTime(at: number, now: number, timeZone?: string): string {
    const minutes = Math.floor((now - at) / 60_000);
    if (minutes < 1) {
        return 'Just now';
    }
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    if (minutes < 1440) {
        return `${Math.floor(minutes / 60)}h ago`;
    }
    return new Date(at).toLocaleDateString('en-US', timeZone === undefined ? {} : { timeZone });
}

/** A repeat interval in words, the web's `every`. */
export const every = (seconds: number): string =>
    seconds === 604_800
        ? 'every week'
        : seconds === 86_400
          ? 'every day'
          : seconds === 3600
            ? 'every hour'
            : seconds % 3600 === 0
              ? `every ${seconds / 3600} hours`
              : `every ${Math.round(seconds / 60)} min`;

/** "350 ms", "4.2 s": the web's `seconds`. */
export const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`);
const took = (ms: number) => (ms < 60_000 ? seconds(ms) : `${Math.round(ms / 6_000) / 10} min`);

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A status's word: a run's `timed_out` reads "timed out". */
export const statusWord = (status: string): string => capital(status.replace('_', ' '));

/** The outbox's words for a write over a row, or null when none waits. */
function pendingWords(state: OverlayItem['state'] | null, reason: string | null): string | null {
    switch (state) {
        case null:
        case 'sent':
            return null;
        case 'unconfirmed':
            return OUTBOX_COPY.unconfirmed;
        case 'unsent':
            return reason === null ? UNSENT_FALLBACK : (UNSENT_REASON_COPY[reason] ?? UNSENT_FALLBACK);
        default:
            return OUTBOX_COPY.waitingToSend;
    }
}

/** "Saved Nov 8, 3:45 PM" over a copy the last read couldn't refresh, else null. */
export function detailAge(
    item: Pick<BoundedItemState<unknown>, 'failed' | 'fetchedAt'>,
    timeZone?: string,
): string | null {
    return item.failed && item.fetchedAt !== null ? `Saved ${scheduleTime(item.fetchedAt, timeZone)}` : null;
}

/** Where a detail stands: shown, waiting for its first read, gone, or offline with no copy. */
export type DetailState = 'ready' | 'loading' | 'gone' | 'offline';

export function detailState(item: Pick<BoundedItemState<unknown>, 'value' | 'gone' | 'settled'>): DetailState {
    if (item.value !== null) {
        return 'ready';
    }
    return item.gone ? 'gone' : item.settled ? 'offline' : 'loading';
}

// ---- Scheduled & activity -------------------------------------------------------

/** A task's status word, the web's `statusLabel`: a completed task with a next run is "Scheduled". */
export const taskStatusLabel = (task: Pick<Task, 'status' | 'nextRunAt'>): string =>
    task.status === 'completed' && task.nextRunAt ? 'Scheduled' : capital(task.status);

/**
 * A task's status chip's tone, the web's TaskPresentation STATUS_TONE: done
 * (and Scheduled) in emerald, running in indigo, failed and interrupted in rose,
 * paused in amber; null for the rest, which keep the neutral chip.
 */
export function taskStatusTone(status: Task['status']): ToneName | null {
    switch (status) {
        case 'completed':
            return 'emerald';
        case 'running':
            return 'indigo';
        case 'failed':
        case 'interrupted':
            return 'rose';
        case 'paused':
            return 'amber';
        default:
            return null;
    }
}

export interface TaskRow {
    readonly id: string;
    readonly title: string;
    readonly line: string;
    readonly status: string;
    readonly statusTone: ToneName | null;
    readonly testID: string;
    readonly accessibilityLabel: string;
}

/** Scheduled & activity's rows: the tasks whose prompt holds `query` (any case), as the web's list. */
export function activityRows(
    tasks: readonly Task[],
    query: string,
    now: number,
    timeZone?: string,
): readonly TaskRow[] {
    const words = query.toLowerCase();
    return tasks
        .filter((task) => task.prompt.toLowerCase().includes(words))
        .map((task) => {
            const repeat = task.intervalSeconds
                ? `Repeats every ${task.intervalSeconds < 3600 ? `${task.intervalSeconds / 60} min` : `${task.intervalSeconds / 3600} hr`} · `
                : '';
            const line = `${repeat}${relativeTime(task.updatedAt, now, timeZone)}`;
            const status = taskStatusLabel(task);
            return {
                id: task.id,
                title: task.prompt,
                line,
                status,
                statusTone: taskStatusTone(task.status),
                testID: `task-${task.id}`,
                accessibilityLabel: `${task.prompt}, ${status}, ${line}`,
            };
        });
}

export interface TaskButton {
    readonly action: TaskAction;
    readonly label: string;
    /** Why it can't go (a blocked Run now), for its hint; null when it can. */
    readonly blocked: string | null;
}

const BLOCKED_COPY: Readonly<Record<string, string>> = {
    paused: 'Socios are paused in this workspace',
    'research-off': 'Running now is turned off for this workspace',
    cancelled: 'That schedule was cancelled',
};

/**
 * A task's buttons, the web's TaskActions: Pause while it runs or waits, else
 * Run again (Retry, Resume) unless settings block it; Pause schedule for a
 * finished repeating one; Cancel unless cancelled. All online only. Its
 * repeat interval opens the web.
 */
export function taskButtons(
    task: Pick<Task, 'status' | 'intervalSeconds'>,
    settings: Pick<Settings, 'paused' | 'researchAllowed'> | null,
): readonly TaskButton[] {
    const buttons: TaskButton[] = [];
    if (task.status === 'running' || task.status === 'queued') {
        buttons.push({ action: 'pause', label: 'Pause task', blocked: null });
    } else {
        const why = runNowBlocked(settings);
        const label =
            task.status === 'interrupted'
                ? 'Retry after review'
                : task.status === 'failed'
                  ? 'Retry task'
                  : task.status === 'paused'
                    ? 'Resume task'
                    : 'Run again';
        buttons.push({ action: 'run', label, blocked: why === null ? null : BLOCKED_COPY[why]! });
    }
    if (task.status === 'completed' && !!task.intervalSeconds) {
        buttons.push({ action: 'pause', label: 'Pause schedule', blocked: null });
    }
    if (task.status !== 'cancelled') {
        buttons.push({ action: 'cancel', label: 'Cancel', blocked: null });
    }
    return buttons;
}

export interface TaskDetailView {
    readonly state: DetailState;
    readonly title: string | null;
    readonly prompt: string | null;
    readonly status: string | null;
    readonly error: string | null;
    /** The last six events' words, oldest first, as the web shows them. */
    readonly events: readonly string[];
    readonly runs: string | null;
    readonly age: string | null;
    readonly task: Task | null;
}

/** A task's detail: the bounded kind's copy, its status from the shell's newer row when there is one. */
export function taskDetailView(item: BoundedItemState<Detail>, row: Task | null, timeZone?: string): TaskDetailView {
    const detail = item.value;
    const task = detail === null ? row : row !== null && row.updatedAt >= detail.task.updatedAt ? row : detail.task;
    return {
        state: detail !== null || row !== null ? 'ready' : detailState(item),
        title: task === null ? null : (task.title ?? task.prompt.split('\n')[0] ?? ''),
        prompt: task?.prompt ?? null,
        status: task === null ? null : taskStatusLabel(task),
        error: task?.error ?? null,
        events: (detail?.events ?? []).slice(-6).map((event) => event.text),
        runs: detail === null ? null : detail.runs.length === 1 ? '1 saved run' : `${detail.runs.length} saved runs`,
        age: detailAge(item, timeZone),
        task,
    };
}

// ---- Schedules ------------------------------------------------------------------

const repeats = (schedule: Pick<ScheduleView, 'cadence' | 'intervalSeconds'>) =>
    !!schedule.cadence || !!schedule.intervalSeconds;

/** A schedule's buttons, the web's: none once cancelled; Run now unless running; Pause or Resume; Cancel. */
export type ScheduleButton = 'run' | 'pause' | 'resume' | 'cancel';
export function scheduleButtons(schedule: Pick<ScheduleView, 'status'>): readonly ScheduleButton[] {
    if (schedule.status === 'cancelled') {
        return [];
    }
    return [
        ...(schedule.status === 'running' ? [] : (['run'] as const)),
        schedule.status === 'paused' ? 'resume' : 'pause',
        'cancel',
    ];
}

export const SCHEDULE_BUTTON_LABEL: Readonly<Record<ScheduleButton, string>> = {
    run: 'Run now',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel',
};

/** What a schedule runs, in words. */
const scheduleWhat = (schedule: ScheduleView) =>
    [
        schedule.dotName ?? 'A deleted socio',
        schedule.kind === 'job' ? `job ${schedule.jobName ?? '(deleted)'}` : 'Socio turn',
        ...(schedule.origin === 'user' ? ['made by you'] : []),
    ].join(' · ');

/** When a schedule runs, the web's "Runs" column. */
const scheduleRuns = (schedule: ScheduleView) =>
    schedule.cadence
        ? `${schedule.cadence} (${schedule.timezone ?? 'UTC'})`
        : schedule.intervalSeconds
          ? `${capital(every(schedule.intervalSeconds))}, after each successful run`
          : null;

export interface ScheduleRow {
    readonly id: string;
    readonly title: string;
    readonly status: Status;
    readonly statusWord: string;
    readonly what: string;
    readonly runs: string | null;
    readonly next: string | null;
    readonly last: string | null;
    readonly pending: string | null;
    readonly buttons: readonly ScheduleButton[];
    readonly testID: string;
    readonly accessibilityLabel: string;
}

const byNewest = <T extends { createdAt: number; id: string }>(a: T, b: T) =>
    b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

export function scheduleRows(schedules: readonly ShownSchedule[], timeZone?: string): readonly ScheduleRow[] {
    return [...schedules].sort(byNewest).map((schedule) => {
        const last = schedule.lastRun
            ? `Last run ${statusWord(schedule.lastRun.status).toLowerCase()} ${scheduleTime(schedule.lastRun.startedAt, timeZone)}`
            : 'Not run yet';
        const next = schedule.nextRunAt ? `Next ${scheduleTime(schedule.nextRunAt, timeZone)}` : null;
        const what = scheduleWhat(schedule);
        const runs = scheduleRuns(schedule);
        const pending = pendingWords(schedule.pending, schedule.reason);
        return {
            id: schedule.id,
            title: schedule.title,
            status: schedule.status,
            statusWord: statusWord(schedule.status),
            what,
            runs,
            next,
            last,
            pending,
            buttons: scheduleButtons(schedule),
            testID: `schedule-${schedule.id}`,
            accessibilityLabel: [schedule.title, statusWord(schedule.status), what, runs, next, last, pending]
                .filter(Boolean)
                .join(', '),
        };
    });
}

// Schedules' search and filters, the web's schedules-format.ts (CB-392):
// the words match a schedule's title, socio or job; Status and Socio narrow it.

export const SCHEDULE_SEARCH_LABEL = 'Search title, socio or job';
export const NO_SCHEDULES_MATCH = 'No schedules match.';
/** The Socio filter's value for a schedule whose socio was deleted. */
export const DELETED_SOCIO = '__none';

/** The Status filter's words, the web's STATUS_LABELS (the schedule page's `standing()`). */
export const SCHEDULE_STATUS_LABELS: Readonly<Record<Status, string>> = {
    scheduled: 'Active',
    running: 'Running',
    queued: 'Queued',
    paused: 'Paused',
    failed: 'Stopped',
    interrupted: 'Interrupted',
    completed: 'Completed',
    cancelled: 'Canceled',
};

export interface ScheduleFilter {
    /** Free text over the title, socio and job. */
    readonly query: string;
    /** A status, or '' for any. */
    readonly status: Status | '';
    /** A socio's id, DELETED_SOCIO, or '' for any. */
    readonly socio: string;
}

export const ANY_SCHEDULE: ScheduleFilter = { query: '', status: '', socio: '' };

/** The filters off, the words kept: Clear filters (CB-552). */
export const ANY_SCHEDULE_FILTERS = { status: '', socio: '' } as const satisfies Omit<ScheduleFilter, 'query'>;

/** The line under Schedules' "no results" (CB-552). */
export const SCHEDULES_EMPTY_LINE = 'Try other words, or another status or socio.';

/**
 * What Schedules shows when its search and filters let no schedule through (CB-552): "No results
 * for “…”" while words are typed, the web's "No schedules match" for the filters alone, with Clear
 * search and Clear filters for what is set.
 */
export function schedulesEmpty(filter: ScheduleFilter): SearchEmptyView {
    const typed = filter.query.trim() !== '';
    return searchEmpty({
        query: filter.query,
        line: SCHEDULES_EMPTY_LINE,
        filtered: filter.status !== '' || filter.socio !== '',
        ...(typed ? {} : { title: NO_SCHEDULES_MATCH.replace(/\.$/, '') }),
    });
}

export interface FilterOption {
    /** '' for any. */
    readonly value: string;
    readonly label: string;
}

/** The Status filter's options: any, then each status in the web's order. */
export const SCHEDULE_STATUS_OPTIONS: readonly FilterOption[] = [
    { value: '', label: 'Status: any' },
    ...(Object.keys(SCHEDULE_STATUS_LABELS) as Status[]).map((status) => ({
        value: status,
        label: SCHEDULE_STATUS_LABELS[status],
    })),
];

/** The Socio filter's options: any, then each socio the schedules name, by name, the web's `dotOptions`. */
export function scheduleSocioOptions(
    schedules: readonly Pick<ScheduleView, 'dotId' | 'dotName'>[],
): readonly FilterOption[] {
    const seen = new Map<string, string>();
    for (const schedule of schedules) {
        const key = schedule.dotId ?? DELETED_SOCIO;
        if (!seen.has(key)) {
            seen.set(key, schedule.dotName ?? 'A deleted socio');
        }
    }
    const socios = [...seen.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => compareText(a.label, b.label));
    return [{ value: '', label: 'Socio: any' }, ...socios];
}

/** A filter button's words: "Status: any" while it's off, else "Status: Paused". */
export function filterButtonLabel(name: 'Status' | 'Socio', options: readonly FilterOption[], value: string): string {
    const chosen = value === '' ? undefined : options.find((option) => option.value === value);
    return chosen === undefined ? `${name}: any` : `${name}: ${chosen.label}`;
}

/** Whether a schedule shows under the filter, the web's `matches`. */
export function matchesSchedule(
    schedule: Pick<ScheduleView, 'title' | 'dotId' | 'dotName' | 'jobName' | 'status'>,
    filter: ScheduleFilter,
): boolean {
    const words = lowerText(filter.query.trim());
    return (
        (words === '' ||
            lowerText(`${schedule.title} ${schedule.dotName ?? ''} ${schedule.jobName ?? ''}`).includes(words)) &&
        (filter.status === '' || schedule.status === filter.status) &&
        (filter.socio === '' || (schedule.dotId ?? DELETED_SOCIO) === filter.socio)
    );
}

/** "2 of 10 active schedules. Runs are at least 15 minutes apart." */
export function scheduleLimitsLine(
    limits: { readonly maxActiveSchedules: number; readonly minIntervalMinutes: number } | null,
    usage: { readonly activeSchedules: number } | null,
): string | null {
    return limits === null || usage === null
        ? null
        : `${usage.activeSchedules} of ${limits.maxActiveSchedules} active schedules. Runs are at least ${limits.minIntervalMinutes} minutes apart.`;
}

// ---- Goals ----------------------------------------------------------------------

export interface GoalCommentRow {
    readonly id: string;
    readonly who: string;
    readonly body: string;
    readonly pending: string | null;
}

export interface GoalRow {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly line: string;
    readonly comments: readonly GoalCommentRow[];
    readonly commentsLabel: string;
    /** Comments are taken while the goal is open (the web's GoalComments). */
    readonly open: boolean;
    readonly socio: string;
    readonly goal: ShownGoal;
}

export function goalRows(
    goals: readonly ShownGoal[],
    schedules: readonly Pick<ScheduleView, 'dotId' | 'dotName'>[],
    timeZone?: string,
): readonly GoalRow[] {
    const socioOf = (id: string) => schedules.find((schedule) => schedule.dotId === id)?.dotName ?? 'A socio';
    return [...goals].sort(byNewest).map((goal) => {
        const socio = socioOf(goal.dotId);
        return {
            id: goal.id,
            title: goal.title,
            status: statusWord(goal.status),
            line: `${socio} · ${goal.cadence ?? 'no schedule'}${goal.progress ? ` · ${goal.progress}` : ' · no progress yet'}`,
            comments: goal.comments.map((comment) => ({
                id: comment.id,
                who: `${comment.author === 'person' ? 'You' : socio} · ${scheduleTime(comment.createdAt, timeZone)}`,
                body: comment.body,
                pending: comment.pending === 'unsent' ? 'Not sent' : pendingWords(comment.pending, comment.reason),
            })),
            commentsLabel: goal.comments.length === 1 ? '1 comment' : `${goal.comments.length} comments`,
            open: goal.status === 'active' || goal.status === 'paused',
            socio,
            goal,
        };
    });
}

// ---- Jobs -----------------------------------------------------------------------

/** Whether a job's long run is going (Run now is off, Stop is on). */
export const jobGoing = (job: { readonly longRun?: LongRunView | null }): boolean =>
    job.longRun?.status === 'running' || job.longRun?.status === 'waiting';

export interface JobRow {
    readonly id: string;
    readonly name: string;
    readonly line: string;
    readonly last: string;
    readonly going: boolean;
    readonly testID: string;
    readonly accessibilityLabel: string;
}

/** "412 of 726 done · 3 failed", a long run's items, the web's LongRunLine. */
export function longRunLine(run: LongRunView): string {
    const { done, total, failed } = run.items;
    return `${statusWord(run.status)} · ${total ? `${done} of ${total} done${failed ? ` · ${failed} failed` : ''}` : 'No items yet'}`;
}

export function jobRows(jobs: readonly JobView[], timeZone?: string): readonly JobRow[] {
    return [...jobs]
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
        .map((job) => {
            const line = [
                job.dotName ?? 'A deleted socio',
                job.entry,
                `v${job.version}`,
                `${job.timeoutSeconds} s`,
                ...(job.untilDone ? ['runs until done'] : []),
            ].join(' · ');
            const last = job.longRun
                ? longRunLine(job.longRun)
                : job.lastRun
                  ? `Last run ${statusWord(job.lastRun.status).toLowerCase()} ${scheduleTime(job.lastRun.startedAt ?? job.lastRun.queuedAt, timeZone)}`
                  : 'Never run';
            return {
                id: job.id,
                name: job.name,
                line,
                last,
                going: jobGoing(job),
                testID: `job-${job.id}`,
                accessibilityLabel: `${job.name}, ${line}, ${last}`,
            };
        });
}

// ---- Details --------------------------------------------------------------------

/** Where a schedule stands, in words: the web's `standing`. */
export function standing(schedule: Pick<ScheduleView, 'status' | 'error' | 'cadence' | 'intervalSeconds'>): {
    readonly label: string;
    readonly note: string;
} {
    switch (schedule.status) {
        case 'paused':
            return {
                label: 'Paused',
                note: schedule.error ?? 'It keeps its cadence and runs again once you resume it.',
            };
        case 'cancelled':
            return { label: 'Canceled', note: 'It won’t run again.' };
        case 'failed':
            return { label: 'Stopped', note: schedule.error ?? 'Its last run failed.' };
        case 'completed':
            if (!repeats(schedule)) {
                return { label: 'Completed', note: 'It ran and has nothing left.' };
            }
            break;
        case 'running':
            return { label: 'Active', note: 'Running now.' };
    }
    return { label: 'Active', note: 'It runs at its next time.' };
}

const BOARD_VERB: Readonly<Record<string, string>> = {
    create: 'Filed',
    comment: 'Commented on',
    vote: 'Voted for',
    unvote: 'Withdrew a vote on',
    update: 'Updated dependencies on',
};

export interface RunRow {
    readonly id: string;
    readonly head: string;
    readonly text: string | null;
    /** The turn in the schedule's chat, `/chats/<id>#…`, when kept. */
    readonly turnPath: string | null;
    readonly board: readonly { readonly issue: string; readonly words: string }[];
}

export function scheduleRunRows(runs: readonly ScheduleRunView[], timeZone?: string): readonly RunRow[] {
    return runs.map((run) => ({
        id: run.id,
        head: [
            statusWord(run.status),
            scheduleTime(run.startedAt, timeZone),
            ...(run.finishedAt ? [`took ${took(run.finishedAt - run.startedAt)}`] : []),
        ].join(' · '),
        text: run.summary ?? run.error,
        turnPath: run.turnPath,
        board: run.board.map((item) => ({
            issue: item.issue,
            words: `${BOARD_VERB[item.action] ?? 'Changed'} ${item.issue}`,
        })),
    }));
}

export interface ScheduleDetailView {
    readonly state: DetailState;
    readonly schedule: ShownSchedule | null;
    readonly title: string | null;
    readonly what: string | null;
    readonly standing: { readonly label: string; readonly note: string } | null;
    readonly purpose: string | null;
    readonly facts: readonly { readonly label: string; readonly value: string }[];
    readonly buttons: readonly ScheduleButton[];
    readonly pending: string | null;
    readonly goal: ShownGoal | null;
    readonly runs: readonly RunRow[];
    readonly age: string | null;
}

/**
 * A schedule's page, the web's SchedulePage: the held detail, its schedule
 * replaced by the list's shown row (the schedule writes' overlays, a newer
 * poll) when the phone holds one. Pause, Resume and Cancel only on a repeating
 * schedule.
 */
export function scheduleDetailView(
    item: BoundedItemState<ScheduleDetail>,
    shown: ShownSchedule | null,
    goal: ShownGoal | null,
    timeZone?: string,
): ScheduleDetailView {
    const detail = item.value;
    const schedule: ShownSchedule | null =
        shown ?? (detail === null ? null : { ...detail.schedule, pending: null, writeId: null, reason: null });
    if (schedule === null) {
        return {
            state: detailState(item),
            schedule: null,
            title: null,
            what: null,
            standing: null,
            purpose: null,
            facts: [],
            buttons: [],
            pending: null,
            goal: null,
            runs: [],
            age: null,
        };
    }
    const stored = detail?.goal ?? null;
    const held: ShownGoal | null =
        goal ??
        (stored === null
            ? null
            : { ...stored, comments: stored.comments.map((item) => ({ ...item, pending: null, reason: null })) });
    const facts: { label: string; value: string }[] = [
        { label: 'Socio', value: schedule.dotName ?? 'A deleted socio' },
        {
            label: 'Runs',
            value:
                detail?.cadenceText ??
                (schedule.intervalSeconds
                    ? `${capital(every(schedule.intervalSeconds))}, after each successful run`
                    : (schedule.cadence ?? 'Once')),
        },
    ];
    if (detail !== null) {
        facts.push({
            label: 'Next runs',
            value: detail.upcoming.length
                ? detail.upcoming.map((at) => scheduleTime(at, timeZone)).join('\n')
                : `None${schedule.status === 'paused' ? ' while paused' : ''}`,
        });
    } else if (schedule.nextRunAt) {
        facts.push({ label: 'Next run', value: scheduleTime(schedule.nextRunAt, timeZone) });
    }
    if (schedule.cadence) {
        facts.push({ label: 'Time zone', value: schedule.timezone ?? 'UTC' });
    }
    if (detail !== null) {
        facts.push({
            label: 'Approvals',
            value: detail.approvals.length
                ? `Its runs act without asking for ${detail.approvals
                      .map((entry) => `${entry.label} (${entry.policy === 'auto' ? 'auto review' : 'bypass'})`)
                      .join(', ')}; anything else waits for you.`
                : 'Anything that needs your approval waits for you.',
        });
    }
    const state = standing(schedule);
    return {
        state: 'ready',
        schedule,
        title: schedule.title,
        what: scheduleWhat(schedule),
        standing: state,
        purpose:
            schedule.kind === 'job'
                ? `Runs the job ${schedule.jobName ?? '(deleted)'} in the socio’s computer.`
                : held !== null
                  ? [held.title, held.detail].filter(Boolean).join('\n\n')
                  : schedule.prompt,
        facts,
        buttons: repeats(schedule) ? scheduleButtons(schedule) : [],
        pending: pendingWords(schedule.pending, schedule.reason),
        goal: held,
        runs: scheduleRunRows(detail?.runs ?? [], timeZone),
        age: detailAge(item, timeZone),
    };
}

export interface JobRunRow {
    readonly id: string;
    readonly head: string;
    readonly line: string;
}

export function jobRunRows(runs: readonly JobRunView[], timeZone?: string): readonly JobRunRow[] {
    return runs.map((run) => ({
        id: run.id,
        head: `${statusWord(run.status)} · ${scheduleTime(run.startedAt ?? run.queuedAt, timeZone)}`,
        line: [
            `${run.trigger === 'dot' ? 'the socio' : run.trigger} · v${run.version}${run.longRunId ? ' · batch' : ''}`,
            `exit ${run.exitCode ?? '—'}`,
            run.finishedAt && run.startedAt ? `took ${seconds(run.finishedAt - run.startedAt)}` : null,
        ]
            .filter(Boolean)
            .join(' · '),
    }));
}

export interface JobDetailView {
    readonly state: DetailState;
    readonly name: string | null;
    readonly line: string | null;
    readonly progress: string | null;
    readonly going: boolean;
    readonly versions: readonly string[];
    readonly runs: readonly JobRunRow[];
    readonly age: string | null;
}

/** A job's detail: its long run (with Stop while it goes), its versions in words, its first runs. */
export function jobDetailView(
    item: BoundedItemState<JobDetail>,
    row: JobView | null,
    timeZone?: string,
): JobDetailView {
    const detail = item.value;
    const job = detail?.job ?? row;
    if (job === null) {
        return {
            state: detailState(item),
            name: null,
            line: null,
            progress: null,
            going: false,
            versions: [],
            runs: [],
            age: null,
        };
    }
    const longRun = detail?.longRun ?? job.longRun ?? null;
    return {
        state: 'ready',
        name: job.name,
        line: [
            job.dotName ?? 'A deleted socio',
            job.entry,
            `${job.files.length} file(s)`,
            ...(job.untilDone ? ['runs until done'] : []),
        ].join(' · '),
        progress: longRun === null ? null : longRunLine(longRun),
        going: longRun !== null && jobGoing({ longRun }),
        versions: (detail?.versions ?? []).map(
            (version) =>
                `v${version.version} · ${scheduleTime(version.createdAt, timeZone)} · ${version.timeoutSeconds} s${version.untilDone ? ' per batch, until done' : ''}`,
        ),
        runs: jobRunRows(detail?.runs ?? [], timeZone),
        age: detailAge(item, timeZone),
    };
}

/** What the screen re-reads a detail on: its list row changed (a 10 s poll, an action's answer). */
export const scheduleSignature = (schedule: ScheduleView | null | undefined): string =>
    schedule === null || schedule === undefined
        ? ''
        : `${schedule.status}|${schedule.nextRunAt}|${schedule.lastRun?.startedAt}|${schedule.lastRun?.status}`;
export const jobSignature = (job: JobView | null | undefined): string =>
    job === null || job === undefined
        ? ''
        : `${job.updatedAt}|${job.lastRun?.id}|${job.lastRun?.status}|${job.longRun?.status}|${job.longRun?.items.done}`;

// ---- Reading a detail again, and older runs -------------------------------

/**
 * Whether a detail is read again as its list row moves from signature `before`
 * to `now`: only from one row's to another's. Opening reads it already, so the
 * first row seen (or a row arriving after the open) asks nothing more.
 */
export const refreshesDetail = (before: string, now: string): boolean => before !== '' && now !== '' && before !== now;

/** The older runs "Load more" added, under the first page they followed. */
export interface OlderRuns<T> {
    /** `firstPageKey` of the first page they follow. */
    readonly after: string;
    readonly runs: readonly T[];
    readonly more: boolean;
}

/** A first page's identity: its runs' ids, in order. */
export const firstPageKey = (runs: readonly { readonly id: string }[]): string => runs.map((run) => run.id).join(' ');

/** The older runs shown under first page `key`: none once the first page has moved on (they'd be out of step). */
export const olderRunsFor = <T>(older: OlderRuns<T>, key: string): OlderRuns<T> =>
    older.after === key ? older : { after: key, runs: [], more: false };

/** A page read after first page `key` added on; dropped when the first page moved on while it was read. */
export function withOlderPage<T>(
    older: OlderRuns<T>,
    key: string,
    page: { readonly runs: readonly T[]; readonly more: boolean },
): OlderRuns<T> {
    if (older.after !== key) {
        return older;
    }
    return { after: key, runs: [...older.runs, ...page.runs], more: page.more };
}
