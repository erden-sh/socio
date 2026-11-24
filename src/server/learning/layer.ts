/**
 * Learning's layers: they implement `contract.ts` over the tags of the features
 * Learning reads: the conversations (`Conversations`, whose container a
 * thread's evidence is in), the socios (`Socios`, for the views), the runner
 * (`Runner`), the default shared backend (`Inference`) and the reactions under
 * a thread's replies (`Reactions`). Only the composition root and tests import
 * this file.
 *
 * What no tag can hold yet is passed in (`LearningLate`): the
 * classification seam, which the graph builds after Learning, is looked up
 * on first use, as before.
 *
 * Nothing is started here. The daily tick, the triage tick, recovery and
 * stopping stay the module's hooks (`module.ts`), on the analysis
 * `LegacyLearning` holds (`LearningJob`).
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { transaction } from '@socio/data/open';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import { Reactions } from '../context/contract.js';
import { Inference, type ChatCompletionsEndpoint, type InferenceShape } from '../inference/contract.js';
import { Runner, type RunnerShape } from '../turns/contract.js';
import { Conversations, Socios, type ConversationsShape } from '../workspace/contract.js';

import { LearningAnalysis } from './analysis.js';
import { Evidence, Learning, LearningViews, SkillDelivery, Skills, type EvidenceShape } from './contract.js';
import { skillDelivery } from './delivery.js';
import { EvidenceLedger } from './evidence.js';
import { LearningJob } from './tags.js';
import { EvidenceTriage, type TriageDeps } from './triage.js';
import { learningViews } from './views.js';

/** The analysis, whole: in `tags.ts` so the module can read it. */
export { LearningJob };

/** The classification seam's classifier and labels, as Learning's triage uses them. */
export type TriageSeam = Pick<TriageDeps, 'classifier' | 'store'>;

/** What Learning reads at the moment of use that no tag holds yet (see above). */
export interface LearningLate {
    /** The seam, looked up on the triage's first use. */
    readonly seam: () => TriageSeam;
}

/**
 * The container a thread's evidence goes to: the one frozen on the
 * conversation (`learningContainerId`), with its socio and owner.
 */
export const threadContainer = (conversations: Pick<ConversationsShape, 'thread'>) => (threadId: string) => {
    const thread = conversations.thread(threadId);
    return thread?.learningContainerId
        ? {
              containerId: thread.learningContainerId,
              dotId: thread.dotId,
              ownerId: thread.ownerId,
          }
        : undefined;
};

/** Background work's endpoint: the default shared backend's, looked up per request. */
export const sharedEndpoint = (inference: Pick<InferenceShape, 'shared'>) => async () =>
    (await inference.shared())?.chatCompletions;

/**
 * Learning's analysis over the evidence, on the classification seam
 * (CB-200): its triage and checks go through the seam's `learning` use,
 * made on first use.
 */
export function learningAnalysis(deps: {
    db: DatabaseSync;
    evidence: EvidenceLedger;
    runner: Pick<RunnerShape, 'messages'>;
    endpoint: () => Promise<ChatCompletionsEndpoint | undefined>;
    /** Reactions on a thread's replies are evidence too (CB-133). */
    reactions: (threadId: string) => Map<string, string>;
    seam: LearningLate['seam'];
}): LearningAnalysis {
    const { db, runner } = deps;
    const learning = new LearningAnalysis(db, deps.evidence, runner, deps.endpoint, undefined, deps.reactions);
    let triage: EvidenceTriage | undefined;
    learning.useSeam(() => {
        if (!triage) {
            const seam = deps.seam();
            triage = new EvidenceTriage({
                db,
                classifier: seam.classifier,
                store: seam.store,
                runner,
            });
        }
        return triage;
    });
    return learning;
}

/**
 * Each finished run is evidence of its thread's container, then the
 * threshold trigger. The runner has its own connection; the evidence row
 * is on the shared one, behind any open unit of work (CB-110).
 */
export function recordEvidence(
    db: DatabaseSync,
    runner: Pick<RunnerShape, 'onRunFinished'>,
    evidence: Pick<EvidenceShape, 'record'>,
    learning: Pick<LearningAnalysis, 'maybeAnalyze'>,
) {
    runner.onRunFinished((threadId, status) => {
        transaction(db, 'record learning evidence', () => evidence.record(threadId, status))
            .then((container) => {
                if (container) {
                    void learning
                        .maybeAnalyze(container)
                        .catch((error: unknown) => reportFailure('Learning analysis', [safeFailure(error)]));
                }
            })
            .catch((error: unknown) =>
                console.error(
                    `Learning: a run's evidence wasn't recorded (${error instanceof Error ? error.name : 'unknown'}).`,
                ),
            );
    });
}

/**
 * The analysis on the workspace's connection, built once, under
 * `LearningJob` and `Learning`; its evidence under `Evidence`, its
 * published skills under `Skills`, delivery over them under
 * `SkillDelivery`, and the views over all of them under `LearningViews`.
 * Needs `Conversations`, `Socios`, `Runner`, `Inference` and `Reactions`.
 */
export const LearningLive = (db: DatabaseSync, late: LearningLate) =>
    Layer.effectContext(
        Effect.gen(function* () {
            const runner = yield* Runner;
            const inference = yield* Inference;
            const reactions = yield* Reactions;
            const socios = yield* Socios;
            const evidence = new EvidenceLedger(db, threadContainer(yield* Conversations));
            const learning = learningAnalysis({
                db,
                evidence,
                runner,
                endpoint: sharedEndpoint(inference),
                reactions: (threadId) => reactions.labels(threadId),
                seam: late.seam,
            });
            const { skills } = learning;
            return Context.make(LearningJob, learning).pipe(
                Context.add(Learning, learning),
                Context.add(Evidence, evidence),
                Context.add(Skills, skills),
                Context.add(SkillDelivery, skillDelivery(skills)),
                Context.add(LearningViews, learningViews({ learning, evidence, skills, socios })),
            );
        }),
    );

/**
 * The evidence each finished run records (`recordEvidence`): a listener on
 * the runner, registered when the layer is built. Needs `Runner`,
 * `Evidence` and `LearningJob`.
 */
export const EvidenceHookLive = (db: DatabaseSync) =>
    Layer.effectDiscard(
        Effect.gen(function* () {
            recordEvidence(db, yield* Runner, yield* Evidence, yield* LearningJob);
        }),
    );
