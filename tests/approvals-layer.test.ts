// Approvals' services as tags, built by `approvals/layer.ts` over the tags of
// the features they read (the workspace's and Telegram's through approvals'
// own). A test swaps those features' layers for fakes.
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import {
    Approvals,
    ApprovalsConfig,
    ApprovalsViews,
    Continuations,
    type ApprovalsShape,
} from '../src/server/approvals/contract.js';
import {
    ApprovalContinuationsTag,
    ApprovalNoticesLive,
    ApprovalServiceTag,
    ApprovalsLinks,
    ApprovalsLive,
    ApprovalsWorkspace,
    ContinuationsLive,
    type ApprovalsWorkspaceShape,
} from '../src/server/approvals/layer.js';
import { ApprovalService } from '../src/server/approvals/service.js';
import type { ApprovalChannel, ApprovalLinks } from '../src/server/approvals/sources.js';
import { approvalsConfig } from '../src/server/composition/approvals.js';
import { Cycles, type CyclesShape } from '../src/server/cycles/contract.js';
import { Flags, type FlagsShape } from '../src/server/flags/contract.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { WorkspaceSettings, type WorkspaceSettingsShape } from '../src/server/settings/contract.js';
import { Runner, type RunnerShape } from '../src/server/turns/contract.js';

import { testDatabase } from './helpers/test-database.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) {
        db.close();
    }
    vi.restoreAllMocks();
});

function fakes(flagOn = false) {
    const settled: string[] = [];
    const runFinished: Array<(threadId: string) => void> = [];
    const layer = Layer.mergeAll(
        Layer.succeed(ApprovalsWorkspace, {
            socios: { dot: () => undefined, canUseDot: () => false },
            conversations: {
                thread: () => undefined,
                allows: () => true,
                answers: () => false,
            },
            people: { isDeactivated: () => false },
        } satisfies ApprovalsWorkspaceShape),
        Layer.succeed(Runner, {
            activeRunId: () => undefined,
            onRunFinished: (listener: (threadId: string) => void) => void runFinished.push(listener),
        } as unknown as RunnerShape),
        Layer.succeed(Cycles, {
            running: async () => undefined,
            settleWaiting: async (threadId: string) => {
                settled.push(threadId);
                return 0;
            },
        } as unknown as CyclesShape),
        Layer.succeed(Inference, { resolve: async () => ({ ok: false }) } as unknown as InferenceShape),
        Layer.succeed(Flags, { enabled: () => flagOn } as unknown as FlagsShape),
    );
    return { layer, settled, runFinished };
}

function database() {
    const db = testDatabase();
    dbs.push(db);
    return db;
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

it('builds the service once, under its own tag and `Approvals`, with its views', async () => {
    const { layer } = fakes();
    const context = await run(Layer.build(ApprovalsLive(database()).pipe(Layer.provide(layer))).pipe(Effect.scoped));
    const service = Context.get(context, ApprovalServiceTag);
    expect(service).toBeInstanceOf(ApprovalService);
    expect(Context.get(context, Approvals)).toBe(service);
    const views = Context.get(context, ApprovalsViews);
    expect(await views.approval('missing', 'alice')).toBeNull();
    const state = await views.approvals('alice');
    expect(state).toMatchObject({ pending: [], recent: [], policies: [], audit: [] });
});

it('ends a waiting work cycle once its conversation’s requests settle', async () => {
    const { layer, settled } = fakes();
    const db = database();
    const context = await run(Layer.build(ApprovalsLive(db).pipe(Layer.provide(layer))).pipe(Effect.scoped));
    const approvals = Context.get(context, ApprovalServiceTag);
    approvals.register({
        capability: 'test.write',
        label: 'Test',
        description: 'A test capability.',
        execute: () => 'Done.',
    });
    const outcome = await approvals.request({
        userId: 'alice',
        dotId: 'dot-1',
        capability: 'test.write',
        summary: 'Write a thing',
        payload: {},
        threadId: 'thread-1',
    });
    expect(outcome.status).toBe('pending_approval');
    await approvals.decide(outcome.id, 'alice', false);
    await vi.waitFor(() => expect(settled).toEqual(['thread-1']));
});

it('registers the Telegram notices on `Approvals`, reading the channel when a request waits', async () => {
    const pending: Array<Parameters<ApprovalsShape['onPending']>[0]> = [];
    const approvals = { onPending: (listener) => void pending.push(listener) } as Pick<
        ApprovalsShape,
        'onPending'
    > as ApprovalsShape;
    const channel = vi.fn((): ApprovalChannel | undefined => undefined);
    const layer = ApprovalNoticesLive({ telegram: channel }).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(Approvals, approvals),
                Layer.succeed(ApprovalsLinks, {} as ApprovalLinks),
                Layer.succeed(ApprovalsConfig, { appOrigin: 'https://app.example.invalid' }),
            ),
        ),
    );
    await run(Layer.build(layer).pipe(Effect.scoped));
    expect(pending).toHaveLength(1);
    expect(channel).not.toHaveBeenCalled();
    pending[0]!({ id: 'r1' } as never, { userId: 'alice', threadId: 't1' });
    expect(channel).toHaveBeenCalledTimes(1);
});

it('builds the continuations under their own tag and `Continuations`, listening for runs that finish', async () => {
    const { layer, runFinished } = fakes();
    const continuations = ContinuationsLive({
        telegram: () => undefined,
        draining: () => false,
        turnOutcome: () => Promise.reject(new Error('not in this test')),
        log: () => undefined,
    }).pipe(
        Layer.provideMerge(ApprovalsLive(database())),
        Layer.provide(
            Layer.mergeAll(
                layer,
                Layer.succeed(ApprovalsLinks, {} as ApprovalLinks),
                Layer.succeed(WorkspaceSettings, {} as WorkspaceSettingsShape),
            ),
        ),
    );
    const context = await run(Layer.build(continuations).pipe(Effect.scoped));
    expect(Context.get(context, Continuations)).toBe(Context.get(context, ApprovalContinuationsTag));
    expect(runFinished).toHaveLength(1);
});

it('takes `ApprovalsConfig` from the startup configuration, only the fields approvals read', () => {
    const config = { baseUrl: '', apiKey: '', appOrigin: 'https://app.example.invalid' };
    expect(approvalsConfig(config)).toEqual({ appOrigin: 'https://app.example.invalid' });
    expect(approvalsConfig({})).toEqual({ appOrigin: undefined });
});
