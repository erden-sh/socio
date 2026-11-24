import { characterOf, type LocalId } from '@socio/shared/mascot';
import type { GoalView, ScheduleView } from '@socio/shared/schedule-types';
import type { Conversation, Dot, DotRun, State } from '@socio/shared/types';

import { byNewest, isRoom, roomsOn, UNTITLED_CHAT } from './chat-list';
import { NO_INSTRUCTIONS, SOCIO_STATE_LABEL, type SocioState, socioState } from './home';
import { RUN_STATUS_LABEL } from './runs';
import { relativeTime, scheduleTime } from './schedules';

// A socio's page (CB-431; the web's DotHome, `/dots/:dotId`, CB-89), as an
// inset grouped list (Settings', Contacts'): its avatar, name, what it is doing
// now and its description, then Start a chat and the shortcuts the web's
// dashboard has: Now (its turns running, its tasks running), its chats (active,
// then archived), Scheduled (its goals and schedules, soonest first, with their
// next runs) and Recent turns. Everything comes from what the phone holds (the
// shell, the chats, the `schedules` kind), except the turns: the web's own
// `GET /api/dots/:id/runs` (the person's own chats' latest 10), read online as
// the page opens (src/sync/socio-runs.ts). No React Native, so tests/shell
// runs it under Node. Never "Dot" in copy (10.2).

/** Rows a chats section shows before its "Show all". */
export const SOCIO_CHATS_SHOWN = 3;
/** Recent turns shown, as the web's panel. */
export const SOCIO_RECENT_RUNS = 5;

export const SOCIO_START_CHAT = 'Start a chat';
export const SOCIO_ARCHIVED = 'This socio is archived. You can read its chats and history; it no longer answers.';
export const SOCIO_RUNS_OFFLINE = 'Its turns show once you’re online.';
export const SOCIO_RUNS_FAILED = 'Couldn’t load its turns.';
export const SOCIO_RUNS_LOADING = 'Loading its turns…';

export interface SocioPageRow {
    readonly key: string;
    readonly title: string;
    readonly detail: string | null;
    readonly target:
        | { readonly kind: 'chat'; readonly id: string; readonly room: boolean }
        | { readonly kind: 'schedule'; readonly id: string }
        | { readonly kind: 'task'; readonly id: string }
        | { readonly kind: 'schedules' }
        | { readonly kind: 'runs' }
        | null;
    readonly accessibilityLabel: string;
}

export interface SocioPageSection {
    readonly id: 'now' | 'chats' | 'archived' | 'scheduled' | 'recent';
    readonly title: string;
    readonly rows: readonly SocioPageRow[];
    /** What the section says with no rows. */
    readonly empty: string;
    /** Rows past what it shows ("Show all 7"), for a chats section; 0 otherwise. */
    readonly more: number;
    /** A last row to the module's own page (All schedules, All runs), or null. */
    readonly footer: SocioPageRow | null;
}

export interface SocioPageView {
    readonly id: string;
    readonly name: string;
    readonly character: LocalId;
    readonly description: string;
    readonly state: SocioState;
    readonly stateLabel: string;
    /** What it is doing while it works (a task's or a turn's title), else null. */
    readonly doing: string | null;
    readonly archived: boolean;
    readonly sections: readonly SocioPageSection[];
    readonly accessibilityLabel: string;
}

/** The turns' read: not yet answered, answered, or failed (offline or refused). */
export type SocioRuns =
    | { readonly kind: 'loading' }
    | { readonly kind: 'ok'; readonly runs: readonly DotRun[] }
    | { readonly kind: 'offline' }
    | { readonly kind: 'failed' };

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

const chatTitle = (chat: Conversation) => text(chat.title) ?? UNTITLED_CHAT;

function chatRow(chat: Conversation, now: number, timeZone?: string): SocioPageRow {
    const room = isRoom(chat);
    const title = chatTitle(chat);
    const detail = chat.team ? 'Team' : room ? 'Room' : relativeTime(chat.archivedAt ?? chat.createdAt, now, timeZone);
    return {
        key: `chat-${chat.id}`,
        title,
        detail,
        target: { kind: 'chat', id: chat.id, room },
        accessibilityLabel: `${title}, ${detail}`,
    };
}

const runTitle = (run: Pick<DotRun, 'title'>) => text(run.title) ?? UNTITLED_CHAT;

/**
 * The page, from the socio, the shell's state, the shown chats, the turns'
 * read, and the `schedules` kind's goals and schedules. `expanded` names the
 * chat sections opened past their first rows. Null for a socio the phone
 * doesn't hold.
 */
export function socioPage(input: {
    readonly socioId: string;
    readonly dots: readonly Dot[];
    readonly state: Pick<State, 'settings' | 'tasks'> | null | undefined;
    readonly chats: readonly Conversation[];
    readonly runs: SocioRuns;
    readonly schedules: readonly ScheduleView[];
    readonly goals: readonly GoalView[];
    readonly expanded?: ReadonlySet<'chats' | 'archived'>;
    readonly now: number;
    readonly timeZone?: string;
}): SocioPageView | null {
    const dot = input.dots.find((one) => one.id === input.socioId);
    if (dot === undefined) {
        return null;
    }
    const { now, timeZone } = input;
    const runs = input.runs.kind === 'ok' ? input.runs.runs : [];
    const runningRuns = runs.filter((run) => run.status === 'running');
    const runningTasks = (input.state?.tasks ?? []).filter(
        (task) => task.dotId === dot.id && task.status === 'running',
    );
    // The web's dotState with its turns: Working while a turn of its runs too.
    const base = socioState(dot.id, input.state);
    const state: SocioState = base === 'idle' && runningRuns.length > 0 ? 'working' : base;
    const firstTask = runningTasks[0];
    const firstRun = runningRuns[0];
    const doing =
        state !== 'working'
            ? null
            : firstTask !== undefined
              ? (text(firstTask.title) ?? text(firstTask.prompt))
              : firstRun !== undefined
                ? runTitle(firstRun)
                : null;
    const rooms = roomsOn(input.state);
    const mine = input.chats
        .filter((chat) => chat.dotId === dot.id && (!isRoom(chat) || rooms))
        .slice()
        .sort(byNewest);
    const active = mine.filter((chat) => chat.archivedAt === undefined || chat.archivedAt === null);
    const archived = mine
        .filter((chat) => chat.archivedAt !== undefined && chat.archivedAt !== null)
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    const shown = (id: 'chats' | 'archived', list: readonly Conversation[]) =>
        input.expanded?.has(id) === true ? list : list.slice(0, SOCIO_CHATS_SHOWN);
    const now_: SocioPageRow[] = [
        ...runningTasks.map((task) => {
            const title = text(task.title) ?? text(task.prompt) ?? 'Scheduled task';
            return {
                key: `task-${task.id}`,
                title,
                detail: 'Scheduled task · Running',
                target: { kind: 'task' as const, id: task.id },
                accessibilityLabel: `${title}, scheduled task, running`,
            };
        }),
        ...runningRuns.map((run) => {
            const title = runTitle(run);
            const detail = `Running · started ${relativeTime(run.startedAt, now, timeZone).toLowerCase()}`;
            return {
                key: `run-${run.runId}`,
                title,
                detail,
                target: { kind: 'chat' as const, id: run.threadId, room: false },
                accessibilityLabel: `${title}, ${detail}`,
            };
        }),
    ];
    // Its goals still going, then its schedules that will run again (not a goal's own), soonest first: the web's DotPlans.
    const goals = input.goals.filter(
        (goal) => goal.dotId === dot.id && goal.status !== 'cancelled' && goal.status !== 'done',
    );
    const goalSchedules = new Set(input.goals.map((goal) => goal.scheduleId));
    const schedules = input.schedules
        .filter(
            (item) =>
                item.dotId === dot.id &&
                !goalSchedules.has(item.id) &&
                item.status !== 'cancelled' &&
                item.status !== 'completed',
        )
        .slice()
        .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER));
    const nextRun = (at: number | null, status: string) =>
        status === 'paused' ? 'Paused' : at === null ? 'Not scheduled' : `Next run ${scheduleTime(at, timeZone)}`;
    const scheduled: SocioPageRow[] = [
        ...goals.map((goal) => {
            const detail = `Goal · ${nextRun(goal.nextRunAt, goal.status)}`;
            return {
                key: `goal-${goal.id}`,
                title: goal.title,
                detail,
                target: { kind: 'schedule' as const, id: goal.scheduleId },
                accessibilityLabel: `${goal.title}, ${detail}`,
            };
        }),
        ...schedules.map((item) => {
            const detail =
                item.cadence === null
                    ? nextRun(item.nextRunAt, item.status)
                    : `${capital(item.cadence)} · ${nextRun(item.nextRunAt, item.status)}`;
            return {
                key: `schedule-${item.id}`,
                title: item.title,
                detail,
                target: { kind: 'schedule' as const, id: item.id },
                accessibilityLabel: `${item.title}, ${detail}`,
            };
        }),
    ];
    // Its scheduled tasks the shell holds (`State.tasks`, Scheduled & activity's) that no schedule
    // row above names: a task that will run again, soonest first.
    const named = new Set([...schedules.map((item) => item.id), ...goalSchedules]);
    const tasks = (input.state?.tasks ?? [])
        .filter(
            (task) =>
                task.dotId === dot.id &&
                !named.has(task.id) &&
                task.status !== 'running' &&
                task.status !== 'cancelled' &&
                (task.status !== 'completed' || task.nextRunAt !== null),
        )
        .slice()
        .sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER));
    for (const task of tasks) {
        const title = text(task.title) ?? text(task.prompt) ?? 'Scheduled task';
        const cadence = text(task.cadence);
        const next = nextRun(task.nextRunAt, task.status);
        const detail = cadence === null ? next : `${capital(cadence)} · ${next}`;
        scheduled.push({
            key: `task-${task.id}`,
            title,
            detail,
            target: { kind: 'task', id: task.id },
            accessibilityLabel: `${title}, ${detail}`,
        });
    }
    const recent: SocioPageRow[] = runs
        .filter((run) => run.status !== 'running')
        .slice(0, SOCIO_RECENT_RUNS)
        .map((run) => {
            const title = runTitle(run);
            const when = relativeTime(run.startedAt, now, timeZone);
            const detail = run.status === 'finished' ? when : `${RUN_STATUS_LABEL[run.status]} · ${when}`;
            return {
                key: `recent-${run.runId}`,
                title,
                detail,
                target: { kind: 'chat' as const, id: run.threadId, room: false },
                accessibilityLabel: `${title}, ${detail}`,
            };
        });
    const runsEmpty =
        input.runs.kind === 'loading'
            ? SOCIO_RUNS_LOADING
            : input.runs.kind === 'offline'
              ? SOCIO_RUNS_OFFLINE
              : input.runs.kind === 'failed'
                ? SOCIO_RUNS_FAILED
                : null;
    const archivedSocio = dot.archivedAt !== undefined && dot.archivedAt !== null;
    const sections: SocioPageSection[] = [
        { id: 'now', title: 'Now', rows: now_, empty: runsEmpty ?? 'Nothing running', more: 0, footer: null },
        {
            id: 'chats',
            title: 'Chats',
            rows: shown('chats', active).map((chat) => chatRow(chat, now, timeZone)),
            empty: archivedSocio ? 'No active chats' : `Your chats with ${dot.name} will live here`,
            more: active.length - shown('chats', active).length,
            footer: null,
        },
        {
            id: 'archived',
            title: 'Archived chats',
            rows: shown('archived', archived).map((chat) => chatRow(chat, now, timeZone)),
            empty: 'Chats you archive wait here',
            more: archived.length - shown('archived', archived).length,
            footer: null,
        },
        {
            id: 'scheduled',
            title: 'Scheduled',
            rows: scheduled,
            empty: 'Nothing scheduled',
            more: 0,
            footer: {
                key: 'all-schedules',
                title: 'All schedules',
                detail: null,
                target: { kind: 'schedules' },
                accessibilityLabel: 'All schedules',
            },
        },
        {
            id: 'recent',
            title: 'Recent turns',
            rows: recent,
            empty: runsEmpty ?? 'No turns yet',
            more: 0,
            footer: {
                key: 'all-runs',
                title: 'All runs',
                detail: null,
                target: { kind: 'runs' },
                accessibilityLabel: 'All runs',
            },
        },
    ];
    const stateLabel = SOCIO_STATE_LABEL[state];
    const description = text(dot.instructions) ?? NO_INSTRUCTIONS;
    return {
        id: dot.id,
        name: dot.name,
        character: characterOf(dot),
        description,
        state,
        stateLabel,
        doing,
        archived: archivedSocio,
        sections,
        accessibilityLabel: `${dot.name}, ${stateLabel}${doing === null ? '' : `: ${doing}`}`,
    };
}

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** "Working on “Weekly digest”", "Idle", "Paused": the status line under the name. */
export const socioStatusLine = (view: Pick<SocioPageView, 'stateLabel' | 'doing'>) =>
    view.doing === null ? view.stateLabel : `${view.stateLabel} on “${view.doing}”`;
