import { Context, Effect, Layer } from 'effect';

/**
 * The turn engine's layers: what each finished turn sets off, over the tags.
 * Only the composition (`composition/turns.ts`) and tests import this file.
 *
 * Not here: the runner itself, which `index.ts` builds before the graph
 * and the graph's root (`composition/root.ts`) provides as `Runner`; and the task runner, made
 * after the graph (`composition/lifecycle/turns.ts`).
 */
import type { OtlpExporter } from '@socio/foundation/observability/otel-export';

import { Runner, TurnSubjects, TurnsConfig } from './contract.js';
import { logFinishedTurns, sendTurnTraces, turnTraceExporter } from './finished-turns.js';

/**
 * The turn trace exporter, under the graph's `TraceExporter` tag (its `stop` flushes it):
 * none unless an OTLP endpoint is set.
 */
export const TraceExporter = Context.Reference<OtlpExporter | undefined>('socio/turns/TraceExporter', {
    defaultValue: () => undefined,
});

/** Each finished turn's log line: a listener on the runner, registered when built. */
export const FinishedTurnLogLive = Layer.effectDiscard(
    Effect.gen(function* () {
        logFinishedTurns(yield* Runner, yield* TurnSubjects);
    }),
);

/**
 * Turn traces to the operator's collector (CB-128): a listener on the
 * runner and its exporter, only when `TurnsConfig.otlp` is set. The
 * exporter's shutdown is registered as it is made, so a graph that fails
 * to build after it (here, or in a later layer) still stops its timer;
 * `LeaderWork.stop` shuts it down first, as before, and the second shutdown
 * finds nothing left to send.
 */
export const TraceExporterLive = Layer.effect(
    TraceExporter,
    Effect.gen(function* () {
        const runner = yield* Runner;
        const subjects = yield* TurnSubjects;
        const config = yield* TurnsConfig;
        const exporter = yield* Effect.acquireRelease(
            Effect.sync(() => turnTraceExporter(config)),
            (exporter) => Effect.promise(async () => exporter?.shutdown()),
        );
        if (exporter) {
            sendTurnTraces(exporter, runner, subjects, config);
        }
        return exporter;
    }),
);
