import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AbstractAgent, EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import { lastValueFrom, Observable, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import {
    OtlpExporter,
    otlpFromEnv,
    turnSpans,
    type OtlpSettings,
    type OtlpSpan,
} from '@socio/foundation/observability/otel-export';
import { RUN_TRACE_EVENT, type RunTrace } from '@socio/shared/runs/run-trace';

import { makeTestRuntime } from './helpers/test-runtime.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'the-merger-plan';
const HEADER_SECRET = 'collector-key-0123456789';

/**
 * A loopback OTLP/HTTP receiver: records each request's headers and body.
 * `hold` leaves requests unanswered (a slow collector); `status` answers
 * with that code.
 */
async function receiver(options: { hold?: boolean; status?: number } = {}) {
    const requests: Array<{
        path: string;
        headers: IncomingHttpHeaders;
        body: {
            resourceSpans: Array<{
                resource: { attributes: Array<{ key: string; value: unknown }> };
                scopeSpans: Array<{ spans: OtlpSpan[] }>;
            }>;
        };
    }> = [];
    const held: Array<() => void> = [];
    const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
            requests.push({
                path: request.url ?? '',
                headers: request.headers,
                body: JSON.parse(body),
            });
            const answer = () => response.writeHead(options.status ?? 200).end('{}');
            if (options.hold) {
                held.push(answer);
            } else {
                answer();
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    cleanup.push(
        () =>
            new Promise<void>((resolve) => {
                for (const answer of held.splice(0)) {
                    answer();
                }
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    );
    return {
        requests,
        url: `http://127.0.0.1:${port}`,
        spans: () =>
            requests.flatMap((request) =>
                request.body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)),
            ),
    };
}

const attribute = (span: OtlpSpan, key: string) => {
    const found = span.attributes.find((item) => item.key === key)?.value as Record<string, unknown> | undefined;
    if (!found) {
        return undefined;
    }
    if ('stringValue' in found) {
        return found.stringValue;
    }
    if ('intValue' in found) {
        return Number(found.intValue);
    }
    if ('boolValue' in found) {
        return found.boolValue;
    }
    return (found.arrayValue as { values: Array<{ stringValue: string }> }).values.map((value) => value.stringValue);
};

/** A turn with one tool round and an answer, its trace as a Dot turn sends it. */
class TracedAgent extends AbstractAgent {
    constructor(private reply = `The answer about ${SECRET}.`) {
        super({});
    }
    run(input: RunAgentInput): Observable<BaseEvent> {
        return new Observable<BaseEvent>((subscriber) => {
            const now = Date.now();
            const send = (event: Record<string, unknown>) => subscriber.next(event as unknown as BaseEvent);
            const trace = (value: Record<string, unknown>) =>
                send({ type: EventType.CUSTOM, name: RUN_TRACE_EVENT, value });
            send({
                type: EventType.RUN_STARTED,
                threadId: input.threadId,
                runId: input.runId,
            });
            trace({
                kind: 'turn',
                label: 'Homelab',
                model: 'qwen',
                source: 'shared',
                cap: 5,
            });
            trace({
                kind: 'round',
                round: 1,
                startedAt: now,
                endedAt: now + 40,
                inputTokens: 900,
                outputTokens: 30,
                stop: 'tool_calls',
            });
            send({
                type: EventType.TOOL_CALL_START,
                toolCallId: 'call-1',
                toolCallName: 'search_web',
                parentMessageId: `m-${input.runId}`,
            });
            send({
                type: EventType.TOOL_CALL_ARGS,
                toolCallId: 'call-1',
                delta: JSON.stringify({ objective: SECRET }),
            });
            send({ type: EventType.TOOL_CALL_END, toolCallId: 'call-1' });
            trace({
                kind: 'tool',
                round: 1,
                name: 'search_web',
                callId: 'call-1',
                startedAt: now + 40,
                endedAt: now + 90,
                outcome: 'error',
                error: 'TimeoutError',
            });
            send({
                type: EventType.TOOL_CALL_RESULT,
                messageId: `r-${input.runId}`,
                toolCallId: 'call-1',
                content: `results for ${SECRET}`,
            });
            trace({
                kind: 'round',
                round: 2,
                startedAt: now + 90,
                endedAt: now + 120,
                inputTokens: 1_000,
                outputTokens: 12,
                stop: 'stop',
            });
            send({
                type: EventType.TEXT_MESSAGE_START,
                messageId: `m2-${input.runId}`,
                role: 'assistant',
            });
            send({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: `m2-${input.runId}`,
                delta: this.reply,
            });
            send({
                type: EventType.TEXT_MESSAGE_END,
                messageId: `m2-${input.runId}`,
            });
            send({
                type: EventType.RUN_FINISHED,
                threadId: input.threadId,
                runId: input.runId,
            });
            subscriber.complete();
        });
    }
}

async function fixture(otlp: OtlpSettings) {
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: { apiKey: '', model: '', otlp },
    });
    cleanup.push(dispose);
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Traced', 'alice');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const turn = async (runId: string, message = `Tell me ${SECRET}`) => {
        const agent = new TracedAgent();
        const messages = [{ id: `u-${runId}`, role: 'user' as const, content: message }];
        agent.threadId = 'thread';
        agent.setMessages(messages);
        const started = Date.now();
        const events = await lastValueFrom(
            platform.runner
                .run({
                    threadId: 'thread',
                    agent,
                    input: {
                        threadId: 'thread',
                        runId,
                        messages,
                        state: {},
                        tools: [],
                        context: [],
                        forwardedProps: {},
                    },
                })
                .pipe(toArray()),
        );
        return { events, ms: Date.now() - started };
    };
    // The spans are built on the next turn of the event loop, then sent.
    const flush = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        await platform.traceExporter!.flush();
    };
    return { store, dot, platform, turn, flush };
}

const settingsFor = (url: string): OtlpSettings => ({
    url: `${url}/v1/traces`,
    headers: { authorization: `Bearer ${HEADER_SECRET}` },
    serviceName: 'socio-test',
});

it('exports a turn as GenAI spans: the turn, its model rounds and tool calls, without content', async () => {
    const collector = await receiver();
    const f = await fixture(settingsFor(collector.url));
    await f.turn('run-1');
    await f.flush();
    expect(collector.requests).toHaveLength(1);
    const [request] = collector.requests;
    expect(request.path).toBe('/v1/traces');
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers.authorization).toBe(`Bearer ${HEADER_SECRET}`);
    expect(request.body.resourceSpans[0].resource.attributes).toEqual([
        { key: 'service.name', value: { stringValue: 'socio-test' } },
    ]);
    const spans = collector.spans();
    expect(spans.map((span) => span.name)).toEqual([
        `invoke_agent ${f.dot.name}`,
        'chat qwen',
        'chat qwen',
        'execute_tool search_web',
    ]);
    const [turn, first, second, tool] = spans;
    // One trace, the turn the parent of the rest.
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(turn.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(turn.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(turn.parentSpanId).toBeUndefined();
    for (const child of [first, second, tool]) {
        expect(child.parentSpanId).toBe(turn.spanId);
    }
    expect(attribute(turn, 'gen_ai.operation.name')).toBe('invoke_agent');
    expect(attribute(turn, 'gen_ai.agent.name')).toBe(f.dot.name);
    expect(attribute(turn, 'gen_ai.conversation.id')).toBe('thread');
    expect(attribute(turn, 'gen_ai.usage.input_tokens')).toBe(1_900);
    expect(attribute(turn, 'gen_ai.usage.output_tokens')).toBe(42);
    expect(attribute(turn, 'company_brain.loop.end_reason')).toBe('completed');
    expect(attribute(turn, 'company_brain.run.id')).toBe('run-1');
    expect(attribute(first, 'gen_ai.operation.name')).toBe('chat');
    expect(attribute(first, 'gen_ai.request.model')).toBe('qwen');
    expect(attribute(first, 'gen_ai.usage.input_tokens')).toBe(900);
    expect(attribute(first, 'gen_ai.usage.output_tokens')).toBe(30);
    expect(attribute(first, 'gen_ai.response.finish_reasons')).toEqual(['tool_calls']);
    expect(attribute(second, 'gen_ai.response.finish_reasons')).toEqual(['stop']);
    expect(BigInt(first.endTimeUnixNano) - BigInt(first.startTimeUnixNano)).toBe(40_000_000n);
    expect(attribute(tool, 'gen_ai.operation.name')).toBe('execute_tool');
    expect(attribute(tool, 'gen_ai.tool.name')).toBe('search_web');
    expect(attribute(tool, 'gen_ai.tool.call.id')).toBe('call-1');
    expect(attribute(tool, 'error.type')).toBe('TimeoutError');
    expect(tool.status).toEqual({ code: 2 });
    // No content unless an admin turns it on; no people either.
    const body = JSON.stringify(request.body);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('alice');
    for (const key of [
        'gen_ai.input.messages',
        'gen_ai.output.messages',
        'gen_ai.tool.call.arguments',
        'gen_ai.tool.call.result',
    ]) {
        expect(body).not.toContain(key);
    }
});

it('exports content only when an admin turns it on, cut short', async () => {
    const collector = await receiver();
    const f = await fixture(settingsFor(collector.url));
    await f.store.updateSettings({ tracing: { includeContent: true } });
    await f.turn('run-1', `${SECRET} ${'x'.repeat(6_000)}`);
    await f.flush();
    const [turn, , , tool] = collector.spans();
    const input = JSON.parse(String(attribute(turn, 'gen_ai.input.messages')));
    expect(input[0].role).toBe('user');
    expect(input[0].parts[0].content.startsWith(SECRET)).toBe(true);
    expect(input[0].parts[0].content.length).toBeLessThanOrEqual(4_001);
    expect(String(attribute(turn, 'gen_ai.output.messages'))).toContain(`The answer about ${SECRET}.`);
    expect(attribute(tool, 'gen_ai.tool.call.arguments')).toBe(JSON.stringify({ objective: SECRET }));
    expect(attribute(tool, 'gen_ai.tool.call.result')).toBe(`results for ${SECRET}`);
    // Turned off again: none.
    await f.store.updateSettings({ tracing: { includeContent: false } });
    await f.turn('run-2');
    await f.flush();
    expect(JSON.stringify(collector.requests[1].body)).not.toContain(SECRET);
});

it('never holds up or fails a turn when the collector is slow, failing or gone', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A collector that never answers: the turn ends at once all the same.
    const slow = await receiver({ hold: true });
    const held = await fixture(settingsFor(slow.url));
    const first = await held.turn('slow-run');
    expect(first.events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(first.ms).toBeLessThan(1_000);
    await new Promise((resolve) => setImmediate(resolve));
    void held.platform.traceExporter!.flush();
    await expect.poll(() => slow.requests.length).toBe(1);
    // The next turn doesn't wait for the request in flight either.
    const second = await held.turn('slow-run-2');
    expect(second.events.at(-1)?.type).toBe('RUN_FINISHED');
    expect(second.ms).toBeLessThan(1_000);
    expect(held.platform.runner.runTrace('slow-run-2')!.status).toBe('finished');

    // A collector that refuses, and one that is gone: counted and logged
    // once, never the header.
    const refusing = await receiver({ status: 503 });
    const failing = await fixture(settingsFor(refusing.url));
    await failing.turn('refused-run');
    await failing.flush();
    expect(failing.platform.traceExporter!.stats).toMatchObject({
        exported: 0,
        failed: 4,
    });
    // A port that was just closed: the connection is refused.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    const gone = await fixture(settingsFor(`http://127.0.0.1:${port}`));
    const turn = await gone.turn('gone-run');
    expect(turn.events.at(-1)?.type).toBe('RUN_FINISHED');
    await gone.flush();
    expect(gone.platform.traceExporter!.stats.failed).toBe(4);
    const lines = error.mock.calls.map((args) => args.join(' '));
    expect(lines).toContain('Trace export: Error (HTTP 503); 4 spans not delivered, 0 dropped');
    expect(lines.some((line) => line.startsWith('Trace export: TypeError'))).toBe(true);
    for (const line of lines) {
        expect(line).not.toContain(HEADER_SECRET);
    }
});

it('queues within a bound, dropping and counting what doesn’t fit', async () => {
    const collector = await receiver();
    const exporter = new OtlpExporter(settingsFor(collector.url), {
        maxQueue: 5,
        batchSize: 100,
        intervalMs: 60_000,
    });
    cleanup.push(() => exporter.shutdown(100));
    const trace: RunTrace = {
        rounds: [{ kind: 'round', round: 1, startedAt: 1, endedAt: 2, stop: 'stop' }],
        tools: [],
        waits: [],
    };
    const spans = () =>
        turnSpans(
            {
                runId: 'r',
                threadId: 't',
                status: 'finished',
                source: 'web',
                startedAt: 1,
                finishedAt: 3,
            },
            trace,
        );
    for (let i = 0; i < 4; i++) {
        exporter.export(spans());
    }
    expect(exporter.stats.dropped).toBe(3);
    await exporter.flush();
    expect(collector.spans()).toHaveLength(5);
    expect(exporter.stats.exported).toBe(5);
});

it('reads the collector from the OpenTelemetry environment, off unless set', () => {
    expect(otlpFromEnv({})).toBeUndefined();
    expect(otlpFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' })).toEqual({
        url: 'http://collector:4318/v1/traces',
        headers: {},
        serviceName: 'socio',
    });
    expect(
        otlpFromEnv({
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://langfuse.lab/api/public/otel/v1/traces',
            OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic%20${HEADER_SECRET},x-tenant=lab`,
            OTEL_SERVICE_NAME: 'brain',
        }),
    ).toEqual({
        url: 'https://langfuse.lab/api/public/otel/v1/traces',
        headers: { Authorization: `Basic ${HEADER_SECRET}`, 'x-tenant': 'lab' },
        serviceName: 'brain',
    });
    expect(
        otlpFromEnv({
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_SDK_DISABLED: 'true',
        }),
    ).toBeUndefined();
    for (const env of [
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' },
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://collector' },
        {
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        },
        {
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
            OTEL_EXPORTER_OTLP_HEADERS: `${HEADER_SECRET}`,
        },
    ]) {
        expect(() => otlpFromEnv(env)).toThrow(
            expect.objectContaining({
                message: expect.not.stringContaining(HEADER_SECRET),
            }),
        );
    }
});

it('exports a round’s retry, the notes’ request and each compaction (CB-129)', () => {
    const trace: RunTrace = {
        rounds: [
            {
                kind: 'round',
                round: 1,
                startedAt: 1,
                endedAt: 2,
                stop: 'stop',
                summary: true,
            },
            { kind: 'round', round: 1, startedAt: 3, endedAt: 4, stop: 'error' },
            {
                kind: 'round',
                round: 1,
                startedAt: 5,
                endedAt: 6,
                stop: 'stop',
                retry: 1,
            },
        ],
        compactions: [
            {
                kind: 'compaction',
                round: 1,
                at: 2,
                beforeTokens: 40_000,
                afterTokens: 9_000,
                window: 16_384,
                stubbed: 4,
                summarised: 2,
                retried: 0,
            },
        ],
        tools: [],
        waits: [],
    };
    const [turn, notes, refused, retry] = turnSpans(
        {
            runId: 'r',
            threadId: 't',
            status: 'finished',
            source: 'web',
            startedAt: 1,
            finishedAt: 7,
        },
        trace,
    );
    expect(attribute(notes, 'company_brain.round.purpose')).toBe('context_notes');
    expect(attribute(refused, 'company_brain.round.retry')).toBeUndefined();
    expect(attribute(retry, 'company_brain.round.retry')).toBe(1);
    const event = turn.events?.find((entry) => entry.name === 'company_brain.context_compaction');
    expect(
        Object.fromEntries(event!.attributes.map(({ key, value }) => [key, (value as { intValue?: string }).intValue])),
    ).toEqual({
        'company_brain.round': '1',
        'company_brain.context.before_tokens': '40000',
        'company_brain.context.after_tokens': '9000',
        'company_brain.context.window': '16384',
        'company_brain.context.stubbed': '4',
        'company_brain.context.summarised': '2',
        'company_brain.context.retried': '0',
    });
});
