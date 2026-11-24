/**
 * The approvals' layers: they implement `contract.ts`, over the tags of the
 * features they read. Only the composition root and tests import this file.
 *
 * What no tag can hold yet is passed in (`ApprovalsLate`): the Telegram
 * channel and the drain are set after the graph is built, and the turn
 * (`AppTurns`) and the log are the composition's.
 *
 * What approvals read of the features above them in the folder order
 * (scripts/feature-ranks.json) they declare here as their own tags, typed
 * by the slices in `sources.ts`, and the composition root provides them
 * (`composition/approvals.ts`):
 * - `ApprovalsWorkspace`: the workspace's socios and conversations
 *   (`Socios`, `Conversations`);
 * - `ApprovalsLinks`: Telegram's links (`Links`).
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context, Effect, Layer } from 'effect';

import { Cycles } from '../cycles/contract.js';
import { Flags } from '../flags/contract.js';
import { Inference } from '../inference/contract.js';
import { WorkspaceSettings } from '../settings/contract.js';
import { Runner } from '../turns/contract.js';

import { ApprovalContinuations } from './continue.js';
import { Approvals, ApprovalsConfig, ApprovalsViews, ApprovalsWorkspace, Continuations } from './contract.js';
import { approvalNotices } from './notices.js';
import type { ApprovalService } from './service.js';
import { workspaceApprovals } from './services.js';
import type { ApprovalLinks, ContinuationSources } from './sources.js';
import { approvalsViews } from './views.js';

/**
 * The approval service as `workspaceApprovals` builds it, with every method
 * approvals' own code uses: what `LegacyApprovals` holds. Other features see the
 * `Approvals` tag, typed by the contract.
 */
export class ApprovalServiceTag extends Context.Service<ApprovalServiceTag, ApprovalService>()(
    'socio/approvals/ApprovalService',
) {}

/**
 * The continuations, under the graph's `ApprovalContinuationsTag` tag (the class), for its start
 * and stop. Other features see the `Continuations` tag.
 */
export class ApprovalContinuationsTag extends Context.Service<ApprovalContinuationsTag, ApprovalContinuations>()(
    'socio/approvals/ApprovalContinuations',
) {}

/** The workspace's socios and conversations, as approvals read them: in the contract. */
export { ApprovalsWorkspace, type ApprovalsWorkspaceShape } from './contract.js';

/** Telegram's links, as approvals read them (see above). */
export class ApprovalsLinks extends Context.Service<ApprovalsLinks, ApprovalLinks>()(
    'socio/approvals/ApprovalsLinks',
) {}

/** What the approvals read at the moment of use that no tag holds yet (see above). */
export type ApprovalsLate = Pick<ContinuationSources, 'telegram' | 'draining' | 'turnOutcome' | 'log'>;

/**
 * The approval service on the workspace's connection, built once, under
 * `ApprovalServiceTag` and `Approvals`; and its views, under
 * `ApprovalsViews`.
 */
export const ApprovalsLive = (db: DatabaseSync) =>
    Layer.mergeAll(
        Layer.effect(
            Approvals,
            Effect.gen(function* () {
                return yield* ApprovalServiceTag;
            }),
        ),
        Layer.effect(
            ApprovalsViews,
            Effect.gen(function* () {
                return approvalsViews({ approvals: yield* ApprovalServiceTag, flags: yield* Flags });
            }),
        ),
    ).pipe(
        Layer.provideMerge(
            Layer.effect(
                ApprovalServiceTag,
                Effect.gen(function* () {
                    const { socios, conversations, people } = yield* ApprovalsWorkspace;
                    return workspaceApprovals(db, {
                        socios,
                        conversations,
                        people,
                        runner: yield* Runner,
                        cycles: yield* Cycles,
                        inference: yield* Inference,
                    });
                }),
            ),
        ),
    );

/**
 * The Telegram notices of waiting requests (`approvalNotices`): a listener
 * on the approvals, registered when the layer is built.
 */
export const ApprovalNoticesLive = (late: Pick<ApprovalsLate, 'telegram'>) =>
    Layer.effectDiscard(
        Effect.gen(function* () {
            approvalNotices({
                approvals: yield* Approvals,
                links: yield* ApprovalsLinks,
                config: yield* ApprovalsConfig,
                telegram: late.telegram,
            });
        }),
    );

/**
 * The turns that carry on once a conversation's requests are decided
 * (CB-58), under `ApprovalContinuationsTag` and `Continuations`. Its
 * listeners are registered when the layer is built.
 */
export const ContinuationsLive = (late: ApprovalsLate) =>
    Layer.effect(
        Continuations,
        Effect.gen(function* () {
            return yield* ApprovalContinuationsTag;
        }),
    ).pipe(
        Layer.provideMerge(
            Layer.effect(
                ApprovalContinuationsTag,
                Effect.gen(function* () {
                    const approvals = yield* ApprovalServiceTag;
                    const runner = yield* Runner;
                    const cycles = yield* Cycles;
                    const { socios, conversations } = yield* ApprovalsWorkspace;
                    return new ApprovalContinuations({
                        approvals,
                        runner,
                        cycles,
                        socios,
                        conversations,
                        links: yield* ApprovalsLinks,
                        settings: yield* WorkspaceSettings,
                        ...late,
                    });
                }),
            ),
        ),
    );
