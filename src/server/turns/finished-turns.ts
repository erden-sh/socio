/**
 * What happens on each finished turn, in the graph's order: its log line,
 * then its trace to the operator's collector. `layer.ts` runs them over the
 * tags; `composition/turns.ts`'s builders over the objects they are
 * given.
 */
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';
import { OtlpExporter, traceSettings, turnContent, turnSpans } from '@socio/foundation/observability/otel-export';

import type { RunnerShape, TurnSubjectsShape, TurnsConfigShape } from './contract.js';
import { turnLogLine } from './local-runner.js';
import { traceSummary } from './turn-trace.js';

/** Each finished turn's log line. */
export function logFinishedTurns(
    runner: Pick<RunnerShape, 'onRunFinished'>,
    subjects: Pick<TurnSubjectsShape, 'owner' | 'source'>,
) {
    runner.onRunFinished((threadId, status, run) => {
        const ownerId = subjects.owner(threadId);
        void subjects.source(threadId, run.source).then((source) =>
            console.log(
                turnLogLine({
                    status,
                    runId: run.runId,
                    threadId,
                    ownerId,
                    source,
                    ms: run.finishedAt - run.startedAt,
                    error: run.error,
                    trace: traceSummary(run.trace),
                    // Who started its cycle and whose access it used (CB-211).
                    initiator: run.trace.trigger,
                    cycle: run.trace.cycle,
                }),
            ),
        );
    });
}

/** The exporter the turn traces go to: none unless an OTLP endpoint is set. */
export function turnTraceExporter(config: TurnsConfigShape): OtlpExporter | undefined {
    return config.otlp ? new OtlpExporter(config.otlp) : undefined;
}

/** Sends each finished turn's spans to `exporter`: a listener on the runner. */
export function sendTurnTraces(
    exporter: OtlpExporter,
    runner: Pick<RunnerShape, 'onRunFinished' | 'runEvents'>,
    subjects: Pick<TurnSubjectsShape, 'socio' | 'settings' | 'source'>,
    config: TurnsConfigShape,
) {
    runner.onRunFinished((threadId, status, run) =>
        setImmediate(async () => {
            try {
                const dot = subjects.socio(threadId);
                const { includeContent } = traceSettings(subjects.settings(), config.traceContent);
                exporter.export(
                    turnSpans(
                        {
                            runId: run.runId,
                            threadId,
                            status,
                            source: await subjects.source(threadId, run.source),
                            startedAt: run.startedAt,
                            finishedAt: run.finishedAt,
                            dotId: dot?.id,
                            dotName: dot?.name,
                            error: run.error,
                        },
                        run.trace,
                        includeContent ? turnContent(runner.runEvents(run.runId)) : undefined,
                    ),
                );
            } catch (error) {
                reportFailure('Trace export', [safeFailure(error)]);
            }
        }),
    );
}
