import { Effect, Layer } from 'effect';

/**
 * The approvals' construction: the graph's steps over approvals' layers
 * (`approvals/layer.ts`). What no tag holds yet at a step is read from the
 * late-bound ports (the channel, the drain, a socio's turn, the orchestrator);
 * the log is the modules' context's (`LegacyModuleContext`). The Telegram links
 * and the workspace settings are the graph's leaf bridges, built before every
 * step. The workspace's socios and conversations and Telegram's links reach
 * approvals through approvals' own tags (`ApprovalsWorkspace`,
 * `ApprovalsLinks`), provided here over the workspace's and telegram's.
 */
import { ApprovalsConfig, type ApprovalsConfigShape } from '../approvals/contract.js';
import {
    ApprovalContinuationsTag,
    ApprovalNoticesLive,
    ApprovalServiceTag,
    ApprovalsLinks,
    ApprovalsLive,
    ApprovalsWorkspace,
    ContinuationsLive,
    type ApprovalsLate,
} from '../approvals/layer.js';
import type { ApprovalService } from '../approvals/service.js';
import type { WorkCycles } from '../cycles/service.js';
import type { ModuleContext } from '../modules/contract.js';
import { Links } from '../telegram/contract.js';
import { Conversations, People, Socios } from '../workspace/contract.js';

import { LegacyConfig, LegacyModuleContext, LegacyWorkspace } from './base.js';
import { LegacyCycles } from './cycles.js';
import { type PlatformPorts, Ports } from './ports.js';

/**
 * Approvals, as the other features' steps hold them (the class): the
 * layer's own tag.
 */
export { ApprovalServiceTag as LegacyApprovals };

/** The continuations after a decision (the class): the layer's own tag, under its composition name. */
export { ApprovalContinuationsTag as LegacyContinuations };

/**
 * `ApprovalsConfig` from the startup configuration (`PlatformConfig`, as
 * `startAppRuntime` is given it): the fields approvals read. Moving env
 * parsing into composition is a later change.
 */
export function approvalsConfig(config: ApprovalsConfigShape): ApprovalsConfigShape {
    return { appOrigin: config.appOrigin };
}

/**
 * What the approvals read at the moment of use: the channel and the drain,
 * set after construction, and a socio's turn (`AppTurns`, built after
 * them), through their ports; and the modules' context's log.
 */
function approvalsLate(
    ports: Pick<PlatformPorts, 'turns' | 'telegram' | 'draining'>,
    context: Pick<ModuleContext, 'log'>,
): ApprovalsLate {
    return {
        telegram: () => ports.telegram.peek(),
        draining: () => ports.draining.get(),
        turnOutcome: (threadId, prompt, signal, options) =>
            ports.turns.get().turnOutcome(threadId, prompt, signal, options),
        log: (line) => context.log(line),
    };
}

/** `ApprovalsWorkspace` over the workspace's `Socios` and `Conversations`. */
const ApprovalsWorkspaceLive = Layer.effect(
    ApprovalsWorkspace,
    Effect.gen(function* () {
        return { socios: yield* Socios, conversations: yield* Conversations, people: yield* People };
    }),
);

/** `ApprovalsLinks` over telegram's `Links`. */
const ApprovalsLinksLive = Layer.effect(
    ApprovalsLinks,
    Effect.gen(function* () {
        return yield* Links;
    }),
);

/**
 * A step that left requests waiting waits too: the decision carries on in
 * its work cycle (CB-209). So does one a next socio follows in the room
 * (CB-206), through the orchestrator, built after the approvals.
 */
function awaitDecisions(cycles: WorkCycles, approvals: ApprovalService, ports: Pick<PlatformPorts, 'orchestrator'>) {
    cycles.awaiting = async (conversationId, runId) =>
        (await approvals.awaitingInRun(conversationId, runId)) ||
        (await ports.orchestrator.get().awaits(conversationId, runId));
}

/**
 * The approvals' steps of the graph, in the graph's order: the service
 * (`Approvals`, with its views and `ApprovalsConfig`), then, once the
 * socios' extensions exist, the Telegram notices and the continuations
 * (`Continuations`).
 */
export const approvalsLayers = {
    approvals: Layer.effectDiscard(
        Effect.gen(function* () {
            awaitDecisions(yield* LegacyCycles, yield* ApprovalServiceTag, yield* Ports);
        }),
    ).pipe(
        Layer.provideMerge(
            Layer.unwrap(
                Effect.gen(function* () {
                    // The workspace as the approvals read it is offered too: the
                    // module's hooks read it.
                    return ApprovalsLive((yield* LegacyWorkspace).db).pipe(Layer.provideMerge(ApprovalsWorkspaceLive));
                }),
            ),
        ),
        Layer.provideMerge(
            Layer.effect(
                ApprovalsConfig,
                Effect.gen(function* () {
                    return approvalsConfig(yield* LegacyConfig);
                }),
            ),
        ),
    ),
    notices: Layer.unwrap(
        Effect.gen(function* () {
            const ports = yield* Ports;
            return ApprovalNoticesLive({ telegram: () => ports.telegram.peek() }).pipe(
                Layer.provide(ApprovalsLinksLive),
            );
        }),
    ),
    continuations: Layer.unwrap(
        Effect.gen(function* () {
            return ContinuationsLive(approvalsLate(yield* Ports, yield* LegacyModuleContext)).pipe(
                Layer.provide(Layer.mergeAll(ApprovalsWorkspaceLive, ApprovalsLinksLive)),
            );
        }),
    ),
};
