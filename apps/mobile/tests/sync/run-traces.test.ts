import { afterEach, describe, expect, it } from 'vitest';

import type { RunTraceView } from '@socio/shared/runs/run-trace';

import { runTracePath } from '../../src/chat/run-trace';
import type { AuthedFetch } from '../../src/net/authed-fetch';
import { NetworkError } from '../../src/net/errors';
import { traceState } from '../../src/shell/runs';
import type { BoundedStore } from '../../src/sync/bounded-kind';
import { SnapshotShapeError } from '../../src/sync/errors';
import { createRunTraces, isOwnRun, RUN_TRACES } from '../../src/sync/run-traces';

import { syncSetup } from './helpers';

// Runs' traces: a bounded kind against a real
// cache.db, read only when asked (the run page's open), the person's own kept
// on disk and shown offline with its age, someone else's never written, a 404
// said as "isn't available".

type Setup = Awaited<ReturnType<typeof syncSetup>>;
const open: Array<{ s: Setup; traces: BoundedStore<RunTraceView> }> = [];
afterEach(async () => {
    for (const { s, traces } of open.splice(0)) {
        await traces.close().catch(() => {});
        await s.close().catch(() => {});
    }
});

const view = (runId: string): RunTraceView => ({
    runId,
    status: 'failed',
    startedAt: 1_000,
    finishedAt: 5_000,
    trace: {
        rounds: [{ kind: 'round', round: 1, startedAt: 1_000, endedAt: 2_000, stop: 'tool_calls' }],
        tools: [
            {
                kind: 'tool',
                round: 1,
                name: 'web_search',
                callId: 'call-1',
                startedAt: 2_000,
                endedAt: 3_500,
                outcome: 'error',
                error: 'http_500',
            },
        ],
        waits: [],
        end: { reason: 'error', rounds: 2, cap: 25 },
    },
});

const OWNERS: Record<string, string> = { mine: 'u-ada', theirs: 'u-ben' };

async function setup(directory?: string) {
    const s = await syncSetup(directory === undefined ? {} : { directory });
    const server = { mode: 'ok' as 'ok' | 'offline', requests: [] as string[] };
    const fetch: AuthedFetch = async (path) => {
        server.requests.push(path);
        if (server.mode === 'offline') {
            throw new NetworkError(path);
        }
        const runId = /^\/api\/runs\/([^/]+)\/trace$/.exec(path)?.[1];
        return runId === undefined || !(runId in OWNERS)
            ? new Response(JSON.stringify({ error: 'Run not found.' }), { status: 404 })
            : new Response(JSON.stringify(view(runId)), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
              });
    };
    const traces = createRunTraces({
        db: s.db,
        fetch,
        now: s.clock.device,
        ownRun: (runId) => isOwnRun(OWNERS[runId] === undefined ? undefined : { ownerId: OWNERS[runId]! }, 'u-ada'),
    });
    open.push({ s, traces });
    return { s, traces, server };
}

describe('run traces', () => {
    it('ask nothing until a run’s page uses one; a press reads disk alone', async () => {
        const { traces, server } = await setup();
        await traces.preload('mine');
        expect(traces.item('mine').state.value).toBeNull();
        expect(server.requests).toEqual([]);
        const item = traces.item('mine');
        const release = item.use();
        await item.refresh();
        expect(server.requests.every((path) => path === '/api/runs/mine/trace')).toBe(true);
        release();
    });

    it('keep the person’s own on disk, shown offline with its age; another’s is never written', async () => {
        const first = await setup();
        for (const key of ['mine', 'theirs']) {
            await first.traces.item(key).refresh();
        }
        await first.traces.flush();
        expect(await first.traces.stored('mine')).toBe(true);
        expect(await first.traces.stored('theirs')).toBe(false);
        const directory = first.s.directory;
        await first.traces.close();
        await first.s.close({ remove: false });
        open.splice(0);

        const again = await setup(directory);
        again.server.mode = 'offline';
        const mine = again.traces.item('mine');
        const release = mine.use();
        await mine.loaded;
        await mine.refresh();
        const state = traceState(mine.state, true, false, 'UTC');
        expect(state.kind).toBe('ready');
        expect(state.kind === 'ready' && state.age).toMatch(/^Saved /);
        release();

        const theirs = again.traces.item('theirs');
        await theirs.loaded;
        await theirs.refresh();
        expect(traceState(theirs.state, true, false)).toEqual({ kind: 'offline', retrying: false });
        // Try again: the page's button reads it once more, and it shows once the server answers.
        again.server.mode = 'ok';
        await theirs.refresh();
        expect(traceState(theirs.state, true, false).kind).toBe('ready');
    });

    it('refuses an answer for another run than the one asked', () => {
        expect(RUN_TRACES.parse(runTracePath('r1'), view('r1')).runId).toBe('r1');
        expect(() => RUN_TRACES.parse(runTracePath('r1'), view('r2'))).toThrow(SnapshotShapeError);
    });

    it('a run the phone can’t place counts as someone else’s', async () => {
        expect(isOwnRun(undefined, 'u-ada')).toBe(false);
        expect(isOwnRun({ ownerId: null }, 'u-ada')).toBe(false);
        expect(isOwnRun({ ownerId: 'u-ada' }, 'u-ada')).toBe(true);
    });

    it('a 404 says the trace isn’t available, and keeps no copy', async () => {
        const { traces } = await setup();
        const item = traces.item('gone');
        const release = item.use();
        await item.refresh();
        expect(item.state.gone).toBe(true);
        expect(traceState(item.state, true, false).kind).toBe('missing');
        release();
        await traces.flush();
        expect(await traces.stored('gone')).toBe(false);
    });
});
