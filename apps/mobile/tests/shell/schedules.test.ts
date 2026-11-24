import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { GoalView, JobView, LongRunView, ScheduleView } from '@socio/shared/schedule-types';
import type { Task } from '@socio/shared/types';

import type { AuthedFetch } from '../../src/net/authed-fetch';
import {
    firstPageKey,
    type OlderRuns,
    olderRunsFor,
    refreshesDetail,
    withOlderPage,
    activityRows,
    every,
    goalRows,
    jobRows,
    scheduleButtons,
    scheduleDetailView,
    scheduleRows,
    standing,
    taskButtons,
    taskStatusLabel,
} from '../../src/shell/schedules';
import type { BoundedItemState } from '../../src/sync/bounded-kind';
import type { OverlayItem } from '../../src/sync/outbox-overlay';
import {
    actOnTask,
    onlineActionCopy,
    runJobNow,
    runScheduleNow,
    SCHEDULE_REASON,
    shownSchedules,
    stopJob,
} from '../../src/sync/schedule-writes';
import { GOALS, SCHEDULES } from '../../src/sync/schedules';

// Scheduled & activity and Schedules' view models under Node: the web's rows,
// buttons and words; this device's schedule writes laid over; Run now, a
// task's Pause and Stop sending nothing offline (the phone stops a running job
// but creates and edits nothing).

const NOW = Date.UTC(2026, 10, 9, 12, 0);
const SETTINGS = { paused: false, researchAllowed: true };

const task = (fields: Partial<Task> = {}): Task => ({
    id: 't1',
    prompt: 'Check the build',
    status: 'completed',
    intervalSeconds: null,
    nextRunAt: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 5 * 60_000,
    error: null,
    lease: null,
    leaseUntil: null,
    ...fields,
});

const schedule = (fields: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 's1',
    title: 'Morning digest',
    prompt: 'Summarize the news',
    kind: 'turn',
    cadence: 'every day at 09:00',
    timezone: 'Europe/Madrid',
    intervalSeconds: null,
    status: 'scheduled',
    origin: 'user',
    dotId: 'dot-1',
    dotName: 'Ada',
    jobId: null,
    jobName: null,
    threadId: null,
    nextRunAt: Date.UTC(2026, 10, 10, 8, 0),
    lastRun: null,
    error: null,
    createdAt: 1_000,
    ...fields,
});

const goal = (fields: Partial<GoalView> = {}): GoalView => ({
    id: 'G-00000001',
    userId: 'u1',
    dotId: 'dot-1',
    title: 'Ship the report',
    detail: 'By Friday',
    status: 'active',
    progress: null,
    comments: [{ id: 'c1', author: 'dot', body: 'Started', createdAt: Date.UTC(2026, 10, 8, 9, 0) }],
    scheduleId: 's1',
    threadId: null,
    cadence: 'every day at 09:00',
    nextRunAt: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    closedAt: null,
    ...fields,
});

const overlay = (fields: Partial<OverlayItem> & Pick<OverlayItem, 'collection' | 'key' | 'value'>): OverlayItem =>
    ({ id: 'w1', state: 'queued', reason: null, createdAt: NOW, ...fields }) as OverlayItem;

describe('Scheduled & activity', () => {
    it('lists the tasks as the web does, searched over the prompt in any case', () => {
        const tasks = [
            task(),
            task({ id: 't2', prompt: 'Water the PLANTS', status: 'running', intervalSeconds: 7200 }),
            task({ id: 't3', prompt: 'Later', status: 'completed', nextRunAt: NOW + 1 }),
        ];
        const rows = activityRows(tasks, '', NOW, 'UTC');
        expect(rows.map((row) => [row.title, row.status, row.line])).toEqual([
            ['Check the build', 'Completed', '5m ago'],
            ['Water the PLANTS', 'Running', 'Repeats every 2 hr · 5m ago'],
            ['Later', 'Scheduled', '5m ago'],
        ]);
        expect(activityRows(tasks, 'plants', NOW).map((row) => row.id)).toEqual(['t2']);
        expect(rows[0]!.accessibilityLabel).toBe('Check the build, Completed, 5m ago');
    });

    it('offers the web’s task buttons: Pause only while running or queued, Run now blocked by the settings', () => {
        const labels = (t: Task, settings = SETTINGS) => taskButtons(t, settings).map((b) => [b.label, b.blocked]);
        expect(labels(task({ status: 'running' }))).toEqual([
            ['Pause task', null],
            ['Cancel', null],
        ]);
        expect(labels(task({ status: 'queued' }))[0]).toEqual(['Pause task', null]);
        expect(labels(task({ status: 'completed', intervalSeconds: 3600 }))).toEqual([
            ['Run again', null],
            ['Pause schedule', null],
            ['Cancel', null],
        ]);
        expect(labels(task({ status: 'paused' }))[0]).toEqual(['Resume task', null]);
        expect(labels(task({ status: 'failed' }))[0]).toEqual(['Retry task', null]);
        expect(labels(task({ status: 'cancelled' }))).toEqual([['Run again', null]]);
        expect(labels(task(), { paused: true, researchAllowed: true })[0]).toEqual([
            'Run again',
            'Socios are paused in this workspace',
        ]);
        expect(taskStatusLabel({ status: 'completed', nextRunAt: 1 })).toBe('Scheduled');
    });

    it('offline, Run now and a task’s Pause send nothing and say "Needs a connection"', async () => {
        const requests: string[] = [];
        const fetch: AuthedFetch = async (path) => {
            requests.push(path);
            return new Response('{}', { status: 200 });
        };
        const context = { fetch, connected: false };
        for (const result of [
            await actOnTask(context, { taskId: 't1', action: 'pause' }),
            await actOnTask(context, { taskId: 't1', action: 'run', settings: SETTINGS }),
            await runScheduleNow(context, { scheduleId: 's1', settings: SETTINGS }),
            await runJobNow(context, { jobId: 'j1', settings: SETTINGS }),
            await stopJob(context, { jobId: 'j1' }),
        ]) {
            expect(onlineActionCopy(result)).toBe('Needs a connection');
        }
        expect(requests).toEqual([]);
    });
});

describe('Schedules', () => {
    it('shows each schedule as the web does, newest first, with this device’s writes laid over', () => {
        const paused = schedule({ id: 's2', status: 'paused', createdAt: 3_000 });
        const stored = [schedule(), paused, schedule({ id: 's3', status: 'cancelled', createdAt: 500 })];
        const shown = shownSchedules(
            stored,
            [],
            [
                overlay({ collection: SCHEDULES, key: 's1', value: { action: 'pause' } }),
                overlay({
                    id: 'w2',
                    collection: SCHEDULES,
                    key: 's2',
                    value: { action: 'resume' },
                    state: 'unsent',
                    reason: SCHEDULE_REASON.closed,
                }),
            ],
        );
        const rows = scheduleRows(shown.schedules, 'UTC');
        expect(rows.map((row) => [row.id, row.statusWord, row.pending, row.buttons])).toEqual([
            ['s2', 'Paused', 'That schedule was cancelled, or its socio is archived', ['run', 'resume', 'cancel']],
            ['s1', 'Paused', 'Waiting to send', ['run', 'resume', 'cancel']],
            ['s3', 'Cancelled', null, []],
        ]);
        expect(rows[1]).toMatchObject({
            what: 'Ada · Socio turn · made by you',
            runs: 'every day at 09:00 (Europe/Madrid)',
            next: 'Next Nov 10, 2026, 8:00 AM',
            last: 'Not run yet',
        });
        expect(scheduleButtons({ status: 'running' })).toEqual(['pause', 'cancel']);
    });

    it('shows goals newest first, with their socio, and a comment waiting under them', () => {
        const shown = shownSchedules(
            [schedule()],
            [goal(), goal({ id: 'G-2', createdAt: 5_000, status: 'done' })],
            [
                overlay({
                    collection: GOALS,
                    key: 'G-00000001',
                    value: { comment: { id: 'pending-goal-comment-1', serverId: null, body: 'Add charts' } },
                }),
            ],
        );
        const rows = goalRows(shown.goals, shown.schedules, 'UTC');
        expect(rows.map((row) => [row.id, row.status, row.open])).toEqual([
            ['G-2', 'Done', false],
            ['G-00000001', 'Active', true],
        ]);
        expect(rows[1]!.line).toBe('Ada · every day at 09:00 · no progress yet');
        expect(rows[1]!.comments.map((c) => [c.who.split(' · ')[0], c.body, c.pending])).toEqual([
            ['Ada', 'Started', null],
            ['You', 'Add charts', 'Waiting to send'],
        ]);
        expect(rows[1]!.commentsLabel).toBe('2 comments');
    });

    it('lists jobs by their last change, with a long run in progress as Running', () => {
        const longRun = {
            status: 'running',
            items: { done: 412, total: 726, failed: 3, remaining: 311, inProgress: 0 },
        } as unknown as LongRunView;
        const job = (fields: Partial<JobView>): JobView =>
            ({
                id: 'j1',
                name: 'Prices',
                dotId: 'dot-1',
                dotName: 'Ada',
                entry: 'main.sh',
                version: 2,
                timeoutSeconds: 60,
                datasets: [],
                files: [],
                untilDone: false,
                createdAt: 1,
                updatedAt: 1,
                lastRun: null,
                ...fields,
            }) as JobView;
        const rows = jobRows([job({}), job({ id: 'j2', name: 'Crawl', updatedAt: 9, untilDone: true, longRun })]);
        expect(rows.map((row) => [row.name, row.going, row.last])).toEqual([
            ['Crawl', true, 'Running · 412 of 726 done · 3 failed'],
            ['Prices', false, 'Never run'],
        ]);
        expect(rows[0]!.line).toBe('Ada · main.sh · v2 · 60 s · runs until done');
    });

    it('a schedule’s page takes the list’s shown row over its held copy, and its goal’s comments', () => {
        const item: BoundedItemState<never> = {
            value: null,
            fetchedAt: null,
            loaded: true,
            settled: true,
            refreshing: false,
            failed: true,
            gone: false,
        };
        expect(scheduleDetailView(item, null, null).state).toBe('offline');
        const shown = shownSchedules(
            [schedule({ intervalSeconds: 3600, cadence: null })],
            [goal()],
            [overlay({ collection: SCHEDULES, key: 's1', value: { action: 'cancel' } })],
        );
        const view = scheduleDetailView(item, shown.schedules[0]!, shown.goals[0]!, 'UTC');
        expect(view).toMatchObject({
            state: 'ready',
            title: 'Morning digest',
            purpose: 'Ship the report\n\nBy Friday',
            pending: 'Waiting to send',
            buttons: [],
            standing: { label: 'Canceled', note: 'It won’t run again.' },
        });
        expect(view.facts.map((fact) => [fact.label, fact.value])).toEqual([
            ['Socio', 'Ada'],
            ['Runs', 'Every hour, after each successful run'],
            ['Next run', 'Nov 10, 2026, 8:00 AM'],
        ]);
        expect(standing({ status: 'completed', error: null, cadence: null, intervalSeconds: null }).label).toBe(
            'Completed',
        );
        expect(every(86_400)).toBe('every day');
        expect(every(5400)).toBe('every 90 min');
    });

    it('never says "Dot" in what it shows', async () => {
        const words = Object.values(await import('../../src/shell/schedules')).filter(
            (value: unknown): value is string => typeof value === 'string',
        );
        expect(words.length).toBeGreaterThan(5);
        for (const text of words) {
            expect(text).not.toMatch(/\bDots?\b/);
        }
    });
});

describe('a detail read again, and older runs', () => {
    const screens = ['schedules.tsx', 'activity.tsx'].map((file) =>
        readFileSync(new URL(`../../src/screens/${file}`, import.meta.url), 'utf8'),
    );

    it('reads a detail again only when its row moves on, never on the open', () => {
        // The open reads it (the first row seen, or one arriving after), so nothing more is asked.
        expect(refreshesDetail('a', 'a')).toBe(false);
        expect(refreshesDetail('', 'a')).toBe(false);
        expect(refreshesDetail('a', '')).toBe(false);
        expect(refreshesDetail('a', 'b')).toBe(true);
        for (const screen of screens) {
            expect(screen).toContain('useRefreshOnRowChange(');
            expect(screen).not.toMatch(/useEffect\(\(\) => \{\s*if \((signature|updatedAt)/);
        }
    });

    it('starts the older runs again when the first page changes, and drops a page read for the old one', () => {
        const first = firstPageKey([{ id: 'r3' }, { id: 'r2' }]);
        const empty: OlderRuns<{ id: string }> = { after: first, runs: [], more: false };
        const once = withOlderPage(empty, first, { runs: [{ id: 'r1' }], more: true });
        expect(once).toEqual({ after: first, runs: [{ id: 'r1' }], more: true });
        expect(olderRunsFor(once, first)).toBe(once);
        // A refresh brought a new run: the first page moved on, and what Load more added goes.
        const moved = firstPageKey([{ id: 'r4' }, { id: 'r3' }]);
        expect(olderRunsFor(once, moved)).toEqual({ after: moved, runs: [], more: false });
        // A page read for the old first page arrives late: nothing is added.
        const fresh = olderRunsFor(once, moved);
        expect(withOlderPage(fresh, first, { runs: [{ id: 'r1' }], more: false })).toBe(fresh);
    });

    it('asks nothing on a second tap while older runs are read', () => {
        const schedules = screens[0]!;
        expect(schedules).toMatch(/if \(last === undefined \|\| loading\.current\) \{\s*return;/);
        expect(schedules).toMatch(/\.finally\(\(\) => \{\s*loading\.current = false;/);
    });
});
