// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
    GoalView,
    JobDetail,
    JobRunsPage,
    JobRunView,
    LongRunView,
    ScheduleDetail,
    ScheduleRunsPage,
    ScheduleRunView,
    ScheduleView,
    SchedulesState,
} from '@socio/shared/schedule-types';
import type { Role, State, WorkspaceState } from '@socio/shared/types';

import { createTestRouter } from './helpers/app-router';

vi.mock('@copilotkit/react-core/v2', () => ({
    CopilotKitProvider: ({ children }: { children: unknown }) => children,
}));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const state: State = {
    settings: {
        name: 'Brain',
        paused: false,
        researchAllowed: false,
        memoryAllowed: true,
    },
    tasks: [],
    memories: [],
    mode: 'live',
    configured: false,
};
const users = {
    alice: { id: 'alice', name: 'Alice', role: 'admin' as Role },
    bob: { id: 'bob', name: 'Bob', role: 'member' as Role },
};
let me: keyof typeof users = 'bob';
const workspace = (): WorkspaceState => ({
    user: users[me],
    spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 1 }],
    dots: [
        {
            id: 'd1',
            spaceId: 's1',
            spaceIds: ['s1'],
            name: 'Dot',
            instructions: 'Dot helps.',
            researchAllowed: false,
            memoryAllowed: false,
            createdAt: 1,
        },
    ],
    conversations: [],
    setup: {
        model: false,
        voice: false,
        telegram: 'not_configured',
        missing: ['model'],
    },
    calls: [],
});
const schedule = (extra: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 'sc1',
    title: 'Morning digest',
    prompt: 'Summarise.',
    kind: 'turn',
    cadence: 'every day at 09:00',
    timezone: 'Europe/Paris',
    intervalSeconds: null,
    status: 'scheduled',
    origin: 'dot',
    dotId: 'd1',
    dotName: 'Dot',
    jobId: null,
    jobName: null,
    threadId: 't1',
    nextRunAt: Date.UTC(2026, 9, 9, 7),
    lastRun: {
        status: 'failed',
        startedAt: Date.UTC(2026, 9, 8, 7),
        finishedAt: Date.UTC(2026, 9, 8, 7, 1),
        error: 'Model unavailable.',
    },
    error: null,
    createdAt: 1,
    ...extra,
});
const run: JobRunView = {
    id: 'r1',
    jobId: 'j1',
    version: 2,
    trigger: 'schedule',
    scheduleId: 'sc2',
    status: 'succeeded',
    queuedAt: 1,
    startedAt: Date.UTC(2026, 9, 8, 6),
    wakeMs: 4200,
    finishedAt: Date.UTC(2026, 9, 8, 6, 0, 9),
    exitCode: 0,
    error: null,
    longRunId: null,
};
// Past the newest keepRuns of its job: kept, without its output.
const oldRun: JobRunView = {
    ...run,
    id: 'r0',
    startedAt: Date.UTC(2026, 8, 8, 6),
    finishedAt: Date.UTC(2026, 8, 8, 6, 0, 7),
    outputNotKept: 'Output not kept for older runs.',
};
const job = {
    id: 'j1',
    name: 'Collect prices',
    dotId: 'd1',
    dotName: 'Dot',
    entry: 'main.ts' as const,
    version: 2,
    timeoutSeconds: 120,
    datasets: ['scratch'],
    files: [{ path: 'main.ts', size: 120 }],
    untilDone: false,
    createdAt: 1,
    updatedAt: 1,
    lastRun: run,
};
// A goal's schedule with a long Markdown prompt, as its details show it.
const PROMPT = [
    '## Weekly numbers',
    '',
    '- **Collect** the sign-ups and the churn',
    '- Post them here with one line on what changed',
    '',
    ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Check source ${i + 1} and note anything odd.`),
].join('\n');
const turnRun: ScheduleRunView = {
    id: 'tr2',
    status: 'completed',
    startedAt: Date.UTC(2026, 9, 8, 7),
    finishedAt: Date.UTC(2026, 9, 8, 7, 0, 42),
    summary: 'Sign-ups rose 12% this week; churn held at 2%.',
    error: null,
    turnPath: '/chats/t1#message-m2',
    board: [{ issue: 'CB-7', title: 'Churn export is late', action: 'create' }],
};
const olderTurnRun: ScheduleRunView = {
    ...turnRun,
    id: 'tr1',
    status: 'failed',
    startedAt: Date.UTC(2026, 9, 1, 7),
    finishedAt: Date.UTC(2026, 9, 1, 7, 0, 3),
    summary: null,
    error: 'Model unavailable.',
    turnPath: null,
    board: [],
};
const baseDetail = (): ScheduleDetail => ({
    schedule: schedules[0]!,
    cadenceText: 'Every weekday at 09:00',
    upcoming: [Date.UTC(2026, 9, 9, 7), Date.UTC(2026, 9, 12, 7), Date.UTC(2026, 9, 13, 7)],
    approvals: [{ capability: 'issue.file', label: 'File an improvement', policy: 'auto' }],
    goal: {
        id: 'G-0000beef',
        userId: 'bob',
        dotId: 'd1',
        title: 'Keep the weekly numbers current',
        detail: PROMPT,
        status: 'active',
        progress: 'Posted week 41; churn source still late.',
        comments: [
            {
                id: 'GC-1',
                author: 'person',
                body: 'Also add the churn numbers by plan.',
                createdAt: Date.UTC(2026, 9, 8, 6),
            },
            {
                id: 'GC-2',
                author: 'dot',
                body: 'Added churn by plan to the sheet.',
                createdAt: Date.UTC(2026, 9, 8, 7),
            },
        ],
        scheduleId: 'sc1',
        threadId: 't1',
        cadence: 'every weekday at 09:00',
        nextRunAt: Date.UTC(2026, 9, 9, 7),
        createdAt: 1,
        updatedAt: Date.UTC(2026, 9, 8, 7, 0, 40),
        closedAt: null,
    },
    runs: [turnRun],
    moreRuns: true,
});
let scheduleDetail = baseDetail;
let schedules: ScheduleView[] = [];
let listedGoals: GoalView[] = [];
let calls: Array<{ method: string; path: string; body?: unknown }> = [];
/** Set: j1 runs until done, with this long run (CB-122). */
let longRun: LongRunView | null = null;
let codeMissing = false;
const listedJob = () => (longRun ? { ...job, untilDone: true, longRun } : job);

const respond = (url: URL, init?: RequestInit): [number, unknown] => {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${path}${url.search}`, body });
    if (path === '/api/state') {
        return [200, state];
    }
    if (path === '/api/workspace') {
        return [200, workspace()];
    }
    if (path === '/api/issues') {
        return [200, { issues: [], users: {} }];
    }
    if (path.startsWith('/api/learning/')) {
        return [200, []];
    }
    if (path === '/api/schedules') {
        return [
            200,
            {
                schedules,
                goals: listedGoals,
                jobs: [listedJob()],
                limits: {
                    minIntervalMinutes: 15,
                    maxActiveSchedules: 20,
                    maxJobTimeoutSeconds: 900,
                    jobConcurrency: 2,
                    maxJobs: 50,
                },
                usage: { activeSchedules: schedules.length, jobs: 1 },
                ...(users[me].role === 'admin'
                    ? {
                          counts: {
                              schedules: { scheduled: 7, paused: 1 },
                              jobs: 3,
                              jobRuns: { succeeded: 12 },
                              runningJobs: 1,
                          },
                      }
                    : {}),
            } satisfies SchedulesState,
        ];
    }
    if (path === '/api/schedules/sc1') {
        return [200, scheduleDetail()];
    }
    if (path === '/api/schedules/goals/G-0000beef/comments') {
        const full = scheduleDetail();
        const goal = full.goal!;
        const comments = [
            ...goal.comments,
            {
                id: 'GC-3',
                author: 'person' as const,
                body: body.body,
                createdAt: Date.UTC(2026, 9, 8, 8),
            },
        ];
        const was = scheduleDetail;
        scheduleDetail = () => ({ ...was(), goal: { ...goal, comments } });
        return [200, { ...goal, comments }];
    }
    if (path === '/api/schedules/sc1/runs') {
        return url.searchParams.get('before') === 'tr2'
            ? [200, { runs: [olderTurnRun], more: false } satisfies ScheduleRunsPage]
            : [404, { error: 'Run not found.' }];
    }
    if (path.match(/^\/api\/schedules\/[^/]+\/actions$/) && method === 'POST') {
        const id = path.split('/')[3]!;
        schedules = schedules.map((item) =>
            item.id === id
                ? {
                      ...item,
                      status:
                          body.action === 'pause'
                              ? 'paused'
                              : body.action === 'resume'
                                ? 'scheduled'
                                : body.action === 'cancel'
                                  ? 'cancelled'
                                  : item.status,
                  }
                : item,
        );
        return [200, schedules.find((s) => s.id === id) ?? {}];
    }
    if (path === '/api/schedules/jobs/j1') {
        return [
            200,
            {
                job: listedJob(),
                code: codeMissing
                    ? { state: 'missing', missing: ['main.ts'], error: null }
                    : { state: 'stored', missing: [], error: null },
                ...(longRun ? { longRun } : {}),
                versions: [
                    {
                        version: 2,
                        entry: 'main.ts',
                        files: job.files,
                        timeoutSeconds: 120,
                        datasets: ['scratch'],
                        untilDone: false,
                        createdAt: 1,
                    },
                ],
                runs: [run],
                moreRuns: true,
            } satisfies JobDetail,
        ];
    }
    if (path === '/api/schedules/jobs/j1/stop') {
        longRun = {
            ...longRun!,
            status: 'cancelled',
            outcome: '“Collect prices” was stopped: Stopped by its owner.',
        };
        return [200, longRun];
    }
    if (path === '/api/schedules/jobs/j1/runs') {
        return url.searchParams.get('before') === 'r1'
            ? [200, { runs: [oldRun], more: false } satisfies JobRunsPage]
            : [404, { error: 'Run not found.' }];
    }
    if (path === '/api/schedules/runs/r1') {
        return [200, { ...run, stdout: 'fetched 12 prices\n', stderr: '' }];
    }
    if (path === '/api/schedules/runs/r0') {
        return [200, oldRun];
    }
    if (path === '/api/schedules/jobs/j1/code') {
        return [200, { version: 2, files: { 'main.ts': 'console.log(1)' } }];
    }
    if (path === '/api/schedules/jobs/j1/retry') {
        codeMissing = false;
        return [200, { repaired: 'code', run: { ...run, id: 'r3', status: 'queued', trigger: 'manual' } }];
    }
    if (path === '/api/schedules/jobs/j1/run') {
        return [200, { ...run, id: 'r2', status: 'queued', trigger: 'manual' }];
    }
    return [404, { error: 'Not found.' }];
};

let root: Root;
let host: HTMLElement;
vi.setConfig({ testTimeout: 20_000 });
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }) as unknown as MediaQueryList;
    me = 'bob';
    calls = [];
    scheduleDetail = baseDetail;
    longRun = null;
    codeMissing = false;
    schedules = [schedule()];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const [status, body] = respond(new URL(input, 'http://app.test'), init);
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
async function open(path: string) {
    const router = createTestRouter(path);
    act(() => root.render(<RouterProvider router={router} />));
    await until(() => !!host.querySelector('[data-slot="app-header"]'), 'shell');
    return router;
}
const text = () => host.textContent ?? '';
const button = (name: string, within: ParentNode = document) =>
    [...within.querySelectorAll<HTMLButtonElement>('button')].find(
        (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name,
    );
const click = (element: HTMLElement | undefined) =>
    act(() => {
        element!.click();
    });
const tab = (name: string) =>
    act(() => {
        const trigger = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
            (item) => item.textContent === name,
        )!;
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        trigger.click();
    });
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const menuItem = (label: string) => menuItems().find((item) => item.textContent === label);
/** Opens a schedule row's ⋯ menu by its title (CB-392). */
async function openScheduleMenu(scope: ParentNode, title: string) {
    const trigger = scope.querySelector<HTMLElement>(`[aria-label="Actions for ${title}"]`)!;
    act(() => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        trigger.click();
    });
    await until(() => menuItems().length > 0, `${title}'s menu`);
}

it('lists the user’s schedules with next and last runs, and pauses and resumes them', async () => {
    await open('/schedules');
    await until(() => !!host.querySelector('[data-schedule="sc1"]'), 'the schedules');
    const row = host.querySelector('[data-schedule="sc1"]')!;
    expect(row.textContent).toContain('Morning digest');
    expect(row.textContent).toContain('every day at 09:00 (Europe/Paris)');
    expect(row.textContent).toContain('Model unavailable.');
    expect(row.querySelector('[data-status="failed"]')).not.toBeNull();
    // Its title opens its details (CB-88).
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/schedules/sc1');
    // Row actions live in a ⋯ menu that targets its own row (CB-392).
    await openScheduleMenu(row, 'Morning digest');
    click(menuItem('Pause'));
    await until(
        () =>
            calls.some(
                (call) =>
                    call.method === 'POST' &&
                    call.path === '/api/schedules/sc1/actions' &&
                    (call.body as { action: string }).action === 'pause',
            ),
        'paused',
    );
    await until(
        () => host.querySelector('[data-schedule="sc1"] [data-slot="schedule-status"]')?.textContent === 'Paused',
        'the status badge',
    );
    await openScheduleMenu(host.querySelector('[data-schedule="sc1"]')!, 'Morning digest');
    click(menuItem('Resume'));
    await until(
        () =>
            calls.some(
                (call) =>
                    call.path === '/api/schedules/sc1/actions' && (call.body as { action: string }).action === 'resume',
            ),
        'resumed',
    );
    // Members don't get the workspace's counts.
    expect([...host.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual(['Schedules', 'Jobs']);
});

it('cancels the schedule its row names, not a different one, after typing its title (CB-392)', async () => {
    schedules = [
        schedule({ id: 'sc1', title: 'Morning digest' }),
        schedule({ id: 'sc2', title: 'Build Erden plan', dotId: 'd1', dotName: 'Dot', threadId: 't2' }),
    ];
    await open('/schedules');
    await until(() => !!host.querySelector('[data-schedule="sc2"]'), 'both schedules');
    expect(
        [...host.querySelectorAll('[data-slot="schedule-list"] tbody [data-schedule]')].map((row) =>
            row.getAttribute('data-schedule'),
        ),
    ).toEqual(['sc2', 'sc1']);
    // The shared grid's sortable headers (CB-392): Schedule, pressed twice, sorts by title descending.
    const order = () =>
        [...host.querySelectorAll('[data-slot="schedule-list"] tbody [data-schedule]')].map((row) =>
            row.getAttribute('data-schedule'),
        );
    const sortBy = (header: string) =>
        click(
            [...host.querySelectorAll<HTMLButtonElement>('[data-slot="grid-sort"]')].find((b) =>
                b.textContent?.includes(header),
            )!,
        );
    sortBy('Schedule');
    sortBy('Schedule');
    expect(order()).toEqual(['sc1', 'sc2']);
    sortBy('Schedule');
    expect(order()).toEqual(['sc2', 'sc1']);
    // Act on the Erden plan's row: its menu, then Cancel…, then type its title.
    await openScheduleMenu(host.querySelector('[data-schedule="sc2"]')!, 'Build Erden plan');
    click(menuItem('Cancel…'));
    const dialog = () => document.querySelector<HTMLElement>('[data-slot="schedule-cancel-confirm"]');
    await until(() => !!dialog(), 'the cancel confirm');
    expect(dialog()!.textContent).toContain('Build Erden plan');
    // The destructive button stays disabled until the title is typed exactly.
    const confirm = () => [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel schedule')!;
    expect(confirm().disabled).toBe(true);
    // A near-miss title (the other schedule's) does not unlock it.
    const input = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Schedule title"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    const type = (value: string) =>
        act(() => {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    // A near-miss title (the other schedule's) does not unlock it.
    type('Morning digest');
    expect(confirm().disabled).toBe(true);
    expect(dialog()!.querySelector('[data-slot="cancel-name-mismatch"]')).not.toBeNull();
    type('Build Erden plan');
    await until(() => !confirm().disabled, 'the title matched');
    click(confirm());
    await until(
        () =>
            calls.some(
                (call) =>
                    call.method === 'POST' &&
                    call.path === '/api/schedules/sc2/actions' &&
                    (call.body as { action: string }).action === 'cancel',
            ),
        'sc2 cancelled',
    );
    // Only sc2 was cancelled; sc1 is untouched.
    expect(calls.some((call) => call.path === '/api/schedules/sc1/actions')).toBe(false);
    await until(
        () => host.querySelector('[data-schedule="sc2"] [data-slot="schedule-status"]')?.textContent === 'Canceled',
        'sc2 canceled badge',
    );
    expect(host.querySelector('[data-schedule="sc1"] [data-slot="schedule-status"]')?.textContent).toBe('Active');
});

it('shows a job’s versions, runs and logs, and runs it now', async () => {
    await open('/schedules?tab=jobs');
    await until(() => !!host.querySelector('[data-job="j1"]'), 'the jobs');
    expect(host.querySelector('[data-job="j1"]')!.textContent).toContain('v2');
    click(button('Run now', host.querySelector('[data-job="j1"]')!));
    await until(() => calls.some((call) => call.path === '/api/schedules/jobs/j1/run'), 'run now');
    click(button('Details', host.querySelector('[data-job="j1"]')!));
    await until(() => !!host.querySelector('[data-slot="job-runs"]'), 'the job detail');
    expect(text()).toContain('wake 4.2 s');
    click(button('Logs', host.querySelector('[data-slot="job-runs"]')!));
    await until(() => text().includes('fetched 12 prices'), 'the logs');
    // Older runs page in; one past the newest keepRuns has no output, and
    // the panel says so.
    const runsTable = () => host.querySelector('[data-slot="job-runs"]')!;
    const logs = () =>
        [...runsTable().querySelectorAll<HTMLButtonElement>('button')].filter(
            (item) => item.textContent?.trim() === 'Logs',
        );
    expect(logs()).toHaveLength(1);
    click(button('Load more', host.querySelector('[data-slot="job-detail"]')!));
    await until(() => logs().length === 2, 'the older runs');
    expect(button('Load more')).toBeUndefined();
    click(logs()[1]);
    await until(() => !!host.querySelector('[data-slot="job-output-not-kept"]'), 'the older run');
    expect(host.querySelector('[data-slot="job-logs"]')!.textContent).not.toContain('stdout');
    expect(text()).toContain('Output not kept for older runs.');
    expect(text()).not.toContain('fetched 12 prices');
    click(button('Code', host.querySelector('[data-slot="job-detail"]')!));
    await until(() => text().includes('console.log(1)'), 'the code');

    // Deleting asks first, in a dialog (CB-64), and claims no permanence.
    const deletes = () => calls.filter((call) => call.method === 'DELETE' && call.path === '/api/schedules/jobs/j1');
    click(button('Delete job', host.querySelector('[data-slot="job-detail"]')!));
    const dialog = () => document.querySelector<HTMLElement>('[data-slot="job-confirm-delete"]');
    await until(() => !!dialog(), 'the confirm');
    expect(dialog()!.textContent).toContain('Delete job?');
    expect(dialog()!.textContent).toContain('schedules that run it stop');
    expect(dialog()!.textContent).not.toMatch(/undone|restored|for good/);
    click(button('Cancel', dialog()!));
    await until(() => !dialog(), 'the confirm closed');
    expect(deletes()).toEqual([]);
    click(button('Delete job', host.querySelector('[data-slot="job-detail"]')!));
    await until(() => !!dialog(), 'the confirm again');
    click(button('Delete', dialog()!));
    await until(() => deletes().length === 1, 'the delete');
});

it('says when a job’s code is missing from storage, and restores the approved code and runs it (CB-336)', async () => {
    codeMissing = true;
    await open('/schedules?tab=jobs');
    await until(() => !!host.querySelector('[data-job="j1"]'), 'the jobs');
    click(button('Details', host.querySelector('[data-job="j1"]')!));
    await until(() => !!host.querySelector('[data-slot="job-code-missing"]'), 'the missing code');
    const notice = host.querySelector('[data-slot="job-code-missing"]')!;
    expect(notice.textContent).toContain('The code of v2 isn’t in storage (main.ts)');
    click(button('Restore code and run', notice));
    await until(
        () => calls.some((call) => call.method === 'POST' && call.path === '/api/schedules/jobs/j1/retry'),
        'the retry',
    );
    await until(() => !host.querySelector('[data-slot="job-code-missing"]'), 'the code restored');
});

it('shows how a job that runs until done is going, and stops it (CB-122)', async () => {
    longRun = {
        id: 'L1',
        jobId: 'j1',
        trigger: 'dot',
        scheduleId: null,
        status: 'waiting',
        items: { total: 726, done: 412, remaining: 313, inProgress: 0, failed: 1 },
        listComplete: true,
        batches: 3,
        maxBatches: 200,
        currentRunId: null,
        checkpoint: '{"page":41}',
        checkpointAt: Date.UTC(2026, 9, 8, 6, 30),
        retries: 1,
        maxRetries: 5,
        nextAt: Date.UTC(2026, 9, 8, 6, 40),
        waitReason: 'The source refused (HTTP 429): Too Many Requests. Waiting until 2026-10-08 06:40 UTC.',
        lastError: null,
        deadLetters: [
            {
                key: 'listing-77',
                error: 'Unexpected detail schema',
                attempts: 3,
                at: Date.UTC(2026, 9, 8, 6, 20),
            },
        ],
        outcome: null,
        createdAt: Date.UTC(2026, 9, 8, 6),
        updatedAt: Date.UTC(2026, 9, 8, 6, 30),
        finishedAt: null,
    };
    await open('/schedules?tab=jobs');
    await until(() => !!host.querySelector('[data-job="j1"]'), 'the jobs');
    const row = host.querySelector('[data-job="j1"]')!;
    expect(row.textContent).toContain('runs until done');
    expect(row.querySelector('[data-slot="long-run-line"]')!.textContent).toContain('412 of 726 done · 1 failed');
    // Running until done: no second start from here.
    expect(button('Running', row)!.disabled).toBe(true);
    click(button('Details', row));
    await until(() => !!host.querySelector('[data-slot="job-progress"]'), 'the progress');
    const progress = host.querySelector('[data-slot="job-progress"]')!;
    expect(progress.querySelector('[data-slot="job-progress-items"]')!.textContent).toBe(
        '412 done · 313 left · 1 failed · 726 in all',
    );
    expect(progress.textContent).toContain('{"page":41}');
    expect(progress.textContent).toContain('1 of 5');
    expect(progress.querySelector('[data-slot="job-progress-wait"]')!.textContent).toContain('HTTP 429');
    expect(progress.querySelector('[data-slot="job-dead-letters"]')!.textContent).toContain(
        'listing-77Unexpected detail schema · 3 tries',
    );
    click(button('Stop', progress));
    await until(() => calls.some((call) => call.path === '/api/schedules/jobs/j1/stop'), 'the stop');
    await until(() => !!host.querySelector('[data-slot="job-progress-outcome"]'), 'the outcome');
    expect(button('Stop', host.querySelector('[data-slot="job-progress"]')!)).toBeUndefined();
});

it('shows admins the workspace’s counts only', async () => {
    me = 'alice';
    await open('/schedules');
    await until(() => text().includes('Workspace'), 'the workspace tab');
    tab('Workspace');
    await until(() => !!host.querySelector('[data-slot="schedule-counts"]'), 'the counts');
    const counts = host.querySelector('[data-slot="schedule-counts"]')!;
    expect(counts.textContent).toContain('7 scheduled · 1 paused');
    expect(counts.textContent).toContain('Saved jobs: 3');
});

it('shows a schedule in full: its purpose, what it does, its goal and its runs, paged (CB-88)', async () => {
    schedules = [schedule({ title: 'Weekly numbers', prompt: PROMPT })];
    await open('/schedules/sc1');
    const page = () => host.querySelector('[data-slot="schedule-page"]')!;
    await until(() => !!host.querySelector('[data-slot="schedule-runs"]'), 'the details');
    // The title heads the page; the goal is its purpose, its detail Markdown
    // at body sizes, not a heading, collapsed when long.
    expect(page().querySelector('h1')!.textContent).toBe('Weekly numbers');
    expect(host.querySelector('[data-slot="schedule-purpose-card"]')!.textContent).toContain(
        'Keep the weekly numbers current',
    );
    const purpose = host.querySelector('[data-slot="schedule-purpose"]')!;
    expect(purpose.querySelector('h3')!.textContent).toBe('Weekly numbers');
    expect(purpose.querySelector('strong')!.textContent).toBe('Collect');
    expect(purpose.querySelectorAll('ol li')).toHaveLength(12);
    expect(purpose.querySelector('[data-collapsed]')).not.toBeNull();
    click(button('Show all', purpose));
    expect(purpose.querySelector('[data-collapsed]')).toBeNull();
    expect(button('Show less', purpose)).toBeDefined();
    // What it does: the Dot, the cadence in words, the next runs, its zone,
    // its chat, the approvals that apply and its status.
    const facts = host.querySelector('[data-slot="schedule-facts"]')!;
    expect(facts.textContent).toContain('Every weekday at 09:00');
    expect(facts.textContent).toContain('Europe/Paris');
    expect(facts.querySelectorAll('[data-slot="schedule-upcoming"] li')).toHaveLength(3);
    expect([...facts.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
        '/chats/t1',
        '/approvals?dot=d1',
    ]);
    expect(facts.querySelector('[data-slot="schedule-approvals"]')!.textContent).toContain(
        'File an improvement (auto review)',
    );
    expect(facts.querySelector('[data-slot="schedule-standing"]')!.textContent).toContain('Active');
    // Its goal's progress.
    const goal = host.querySelector('[data-slot="schedule-goal"]')!;
    expect(goal.textContent).toContain('Keep the weekly numbers current');
    expect(goal.textContent).toContain('Posted week 41; churn source still late.');
    // Its comments, oldest first, with who wrote each; the person adds more.
    const thread = host.querySelector('[data-slot="schedule-goal-comments"]')!;
    expect([...thread.querySelectorAll('[data-slot="goal-comment"]')].map((item) => item.textContent)).toEqual([
        expect.stringMatching(/^You · .*Also add the churn numbers by plan\.$/),
        expect.stringMatching(/^Dot · .*Added churn by plan to the sheet\.$/),
    ]);
    const area = thread.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(button('Comment', thread)!.disabled).toBe(true);
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'Skip the free plan.');
        area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(button('Comment', thread));
    await until(() => thread.querySelectorAll('[data-slot="goal-comment"]').length === 3, 'the new comment');
    expect(calls.find((call) => call.path === '/api/schedules/goals/G-0000beef/comments')?.body).toEqual({
        body: 'Skip the free plan.',
    });
    // Its runs, newest first, with the answer, the turn and the board.
    const runs = () => host.querySelector('[data-slot="schedule-runs"]')!;
    const latest = runs().querySelector('[data-run="tr2"]')!;
    expect(latest.textContent).toContain('Sign-ups rose 12% this week');
    expect(latest.textContent).toContain('42 s');
    expect([...latest.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
        ['Open in chat', '/chats/t1#message-m2'],
        ['Filed CB-7', '/issues/CB-7'],
    ]);
    click(button('Load more', page()));
    await until(() => !!runs().querySelector('[data-run="tr1"]'), 'the older runs');
    expect(calls.map((call) => call.path)).toContain('/api/schedules/sc1/runs?before=tr2');
    expect(runs().querySelector('[data-run="tr1"]')!.textContent).toContain('Model unavailable.');
    expect(button('Load more', page())).toBeUndefined();
    click(button('Pause', facts));
    await until(
        () =>
            calls.some(
                (call) =>
                    call.path === '/api/schedules/sc1/actions' && (call.body as { action: string }).action === 'pause',
            ),
        'paused',
    );
});

it('lists a goal’s comments on the schedules page, and adds one (CB-135)', async () => {
    schedules = [schedule()];
    listedGoals = [scheduleDetail().goal!];
    try {
        await open('/schedules');
        await until(() => !!host.querySelector('[data-slot="goal-list"]'), 'the goals');
        const row = host.querySelector('[data-goal="G-0000beef"]')!;
        expect(row.querySelector('[data-slot="goal-comments-toggle"] summary')!.textContent).toBe('2 comments');
        expect(row.querySelectorAll('[data-slot="goal-comment"]')).toHaveLength(2);
        expect(row.textContent).toContain('Added churn by plan to the sheet.');
    } finally {
        listedGoals = [];
    }
});

it('says why a schedule is paused, and that it has no next runs', async () => {
    schedules = [
        schedule({
            status: 'paused',
            nextRunAt: null,
            error: 'Paused after 3 failed runs in a row: Model unavailable.',
        }),
    ];
    const full = scheduleDetail;
    scheduleDetail = () => ({ ...full(), upcoming: [], goal: null });
    try {
        await open('/schedules/sc1');
        await until(() => !!host.querySelector('[data-slot="schedule-standing"]'), 'the details');
        const facts = host.querySelector('[data-slot="schedule-facts"]')!;
        expect(facts.querySelector('[data-slot="schedule-standing"]')!.textContent).toBe(
            'Paused Paused after 3 failed runs in a row: Model unavailable.',
        );
        expect(facts.textContent).toContain('None while paused');
        expect(button('Resume', facts)).toBeDefined();
        expect(host.querySelector('[data-slot="schedule-goal"]')).toBeNull();
        // Without a goal, the prompt is its purpose.
        expect(host.querySelector('[data-slot="schedule-purpose"]')!.textContent).toBe('Summarise.');
    } finally {
        scheduleDetail = full;
    }
});

it('says a schedule that isn’t the person’s is not found', async () => {
    await open('/schedules/someone-elses');
    await until(() => text().includes('Schedule not found'), 'not found');
});
