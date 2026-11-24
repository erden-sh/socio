import { expect, it } from 'vitest';

import { execPlan, sandboxConfig } from '../deployment/computers/coding-sandbox.mjs';
import { claudeCodeHarness, readClaudeCode } from '../src/server/coding/claude-code.js';
import { codexHarness, readCodex } from '../src/server/coding/codex.js';
import { geminiCliHarness, readGeminiCli } from '../src/server/coding/gemini-cli.js';
import { grokHarness, readGrok } from '../src/server/coding/grok.js';
import { PROGRESS_LINES, SUMMARY_MAX } from '../src/server/coding/harness-output.js';

// CB-326: Codex and Claude Code as coding harnesses on the gateway
// route; Gemini CLI and Grok Build, the same way. Their readers follow readOpenCode's rules: tolerant JSON lines,
// every string untrusted (redacted, inert), progress and summary capped,
// and the harness's own session id (a UUID) kept to continue.

const identity = { name: 'Rulo (Socio)', email: 'socio-a1b2c3d4@users.noreply.apps.example.com' };
const sandbox = sandboxConfig({ CODING_SANDBOX_IMAGE: `socio-coding@sha256:${'a'.repeat(64)}` }, 'company-brain');
const THREAD = '0199a213-81c0-7800-8aa1-bbab2a035a53';
const SESSION = '5f0c5b8e-2c1e-4c55-9d7a-0b8e1c2d3f4a';
const TOKEN = `cbgw_${'Z'.repeat(43)}`;
const lines = (events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

// ---------------------------------------------------------------------------
// Codex: `codex exec --json`

const codexOutput = (text: string, extra: object[] = []) =>
    lines([
        { type: 'thread.started', thread_id: THREAD },
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Thinking about the test' } },
        {
            type: 'item.started',
            item: { id: 'item_1', type: 'command_execution', command: 'bash -lc "pnpm test"', status: 'in_progress' },
        },
        {
            type: 'item.completed',
            item: {
                id: 'item_1',
                type: 'command_execution',
                command: 'bash -lc "pnpm test"',
                aggregated_output: 'ok',
                exit_code: 0,
                status: 'completed',
            },
        },
        {
            type: 'item.completed',
            item: {
                id: 'item_2',
                type: 'file_change',
                changes: [{ path: 'src/index.ts', kind: 'update' }],
                status: 'completed',
            },
        },
        ...extra,
        { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);

it('reads Codex’s progress, final message and thread id', () => {
    const output = readCodex(codexOutput('Done: the flaky test now waits.\nDetails follow.'));
    expect(output).toEqual({
        progress: ['$ bash -lc "pnpm test"', 'edit: src/index.ts (update)', 'Done: the flaky test now waits.'],
        summary: 'Done: the flaky test now waits.\nDetails follow.',
        sessionId: THREAD,
        errored: false,
    });
    // Reasoning is never shown.
    expect(JSON.stringify(output)).not.toContain('Thinking');
});

it('shows a running command once, and its outcome when it ends', () => {
    const running = readCodex(
        lines([
            { type: 'thread.started', thread_id: THREAD },
            {
                type: 'item.started',
                item: { id: 'c1', type: 'command_execution', command: 'make', status: 'in_progress' },
            },
        ]),
    );
    expect(running.progress).toEqual(['$ make (running)']);
    const failed = readCodex(
        lines([
            {
                type: 'item.started',
                item: { id: 'c1', type: 'command_execution', command: 'make', status: 'in_progress' },
            },
            {
                type: 'item.completed',
                item: { id: 'c1', type: 'command_execution', command: 'make', exit_code: 2, status: 'failed' },
            },
            { type: 'item.completed', item: { id: 't', type: 'todo_list', items: [{ completed: true }, {}] } },
            { type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'x', tool: 'y' } },
        ]),
    );
    expect(failed.progress).toEqual(['$ make (failed, exit 2)', 'plan: 1 of 2 done', 'x.y']);
    expect(failed.sessionId).toBeUndefined();
});

it('reports Codex’s errors: the last one is the summary when it said nothing else', () => {
    const output = readCodex(
        lines([
            { type: 'thread.started', thread_id: THREAD },
            { type: 'error', message: 'stream disconnected' },
            { type: 'turn.failed', error: { message: 'The gateway refused: model_not_found' } },
        ]),
    );
    expect(output.errored).toBe(true);
    expect(output.summary).toBe('error: The gateway refused: model_not_found');
    expect(output.progress).toEqual(['error: stream disconnected', 'error: The gateway refused: model_not_found']);
    // A non-fatal error item is shown, not an error of the run.
    const warned = readCodex(
        codexOutput('Fine.', [{ type: 'item.completed', item: { id: 'e', type: 'error', message: 'slow' } }]),
    );
    expect(warned).toMatchObject({ errored: false, summary: 'Fine.' });
    expect(warned.progress).toContain('error: slow');
});

it('reads Codex’s output tolerantly: plain lines, broken JSON, odd shapes', () => {
    const output = readCodex(
        [
            'plain line',
            '{broken json',
            '[1,2]',
            '{"type":"item.completed","item":null}',
            '{"type":"item.completed","item":{"type":"file_change","changes":"nope"}}',
            '{"type":"item.completed","item":{"type":"agent_message","text":42}}',
            '{"type":42}',
        ].join('\n'),
    );
    expect(output.progress).toEqual(['plain line', '{broken json', '[1,2]', 'edit: files']);
    expect(output.summary).toBe('');
    expect(output.errored).toBe(false);
});

it('keeps only a UUID as Codex’s thread id, so no output can pass an option to resume', () => {
    for (const thread of ['--last', '../x', 'ses_abc', `${THREAD} -c x=1`, 42, '']) {
        expect(
            readCodex(lines([{ type: 'thread.started', thread_id: thread }])).sessionId,
            String(thread),
        ).toBeUndefined();
    }
    expect(readCodex(lines([{ type: 'thread.started', thread_id: THREAD.toUpperCase() }])).sessionId).toBe(
        THREAD.toUpperCase(),
    );
});

it('makes Codex’s words inert and strips Socio credentials, in progress and summary', () => {
    const output = readCodex(
        codexOutput(`Leaked ${TOKEN} and evil‮txt.exe`, [
            {
                type: 'item.completed',
                item: { id: 'x', type: 'command_execution', command: `echo ${TOKEN}​`, status: 'completed' },
            },
        ]),
    );
    const all = JSON.stringify(output);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('‮');
    expect(all).not.toContain('​');
    expect(output.summary).toContain('[U+202E]');
    expect(output.progress.join('\n')).toContain('[U+200B]');
});

it('caps Codex’s progress lines and summary', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
        type: 'item.completed',
        item: { id: `c${i}`, type: 'command_execution', command: `step ${i} ${'x'.repeat(500)}`, status: 'completed' },
    }));
    const output = readCodex(
        lines([
            ...many,
            { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'y'.repeat(20_000) } },
        ]),
    );
    expect(output.progress).toHaveLength(PROGRESS_LINES);
    expect(output.progress.every((line) => line.length <= 241)).toBe(true);
    expect(output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
    // The newest output is read; a line cut off at the window's start isn't an event.
    const huge = readCodex('x'.repeat(300_000) + '\n' + codexOutput('Tail.'));
    expect(huge).toMatchObject({ summary: 'Tail.', sessionId: THREAD });
});

it('builds Codex’s prompt exec: a new thread first, then resumes the one its output named', () => {
    const run = { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity };
    const first = codexHarness.command(run);
    expect(first).toEqual({
        kind: 'prompt',
        params: { harness: 'codex', model: 'orion', prompt: 'Fix it', seconds: 1200, identity },
    });
    const next = codexHarness.command({ ...run, session: THREAD });
    expect(next.params).toMatchObject({ harness: 'codex', session: THREAD });
    // The supervisor takes both.
    for (const exec of [first, next]) {
        const plan = execPlan('prompt', exec.params, sandbox);
        expect(plan.ok, JSON.stringify(plan)).toBe(true);
    }
    // On a person's own plan Codex already speaks Responses: nothing to add.
    expect(codexHarness.command({ ...run, plan: 'byo-chatgpt' })).toEqual(first);
    expect(codexHarness).toMatchObject({
        id: 'codex',
        label: 'Codex',
        modelRoute: 'gateway',
        personalPlans: true,
        image: { name: 'socio-coding', pin: 'deployment/coding/codex.pin' },
    });
});

// ---------------------------------------------------------------------------
// Claude Code: `claude -p --output-format stream-json --verbose`

const claudeOutput = (result: string, extra: object[] = []) =>
    lines([
        { type: 'system', subtype: 'init', session_id: SESSION, model: 'orion', tools: ['Bash', 'Edit'] },
        {
            type: 'assistant',
            session_id: SESSION,
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Private reasoning' },
                    { type: 'text', text: 'Let me run the tests.' },
                    {
                        type: 'tool_use',
                        id: 'tu1',
                        name: 'Bash',
                        input: { command: 'pnpm test', description: 'Run the tests' },
                    },
                ],
            },
        },
        {
            type: 'user',
            session_id: SESSION,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
        },
        {
            type: 'assistant',
            session_id: SESSION,
            message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/index.ts' } }] },
        },
        ...extra,
        { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: result }] } },
        { type: 'result', subtype: 'success', is_error: false, result, session_id: SESSION, num_turns: 3 },
    ]);

it('reads Claude Code’s progress, final result and session id', () => {
    const output = readClaudeCode(claudeOutput('Done: the flaky test now waits.\nMore.'));
    expect(output).toEqual({
        progress: [
            'Let me run the tests.',
            'Bash: Run the tests',
            'Edit: src/index.ts',
            'Done: the flaky test now waits.',
        ],
        summary: 'Done: the flaky test now waits.\nMore.',
        sessionId: SESSION,
        errored: false,
    });
    expect(JSON.stringify(output)).not.toContain('Private reasoning');
    expect(JSON.stringify(output)).not.toContain('tool_result');
});

it('reports Claude Code’s failed runs, with its error as the summary', () => {
    const failed = readClaudeCode(
        lines([
            { type: 'system', subtype: 'init', session_id: SESSION },
            {
                type: 'assistant',
                session_id: SESSION,
                message: { content: [{ type: 'text', text: 'API Error: 404 model' }] },
            },
            {
                type: 'result',
                subtype: 'success',
                is_error: true,
                result: 'API Error: 404 That model isn’t available',
                session_id: SESSION,
            },
        ]),
    );
    expect(failed).toMatchObject({
        errored: true,
        summary: 'error: API Error: 404 That model isn’t available',
        sessionId: SESSION,
    });
    const turns = readClaudeCode(lines([{ type: 'result', subtype: 'error_max_turns', session_id: SESSION }]));
    expect(turns).toMatchObject({ errored: true, summary: 'error: error_max_turns' });
    // Still running: no result yet, the newest text is the summary so far.
    const running = readClaudeCode(claudeOutput('x').split('\n').slice(0, 2).join('\n'));
    expect(running).toMatchObject({ errored: false, summary: 'Let me run the tests.', sessionId: SESSION });
});

it('reads Claude Code’s output tolerantly: plain lines, broken JSON, odd shapes', () => {
    const output = readClaudeCode(
        [
            'plain line',
            '{broken',
            '{"type":"assistant","message":null}',
            '{"type":"assistant","message":{"content":"text"}}',
            '{"type":"assistant","message":{"content":[null,{"type":"tool_use"},{"type":"text","text":7}]}}',
            '{"type":"result","result":["x"]}',
        ].join('\n'),
    );
    expect(output.progress).toEqual(['plain line', '{broken', 'tool']);
    expect(output.summary).toBe('');
    expect(output.errored).toBe(false);
});

it('keeps only a UUID as Claude Code’s session id', () => {
    for (const session of ['--resume', 'abc', `${SESSION}\n--x`, 7]) {
        expect(
            readClaudeCode(lines([{ type: 'system', subtype: 'init', session_id: session }])).sessionId,
        ).toBeUndefined();
    }
});

it('makes Claude Code’s words inert and strips Socio credentials', () => {
    const output = readClaudeCode(
        claudeOutput(`Token ${TOKEN} ⁦hidden⁩`, [
            {
                type: 'assistant',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            name: 'Bash',
                            input: { command: `curl -H "Authorization: Bearer ${TOKEN}"` },
                        },
                    ],
                },
            },
        ]),
    );
    const all = JSON.stringify(output);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('⁦');
    expect(output.summary).toContain('[U+2066]');
});

it('caps Claude Code’s progress lines and summary', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `f${i}-${'p'.repeat(400)}` } }] },
    }));
    const output = readClaudeCode(lines([...many, { type: 'result', subtype: 'success', result: 'z'.repeat(20_000) }]));
    expect(output.progress).toHaveLength(PROGRESS_LINES);
    expect(output.progress.every((line) => line.length <= 241)).toBe(true);
    expect(output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
});

it('builds Claude Code’s prompt exec: a new session first, then --resume', () => {
    const run = { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity };
    const first = claudeCodeHarness.command(run);
    expect(first).toEqual({
        kind: 'prompt',
        params: { harness: 'claude-code', model: 'orion', prompt: 'Fix it', seconds: 1200, identity },
    });
    const next = claudeCodeHarness.command({ ...run, session: SESSION });
    expect(next.params).toMatchObject({ harness: 'claude-code', session: SESSION });
    for (const exec of [first, next]) {
        expect(execPlan('prompt', exec.params, sandbox).ok).toBe(true);
    }
    expect(claudeCodeHarness).toMatchObject({
        id: 'claude-code',
        label: 'Claude Code',
        modelRoute: 'gateway',
        personalPlans: false,
        image: { name: 'socio-coding', pin: 'deployment/coding/claude-code.pin' },
    });
});

it('records each harness’s terms: plans built for, a date or null, an https link', () => {
    for (const harness of [codexHarness, claudeCodeHarness, geminiCliHarness, grokHarness]) {
        expect(harness.terms.plans.length).toBeGreaterThan(10);
        expect(harness.terms.url).toMatch(/^https:\/\//);
        expect(harness.terms.checkedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(harness.terms.checkedAt)).toBe(true);
    }
});

// ---------------------------------------------------------------------------
// Gemini CLI: `gemini --output-format stream-json` (CB-326)

const geminiOutput = (text: string, extra: object[] = []) =>
    lines([
        { type: 'init', timestamp: 't', session_id: SESSION, model: 'orion' },
        { type: 'message', role: 'user', content: 'Fix the flaky test' },
        { type: 'message', role: 'assistant', content: 'Let me run ', delta: true },
        { type: 'message', role: 'assistant', content: 'the tests.', delta: true },
        {
            type: 'tool_use',
            tool_name: 'run_shell_command',
            tool_id: 'call-1',
            parameters: { command: 'pnpm test', description: 'Run the tests' },
        },
        { type: 'tool_result', tool_id: 'call-1', status: 'success', output: 'ok' },
        { type: 'tool_use', tool_name: 'replace', tool_id: 'call-2', parameters: { file_path: 'src/index.ts' } },
        {
            type: 'tool_result',
            tool_id: 'call-2',
            status: 'error',
            error: { type: 'EDIT_NO_OCCURRENCE_FOUND', message: 'no match' },
        },
        ...extra,
        { type: 'message', role: 'assistant', content: text.slice(0, 5), delta: true },
        { type: 'message', role: 'assistant', content: text.slice(5), delta: true },
        { type: 'result', status: 'success', stats: { total_tokens: 10 } },
    ]);

it('reads Gemini CLI’s progress, final message and session id', () => {
    const output = readGeminiCli(geminiOutput('Done: the flaky test now waits for the server.'));
    expect(output).toEqual({
        progress: [
            'Let me run the tests.',
            'run_shell_command: Run the tests',
            'replace: src/index.ts (failed)',
            'Done: the flaky test now waits for the server.',
        ],
        summary: 'Done: the flaky test now waits for the server.',
        sessionId: SESSION,
        errored: false,
    });
    // The user's own prompt echo is never progress or the summary.
    expect(JSON.stringify(output)).not.toContain('Fix the flaky test');
});

it('reports Gemini CLI’s failed runs, with the result’s error as the summary; warnings are progress only', () => {
    const failed = readGeminiCli(
        lines([
            { type: 'init', session_id: SESSION },
            { type: 'error', severity: 'warning', message: 'Loop detected, stopping' },
            { type: 'message', role: 'assistant', content: 'Trying', delta: true },
            { type: 'result', status: 'error', error: { type: 'FatalAuthenticationError', message: 'HTTP 401' } },
        ]),
    );
    expect(failed).toMatchObject({ errored: true, summary: 'error: HTTP 401', sessionId: SESSION });
    expect(failed.progress).toEqual(['warning: Loop detected, stopping', 'Trying', 'error: HTTP 401']);
    // An error event alone isn't the run failing; with no answer it's the summary.
    const errorOnly = readGeminiCli(
        lines([
            { type: 'error', severity: 'error', message: 'Maximum session turns exceeded' },
            { type: 'result', status: 'success' },
        ]),
    );
    expect(errorOnly).toMatchObject({ errored: false, summary: 'error: Maximum session turns exceeded' });
    // A run still going: what it said so far.
    const running = readGeminiCli(geminiOutput('x').split('\n').slice(0, 4).join('\n'));
    expect(running).toMatchObject({ errored: false, summary: 'Let me run the tests.', sessionId: SESSION });
});

it('reads Gemini CLI’s output tolerantly, keeps only a UUID as its session id, and makes its words inert', () => {
    const odd = readGeminiCli(
        [
            'Loaded cached credentials.',
            '{broken',
            JSON.stringify({ type: 'init', session_id: 'latest' }),
            JSON.stringify({ type: 'tool_use', tool_name: 7, parameters: 'x' }),
            JSON.stringify({ type: 'message', role: 'assistant', content: { not: 'text' }, delta: true }),
            JSON.stringify({ type: 'result', status: 'success' }),
        ].join('\n'),
    );
    expect(odd.errored).toBe(false);
    expect(odd.sessionId).toBeUndefined();
    expect(odd.progress).toEqual(['Loaded cached credentials.', '{broken', 'tool']);
    for (const id of ['--resume', `${SESSION} --yolo`, '1']) {
        expect(readGeminiCli(lines([{ type: 'init', session_id: id }])).sessionId).toBeUndefined();
    }
    const leaky = readGeminiCli(geminiOutput(`Done. Token ${TOKEN}\u0007 <script>`));
    expect(leaky.summary).not.toContain(TOKEN);
    expect(leaky.summary).not.toContain('\u0007');
    expect(leaky.progress.join('\n')).not.toContain(TOKEN);
});

it('caps Gemini CLI’s progress lines and summary', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: `c${i}`,
        parameters: { absolute_path: `/work/repo/f${i}-${'p'.repeat(400)}` },
    }));
    const output = readGeminiCli(
        lines([...many, { type: 'message', role: 'assistant', content: 'z'.repeat(20_000), delta: true }]),
    );
    expect(output.progress).toHaveLength(PROGRESS_LINES);
    expect(output.progress.every((line) => line.length <= 241)).toBe(true);
    expect(output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
});

it('builds Gemini CLI’s prompt exec: a new session first, then --resume', () => {
    const run = { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity };
    const first = geminiCliHarness.command(run);
    expect(first).toEqual({
        kind: 'prompt',
        params: { harness: 'gemini-cli', model: 'orion', prompt: 'Fix it', seconds: 1200, identity },
    });
    const next = geminiCliHarness.command({ ...run, session: SESSION });
    expect(next.params).toMatchObject({ harness: 'gemini-cli', session: SESSION });
    for (const exec of [first, next]) {
        expect(execPlan('prompt', exec.params, sandbox).ok).toBe(true);
    }
    expect(geminiCliHarness).toMatchObject({
        id: 'gemini-cli',
        label: 'Gemini CLI',
        modelRoute: 'gateway',
        personalPlans: false,
        image: { name: 'socio-coding', pin: 'deployment/coding/gemini-cli.pin' },
    });
    expect(geminiCliHarness.credential).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Grok Build: `grok --output-format streaming-json` (CB-326)

const grokOutput = (text: string, extra: object[] = []) =>
    lines([
        { type: 'thought', data: 'Private reasoning about the repo' },
        { type: 'text', data: 'Let me run ' },
        { type: 'text', data: 'the tests.' },
        {
            type: 'tool_call',
            toolCallId: 'call_1',
            title: 'Run tests',
            kind: 'execute',
            status: 'in_progress',
            toolName: 'run_terminal_cmd',
            rawInput: { command: 'pnpm test' },
        },
        { type: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: { exit: 0 } },
        {
            type: 'tool_call',
            toolCallId: 'call_2',
            title: '',
            kind: 'edit',
            status: 'pending',
            toolName: 'search_replace',
            rawInput: { file_path: 'src/index.ts' },
        },
        { type: 'tool_call_update', toolCallId: 'call_2', status: 'failed' },
        ...extra,
        { type: 'text', data: text },
        { type: 'usage', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } },
        { type: 'end', stopReason: 'end_turn', sessionId: SESSION, requestId: 'r1', num_turns: 3 },
    ]);

it('reads Grok Build’s progress, final message and session id, never its reasoning', () => {
    const output = readGrok(grokOutput('Done: the flaky test now waits for the server.'));
    expect(output).toEqual({
        progress: [
            'Let me run the tests.',
            'Run tests: pnpm test',
            'search_replace: src/index.ts (failed)',
            'Done: the flaky test now waits for the server.',
        ],
        summary: 'Done: the flaky test now waits for the server.',
        sessionId: SESSION,
        errored: false,
    });
    expect(JSON.stringify(output)).not.toContain('Private reasoning');
});

it('reports Grok Build’s errors: the last one is the summary', () => {
    const failed = readGrok(
        lines([
            { type: 'text', data: 'Trying' },
            { type: 'error', message: 'Couldn’t start session: model not found' },
        ]),
    );
    expect(failed).toMatchObject({ errored: true, summary: 'error: Couldn’t start session: model not found' });
    const refused = readGrok(lines([{ type: 'end', stopReason: 'refusal', sessionId: SESSION }]));
    expect(refused).toMatchObject({ errored: true, sessionId: SESSION });
    const running = readGrok(grokOutput('x').split('\n').slice(0, 4).join('\n'));
    expect(running).toMatchObject({ errored: false, summary: 'Let me run the tests.' });
    expect(running.sessionId).toBeUndefined();
});

it('reads Grok Build’s output tolerantly, keeps only a UUID as its session id, and makes its words inert', () => {
    const odd = readGrok(
        [
            'Note: update available',
            '{broken',
            JSON.stringify({ type: 'end', sessionId: 'abc123' }),
            JSON.stringify({ type: 'tool_call', rawInput: 'x' }),
            JSON.stringify({ type: 'text', data: 42 }),
        ].join('\n'),
    );
    expect(odd).toMatchObject({ errored: false, progress: ['Note: update available', '{broken', 'tool'] });
    expect(odd.sessionId).toBeUndefined();
    for (const id of ['--continue', `${SESSION} -c`, 'my title']) {
        expect(readGrok(lines([{ type: 'end', sessionId: id }])).sessionId).toBeUndefined();
    }
    const leaky = readGrok(grokOutput(`Done. Token ${TOKEN}\u0007`));
    expect(leaky.summary).not.toContain(TOKEN);
    expect(leaky.summary).not.toContain('\u0007');
    expect(leaky.progress.join('\n')).not.toContain(TOKEN);
});

it('caps Grok Build’s progress lines and summary', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
        type: 'tool_call',
        toolCallId: `c${i}`,
        toolName: 'read_file',
        rawInput: { path: `f${i}-${'p'.repeat(400)}` },
    }));
    const output = readGrok(lines([...many, { type: 'text', data: 'z'.repeat(20_000) }]));
    expect(output.progress).toHaveLength(PROGRESS_LINES);
    expect(output.progress.every((line) => line.length <= 241)).toBe(true);
    expect(output.summary.length).toBeLessThanOrEqual(SUMMARY_MAX + 1);
});

it('builds Grok Build’s prompt exec: a new session first, then --resume', () => {
    const run = { session: 'ses_socio_abc', model: 'orion', prompt: 'Fix it', seconds: 1200, identity };
    const first = grokHarness.command(run);
    expect(first).toEqual({
        kind: 'prompt',
        params: { harness: 'grok', model: 'orion', prompt: 'Fix it', seconds: 1200, identity },
    });
    const next = grokHarness.command({ ...run, session: SESSION });
    expect(next.params).toMatchObject({ harness: 'grok', session: SESSION });
    for (const exec of [first, next]) {
        expect(execPlan('prompt', exec.params, sandbox).ok).toBe(true);
    }
    expect(grokHarness).toMatchObject({
        id: 'grok',
        label: 'Grok Build',
        modelRoute: 'gateway',
        personalPlans: false,
        image: { name: 'socio-coding', pin: 'deployment/coding/grok.pin' },
    });
    expect(grokHarness.credential).toBeUndefined();
});
