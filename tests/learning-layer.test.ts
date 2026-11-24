// Learning's layers: built over the contracts' tags, the analysis is offered
// as `LearningJob` and `Learning` with its evidence (`Evidence`), published
// skills (`Skills`), delivery (`SkillDelivery`) and views (`LearningViews`);
// the evidence of a thread goes to the container its conversation names; the
// classification seam is looked up on the triage's first use, not when the
// layer is built; and the evidence hook is one listener on the runner that
// records a finished run and then asks for the threshold trigger.
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import { Reactions, type ReactionsShape } from '../src/server/context/contract.js';
import { Inference, type InferenceShape } from '../src/server/inference/contract.js';
import { LearningAnalysis } from '../src/server/learning/analysis.js';
import { Evidence, Learning, LearningViews, SkillDelivery, Skills } from '../src/server/learning/contract.js';
import { EvidenceHookLive, LearningJob, LearningLive, type TriageSeam } from '../src/server/learning/layer.js';
import { Runner, type RunFinishedListener, type RunnerShape } from '../src/server/turns/contract.js';
import { WorkspaceLive } from '../src/server/workspace/layer.js';

import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

function fixture() {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const dot = workspace.dots()[0]!;
    workspace.updateDot(dot.id, { ...dot, learningContainerId: 'research', skillDeliveryEnabled: true });
    workspace.bindThread('t1', dot.id, 'Weekly report', 'alice');
    const listeners: RunFinishedListener[] = [];
    const runner = {
        messages: async () => [],
        onRunFinished: (listener: RunFinishedListener) => void listeners.push(listener),
    };
    const seam = vi.fn(
        (): TriageSeam =>
            ({
                classifier: {
                    settings: () => ({ enabled: false, threshold: 0.8, perDay: 100 }),
                    current: async () => undefined,
                    passed: () => false,
                },
                store: {
                    usage: () => ({ label: 0, tokens: 0, cost: 0 }),
                    goldenCount: () => 0,
                    labels: () => [],
                },
            }) as unknown as TriageSeam,
    );
    const tags = Layer.mergeAll(
        WorkspaceLive(workspace),
        Layer.succeed(Runner, runner as unknown as RunnerShape),
        Layer.succeed(Inference, { shared: async () => undefined } as unknown as InferenceShape),
        Layer.succeed(Reactions, { labels: () => new Map() } as unknown as ReactionsShape),
    );
    const graph = EvidenceHookLive(workspace.db).pipe(
        Layer.provideMerge(LearningLive(workspace.db, { seam })),
        Layer.provideMerge(tags),
    );
    return { workspace, dot, listeners, seam, graph };
}

it('offers the analysis and its stores under the contracts’ tags', async () => {
    const f = fixture();
    const built = await Effect.runPromise(
        Effect.gen(function* () {
            return {
                job: yield* LearningJob,
                learning: yield* Learning,
                evidence: yield* Evidence,
                skills: yield* Skills,
                delivery: yield* SkillDelivery,
                views: yield* LearningViews,
            };
        }).pipe(Effect.provide(f.graph)),
    );
    expect(built.job).toBeInstanceOf(LearningAnalysis);
    expect(built.learning).toBe(built.job);
    expect(built.evidence).toBe(built.job.evidence);
    expect(built.skills).toBe(built.job.skills);
    // Built, but the seam isn't looked up until the triage is first used.
    expect(f.seam).not.toHaveBeenCalled();
    expect(await built.job.configured()).toBe(false);

    // The conversation's container takes its evidence.
    expect(built.evidence.record('t1', 'finished', 10)).toBe('research');
    expect(built.evidence.record('unbound', 'finished', 10)).toBeUndefined();
    expect(built.evidence.count('research')).toBe(1);
    expect(f.workspace.evidence.count('research')).toBe(1);

    // The views read the same stores.
    expect(built.views.containerIds()).toEqual(['research']);
    expect(built.views.publishedSkills()).toEqual([{ containerId: 'research', skills: [] }]);
    expect(built.views.containers()).toEqual([
        {
            id: 'research',
            dots: [{ id: f.dot.id, name: f.dot.name, delivery: true }],
            newEvidence: 1,
            pendingProposals: 0,
            published: 0,
            running: false,
            lastRun: null,
        },
    ]);
    const detail = await built.views.container('research');
    expect(detail).toMatchObject({
        id: 'research',
        newEvidence: 1,
        configured: false,
        runs: [],
        proposals: [],
        triage: { enabled: false, available: false, threads: [{ threadId: 't1', title: 'Weekly report' }] },
    });
    expect(f.seam).toHaveBeenCalledOnce();
    expect(built.views.proposals('research')).toEqual({ items: [] });
    expect(built.views.parseProposalCursor('not a cursor')).toBeUndefined();

    // Delivery over the published skills.
    expect(built.delivery.learnedSkillsFor(false, 'research')).toBeUndefined();
    expect(built.delivery.learnedSkillsFor(true, 'research')).toMatchObject({
        containerId: 'research',
        freshnessWindowMs: 0,
    });

    // The seam is looked up once, then kept.
    built.job.seamTriage();
    expect(f.seam).toHaveBeenCalledOnce();
});

it('records each finished run as evidence, then asks for the threshold trigger', async () => {
    const f = fixture();
    const job = await Effect.runPromise(
        Effect.gen(function* () {
            return yield* LearningJob;
        }).pipe(Effect.provide(f.graph)),
    );
    expect(f.listeners).toHaveLength(1);
    const maybeAnalyze = vi.spyOn(job, 'maybeAnalyze').mockResolvedValue();
    f.listeners[0]!('t1', 'finished', {} as never);
    await vi.waitFor(() => expect(maybeAnalyze).toHaveBeenCalledWith('research'));
    expect(job.evidence.count('research')).toBe(1);

    // A thread in no container records nothing and triggers nothing.
    f.listeners[0]!('unbound', 'finished', {} as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maybeAnalyze).toHaveBeenCalledOnce();
});
