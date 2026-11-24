import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { DatasetAnalytics } from '../src/server/dataspace/analytics/process.js';

// CB-369: the datasets' analytics process, as the app drives it.

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

/** A stand-in worker: answers each job with its pid after 500 ms, and takes 300 ms to exit when asked. */
function fakeWorker() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-analytics-process-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const entry = join(dir, 'worker.mjs');
    writeFileSync(
        entry,
        `process.on('message', (m) => {
  if (m.shutdown) { setTimeout(() => process.exit(0), 300); return; }
  setTimeout(() => process.send({ id: m.id, ok: true, value: process.pid }), 500);
});
process.on('disconnect', () => process.exit(0));`,
    );
    return entry;
}

it('starts on first use, stops when idle, and never fails a new process’s job when the old one exits', async () => {
    const analytics = new DatasetAnalytics('child', { entry: fakeWorker(), idleMs: 10 });
    cleanup.push(() => analytics.close());
    expect(analytics.status().state).toBe('idle');
    const first = await analytics.run<number>({ kind: 'ping' }, { timeoutMs: 5_000, concurrency: 2 });
    expect(typeof first).toBe('number');
    // Idle: asked to stop, it is still exiting while the next job starts a new one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await analytics.run<number>({ kind: 'ping' }, { timeoutMs: 5_000, concurrency: 2 });
    expect(second).not.toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The old process has exited by now; the new one answers still.
    expect(typeof (await analytics.run<number>({ kind: 'ping' }, { timeoutMs: 5_000, concurrency: 2 }))).toBe('number');
});

it('refuses jobs when off', async () => {
    const analytics = new DatasetAnalytics('off');
    await expect(analytics.run({ kind: 'ping' }, { timeoutMs: 1_000, concurrency: 1 })).rejects.toThrow(
        /DATA_ANALYTICS_MODE=off/,
    );
});
