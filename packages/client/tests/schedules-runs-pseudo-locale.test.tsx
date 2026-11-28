// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dictionary } from '@socio/i18n/keys';
import { pseudoDictionary } from '@socio/i18n/pseudo';
import { createReactI18n, I18nextProvider } from '@socio/i18n/react';
import ROUTES from '@socio/i18n/route-namespaces.json';
import { REACTION_LABELS } from '@socio/shared/chat/reactions';
import type { RunTraceView } from '@socio/shared/runs/run-trace';
import type {
    GoalView,
    JobDetail,
    JobRunView,
    LongRunView,
    ScheduleDetail,
    ScheduleView,
    SchedulesState,
} from '@socio/shared/schedule-types';
import type { AgentRunSummary, Detail, State, Task, WorkspaceState } from '@socio/shared/types';
import type { PageI18n, RunList } from '@socio/shared/web/web';

import { fetchServices, createTestRouter } from './helpers/app-router';

// Schedules, Runs and Activity in en-XA, the pseudo-locale, through the
// app's real routes: each loader asks for its route's namespaces
// (route-namespaces.json) and gets them in en-XA, nothing more, and what
// loads on demand (a job's panel, the cancel dialog, a socio's panels, a
// turn's trace) comes from this server's files (the fetch below). Text
// that stays plain English was never translated, and a raw key means a
// route doesn't inline what its page shows. Only these modules' parts of
// each page are read: other modules' (the header's actions) and shared
// components' aren't theirs.

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

vi.setConfig({ testTimeout: 30_000 });

const locales = join(import.meta.dirname, '../../i18n/locales/en-US');
const routes = ROUTES as unknown as Record<string, string[]>;
const pseudo = (ns: string) =>
    pseudoDictionary(JSON.parse(readFileSync(join(locales, `${ns}.json`), 'utf8')) as Dictionary);
const inlined = new Set(
    Object.entries(routes)
        .filter(([id]) => !id.startsWith('$'))
        .flatMap(([, namespaces]) => namespaces),
);

// What loads on demand: this server's files, which the manifest names and
// the fetch below serves. Only these, named here rather than worked out
// from route-namespaces.json, so a namespace a route should inline but
// doesn't stays missing, and its keys show.
const ON_DEMAND = ['runs.trace', 'schedules.dialogs', 'schedules.job', 'schedules.plans'];
const SERVED = [...ON_DEMAND, 'chat.trace'];
const manifest = {
    release: '1.0.0',
    locales: {
        'en-XA': {
            coverage: 1,
            ns: Object.fromEntries(
                readdirSync(locales)
                    .map((name) => name.slice(0, -'.json'.length))
                    .filter((ns) => !inlined.has(ns) || SERVED.includes(ns))
                    .map((ns) => [ns, { hash: 'test', sourceHash: 'test' }]),
            ),
        },
    },
};
const pseudoPage = (namespaces: readonly string[]): PageI18n => ({
    locale: 'en-XA',
    dir: 'ltr',
    manifest,
    resources: { 'en-XA': Object.fromEntries(namespaces.map((ns) => [ns, pseudo(ns)])) },
    offered: ['en-US'],
});

// The page's clock and time zone, fixed: what the fixtures' times read as
// doesn't depend on when or where the test runs (set in beforeEach).
const now = Date.UTC(2026, 10, 20, 12);
const TIME_ZONE = 'UTC';
const HOUR = 3_600_000;

const user = { id: 'u-ada', name: 'Ada', role: 'admin' as const };
const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    prompt: 'Omicron',
    status: 'completed',
    intervalSeconds: 1800,
    nextRunAt: now + HOUR,
    createdAt: 1,
    updatedAt: now - 5 * 60_000,
    error: null,
    lease: null,
    leaseUntil: null,
    ...extra,
});
const TASKS: Task[] = [
    task('t1'),
    task('t2', { status: 'paused', intervalSeconds: 7200, updatedAt: now - 3 * HOUR }),
    task('t3', { status: 'failed', intervalSeconds: null, nextRunAt: null, updatedAt: now - 3 * 24 * HOUR }),
    task('t4', { status: 'interrupted', intervalSeconds: null, nextRunAt: null, updatedAt: now - 10_000 }),
];
const state = {
    settings: { name: 'Alpha', paused: false, researchAllowed: true, memoryAllowed: true },
    tasks: TASKS,
    memories: [],
    mode: 'live',
    configured: true,
} as unknown as State;
const workspace = {
    user,
    spaces: [{ id: 's1', name: 'Delta', description: '', createdAt: 1, access: 'editor' }],
    dots: [{ id: 'd1', name: 'Bob', instructions: '', spaceId: 's1', spaceIds: ['s1'], createdAt: 1 }],
    conversations: [],
    setup: { model: true, voice: false, telegram: 'not_configured', missing: [] },
    calls: [],
    preferences: {},
    permissions: { createSpaces: true },
} as unknown as WorkspaceState;

const schedule = (id: string, extra: Partial<ScheduleView> = {}): ScheduleView => ({
    id,
    title: 'Epsilon',
    prompt: 'Omicron',
    kind: 'turn',
    cadence: 'Lambda',
    timezone: 'UTC',
    intervalSeconds: null,
    status: 'scheduled',
    origin: 'dot',
    dotId: 'd1',
    dotName: 'Bob',
    jobId: null,
    jobName: null,
    threadId: 't1',
    nextRunAt: now + HOUR,
    lastRun: { status: 'failed', startedAt: now - HOUR, finishedAt: now - HOUR + 60_000, error: 'Psi' },
    error: null,
    createdAt: 1,
    ...extra,
});
const SCHEDULES: ScheduleView[] = [
    schedule('sc1'),
    schedule('sc2', { kind: 'job', jobId: 'j1', jobName: 'Kappa', origin: 'user', status: 'paused', cadence: null }),
    schedule('sc3', { cadence: null, intervalSeconds: 7200, status: 'running', lastRun: null, dotName: null }),
    schedule('sc4', { cadence: null, intervalSeconds: 86_400, status: 'cancelled', kind: 'job' }),
    schedule('sc5', { cadence: null, intervalSeconds: 900, status: 'failed', error: 'Psi' }),
];
const goal = (id: string, extra: Partial<GoalView> = {}): GoalView => ({
    id,
    userId: 'u-ada',
    dotId: 'd1',
    title: 'Zeta',
    detail: 'Omicron',
    status: 'active',
    progress: 'Rho',
    comments: [
        { id: `${id}-c1`, author: 'person', body: 'Tau', createdAt: now - HOUR },
        { id: `${id}-c2`, author: 'dot', body: 'Phi', createdAt: now - HOUR / 2 },
    ],
    scheduleId: 'sc1',
    threadId: 't1',
    cadence: 'Lambda',
    nextRunAt: now + HOUR,
    createdAt: 1,
    updatedAt: now - HOUR,
    closedAt: null,
    ...extra,
});
const GOALS: GoalView[] = [
    goal('g1'),
    goal('g2', { status: 'paused', progress: null, cadence: null, comments: [], scheduleId: 'sc3' }),
    goal('g3', { status: 'done', progress: null, scheduleId: 'sc2' }),
];
const jobRun = (id: string, extra: Partial<JobRunView> = {}): JobRunView => ({
    id,
    jobId: 'j1',
    version: 2,
    trigger: 'schedule',
    scheduleId: 'sc2',
    status: 'succeeded',
    queuedAt: now - 2 * HOUR,
    startedAt: now - 2 * HOUR,
    wakeMs: 4200,
    finishedAt: now - 2 * HOUR + 125_000,
    exitCode: 0,
    error: null,
    longRunId: null,
    ...extra,
});
const longRun: LongRunView = {
    id: 'L1',
    jobId: 'j1',
    trigger: 'dot',
    scheduleId: null,
    status: 'waiting',
    items: { total: 726, done: 412, remaining: 313, inProgress: 4, failed: 3 },
    listComplete: false,
    batches: 3,
    maxBatches: 200,
    currentRunId: null,
    checkpoint: 'chi',
    checkpointAt: now - HOUR,
    retries: 1,
    maxRetries: 5,
    nextAt: now + HOUR,
    waitReason: 'Sigma',
    lastError: 'Psi',
    deadLetters: [{ key: 'omega', error: 'Psi', attempts: 3, at: now - HOUR }],
    outcome: null,
    createdAt: now - 3 * HOUR,
    updatedAt: now - HOUR,
    finishedAt: null,
};
const files = [{ path: 'main.ts', size: 120 }];
const JOB = {
    id: 'j1',
    name: 'Kappa',
    dotId: 'd1',
    dotName: 'Bob',
    entry: 'main.ts' as const,
    version: 2,
    timeoutSeconds: 120,
    datasets: ['scratch', 'ds1'],
    files,
    untilDone: true,
    createdAt: 1,
    updatedAt: 1,
    lastRun: jobRun('r1'),
    longRun,
};
const JOBS = [
    JOB,
    { ...JOB, id: 'j2', untilDone: false, longRun: null, dotName: null },
    { ...JOB, id: 'j3', untilDone: false, longRun: null, lastRun: null, files: [...files, files[0]!] },
];
const SCHEDULES_STATE: SchedulesState = {
    schedules: SCHEDULES,
    goals: GOALS,
    jobs: JOBS,
    limits: {
        minIntervalMinutes: 15,
        maxActiveSchedules: 20,
        maxJobTimeoutSeconds: 900,
        jobConcurrency: 2,
        maxJobs: 50,
    },
    usage: { activeSchedules: 3, jobs: 3 },
    counts: {
        schedules: { scheduled: 7, paused: 1 },
        jobs: 3,
        jobRuns: { succeeded: 12, timed_out: 1 },
        runningJobs: 1,
    },
};
const JOB_DETAIL: JobDetail = {
    job: JOB,
    code: { state: 'missing', missing: ['main.ts'], error: null },
    longRun,
    versions: [
        {
            version: 2,
            entry: 'main.ts',
            files,
            timeoutSeconds: 120,
            datasets: ['scratch'],
            untilDone: true,
            createdAt: 1,
        },
        {
            version: 1,
            entry: 'main.ts',
            files,
            timeoutSeconds: 60,
            datasets: ['scratch'],
            untilDone: false,
            createdAt: 1,
        },
    ],
    runs: [
        jobRun('r1'),
        jobRun('r2', { trigger: 'dot', longRunId: 'L1', status: 'timed_out', wakeMs: null }),
        jobRun('r3', { trigger: 'manual', status: 'running', finishedAt: null }),
    ],
    moreRuns: true,
};
const detail = (extra: Partial<ScheduleDetail> = {}): ScheduleDetail => ({
    schedule: schedule('sc1', { origin: 'user' }),
    cadenceText: 'Lambda',
    upcoming: [now + HOUR, now + 25 * HOUR],
    approvals: [
        { capability: 'issue.file', label: 'Sigma', policy: 'auto' },
        { capability: 'dataset.write', label: 'Delta', policy: 'bypass' },
    ],
    goal: goal('g1'),
    runs: [
        {
            id: 'tr2',
            status: 'completed',
            startedAt: now - HOUR,
            finishedAt: now - HOUR + 125_000,
            summary: 'Rho',
            error: null,
            turnPath: '/chats/t1#message-m2',
            board: (['create', 'comment', 'vote', 'unvote', 'update'] as const).map((action) => ({
                issue: 'CB-7',
                title: 'Tau',
                action,
            })),
        },
        {
            id: 'tr1',
            status: 'failed',
            startedAt: now - 25 * HOUR,
            finishedAt: now - 25 * HOUR + 3000,
            summary: null,
            error: 'Psi',
            turnPath: null,
            board: [],
        },
    ],
    moreRuns: true,
    ...extra,
});
const DETAILS: Record<string, ScheduleDetail> = {
    sc1: detail(),
    // A job's schedule, paused, with no next runs and no chat or approvals.
    sc2: detail({
        schedule: schedule('sc2', { kind: 'job', jobName: 'Kappa', status: 'paused', threadId: null }),
        goal: null,
        upcoming: [],
        approvals: [],
        runs: [],
        moreRuns: false,
    }),
    // A task's interval, its job deleted, canceled.
    sc3: detail({
        schedule: schedule('sc3', {
            kind: 'job',
            jobName: null,
            status: 'cancelled',
            cadence: null,
            intervalSeconds: 7200,
        }),
        cadenceText: null,
        goal: null,
    }),
};

const summary = (runId: string, extra: Partial<AgentRunSummary> = {}): AgentRunSummary => ({
    runId,
    threadId: 't1',
    status: 'finished',
    source: 'web',
    startedAt: now - HOUR,
    finishedAt: now - HOUR + 125_000,
    error: null,
    errorDetail: null,
    title: 'Epsilon',
    dotName: 'Bob',
    ownerId: 'u-ada',
    ownerName: 'Ada',
    readable: true,
    trace: { reason: 'round_cap', rounds: 5, inputTokens: 12_400, outputTokens: 820, cachedTokens: 9_920 },
    ...extra,
});
const RUNS: RunList = {
    limit: 3,
    runs: [
        summary('r1'),
        summary('r2', { status: 'failed', source: 'telegram', error: 'Psi', title: null, readable: false }),
        summary('r3', { status: 'running', source: 'scheduled', finishedAt: null, trace: undefined, ownerName: null }),
        summary('r4', { status: 'interrupted', source: 'voice', trace: { reason: 'completed', rounds: 1 } }),
    ],
};
const T0 = now - HOUR;
const TRACE: RunTraceView = {
    runId: 'r1',
    status: 'finished',
    startedAt: T0,
    finishedAt: T0 + 125_000,
    trace: {
        turn: { label: 'Kappa', model: 'Zeta', source: 'shared', cap: 5 },
        reactions: { kind: 'reactions', at: T0, counts: { up: 2, down: 1 } },
        rounds: [
            { kind: 'round', round: 1, startedAt: T0 + 10, endedAt: T0 + 400, stop: 'stop', summary: true },
            {
                kind: 'round',
                round: 1,
                startedAt: T0 + 500,
                endedAt: T0 + 1400,
                firstOutputMs: 250,
                inputTokens: 1_200,
                outputTokens: 40,
                cachedTokens: 600,
                reasoningTokens: 12,
                stop: 'tool_calls',
            },
            {
                kind: 'round',
                round: 2,
                startedAt: T0 + 3000,
                endedAt: T0 + 4000,
                stop: 'length',
                retry: 1,
                cause: 'rate_limited',
            },
            {
                kind: 'round',
                round: 3,
                startedAt: T0 + 5000,
                endedAt: T0 + 6000,
                stop: 'content_filter',
                cause: 'fallback',
            },
            {
                kind: 'round',
                round: 4,
                startedAt: T0 + 7000,
                endedAt: T0 + 8000,
                stop: 'error',
                error: 'Psi',
                retry: 2,
                cause: 'unavailable',
            },
            {
                kind: 'round',
                round: 5,
                startedAt: T0 + 9000,
                endedAt: T0 + 10_000,
                stop: 'cancelled',
                retry: 3,
                cause: 'fallback',
            },
            { kind: 'round', round: 6, startedAt: T0 + 11_000, endedAt: T0 + 12_000, stop: 'stop', retry: 1 },
        ],
        compactions: [
            {
                kind: 'compaction',
                round: 1,
                at: T0 + 450,
                beforeTokens: 182_400,
                afterTokens: 88_000,
                window: 128_000,
                stubbed: 12,
                summarised: 3,
                retried: 1,
                pinnedShown: 4,
                pinnedStored: 9,
                selection: 'relevance',
            },
            {
                kind: 'compaction',
                round: 2,
                at: T0 + 2900,
                beforeTokens: 1,
                afterTokens: 1,
                window: 2,
                stubbed: 1,
                summarised: 1,
                retried: 0,
                pinnedShown: 1,
                pinnedStored: 1,
            },
        ],
        notes: [
            {
                kind: 'notes',
                round: 1,
                startedAt: T0 + 20,
                endedAt: T0 + 300,
                by: 'shared',
                model: 'Zeta',
                turns: 6,
                inputTokens: 100,
                outputTokens: 20,
            },
            {
                kind: 'notes',
                round: 2,
                startedAt: T0 + 2950,
                endedAt: T0 + 2990,
                by: 'chat',
                model: null,
                turns: 1,
                fallback: 'error',
            },
            {
                kind: 'notes',
                round: 3,
                startedAt: T0 + 4950,
                endedAt: T0 + 4990,
                by: 'shared',
                model: null,
                turns: 2,
                fallback: 'empty',
            },
            {
                kind: 'notes',
                round: 4,
                startedAt: T0 + 6950,
                endedAt: T0 + 6990,
                by: 'chat',
                model: 'Zeta',
                turns: 2,
                fallback: 'cap',
            },
        ],
        retries: [
            { kind: 'retry', round: 2, at: T0 + 2000, reason: 'rate_limited', waitMs: 2100, attempt: 1, error: 'Psi' },
            { kind: 'retry', round: 4, at: T0 + 6500, reason: 'unavailable', waitMs: 900, attempt: 1, cutShort: true },
        ],
        fallback: { kind: 'fallback', round: 3, at: T0 + 4500, from: 'Zeta', to: 'Kappa', reason: 'rate_limited' },
        tools: [
            {
                kind: 'tool',
                round: 1,
                name: 'search_web',
                startedAt: T0 + 1400,
                endedAt: T0 + 2100,
                outcome: 'timeout',
                error: 'Psi',
            },
            { kind: 'tool', round: 1, name: 'read_page', startedAt: T0 + 1400, endedAt: T0 + 1500, outcome: 'ok' },
            { kind: 'tool', round: 1, name: 'run_job', startedAt: T0 + 1400, endedAt: T0 + 1600, outcome: 'refused' },
            { kind: 'tool', round: 1, name: 'fetch', startedAt: T0 + 1400, endedAt: T0 + 1700, outcome: 'error' },
        ],
        waits: [
            { kind: 'wait', for: 'approval', name: 'job_run', round: 1, at: T0 + 2100 },
            { kind: 'wait', for: 'person', name: 'ask', round: 1, at: T0 + 2200 },
        ],
        end: { reason: 'round_cap', rounds: 5, cap: 5, inferred: true },
        totals: { rounds: 6, inputTokens: 1_200, outputTokens: 40, cachedTokens: 600 },
        dropped: 3,
    },
} as RunTraceView;

/** The data words: names in the fixtures, and code. */
const FIXTURE_TEXT = [
    'Alpha',
    'Delta',
    'Epsilon',
    'Lambda',
    'Kappa',
    'Zeta',
    'Omicron',
    'Sigma',
    'Psi',
    'Rho',
    'Tau',
    'Phi',
    'chi',
    'omega',
    'Bob',
    'u-ada',
    'Ada',
    'UTC',
    'CB',
    'main.ts',
    'bun',
    'search_web',
    'read_page',
    'run_job',
    'job_run',
    'fetch',
    'ask',
];
/**
 * Shared components' and other modules' words, not these modules': the
 * sidebar's toggle and the breadcrumb's landmark (components/ui), the
 * data grid's own controls (components/data-grid), chat's reaction names
 * (@socio/shared/chat/reactions, which chat keeps in English too) and the
 * Ctrl key.
 */
const SHARED_TEXT: (string | RegExp)[] = [
    'Toggle Sidebar',
    'Collapse sidebar',
    'breadcrumb',
    'Close',
    'Ctrl',
    /\bActions(?: for)?\b/g,
    ...Object.values(REACTION_LABELS).map((label) => label.toLowerCase()),
];

const respond = (path: string): [number, unknown] => {
    if (path === '/api/workspace') {
        return [200, workspace];
    }
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/schedules') {
        return [200, SCHEDULES_STATE];
    }
    const one = /^\/api\/schedules\/(sc\d)$/.exec(path);
    if (one && DETAILS[one[1]!]) {
        return [200, DETAILS[one[1]!]];
    }
    if (path === '/api/schedules/jobs/j1') {
        return [200, JOB_DETAIL];
    }
    if (path === '/api/schedules/runs/r1') {
        return [200, { ...jobRun('r1'), error: 'Psi', stdout: '', stderr: '' }];
    }
    if (path === '/api/runs') {
        return [200, RUNS];
    }
    if (path === '/api/runs/r1/trace') {
        return [200, TRACE];
    }
    const taskPath = /^\/api\/tasks\/(t\d)$/.exec(path);
    if (taskPath) {
        return [
            200,
            { task: TASKS.find((item) => item.id === taskPath[1])!, runs: [{}, {}], events: [] } as unknown as Detail,
        ];
    }
    // Whatever else a page asks: nothing to show, in no words.
    return [404, { error: '—' }];
};

let host: HTMLElement;
let root: Root | undefined;
let fetched: string[] = [];
const zone = process.env.TZ;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    process.env.TZ = TIME_ZONE;
    fetched = [];
    // Only Date: the router and the settle loop keep their real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    Element.prototype.scrollIntoView ??= () => {};
    window.matchMedia = (query: string) =>
        ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as never;
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('EventSource', undefined);
    vi.stubGlobal('fetch', async (input: string) => {
        const file = /^\/i18n\/en-XA\/(.+)\.test\.json$/.exec(String(input));
        if (file) {
            fetched.push(file[1]!);
            return SERVED.includes(file[1]!) ? Response.json(pseudo(file[1]!)) : new Response('', { status: 404 });
        }
        const [status, body] = respond(new URL(input, 'http://app.test').pathname);
        return Response.json(body, { status });
    });
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (zone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = zone;
    }
});

/**
 * The words Intl itself writes for en-XA: month and weekday names, day
 * periods (AM, PM), units ("sec", "min", "hr"), how long ago ("5m ago",
 * "now") and lists. They are the locale's data, as the formatters and
 * `LocalTime` write them, not copy to translate. Taken from Intl, not
 * listed, so they follow the engine's CLDR.
 */
const INTL_WORDS = (() => {
    const words = new Set<string>();
    const addWords = (text: string) => {
        for (const match of text.matchAll(/\p{L}{2,}/gu)) {
            words.add(match[0]);
        }
    };
    const add = (options: Intl.DateTimeFormatOptions, at: number) => {
        for (const part of new Intl.DateTimeFormat('en-XA', { timeZone: TIME_ZONE, ...options }).formatToParts(at)) {
            if (part.type === 'month' || part.type === 'weekday' || part.type === 'dayPeriod') {
                words.add(part.value);
            }
        }
    };
    for (let day = 0; day < 366; day += 1) {
        const at = Date.UTC(2026, 0, 1 + day);
        add({ month: 'long', weekday: 'long' }, at);
        add({ month: 'short', weekday: 'short' }, at);
    }
    for (let hour = 0; hour < 24; hour += 1) {
        add({ hour: 'numeric', hour12: true }, Date.UTC(2026, 0, 1, hour));
        add({ hour: 'numeric', hour12: true, dayPeriod: 'short' }, Date.UTC(2026, 0, 1, hour));
    }
    for (const unit of ['millisecond', 'second', 'minute', 'hour'] as const) {
        for (const amount of [0, 1, 1.5, 2, 42]) {
            addWords(new Intl.NumberFormat('en-XA', { style: 'unit', unit, unitDisplay: 'short' }).format(amount));
        }
    }
    for (const style of ['long', 'short', 'narrow'] as const) {
        const format = new Intl.RelativeTimeFormat('en-XA', { numeric: 'auto', style });
        for (const unit of ['second', 'minute', 'hour', 'day'] as const) {
            for (const amount of [-2, -1, 0]) {
                addWords(format.format(amount, unit));
            }
        }
    }
    addWords(new Intl.ListFormat('en-XA', { type: 'conjunction' }).format(['a', 'b', 'c']));
    // A full date and time's own words ("… 2026 at 11:00:00 AM"), as Runs' tooltip has it.
    addWords(
        new Intl.DateTimeFormat('en-XA', { dateStyle: 'full', timeStyle: 'medium', timeZone: TIME_ZONE }).format(now),
    );
    return words;
})();

/** What a person reads in `node`, without the parts `skip` names (other modules'). */
function readable(node: Element, skip: readonly string[] = []) {
    const copy = node.cloneNode(true) as Element;
    for (const selector of skip) {
        for (const element of copy.querySelectorAll(selector)) {
            element.remove();
        }
    }
    const attributes = [...copy.querySelectorAll('[aria-label], [title], [placeholder], [alt]')].flatMap((element) =>
        ['aria-label', 'title', 'placeholder', 'alt']
            .map((name) => element.getAttribute(name))
            .filter((value): value is string => !!value),
    );
    // Each text node apart, as a person reads them: a list's items don't run together.
    const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        texts.push(node.textContent ?? '');
    }
    return [texts.join(' '), ...attributes];
}

/** The English left once every pseudo-locale string (in brackets) and the fixtures' words are taken out. */
function untranslated(texts: readonly string[]) {
    return texts.flatMap((text) => {
        let rest = text;
        for (let before = ''; before !== rest;) {
            before = rest;
            rest = rest.replace(/\[[^[\]]*\]/g, ' ');
        }
        for (const fixture of [...SHARED_TEXT, ...FIXTURE_TEXT]) {
            rest = rest.replaceAll(fixture, ' ');
        }
        return [...rest.matchAll(/\p{L}{2,}/gu)].map((match) => match[0]).filter((word) => !INTL_WORDS.has(word));
    });
}

async function settle(ticks = 12) {
    for (let tick = 0; tick < ticks; tick++) {
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
}

async function until(check: () => boolean, what: string) {
    for (let tick = 0; tick < 300; tick++) {
        if (check()) {
            return;
        }
        await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}

async function open(path: string, asked: string[][] = []) {
    const router = createTestRouter(path, {
        services: () => ({
            ...fetchServices(),
            i18n: async (namespaces) => {
                asked.push([...namespaces]);
                return pseudoPage(namespaces);
            },
        }),
    });
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    await settle();
    return router;
}

const $ = (selector: string) => {
    const found = document.querySelector(selector);
    expect(found, selector).not.toBeNull();
    return found!;
};

const click = (element: Element) =>
    act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

// The header's slots hold other modules' buttons (Ask a socio, Report issue).
const HEADER_SKIP = ['[data-slot="header-actions"]'];

it('inlines each page’s words on its route, and loads the rest on demand', () => {
    const own = readdirSync(locales)
        .map((name) => name.slice(0, -'.json'.length))
        .filter((ns) => /^(schedules|runs|activity)(\.|$)/.test(ns));
    expect(own.filter((ns) => !inlined.has(ns)).sort()).toEqual(ON_DEMAND);
    expect(routes.schedules).toEqual(['schedules', 'schedules.list']);
    expect(routes['schedules:schedule']).toEqual(['schedules', 'schedules.detail', 'schedules.purpose']);
    expect(routes.runs).toEqual(['runs', 'runs.summary']);
    expect(routes.activity).toEqual(['activity', 'schedules.purpose']);
});

it('renders the schedules, their goals, the jobs and everyone’s counts in en-XA', async () => {
    const asked: string[][] = [];
    const router = await open('/schedules', asked);
    expect(asked).toContainEqual(routes.schedules);
    await until(() => !!document.querySelector('[data-slot="schedule-list"]'), 'the schedules');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="schedules-page"]')))).toEqual([]);
    for (const tab of ['jobs', 'workspace']) {
        await act(async () => router.navigate(`/schedules?tab=${tab}`));
        await settle(4);
        expect(untranslated(readable($('[data-slot="schedules-page"]'))), tab).toEqual([]);
    }
});

it('opens a job’s panel in en-XA, its words loaded on demand', async () => {
    await open('/schedules?tab=jobs');
    await until(() => !!document.querySelector('[data-slot="job-list"]'), 'the jobs');
    const details = [...document.querySelectorAll('[data-job="j1"] button')].at(-1)!;
    await click(details);
    await until(() => !!document.querySelector('[data-slot="job-detail"]'), 'the job’s panel');
    expect(fetched).toContain('schedules.job');
    // Its logs and the delete confirmation.
    const logs = [...document.querySelectorAll('[data-slot="job-runs"] tbody tr button')][0]!;
    await click(logs);
    await until(() => !!document.querySelector('[data-slot="job-logs"]'), 'the logs');
    const remove = [...document.querySelectorAll('[data-slot="job-detail"] button')].at(-1)!;
    await click(remove);
    await until(() => !!document.querySelector('[data-slot="job-confirm-delete"]'), 'the confirmation');
    expect(untranslated(readable($('[data-slot="job-detail"]')))).toEqual([]);
    // Its Cancel is the shared ConfirmDelete's (components/).
    expect(
        untranslated(
            readable($('[data-slot="job-confirm-delete"]'), ['[data-slot="alert-dialog-footer"] > button:first-child']),
        ),
    ).toEqual([]);
});

it.each(['sc1', 'sc2', 'sc3'])('renders a schedule’s page (%s) in en-XA', async (id) => {
    const asked: string[][] = [];
    await open(`/schedules/${id}`, asked);
    expect(asked).toContainEqual(routes['schedules:schedule']);
    await until(() => !!document.querySelector('[data-slot="schedule-facts"]'), 'the schedule');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    expect(untranslated(readable($('[data-slot="schedule-page"]')))).toEqual([]);
});

it('says a schedule isn’t there in en-XA', async () => {
    await open('/schedules/sc9');
    await until(() => !!document.querySelector('[data-slot="page-header-title"]'), 'the missing schedule');
    expect(untranslated(readable($('[data-slot="schedule-page"]')))).toEqual([]);
});

it('renders Runs and a turn’s trace in en-XA, the trace’s words loaded on demand', async () => {
    const asked: string[][] = [];
    await open('/runs', asked);
    expect(asked).toContainEqual(routes.runs);
    await until(() => !!document.querySelector('[data-slot="runs-table"]'), 'the runs');
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
    await click($('[data-run="r1"] button[aria-expanded]'));
    await until(() => !!document.querySelector('[data-slot="trace-timeline"]'), 'the trace');
    expect(fetched).toContain('runs.trace');
    // A run's actions are other modules' (Issues' File issue).
    expect(untranslated(readable($('[data-slot="runs-page"]'), ['[data-slot="run-actions"]']))).toEqual([]);
});

it('renders Activity and a task in en-XA', async () => {
    const asked: string[][] = [];
    await open('/activity', asked);
    expect(asked).toContainEqual(routes.activity);
    await until(() => !!document.querySelector('[data-slot="task-row"]'), 'the tasks');
    for (const row of [...document.querySelectorAll('[data-slot="task-row"]')]) {
        await click(row);
        await until(() => !!document.querySelector('[data-slot="task-detail"]'), 'the task');
        await settle(2);
        expect(untranslated(readable($('[data-slot="activity-page"]')))).toEqual([]);
    }
    expect(untranslated(readable($('[data-slot="app-header"]'), HEADER_SKIP))).toEqual([]);
});

/** An instance with the root's namespaces and `namespaces`, in en-XA, as a page that loaded them has. */
function pseudoInstance(namespaces: readonly string[]) {
    const all = [...routes.root!, ...namespaces];
    return createReactI18n({
        locale: 'en-XA',
        resources: { 'en-XA': Object.fromEntries(all.map((ns) => [ns, pseudo(ns)])) },
        namespaces: all,
    });
}

async function renderWith(namespaces: readonly string[], node: ReactNode) {
    root = createRoot(host);
    await act(async () => root!.render(<I18nextProvider i18n={pseudoInstance(namespaces)}>{node}</I18nextProvider>));
    await settle(4);
}

it('opens the cancel dialog in en-XA', async () => {
    const { CancelScheduleDialog } = await import('../src/modules/schedules/CancelScheduleDialog');
    await renderWith(
        ['schedules.dialogs'],
        <CancelScheduleDialog schedule={{ title: 'Epsilon' }} onClose={() => {}} onConfirm={async () => {}} />,
    );
    const input = $('[data-slot="schedule-cancel-confirm"] input') as HTMLInputElement;
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Eps');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle(2);
    expect($('[data-slot="cancel-name-mismatch"]')).toBeTruthy();
    // The dialog's close button is the shared Dialog's.
    expect(untranslated(readable($('[data-slot="schedule-cancel-confirm"]')))).toEqual([]);
});

it('shows a socio’s Goals and Scheduled panels in en-XA', async () => {
    const { DotPlans } = await import('../src/modules/schedules/DotPlans');
    const { ShellContext } = await import('../src/shell/shell-context');
    const { MemoryRouter } = await import('react-router');
    const shell = { state, workspace, admin: true, configured: true } as never;
    await renderWith(
        ['schedules', 'schedules.plans'],
        <ShellContext.Provider value={shell}>
            <MemoryRouter>
                <DotPlans dot={workspace.dots[0]!} />
            </MemoryRouter>
        </ShellContext.Provider>,
    );
    await until(() => !!document.querySelector('[data-panel="schedules"] a'), 'the panels');
    expect(untranslated(readable(host))).toEqual([]);
});

/** A server render with the root's namespaces only (its instance has no backend). */
function serverRender(node: ReactNode) {
    const server = createReactI18n({
        locale: 'en-XA',
        resources: { 'en-XA': Object.fromEntries(routes.root!.map((ns) => [ns, pseudo(ns)])) },
        namespaces: routes.root!,
    });
    return renderToString(<I18nextProvider i18n={server}>{node}</I18nextProvider>);
}

it('renders nothing on the server for what loads on demand, never its keys', async () => {
    const { CancelScheduleDialog } = await import('../src/modules/schedules/CancelScheduleDialog');
    const { JobPanel } = await import('../src/modules/schedules/JobPanel');
    const { RunTimeline } = await import('../src/modules/runs/RunTimeline');
    const { DotPlans } = await import('../src/modules/schedules/DotPlans');
    for (const Component of [CancelScheduleDialog, JobPanel, RunTimeline]) {
        const Shown = Component as unknown as ComponentType<Record<string, unknown>>;
        expect(
            serverRender(<Shown schedule={{ title: 'Epsilon' }} jobId="j1" runId="r1" />),
            Component.displayName,
        ).toBe('');
    }
    const Plans = DotPlans as unknown as ComponentType<Record<string, unknown>>;
    expect(serverRender(<Plans dot={workspace.dots[0]} />)).toBe('');
});
