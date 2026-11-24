import {
    GOAL_COMMENT_MAX,
    type GoalComment,
    type GoalView,
    type ScheduleView,
    type SchedulesState,
} from '@socio/shared/schedule-types';
import type { Settings, Status } from '@socio/shared/types';

import type { AuthedFetch } from '../net/authed-fetch';
import { NetworkError } from '../net/errors';

import type {
    CheckOutcome,
    NewOutboxWrite,
    Outbox,
    OutboxContext,
    OutboxKind,
    OutboxWrite,
    SendOutcome,
    Settled,
} from './outbox';
import { type Answer, type ClassifierAction, classify, readAnswer, reasonOf, type WriteMethod } from './outbox-answers';
import type { Overlay, OverlayItem, OverlayKind } from './outbox-overlay';
import { GOALS, SCHEDULES } from './schedules';
import { serverSince } from './server-clock';
import type { SnapshotCache } from './snapshot-cache';

// Schedules, goals and tasks writes: what the phone may do to the person's
// schedules, goals, jobs and scheduled tasks, against src/server/schedules/routes.ts and
// composition/http/turns.ts.
//
// - **Pause, resume and cancel a schedule** (`schedule-action`, `POST
//   /schedules/:id/actions`) are outbox rows in `schedule:<id>`, safe to
//   repeat: a later one folds into the lane's newest queued row (the newest
//   intent wins), except that a pause or resume never folds over a queued
//   cancel, and goes after it instead. A newer intent first discards the
//   lane's refused ones. A 409 (cancelled, or its socio archived: the server
//   tells them apart only in its text) goes to `unsent` in the app's words; a
//   404 is `unsent` for a pause or resume and done for a cancel.
// - **A comment on a goal** (`goal-comment`, `POST
//   /schedules/goals/:id/comments`, not safe to repeat) is 1 to
//   `GOAL_COMMENT_MAX` characters, trimmed as the server stores it, in
//   `goal:<id>`. A proxy's page, a plain 5xx or no answer is `unknown`, and
//   the check reads `/api/schedules` for exactly one of the person's
//   comments on that goal with that body, newer than the newest the phone
//   held and at or after `serverSince(serverAt)`, and no other write's
//   (`context.claimed`). Its id goes to `ids` (`goal-comment`).
// - **Online only, never queued or retried:** Run now (a schedule's, a
//   job's, a task's), a task's Pause and Cancel (the server aborts the task's
//   running turn on every action but `run`, so a late one would stop a run
//   the person never saw) and Stop on a running job (the
//   one job action the phone has; a job's code, versions and delete, and a
//   task's repeat interval, open the web). Offline they send nothing and say
//   "Needs a connection" (`ONLINE_ACTION_COPY`). Run now is refused before
//   sending while the workspace is paused or research is off
//   (`runNowBlocked`, as the web's TaskActions.tsx disables it).
//
// Each confirmed answer is handed to cache.db's `schedules` or `goals` before
// its row goes. Never the server's text: statuses and codes only.
// No React Native: tests/sync runs it under Node against a fake server.

export const SCHEDULE_ACTION_KIND = 'schedule-action';
export const GOAL_COMMENT_KIND = 'goal-comment';
const VERSION = 1;

/** The `ids` map's kind for a goal comment's server id. */
export const GOAL_COMMENT_IDS = 'goal-comment';

/** The reasons these rows carry after a refusal (`UNSENT_REASON_COPY` words them). */
export const SCHEDULE_REASON = {
    /** 409: the schedule was cancelled, or its socio is archived. */
    closed: 'schedule-closed',
    /** 404: the schedule is gone, or isn't the person's. */
    gone: 'schedule-gone',
    /** 409 on a comment: the goal is done or cancelled, or keeps no more comments. */
    goalClosed: 'goal-closed',
    /** 404 on a comment: the goal is gone. */
    goalGone: 'goal-gone',
    content: 'content',
} as const;

/** What a schedule's row may ask: Run now is online only (`runScheduleNow`). */
export type ScheduleAction = 'pause' | 'resume' | 'cancel';
const SCHEDULE_ACTIONS: readonly string[] = ['pause', 'resume', 'cancel'];

const SCHEDULE_LANE = 'schedule:';
export const scheduleLane = (id: string) => `${SCHEDULE_LANE}${id}`;
const GOAL_LANE = 'goal:';
export const goalLane = (id: string) => `${GOAL_LANE}${id}`;

// ---- Payloads ------------------------------------------------------------------

export interface ScheduleActionPayload {
    readonly scheduleId: string;
    readonly action: ScheduleAction;
}

/** A comment on a goal. Its row's id is the comment's local id. */
export interface GoalCommentPayload {
    readonly goalId: string;
    /** Trimmed, as the server stores it. */
    readonly body: string;
    /** The check's watermark: the newest `createdAt` (the server's) of the goal's comments the phone held, or null. */
    readonly after: number | null;
    /** The scope's newest Date header as the person wrote, or null. */
    readonly serverAt: number | null;
}

/** A write the person can't make: a comment out of range. */
export class ScheduleWriteError extends RangeError {
    override readonly name = 'ScheduleWriteError';
}

/** A goal comment as the server stores it, or null when it isn't 1 to `GOAL_COMMENT_MAX` characters. */
export function goalCommentBody(body: string): string | null {
    const trimmed = body.trim();
    return trimmed.length >= 1 && trimmed.length <= GOAL_COMMENT_MAX ? trimmed : null;
}

/** The newest `createdAt` of a goal's comments the phone holds: a comment's watermark. */
export function newestGoalComment(goal: Pick<GoalView, 'comments'> | null | undefined): number | null {
    let newest: number | null = null;
    for (const comment of goal?.comments ?? []) {
        if (typeof comment.createdAt === 'number' && (newest === null || comment.createdAt > newest)) {
            newest = comment.createdAt;
        }
    }
    return newest;
}

// ---- Writing -------------------------------------------------------------------

type ScheduleOutbox = Pick<Outbox, 'rows' | 'unsent' | 'enqueue' | 'update' | 'revisionOf' | 'discardUnsent'>;

const parse = <P>(payload: string): P | null => {
    try {
        return JSON.parse(payload) as P;
    } catch {
        return null;
    }
};

/**
 * Pauses, resumes or cancels a schedule. The lane's refused actions give way
 * first; then it folds into the lane's newest unsettled row when that is a
 * queued action that never went (a pause or resume never over a cancel),
 * else it is queued after it.
 */
export async function actOnSchedule(
    outbox: ScheduleOutbox,
    input: { scheduleId: string; action: ScheduleAction; newId: () => string },
): Promise<'folded' | 'queued'> {
    const { scheduleId, action, newId } = input;
    if (!SCHEDULE_ACTIONS.includes(action)) {
        throw new ScheduleWriteError('Pause, resume or cancel.');
    }
    const lane = scheduleLane(scheduleId);
    for (const refused of outbox.unsent()) {
        if (refused.lane === lane && refused.kind === SCHEDULE_ACTION_KIND) {
            await outbox.discardUnsent(refused.id);
        }
    }
    const payload: ScheduleActionPayload = { scheduleId, action };
    const last = outbox
        .rows()
        .filter((row) => row.lane === lane && row.state !== 'sent')
        .at(-1);
    const queued =
        last?.state === 'queued' && last.attempts === 0 && last.kind === SCHEDULE_ACTION_KIND
            ? parse<ScheduleActionPayload>(last.payload)
            : null;
    if (last !== undefined && queued !== null && !(queued.action === 'cancel' && action !== 'cancel')) {
        const changed =
            queued.action === action ||
            (await outbox.update(
                last.id,
                { payload: JSON.stringify(payload), payloadVersion: VERSION },
                outbox.revisionOf(last.id),
            ));
        if (changed) {
            return 'folded';
        }
    }
    await outbox.enqueue({
        id: newId(),
        lane,
        kind: SCHEDULE_ACTION_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: newId(),
    });
    return 'queued';
}

export interface GoalCommentInput {
    /** The comment's local id: a fresh UUID. */
    readonly localId: string;
    readonly goalId: string;
    readonly body: string;
    readonly idempotencyKey: string;
    /** `newestGoalComment` of the goal as the person wrote. */
    readonly after: number | null;
    /** The scope's `serverClock.lastDate()` as the person wrote. */
    readonly serverAt: number | null;
}

/**
 * The outbox row of a comment on a goal, for `enqueue` or a draft's
 * `enqueueFromDraft` (`goal:<id>`, a goal's comment box). Throws ScheduleWriteError for a body
 * that isn't 1 to `GOAL_COMMENT_MAX` characters once trimmed.
 */
export function goalCommentWrite(input: GoalCommentInput): NewOutboxWrite {
    const body = goalCommentBody(input.body);
    if (body === null) {
        throw new ScheduleWriteError(`Write the comment in 1 to ${GOAL_COMMENT_MAX.toLocaleString('en')} characters.`);
    }
    const payload: GoalCommentPayload = { goalId: input.goalId, body, after: input.after, serverAt: input.serverAt };
    return {
        id: input.localId,
        lane: goalLane(input.goalId),
        kind: GOAL_COMMENT_KIND,
        payload: JSON.stringify(payload),
        payloadVersion: VERSION,
        idempotencyKey: input.idempotencyKey,
    };
}

/** Comments on a goal: the comment's local id once stored. */
export async function commentOnGoal(
    outbox: Pick<Outbox, 'enqueue'>,
    input: Omit<GoalCommentInput, 'localId' | 'idempotencyKey'> & { newId: () => string },
): Promise<string> {
    const localId = `pending-goal-comment-${input.newId()}`;
    await outbox.enqueue(goalCommentWrite({ ...input, localId, idempotencyKey: input.newId() }));
    return localId;
}

// ---- The kinds -----------------------------------------------------------------

export interface ScheduleWriteOptions {
    /** cache.db's rows: a confirmed write is handed off there before its row goes. */
    readonly cache?: Pick<SnapshotCache, 'confirm'>;
    /** After a write the server took: what it changed is pulled (`notesForWrite`, the scope's). */
    readonly afterWrite?: (path: string) => void;
}

const SCHEDULES_PATH = '/api/schedules';
const actionsPath = (id: string) => `${SCHEDULES_PATH}/${encodeURIComponent(id)}/actions`;
const commentsPath = (id: string) => `${SCHEDULES_PATH}/goals/${encodeURIComponent(id)}/comments`;

/** A classifier action as a send's outcome. */
function outcome(action: ClassifierAction, answer: Answer): SendOutcome {
    switch (action.action) {
        case 'retry':
        case 'unknown':
        case 'unsent':
            return action;
        case 'back-off':
            return action.delayMs === null
                ? { action: 'retry', reason: action.reason }
                : { action: 'retry', delayMs: action.delayMs, reason: action.reason };
        default:
            return { action: 'unsent', reason: reasonOf(answer) };
    }
}

async function request(
    context: OutboxContext,
    write: OutboxWrite<unknown>,
    path: string,
    method: WriteMethod,
    special: (answer: Answer) => ClassifierAction | undefined,
    json: unknown,
): Promise<{ answer: Answer; action: ClassifierAction }> {
    const response = await context.fetch(path, { method, json });
    const answer = await readAnswer(response, context.signal);
    return { answer, action: classify(answer, { method, ambiguous: write.ambiguous === true, special }) };
}

/** `GET /api/schedules` read fresh: a comment's check. A failure throws (asked again later). */
async function readSchedules(context: OutboxContext): Promise<Pick<SchedulesState, 'goals'>> {
    const response = await context.fetch(SCHEDULES_PATH);
    const answer = await readAnswer(response, context.signal);
    const body = answer.body as Partial<SchedulesState> | null;
    if (answer.status !== 200 || body === null || typeof body !== 'object' || !Array.isArray(body.goals)) {
        throw new NetworkError(SCHEDULES_PATH);
    }
    return { goals: body.goals };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const isSchedule = (value: unknown): value is ScheduleView => isRecord(value) && typeof value.id === 'string';
const isGoal = (value: unknown): value is GoalView =>
    isRecord(value) && typeof value.id === 'string' && Array.isArray(value.comments);

function decoder<P>(check: (value: Record<string, unknown>) => boolean, what: string) {
    return (text: string): P => {
        const value = JSON.parse(text) as unknown;
        if (!isRecord(value) || !check(value)) {
            throw new TypeError(`Not a ${what}.`);
        }
        return value as P;
    };
}

const isNumberOrNull = (value: unknown) => value === null || typeof value === 'number';

/**
 * The person's comments on `goal` that may be write `payload`'s: the same
 * body, newer than its watermarks, and no other write's. Oldest first.
 */
function candidates(
    goal: GoalView,
    payload: GoalCommentPayload,
    claimed: (kind: string, serverId: string) => boolean,
): GoalComment[] {
    const since = serverSince(payload.serverAt);
    return goal.comments.filter(
        (comment) =>
            comment.author === 'person' &&
            comment.body === payload.body &&
            typeof comment.createdAt === 'number' &&
            (payload.after === null || comment.createdAt > payload.after) &&
            (since === null || comment.createdAt >= since) &&
            !claimed(GOAL_COMMENT_IDS, comment.id),
    );
}

/** The schedules and goals writes, over the scope's cache and its pull after a write. */
export function scheduleWriteKinds(options: ScheduleWriteOptions = {}): OutboxKind<unknown>[] {
    const { cache, afterWrite } = options;

    const handSchedule = (value: unknown): Pick<Settled, 'handOff'> =>
        cache !== undefined && isSchedule(value)
            ? { handOff: () => cache.confirm({ collection: SCHEDULES, scope: '', key: value.id, value }) }
            : {};
    const handGoal = (value: unknown): Pick<Settled, 'handOff'> =>
        cache !== undefined && isGoal(value)
            ? {
                  handOff: () =>
                      cache.confirm({
                          collection: GOALS,
                          scope: '',
                          key: value.id,
                          value,
                          ...(typeof value.updatedAt === 'number' ? { version: value.updatedAt } : {}),
                      }),
              }
            : {};

    const action: OutboxKind<ScheduleActionPayload> = {
        kind: SCHEDULE_ACTION_KIND,
        payloadVersion: VERSION,
        repeatable: true,
        decode: decoder<ScheduleActionPayload>(
            (value) =>
                typeof value.scheduleId === 'string' &&
                typeof value.action === 'string' &&
                SCHEDULE_ACTIONS.includes(value.action),
            'schedule action',
        ),
        async send(write, context) {
            const { scheduleId, action: what } = write.payload;
            const path = actionsPath(scheduleId);
            const special = (answer: Answer): ClassifierAction | undefined => {
                if (answer.status === 404 || answer.status === 410) {
                    // A cancelled schedule that is gone has nothing left to stop.
                    return what === 'cancel'
                        ? { action: 'delivered' }
                        : { action: 'unsent', reason: SCHEDULE_REASON.gone };
                }
                if (answer.status === 409) {
                    return { action: 'unsent', reason: SCHEDULE_REASON.closed };
                }
                return answer.status === 400 ? { action: 'unsent', reason: SCHEDULE_REASON.content } : undefined;
            };
            const { answer, action: classified } = await request(context, write, path, 'POST', special, {
                action: what,
            });
            if (classified.action !== 'delivered') {
                return outcome(classified, answer);
            }
            afterWrite?.(path);
            return {
                action: 'done',
                ...(answer.status >= 200 && answer.status < 300 ? handSchedule(answer.body) : {}),
            };
        },
        overlay({ payload }): Overlay {
            return { collection: SCHEDULES, key: payload.scheduleId, mode: 'patch', value: { action: payload.action } };
        },
    };

    const comment: OutboxKind<GoalCommentPayload> = {
        kind: GOAL_COMMENT_KIND,
        payloadVersion: VERSION,
        repeatable: false,
        creates: GOAL_COMMENT_IDS,
        decode: decoder<GoalCommentPayload>(
            (value) =>
                typeof value.goalId === 'string' &&
                typeof value.body === 'string' &&
                isNumberOrNull(value.after) &&
                isNumberOrNull(value.serverAt),
            'goal comment',
        ),
        async send(write, context) {
            const { goalId, body } = write.payload;
            const path = commentsPath(goalId);
            const special = (answer: Answer): ClassifierAction | undefined => {
                switch (answer.status) {
                    case 400:
                        return { action: 'unsent', reason: SCHEDULE_REASON.content };
                    case 404:
                    case 410:
                        return { action: 'unsent', reason: SCHEDULE_REASON.goalGone };
                    case 409:
                        return { action: 'unsent', reason: SCHEDULE_REASON.goalClosed };
                    case 502:
                    case 503:
                    case 504:
                        // A proxy's page may come after the server stored it.
                        return answer.code === 'draining' ? undefined : { action: 'unknown', reason: 'away' };
                    default:
                        return undefined;
                }
            };
            const { answer, action: classified } = await request(context, write, path, 'POST', special, { body });
            if (classified.action !== 'delivered') {
                return outcome(classified, answer);
            }
            if (!isGoal(answer.body)) {
                // A 2xx without the goal: the check finds the comment.
                return { action: 'unknown', reason: `http-${answer.status}` };
            }
            // The newest of the person's comments with this body that no other write has is this one.
            const mine = candidates(answer.body, write.payload, context.claimed).at(-1);
            afterWrite?.(path);
            return {
                action: 'done',
                ...(mine === undefined ? {} : { serverId: mine.id }),
                ...handGoal(answer.body),
            };
        },
        async check({ payload }, context): Promise<CheckOutcome> {
            const state = await readSchedules(context);
            const goal = state.goals.find((item) => isGoal(item) && item.id === payload.goalId);
            const found = goal === undefined ? [] : candidates(goal, payload, context.claimed);
            if (found.length === 1) {
                afterWrite?.(commentsPath(payload.goalId));
                return { action: 'sent', serverId: found[0]!.id, ...handGoal(goal) };
            }
            return found.length === 0
                ? { action: 'not-sent' }
                : { action: 'unconfirmed', candidates: found.map((item) => item.id) };
        },
        overlay({ id, payload }, scope): Overlay {
            return {
                collection: GOALS,
                key: payload.goalId,
                mode: 'patch',
                value: { comment: { id, serverId: scope.resolve(GOAL_COMMENT_IDS, id), body: payload.body } },
            };
        },
    };

    return [action, comment] as OutboxKind<unknown>[];
}

/** How these kinds' rows look on screen (`overlaysOf`), without anything that sends: Schedules lays them over. */
export const SCHEDULE_WRITE_VIEWS: readonly OverlayKind<unknown>[] = scheduleWriteKinds();

// ---- Online only ---------------------------------------------------------------

/** Why Run now isn't offered: the workspace's socios are paused, or research is off (the web's TaskActions.tsx). */
export type RunNowBlock = 'paused' | 'research-off' | 'cancelled';

/** Whether Run now is offered for something in `status`, by the shell's `state.settings`; null when it is. */
export function runNowBlocked(
    settings: Pick<Settings, 'paused' | 'researchAllowed'> | null | undefined,
    status?: Status | null,
): RunNowBlock | null {
    if (settings?.paused === true) {
        return 'paused';
    }
    if (settings?.researchAllowed === false) {
        return 'research-off';
    }
    return status === 'cancelled' ? 'cancelled' : null;
}

/** What an online-only action came to. */
export type OnlineActionResult =
    /** The server took it; `body` is its answer (a schedule, a task, a run). */
    | { readonly outcome: 'done'; readonly body: unknown }
    /** No connection: nothing was sent. */
    | { readonly outcome: 'offline' }
    /** Run now isn't offered: nothing was sent. */
    | { readonly outcome: 'blocked'; readonly why: RunNowBlock }
    /** It went and no answer came: it may have landed, and it is never sent again by itself. */
    | { readonly outcome: 'no-answer' }
    /** Refused, as a code (`ONLINE_ACTION_COPY` words it). */
    | { readonly outcome: 'refused'; readonly reason: string };

/** The words for an online-only action that didn't happen; any other reason gets `ONLINE_ACTION_FALLBACK`. */
export const ONLINE_ACTION_COPY: Readonly<Record<string, string>> = {
    offline: 'Needs a connection',
    'no-answer': 'No answer from the workspace. Check before you try again.',
    paused: 'Socios are paused in this workspace',
    'research-off': 'Running now is turned off for this workspace',
    cancelled: 'That schedule was cancelled',
    'http-403': 'Running now is turned off for this workspace',
    [SCHEDULE_REASON.gone]: 'It’s no longer here',
    [SCHEDULE_REASON.closed]: 'That schedule was cancelled, or its socio is archived',
    'http-401': 'Sign in again to do this',
    'http-429': 'Too many tries. Wait a moment.',
};
export const ONLINE_ACTION_FALLBACK = 'That didn’t work. Try again.';

/** What a result says on screen, or null when it worked. */
export function onlineActionCopy(result: OnlineActionResult): string | null {
    switch (result.outcome) {
        case 'done':
            return null;
        case 'offline':
        case 'no-answer':
            return ONLINE_ACTION_COPY[result.outcome]!;
        case 'blocked':
            return ONLINE_ACTION_COPY[result.why]!;
        default:
            return ONLINE_ACTION_COPY[result.reason] ?? ONLINE_ACTION_FALLBACK;
    }
}

export interface OnlineContext extends ScheduleWriteOptions {
    /** The open scope's authedFetch. */
    readonly fetch: AuthedFetch;
    /** NetInfo's `isConnected`: false sends nothing; null (not known yet) tries. */
    readonly connected: boolean | null;
}

/** One online-only request: sent once, never queued, never retried. */
async function once(
    context: OnlineContext,
    path: string,
    json: unknown,
    rules: { goneIsDone?: boolean; conflictIsDone?: boolean } = {},
): Promise<OnlineActionResult> {
    if (context.connected === false) {
        return { outcome: 'offline' };
    }
    let answer: Answer;
    try {
        answer = await readAnswer(await context.fetch(path, { method: 'POST', json }));
    } catch {
        // The request may have reached the server: never sent again by itself.
        return { outcome: 'no-answer' };
    }
    if (answer.status >= 200 && answer.status < 300) {
        context.afterWrite?.(path);
        return { outcome: 'done', body: answer.body };
    }
    if ((answer.status === 404 || answer.status === 410) && rules.goneIsDone === true) {
        return { outcome: 'done', body: null };
    }
    if (answer.status === 409 && rules.conflictIsDone === true) {
        context.afterWrite?.(path);
        return { outcome: 'done', body: null };
    }
    if (answer.status === 404 || answer.status === 410) {
        return { outcome: 'refused', reason: SCHEDULE_REASON.gone };
    }
    if (answer.status === 409) {
        return { outcome: 'refused', reason: SCHEDULE_REASON.closed };
    }
    return { outcome: 'refused', reason: `http-${answer.status}` };
}

/** Run now on a schedule (`…/actions {run}`): online only. Its answer, the schedule, goes to cache.db. */
export async function runScheduleNow(
    context: OnlineContext,
    input: {
        scheduleId: string;
        settings: Pick<Settings, 'paused' | 'researchAllowed'> | null;
        status?: Status | null;
    },
): Promise<OnlineActionResult> {
    const why = runNowBlocked(input.settings, input.status);
    if (why !== null) {
        return { outcome: 'blocked', why };
    }
    const result = await once(context, actionsPath(input.scheduleId), { action: 'run' });
    if (result.outcome === 'done' && context.cache !== undefined && isSchedule(result.body)) {
        await context.cache.confirm({ collection: SCHEDULES, scope: '', key: result.body.id, value: result.body });
    }
    return result;
}

/** Run now on a job (`/schedules/jobs/:id/run`): online only. */
export async function runJobNow(
    context: OnlineContext,
    input: { jobId: string; settings: Pick<Settings, 'paused' | 'researchAllowed'> | null },
): Promise<OnlineActionResult> {
    const why = runNowBlocked(input.settings);
    if (why !== null) {
        return { outcome: 'blocked', why };
    }
    return once(context, `${SCHEDULES_PATH}/jobs/${encodeURIComponent(input.jobId)}/run`, {});
}

/**
 * Stops a running job (`/schedules/jobs/:id/stop`, a job that runs until
 * done): online only. A 409 (it isn't running) is done: nothing is left to stop.
 */
export async function stopJob(context: OnlineContext, input: { jobId: string }): Promise<OnlineActionResult> {
    return once(
        context,
        `${SCHEDULES_PATH}/jobs/${encodeURIComponent(input.jobId)}/stop`,
        {},
        { conflictIsDone: true },
    );
}

/** What a scheduled task may be asked from the phone, each online only. Its repeat interval opens the web. */
export type TaskAction = 'run' | 'pause' | 'cancel';

/**
 * Runs, pauses or cancels a scheduled task (`/api/tasks/:id/actions`): online
 * only, since the server aborts the task's running turn on every action but
 * `run`. Run now is refused first by `runNowBlocked`.
 */
export async function actOnTask(
    context: OnlineContext,
    input: {
        taskId: string;
        action: TaskAction;
        settings?: Pick<Settings, 'paused' | 'researchAllowed'> | null;
    },
): Promise<OnlineActionResult> {
    if (input.action === 'run') {
        const why = runNowBlocked(input.settings);
        if (why !== null) {
            return { outcome: 'blocked', why };
        }
    }
    return once(context, `/api/tasks/${encodeURIComponent(input.taskId)}/actions`, { action: input.action });
}

// ---- The view ------------------------------------------------------------------

/** Where a write over a row stands. */
interface Pending {
    /** The newest write's state over it, or null when none waits. */
    readonly pending: OverlayItem['state'] | null;
    /** The newest write's id: the Unsent row's, for Retry and Discard. */
    readonly writeId: string | null;
    readonly reason: string | null;
}

export type ShownSchedule = ScheduleView & Pending;

/** A goal comment as Schedules shows it: the stored ones, then those waiting, with where each stands. */
export interface ShownGoalComment extends GoalComment {
    readonly pending: OverlayItem['state'] | null;
    readonly reason: string | null;
}

export interface ShownGoal extends Omit<GoalView, 'comments'> {
    readonly comments: readonly ShownGoalComment[];
}

/** The status a resume gives: a schedule with a cadence waits for its time (`tasks.ts`'s `resume`). */
function resumed(schedule: ScheduleView): Status {
    if (schedule.status !== 'paused') {
        return schedule.status;
    }
    if (schedule.cadence) {
        return 'scheduled';
    }
    return schedule.intervalSeconds ? 'completed' : 'queued';
}

const ACTION_STATUS: Readonly<Record<'pause' | 'cancel', Status>> = { pause: 'paused', cancel: 'cancelled' };

/**
 * Schedules' rows with the outbox laid over (these kinds' overlays): a pause, resume
 * or cancel shows its status at once, a refused one shows the stored status
 * with its reason, and a comment waiting shows under the goal's comments.
 * `overlays` are `overlaysOf` with `SCHEDULE_WRITE_VIEWS`, oldest first.
 */
export function shownSchedules(
    schedules: Iterable<ScheduleView>,
    goals: Iterable<GoalView>,
    overlays: readonly OverlayItem[],
): { readonly schedules: readonly ShownSchedule[]; readonly goals: readonly ShownGoal[] } {
    const byId = new Map<string, ShownSchedule>();
    for (const schedule of schedules) {
        byId.set(schedule.id, { ...schedule, pending: null, writeId: null, reason: null });
    }
    const goalsById = new Map<string, ShownGoal>();
    for (const goal of goals) {
        goalsById.set(goal.id, {
            ...goal,
            comments: goal.comments.map((item) => ({ ...item, pending: null, reason: null })),
        });
    }
    for (const overlay of overlays) {
        if (overlay.collection === SCHEDULES) {
            const stored = byId.get(overlay.key);
            const what = (overlay.value as { action?: ScheduleAction }).action;
            if (stored === undefined || what === undefined) {
                continue;
            }
            const status =
                overlay.state === 'unsent' ? stored.status : what === 'resume' ? resumed(stored) : ACTION_STATUS[what];
            byId.set(overlay.key, {
                ...stored,
                status,
                pending: overlay.state,
                writeId: overlay.id,
                reason: overlay.reason,
            });
            continue;
        }
        if (overlay.collection !== GOALS) {
            continue;
        }
        const goal = goalsById.get(overlay.key);
        const added = (overlay.value as { comment?: { id: string; serverId: string | null; body: string } }).comment;
        if (goal === undefined || added === undefined) {
            continue;
        }
        if (added.serverId !== null && goal.comments.some((item) => item.id === added.serverId)) {
            continue;
        }
        goalsById.set(overlay.key, {
            ...goal,
            comments: [
                ...goal.comments,
                {
                    id: added.id,
                    author: 'person',
                    body: added.body,
                    createdAt: overlay.createdAt,
                    pending: overlay.state,
                    reason: overlay.reason,
                },
            ],
        });
    }
    return { schedules: [...byId.values()], goals: [...goalsById.values()] };
}
