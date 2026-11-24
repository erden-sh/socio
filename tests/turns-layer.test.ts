import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OtlpExporter } from '@socio/foundation/observability/otel-export';
import type { RunTrace } from '@socio/shared/runs/run-trace';

import {
    Runner,
    TurnSubjects,
    TurnsConfig,
    type FinishedRun,
    type RunFinishedListener,
    type RunnerShape,
    type TurnSubjectsShape,
    type TurnsConfigShape,
} from '../src/server/turns/contract.js';
import { FinishedTurnLogLive, TraceExporter, TraceExporterLive } from '../src/server/turns/layer.js';

/** A runner that only takes finished-run listeners and has no stored events. */
function fakeRunner() {
    const listeners: RunFinishedListener[] = [];
    const runner = {
        onRunFinished: (listener: RunFinishedListener) => void listeners.push(listener),
        runEvents: () => [],
    } as unknown as RunnerShape;
    return { runner, listeners };
}

const subjects: TurnSubjectsShape = {
    owner: (threadId) => (threadId === 'thread' ? 'alice' : undefined),
    socio: (threadId) => (threadId === 'thread' ? { id: 'dot-1', name: 'Manny' } : undefined),
    settings: () => ({}) as ReturnType<TurnSubjectsShape['settings']>,
    source: async (_threadId, recorded) => recorded ?? 'telegram',
};

const run = (runId: string): FinishedRun => ({
    runId,
    startedAt: 1_000,
    finishedAt: 1_250,
    trace: { rounds: [], tools: [], waits: [] } satisfies RunTrace,
});

/**
 * Both steps over fakes, chained as `composition/index.ts` chains them: the
 * log line's step is built first, then the exporter's over it.
 */
function build(config: TurnsConfigShape) {
    const { runner, listeners } = fakeRunner();
    const needs = Layer.succeed(Runner, runner).pipe(
        Layer.provideMerge(Layer.succeed(TurnSubjects, subjects)),
        Layer.provideMerge(Layer.succeed(TurnsConfig, config)),
    );
    const layer = TraceExporterLive.pipe(Layer.provideMerge(FinishedTurnLogLive.pipe(Layer.provideMerge(needs))));
    // The exporter lives as long as the layer's scope (its shutdown is a
    // finalizer), so the runtime stays up until the test ends.
    const runtime = ManagedRuntime.make(layer);
    runtimes.push(runtime);
    const exporter = runtime.runPromise(
        Effect.gen(function* () {
            return yield* TraceExporter;
        }),
    );
    return { listeners, exporter };
}

const runtimes: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
        await runtime.dispose();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('turns layer', () => {
    it('logs each finished turn with its owner and source, and exports nothing without OTLP', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const { listeners, exporter } = build({});
        expect(await exporter).toBeUndefined();
        expect(listeners).toHaveLength(1);

        listeners[0]('thread', 'finished', run('run-1'));
        await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
        expect(log.mock.calls[0][0]).toBe('Turn: finished run=run-1 thread=thread user=alice source=telegram ms=250');
    });

    it('exports each finished turn after its log line when an OTLP endpoint is set', async () => {
        const events: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((line: string) => void events.push(`log ${line}`));
        const queue = OtlpExporter.prototype.export;
        vi.spyOn(OtlpExporter.prototype, 'export').mockImplementation(function (this: OtlpExporter, spans) {
            events.push(`export ${spans.map((span) => span.name).join(',')}`);
            return queue.call(this, spans);
        });
        const bodies: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_url: string, init: RequestInit) => {
                bodies.push(String(init.body));
                return new Response(null, { status: 200 });
            }),
        );
        const { listeners, exporter } = build({
            otlp: { url: 'http://collector.invalid/v1/traces', headers: {}, serviceName: 'socio-test' },
        });
        const built = await exporter;
        expect(built).toBeInstanceOf(OtlpExporter);
        expect(listeners).toHaveLength(2);

        // The runner calls its listeners in the order they were registered.
        for (const listener of listeners) {
            listener('thread', 'finished', run('run-2'));
        }
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events[0]).toBe('log Turn: finished run=run-2 thread=thread user=alice source=telegram ms=250');
        expect(events[1]).toMatch(/^export invoke_agent Manny/);

        await built!.shutdown();
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toContain('invoke_agent Manny');
        expect(bodies[0]).toContain('run-2');
    });
});
