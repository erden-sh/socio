import { afterEach, expect, it, vi } from 'vitest';

import { RuntimeSession } from '@socio/data/runtime-ownership';
import type { JobRunView } from '@socio/shared/schedule-types';

import type { JobRunPatch } from '../src/server/schedules/domain/repositories.js';
import { JobService } from '../src/server/schedules/jobs.js';
import { LongRunService } from '../src/server/schedules/long-runs.js';
import { sqliteSchedules } from '../src/server/schedules/services.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
    cleanup
        .splice(0)
        .reverse()
        .forEach((close) => close()),
);

async function fixture(stale: boolean) {
    const db = testDatabase();
    let now = 1000;
    const runtime = new RuntimeSession({
        heartbeat: false,
        leaseMs: 100,
        now: () => now,
    });
    const data = sqliteSchedules(db, runtime);
    const lease = data.ownership.claim('job', 'old', 'job:x', (claimed) => claimed);
    await data.repos.jobRuns.insert({
        id: 'old',
        jobId: 'x',
        version: 1,
        userId: 'u',
        dotId: 'd',
        trigger: 'manual',
        scheduleId: null,
        queuedAt: now,
        longRunId: null,
    });
    let other: RuntimeSession | undefined;
    if (stale) {
        now += 101;
        other = new RuntimeSession({
            heartbeat: false,
            leaseMs: 100,
            now: () => now,
        });
        other
            .attach(db)
            .recoverOrphan('job', 'old', () =>
                db.prepare("UPDATE job_runs SET status='interrupted',finishedAt=? WHERE id='old'").run(now),
            );
    }
    cleanup.push(() => {
        runtime.detachSync(db);
        other?.detachSync(db);
        db.close();
    });
    const seen = vi.fn();
    interface Harness {
        pump(): void;
        forceStop(reason: string): number;
        update(id: string, patch: JobRunPatch): Promise<void>;
        readonly running: number;
    }
    // Isolate the actual pump/cancel/update lifecycle from computer I/O, while
    // using real leases, transactions, recovery and repository mutations.
    const service: Harness = Object.assign(Object.create(JobService.prototype) as object, {
        schedules: data,
        active: new Map([['old', { lease, controller: new AbortController() }]]),
        queue: ['old'],
        done: new Map(),
        ends: new Set([seen]),
        stopped: true, // This fixture exercises notification fencing, not its timer.
        runRow: () => data.repos.jobRuns.get('old'),
        runView: (row: unknown) => row,
        log: () => {},
        execute: () => service.update('old', { status: 'succeeded', finishedAt: now }),
    }) as unknown as Harness;
    Object.defineProperty(service, 'settings', { value: { concurrency: 1 } });
    return {
        service,
        seen,
        data,
        expire: () => {
            now += 101;
        },
    };
}

it.each(['pump', 'cancel'] as const)(
    'suppresses stale %s completion listeners after another runtime recovered the row',
    async (mode) => {
        const { service, seen, data } = await fixture(true);
        if (mode === 'pump') {
            service.pump();
        } else {
            service.forceStop('Cancelled');
        }
        await expect.poll(() => service.running).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect((await data.repos.jobRuns.get('old'))?.status).toBe('interrupted');
        expect(seen).not.toHaveBeenCalled();
    },
);
it('emits the valid owner completion once after its terminal write committed and cleanup ended', async () => {
    const { service, seen, data } = await fixture(false);
    service.pump();
    await expect.poll(() => seen.mock.calls.length).toBe(1);
    expect(service.running).toBe(0);
    expect((await data.repos.jobRuns.get('old'))?.status).toBe('succeeded');
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
});
it('suppresses a committed completion if authority expired before cleanup finished', async () => {
    const { service, seen, data, expire } = await fixture(false);
    Object.assign(service, {
        execute: async () => {
            await service.update('old', { status: 'succeeded', finishedAt: 1000 });
            expire();
        },
    });
    service.pump();
    await expect.poll(() => service.running).toBe(0);
    expect((await data.repos.jobRuns.get('old'))?.status).toBe('succeeded');
    expect(seen).not.toHaveBeenCalled();
});
it('does not refund item claims for an obsolete long-run batch callback', async () => {
    const release = vi.fn(),
        counts = vi.fn();
    const service = Object.assign(Object.create(LongRunService.prototype) as object, {
        repo: {
            get: async () => ({ currentRunId: 'replacement' }),
            release,
            counts,
        },
    }) as unknown as { batchEnded(run: JobRunView): Promise<void> };
    await service.batchEnded({
        id: 'obsolete',
        longRunId: 'long-run',
        status: 'interrupted',
    } as JobRunView);
    expect(release).not.toHaveBeenCalled();
    expect(counts).not.toHaveBeenCalled();
});
