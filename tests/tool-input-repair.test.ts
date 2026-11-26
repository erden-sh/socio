import type { RunAgentInput } from '@ag-ui/client';
import { defineTool } from '@copilotkit/runtime/v2';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { checkToolInput, numberFromText, toolInputRepair } from '../src/server/turns/tool-input-repair.js';
import { TraceRecorder, TurnTracer } from '../src/server/turns/turn-trace.js';

import { completion, completionStream } from './fixtures/model-stream.js';
import { DotAgent } from './helpers/dot-agent.js';
import { LocalAgentRunner } from './helpers/runners.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const SECRET = 'the-merger-plan';

const exec = z
    .object({
        command: z.string().trim().min(1),
        timeoutMs: z.number().int().min(1000).max(60000).default(30000),
    })
    .strict();
const write = z
    .object({
        path: z.string().min(1),
        contents: z.string(),
        append: z.boolean().optional(),
    })
    .strict();

it('reads a number sent as text where the schema wants one', async () => {
    expect(await checkToolInput(exec, { command: 'ls', timeoutMs: '18000' })).toEqual({
        valid: false,
        issues: [{ path: ['timeoutMs'], code: 'invalid_type', expected: 'number', received: 'string' }],
        more: 0,
        repaired: {
            input: { command: 'ls', timeoutMs: 18000 },
            repairs: [{ path: ['timeoutMs'], from: '18000', to: 18000 }],
        },
    });
    const number = z.object({ deltaY: z.number().finite() });
    for (const [text, value] of [
        ['-2.5', -2.5],
        ['0', 0],
        ['1e3', 1000],
        ['12.75', 12.75],
    ] as const) {
        const check = await checkToolInput(number, { deltaY: text });
        expect(check.valid === false && check.repaired?.input).toEqual({ deltaY: value });
    }
});

it('reads exactly "true" and "false" where the schema wants a boolean', async () => {
    const check = await checkToolInput(write, { path: 'a.md', contents: 'x', append: 'true' });
    expect(check).toMatchObject({
        valid: false,
        repaired: {
            input: { path: 'a.md', contents: 'x', append: true },
            repairs: [{ path: ['append'], from: 'true', to: true }],
        },
    });
    const off = await checkToolInput(write, { path: 'a.md', contents: 'x', append: 'false' });
    expect(off.valid === false && off.repaired?.input).toEqual({ path: 'a.md', contents: 'x', append: false });
});

it('never repairs null, an empty or other text, or adds, drops or defaults a field', async () => {
    const refused = [
        // null is never read as "", 0 or false, nor dropped.
        [write, { path: 'a.md', contents: null }],
        [write, { path: 'a.md', contents: 'x', append: null }],
        [exec, { command: 'ls', timeoutMs: null }],
        // Not a number or boolean literal.
        [exec, { command: 'ls', timeoutMs: '' }],
        [exec, { command: 'ls', timeoutMs: ' 5000' }],
        [exec, { command: 'ls', timeoutMs: '+5000' }],
        [exec, { command: 'ls', timeoutMs: '05000' }],
        [exec, { command: 'ls', timeoutMs: '5000ms' }],
        [exec, { command: 'ls', timeoutMs: '0x1388' }],
        [exec, { command: 'ls', timeoutMs: 'Infinity' }],
        [write, { path: 'a.md', contents: 'x', append: 'yes' }],
        [write, { path: 'a.md', contents: 'x', append: 'True' }],
        [write, { path: 'a.md', contents: 'x', append: '1' }],
        [write, { path: 'a.md', contents: 'x', append: '' }],
        // A number or boolean sent where the schema wants text stays.
        [write, { path: 'a.md', contents: 5 }],
        // A field the schema doesn't know is left to the schema's error.
        [exec, { command: 'ls', timeoutMs: '5000', extra: '1' }],
        // A missing required field is not added.
        [write, { path: 'a.md', append: 'true' }],
    ] as const;
    for (const [schema, input] of refused) {
        const check = await checkToolInput(schema, input);
        expect(check.valid).toBe(false);
        expect(check.valid === false && check.repaired).toBeUndefined();
    }
});

it('reads only digits for an integer: "1e3", "1.0" and "1.5" stay text', async () => {
    for (const text of ['1e3', '1.0', '1.5', '9007199254740993']) {
        const check = await checkToolInput(exec, { command: 'ls', timeoutMs: text });
        expect(check.valid === false && check.repaired).toBeUndefined();
    }
    expect(numberFromText('1e3', true)).toBeUndefined();
    expect(numberFromText('1e3', false)).toBe(1000);
    expect(numberFromText('1e400', false)).toBeUndefined();
    expect(numberFromText('-0', true)).toBe(-0);
    // A repaired value that breaks a bound still fails: no repair.
    const check = await checkToolInput(exec, { command: 'ls', timeoutMs: '5' });
    expect(check.valid === false && check.repaired).toBeUndefined();
});

it('leaves unions alone unless the text has only the one reading', async () => {
    const union = z.object({
        either: z.union([z.number(), z.string()]),
        flag: z.union([z.boolean(), z.literal('auto')]),
        shape: z.union([z.number(), z.object({ n: z.number() })]),
    });
    const check = await checkToolInput(union, { either: true, flag: 'yes', shape: '5' });
    expect(check.valid === false && check.repaired).toBeUndefined();
    // A nullable number or a number-or-boolean field reads "5" one way only.
    const narrow = z.object({ n: z.number().nullable(), b: z.union([z.number(), z.boolean()]) });
    const read = await checkToolInput(narrow, { n: '5', b: 'false' });
    expect(read.valid === false && read.repaired?.input).toEqual({ n: 5, b: false });
    const kept = await checkToolInput(narrow, { n: null, b: '7' });
    expect(kept.valid === false && kept.repaired?.input).toEqual({ n: null, b: 7 });
});

it('repairs nested fields only where the schema declares them', async () => {
    const nested = z.object({
        page: z.object({ limit: z.number().int(), deep: z.boolean() }),
        rows: z.array(z.object({ id: z.number().int(), note: z.string() })),
        byName: z.record(z.string(), z.number()),
    });
    const check = await checkToolInput(nested, {
        page: { limit: '20', deep: 'true' },
        rows: [
            { id: '1', note: '2' },
            { id: 3, note: 'x' },
        ],
        byName: { a: 1 },
    });
    expect(check).toMatchObject({
        valid: false,
        repaired: {
            input: {
                page: { limit: 20, deep: true },
                rows: [
                    { id: 1, note: '2' },
                    { id: 3, note: 'x' },
                ],
                byName: { a: 1 },
            },
            repairs: [
                { path: ['page', 'limit'], from: '20', to: 20 },
                { path: ['page', 'deep'], from: 'true', to: true },
                { path: ['rows', 0, 'id'], from: '1', to: 1 },
            ],
        },
    });
    // A record's values are found by keys the model chose: never repaired,
    // and the key is not traced.
    const record = await checkToolInput(nested, {
        page: { limit: 1, deep: true },
        rows: [],
        byName: { [SECRET]: '5' },
    });
    expect(record).toEqual({
        valid: false,
        issues: [{ path: ['byName', '*'], code: 'invalid_type', expected: 'number', received: 'string' }],
        more: 0,
    });
});

it('traces each failure without values, and passes a valid input by', async () => {
    const trace = vi.fn();
    const middleware = toolInputRepair(trace);
    const call = (name: string, args: unknown, schema: z.ZodType = exec, execute: unknown = () => 'ok') =>
        middleware.onBeforeToolCall!({} as never, {
            toolName: name,
            toolCallId: `call-${name}`,
            toolCall: {} as never,
            tool: { name, description: name, inputSchema: schema, execute } as never,
            args,
        });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await call('computer_exec', { command: 'ls' })).toBeUndefined();
    expect(trace).not.toHaveBeenCalled();
    // Repaired: the args change, and the log line names the field.
    expect(await call('computer_exec', { command: SECRET, timeoutMs: '18000' })).toEqual({
        type: 'transformArgs',
        args: { command: SECRET, timeoutMs: 18000 },
    });
    expect(console.error).toHaveBeenCalledWith(
        'Model tool call computer_exec (call-computer_exec): repaired input (number or boolean sent as text); timeoutMs: "18000" to 18000',
    );
    // Not repaired: the call goes on as the model sent it, to the schema's error.
    expect(await call('computer_files_write', { path: SECRET, contents: null, append: SECRET }, write)).toBeUndefined();
    // A client tool (no execute) is the browser's.
    expect(await call('pick', { timeoutMs: '5' }, exec, null)).toBeUndefined();
    expect(trace.mock.calls).toEqual([
        [
            {
                name: 'computer_exec',
                callId: 'call-computer_exec',
                issues: [{ path: ['timeoutMs'], code: 'invalid_type', expected: 'number', received: 'string' }],
                repaired: true,
                repairs: [{ path: ['timeoutMs'], from: '18000', to: 18000 }],
            },
        ],
        [
            {
                name: 'computer_files_write',
                callId: 'call-computer_files_write',
                issues: [
                    { path: ['contents'], code: 'invalid_type', expected: 'string', received: 'null' },
                    { path: ['append'], code: 'invalid_type', expected: 'boolean', received: 'string' },
                ],
                repaired: false,
            },
        ],
    ]);
    expect(JSON.stringify(trace.mock.calls)).not.toContain(SECRET);
});

it('keeps only checked tool_input entries in the stored trace', () => {
    const entries: unknown[] = [];
    let now = 1_000;
    const tracer = new TurnTracer(
        (entry) => entries.push(entry),
        () => now++,
    );
    tracer.toolInput({
        name: 'computer_exec',
        issues: [{ path: ['timeoutMs'], code: 'invalid_type', expected: 'number', received: 'string' }],
        repaired: true,
        repairs: [{ path: ['timeoutMs'], from: '18000', to: 18000 }],
    });
    const recorder = new TraceRecorder();
    for (const entry of entries) {
        recorder.add(entry);
    }
    // A forged entry: text where a repair's literal goes, a message, a value.
    recorder.add({
        kind: 'tool_input',
        round: 1,
        at: 5,
        name: 'computer_files_write',
        issues: [{ path: ['contents'], code: 'invalid_type', received: 'null', message: SECRET, value: SECRET }],
        repaired: true,
        repairs: [{ path: ['contents'], from: SECRET, to: 0 }],
    });
    expect(recorder.trace.toolInputs).toEqual([
        {
            kind: 'tool_input',
            round: 0,
            at: 1_000,
            name: 'computer_exec',
            issues: [{ path: ['timeoutMs'], code: 'invalid_type', expected: 'number', received: 'string' }],
            repaired: true,
            repairs: [{ path: ['timeoutMs'], from: '18000', to: 18000 }],
        },
        {
            kind: 'tool_input',
            round: 1,
            at: 5,
            name: 'computer_files_write',
            issues: [{ path: ['contents'], code: 'invalid_type', received: 'null' }],
            repaired: false,
        },
    ]);
});

/** A Dot whose turn has these tools (the module tools' place). */
function dotFixture(tools: ReturnType<typeof defineTool>[]) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    const runner = new LocalAgentRunner(testDatabase());
    cleanup.push(
        () => runner.close(),
        () => workspace.close(),
        () => store.close(),
    );
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Traced', 'owner');
    const agent = new DotAgent(
        store,
        workspace,
        { apiKey: 'fixture', model: 'custom-model', baseUrl: 'https://unused.invalid/v1' },
        dot.id,
        false,
        undefined,
        { extensions: { tools: () => tools } },
    );
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        context: [],
        messages: [{ id: 'user', role: 'user', content: `Run ${SECRET}.` }],
        tools: [],
        forwardedProps: {},
    };
    agent.threadId = input.threadId;
    agent.setMessages(input.messages);
    const run = () => lastValueFrom(runner.run({ threadId: 'thread', agent, input }).pipe(toArray()));
    return { runner, run };
}

const toolCall = (index: number, id: string, name: string, args: unknown) => ({
    index,
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
});

it('runs a repaired call with the repaired input, and sends an unrepaired one back as today', async () => {
    const ran: unknown[] = [];
    const f = dotFixture([
        defineTool({
            name: 'computer_exec',
            description: 'Run a command.',
            parameters: exec,
            execute: async (args) => {
                ran.push(args);
                return { ok: true };
            },
        }),
        defineTool({
            name: 'computer_files_write',
            description: 'Write a file.',
            parameters: write,
            execute: async (args) => {
                ran.push(args);
                return { ok: true };
            },
        }),
    ]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
            completionStream(
                [
                    {
                        role: 'assistant',
                        tool_calls: [
                            toolCall(0, 'c1', 'computer_exec', { command: SECRET, timeoutMs: '18000' }),
                            toolCall(1, 'c2', 'computer_files_write', { path: SECRET, contents: null }),
                        ],
                    },
                ],
                'tool_calls',
            ),
        )
        .mockResolvedValueOnce(completion({ role: 'assistant', content: 'Done.' }, 'stop'));
    const events = await f.run();
    expect(events.at(-1)?.type).toBe('RUN_FINISHED');
    // The repaired call ran with its number; the file was never written.
    expect(ran).toEqual([{ command: SECRET, timeoutMs: 18000 }]);
    // The model got the schema error for the other call, as without the repair.
    const second = JSON.parse(String(fetch.mock.calls[1][1]?.body)) as {
        messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    const results = Object.fromEntries(
        second.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]),
    );
    expect(results.c2).toContain('Input validation failed for tool computer_files_write');
    expect(results.c1).not.toContain('Input validation failed');

    const trace = f.runner.runTrace('run')!.trace!;
    expect(trace.toolInputs).toEqual([
        expect.objectContaining({
            kind: 'tool_input',
            round: 1,
            name: 'computer_exec',
            callId: 'c1',
            repaired: true,
            repairs: [{ path: ['timeoutMs'], from: '18000', to: 18000 }],
        }),
        expect.objectContaining({
            kind: 'tool_input',
            round: 1,
            name: 'computer_files_write',
            callId: 'c2',
            issues: [{ path: ['contents'], code: 'invalid_type', expected: 'string', received: 'null' }],
            repaired: false,
        }),
    ]);
    expect(trace.tools).toEqual([expect.objectContaining({ name: 'computer_exec', outcome: 'ok', callId: 'c1' })]);
    expect(JSON.stringify(trace)).not.toContain(SECRET);
});

it('holds to the review’s edge cases: precision, -0, path keys, schema words and call IDs', async () => {
    const number = z.object({ n: z.number() });
    // A value past what a number holds, in any notation, or a tiny one read as 0.
    for (const text of ['9007199254740993.0', '9.007199254740993e15', '1e-400']) {
        const check = await checkToolInput(number, { n: text });
        expect(check.valid === false && check.repaired).toBeUndefined();
    }
    const negative = await checkToolInput(number, { n: '-0' });
    const repairedZero = negative.valid === false ? (negative.repaired?.input as { n: number } | undefined) : undefined;
    expect(Object.is(repairedZero?.n, -0)).toBe(true);
    // Keys that would join into the same path: only the failed one is read.
    const joined = z.object({ 'a\u0000b': z.number(), a: z.object({ b: z.number().catch(7) }) });
    const check = await checkToolInput(joined, { 'a\u0000b': '1', a: { b: '5' } });
    expect(check.valid === false && check.repaired?.input).toEqual({ 'a\u0000b': 1, a: { b: '5' } });
    // A schema's own words for an issue are never kept.
    const worded = z.object({ reason: z.string() }).superRefine((value, ctx) => {
        ctx.addIssue({ code: 'invalid_type', expected: value.reason as never, path: ['reason'] });
    });
    const issues = await checkToolInput(worded, { reason: 'secretplan' });
    expect(JSON.stringify(issues)).not.toContain('secretplan');
    // A recheck that throws leaves the failure, traced.
    const throwing = z.object({
        n: z.number().refine(() => {
            throw new Error('down');
        }),
    });
    expect(await checkToolInput(throwing, { n: '5' })).toMatchObject({ valid: false, issues: [{ path: ['n'] }] });
    // The model's call ID is kept only when it is a short token.
    const trace = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await toolInputRepair(trace).onBeforeToolCall!({} as never, {
        toolName: 'x',
        toolCallId: `${SECRET}\nforged line`,
        toolCall: {} as never,
        tool: { name: 'x', description: 'x', inputSchema: number, execute: () => 'ok' } as never,
        args: { n: '5' },
    });
    expect(trace.mock.calls[0][0]).not.toHaveProperty('callId');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(SECRET);
});
