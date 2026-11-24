import { describe, expect, it } from 'vitest';

import { sanitizeResponsesRequest } from '../src/server/gateway/responses-request.js';
import {
    ResponsesStreamMeter,
    responsesAnswerChars,
    responsesUsageOf,
} from '../src/server/gateway/responses-stream.js';

// CB-239: what of an OpenAI Responses request may reach a backend, and
// reading its answer. Negative cases first.

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PLAIN = { acceptsImages: false, personalPlan: false };
const IMAGES = { acceptsImages: true, personalPlan: false };
const PLAN = { acceptsImages: false, personalPlan: true };

const base = (extra: Record<string, unknown> = {}) => ({
    model: 'orion',
    input: 'hi',
    ...extra,
});

function ok(body: unknown, shape = PLAIN) {
    const result = sanitizeResponsesRequest(body, shape);
    if (!result.ok) {
        throw new Error(`refused: ${JSON.stringify(result)}`);
    }
    return result;
}

function refused(body: unknown, shape = PLAIN) {
    const result = sanitizeResponsesRequest(body, shape);
    if (result.ok) {
        throw new Error(`passed: ${JSON.stringify(result.body)}`);
    }
    return result;
}

const user = (content: unknown) => ({ role: 'user', content });

describe('refusals', () => {
    it('refuses a body that is not an object, and a missing or empty input', () => {
        for (const body of [null, 'x', [], 3]) {
            expect(refused(body).code).toBe('invalid_request');
        }
        expect(refused({ model: 'orion' }).param).toBe('input');
        expect(refused(base({ input: [] })).param).toBe('input');
        expect(refused(base({ input: Array.from({ length: 5001 }, () => user('x')) })).param).toBe('input');
    });

    it('refuses what relies on state stored at the provider', () => {
        for (const [key, value] of [
            ['previous_response_id', 'resp_123'],
            ['conversation', 'conv_123'],
            ['conversation', { id: 'conv_123' }],
            ['prompt', { id: 'pmpt_123', version: '2' }],
            ['background', true],
        ] as const) {
            const result = refused(base({ [key]: value }));
            expect(result.code, key).toBe('unsupported_parameter');
            expect(result.param).toBe(key);
        }
        expect(refused(base({ input: [{ type: 'item_reference', id: 'msg_1' }] })).code).toBe('unsupported_content');
    });

    it('refuses every provider-side tool type', () => {
        for (const type of [
            'web_search',
            'web_search_preview',
            'web_search_preview_2025_03_11',
            'file_search',
            'code_interpreter',
            'image_generation',
            'mcp',
            'computer_use_preview',
            'local_shell',
            'shell',
            'apply_patch',
            undefined,
        ]) {
            const result = refused(base({ tools: [{ type, name: 'x', server_url: 'https://evil' }] }));
            expect(result.code, String(type)).toBe('unsupported_tool');
            expect(result.param).toBe('tools[0]');
            expect(result.message).toMatch(/provider-side tools/);
        }
        expect(refused(base({ tools: ['web_search'] })).code).toBe('unsupported_tool');
        expect(
            refused(
                base({
                    tools: Array.from({ length: 257 }, (_, n) => ({
                        type: 'function',
                        name: `f${n}`,
                    })),
                }),
            ).param,
        ).toBe('tools');
    });

    it('refuses every item type a provider-side tool or stored state makes', () => {
        for (const type of [
            'web_search_call',
            'file_search_call',
            'computer_call',
            'computer_call_output',
            'code_interpreter_call',
            'image_generation_call',
            'mcp_call',
            'mcp_list_tools',
            'mcp_approval_request',
            'mcp_approval_response',
            'local_shell_call',
            'local_shell_call_output',
            'shell_call',
            'shell_call_output',
            'apply_patch_call',
            'apply_patch_call_output',
            'compaction',
            'something_new',
        ]) {
            const result = refused(base({ input: [{ type, id: 'x', call_id: 'c' }] }));
            expect(result.code, type).toBe('unsupported_content');
            expect(result.param).toBe('input[0]');
        }
        // An item with neither a type nor a role.
        expect(refused(base({ input: [{ content: 'hi' }] })).code).toBe('unsupported_content');
        expect(refused(base({ input: ['hi'] })).param).toBe('input[0]');
    });

    it('takes images only as inline data in user messages and tool output, for models that take them', () => {
        const image = (part: Record<string, unknown>) => base({ input: [user([{ type: 'input_image', ...part }])] });
        // The model takes no images.
        expect(refused(image({ image_url: PNG })).message).toMatch(/images/);
        for (const part of [
            { image_url: 'https://example.com/a.png' },
            { image_url: 'http://10.0.0.1/a.png' },
            { image_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
            { image_url: 'data:text/html;base64,PGI+' },
            { image_url: `${PNG}\nhttps://x` },
            { file_id: 'file-abc' },
            { file_id: 'file-abc', image_url: PNG },
            {},
        ]) {
            const result = refused(image(part), IMAGES);
            expect(result.code, JSON.stringify(part)).toBe('unsupported_content');
            expect(result.param).toBe('input[0].content[0]');
        }
        for (const role of ['assistant', 'system', 'developer']) {
            expect(
                refused(
                    base({
                        input: [{ role, content: [{ type: 'input_image', image_url: PNG }] }],
                    }),
                    IMAGES,
                ).code,
                role,
            ).toBe('unsupported_content');
        }
        expect(
            refused(
                base({
                    input: [
                        {
                            type: 'custom_tool_call_output',
                            call_id: 'c1',
                            output: [{ type: 'input_image', image_url: PNG }],
                        },
                    ],
                }),
                IMAGES,
            ).code,
        ).toBe('unsupported_content');
        expect(
            refused(
                base({
                    input: [
                        {
                            type: 'function_call_output',
                            call_id: 'c1',
                            output: [{ type: 'input_image', image_url: 'https://x.test/a.png' }],
                        },
                    ],
                }),
                IMAGES,
            ).code,
        ).toBe('unsupported_content');
    });

    it('refuses files and parts out of place', () => {
        for (const part of [
            { type: 'input_file', file_id: 'file-1' },
            { type: 'input_file', file_url: 'https://x.test/a.pdf' },
            { type: 'input_file', file_data: 'data:application/pdf;base64,AA==' },
            { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } },
            { type: 'output_text', text: 'x' },
            { type: 'refusal', refusal: 'x' },
            { text: 'untyped' },
        ]) {
            expect(refused(base({ input: [user([part])] }), IMAGES).code, JSON.stringify(part)).toBe(
                'unsupported_content',
            );
        }
        expect(
            refused(
                base({
                    input: [
                        {
                            type: 'function_call_output',
                            call_id: 'c',
                            output: [{ type: 'input_file', file_id: 'f' }],
                        },
                    ],
                }),
            ).code,
        ).toBe('unsupported_content');
    });

    it('checks the shape of allowed items', () => {
        const cases: [unknown, string][] = [
            [{ role: 'tool', content: 'x' }, 'input[0].role'],
            [{ type: 'message', content: 'x' }, 'input[0].role'],
            [{ role: 'user' }, 'input[0].content'],
            [user([{ type: 'input_text', text: 3 }]), 'input[0].content[0].text'],
            [
                {
                    type: 'function_call',
                    call_id: 'c',
                    name: 'bad name',
                    arguments: '{}',
                },
                'input[0].name',
            ],
            [{ type: 'function_call', call_id: 'c', name: 'f', arguments: {} }, 'input[0].arguments'],
            [
                {
                    type: 'function_call',
                    call_id: 'x'.repeat(201),
                    name: 'f',
                    arguments: '',
                },
                'input[0].call_id',
            ],
            [{ type: 'function_call_output', output: 'x' }, 'input[0].call_id'],
            [{ type: 'function_call_output', call_id: 'c', output: 3 }, 'input[0].output'],
            [{ type: 'custom_tool_call', call_id: 'c', name: 'f', input: {} }, 'input[0].input'],
            [{ type: 'reasoning', summary: 'x' }, 'input[0].summary'],
            [{ type: 'reasoning', summary: [{ type: 'text', text: 'x' }] }, 'input[0].summary[0]'],
            [
                {
                    type: 'reasoning',
                    summary: [],
                    content: [{ type: 'summary_text', text: 'x' }],
                },
                'input[0].content[0]',
            ],
            [
                {
                    type: 'reasoning',
                    summary: [],
                    encrypted_content: 'x'.repeat(2 * 1024 * 1024 + 1),
                },
                'input[0].encrypted_content',
            ],
        ];
        for (const [item, param] of cases) {
            const result = refused(base({ input: [item] }));
            expect(result.code, param).toBe('invalid_value');
            expect(result.param).toBe(param);
        }
    });

    it('checks tools, including their schemas', () => {
        const fn = (extra: Record<string, unknown>) => base({ tools: [{ type: 'function', name: 'f', ...extra }] });
        expect(refused(fn({ name: 'has space' })).param).toBe('tools[0].name');
        expect(refused(fn({ name: 'x'.repeat(65) })).param).toBe('tools[0].name');
        expect(refused(fn({ parameters: 'object' })).param).toBe('tools[0].parameters');
        expect(refused(fn({ description: 3 })).param).toBe('tools[0].description');
        expect(refused(fn({ strict: 'yes' })).param).toBe('tools[0].strict');
        for (const ref of ['https://evil.test/schema.json', 'file:///etc/passwd', 'other.json#/a']) {
            const result = refused(
                fn({
                    parameters: {
                        type: 'object',
                        properties: { a: { $ref: ref } },
                    },
                }),
            );
            expect(result.code).toBe('unsupported_schema');
            expect(result.param).toBe('tools[0].parameters');
        }
        let deep: Record<string, unknown> = { type: 'string' };
        for (let n = 0; n < 40; n++) {
            deep = { type: 'object', properties: { a: deep } };
        }
        expect(refused(fn({ parameters: deep })).code).toBe('unsupported_schema');
        expect(refused(fn({ parameters: { type: 'object', description: 'x'.repeat(70_000) } })).code).toBe(
            'unsupported_schema',
        );

        const custom = (format: unknown) => base({ tools: [{ type: 'custom', name: 'patch', format }] });
        expect(refused(custom('text')).param).toBe('tools[0].format');
        expect(refused(custom({ type: 'json' })).param).toBe('tools[0].format.type');
        expect(refused(custom({ type: 'grammar', syntax: 'ebnf', definition: 'x' })).param).toBe(
            'tools[0].format.syntax',
        );
        expect(refused(custom({ type: 'grammar', syntax: 'lark', definition: 3 })).param).toBe(
            'tools[0].format.definition',
        );
        expect(
            refused(
                custom({
                    type: 'grammar',
                    syntax: 'regex',
                    definition: 'a'.repeat(64 * 1024 + 1),
                }),
            ).param,
        ).toBe('tools[0].format.definition');
    });

    it('lets tool_choice name only the request’s own tools', () => {
        const tools = [
            { type: 'function', name: 'read' },
            { type: 'custom', name: 'patch' },
        ];
        for (const choice of ['auto', 'required']) {
            expect(refused(base({ tool_choice: choice })).param).toBe('tool_choice');
        }
        for (const choice of [
            'any',
            { type: 'function', name: 'other' },
            { type: 'function', name: 'patch' },
            { type: 'custom', name: 'read' },
            { type: 'function', function: { name: 'read' } },
            { type: 'web_search_preview' },
            { type: 'file_search' },
            { type: 'mcp', server_label: 'x' },
            { type: 'allowed_tools', mode: 'auto', tools: [] },
            {
                type: 'allowed_tools',
                mode: 'none',
                tools: [{ type: 'function', name: 'read' }],
            },
            {
                type: 'allowed_tools',
                mode: 'auto',
                tools: [{ type: 'function', name: 'read' }, { type: 'web_search' }],
            },
            {
                type: 'allowed_tools',
                mode: 'required',
                tools: [{ type: 'function', name: 'missing' }],
            },
        ]) {
            expect(refused(base({ tools, tool_choice: choice })).param, JSON.stringify(choice)).toBe('tool_choice');
        }
    });

    it('checks the other known fields', () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ instructions: 3 }, 'instructions'],
            [{ temperature: 2.5 }, 'temperature'],
            [{ temperature: '1' }, 'temperature'],
            [{ top_p: -0.1 }, 'top_p'],
            [{ max_output_tokens: 0 }, 'max_output_tokens'],
            [{ max_output_tokens: 1.5 }, 'max_output_tokens'],
            [{ max_tool_calls: 0 }, 'max_tool_calls'],
            [{ max_tool_calls: 1001 }, 'max_tool_calls'],
            [{ truncation: 'always' }, 'truncation'],
            [{ parallel_tool_calls: 'yes' }, 'parallel_tool_calls'],
            [{ stream: 'yes' }, 'stream'],
            [{ reasoning: 'high' }, 'reasoning'],
            [{ reasoning: { effort: 'max' } }, 'reasoning.effort'],
            [{ reasoning: { summary: 'long' } }, 'reasoning.summary'],
            [{ text: { verbosity: 'loud' } }, 'text.verbosity'],
            [{ text: { format: { type: 'json_schema', name: 'x' } } }, 'text.format'],
            [
                {
                    text: {
                        format: { type: 'json_schema', name: 'bad name', schema: {} },
                    },
                },
                'text.format',
            ],
            [{ text: { format: { type: 'grammar' } } }, 'text.format.type'],
            [{ include: 'reasoning.encrypted_content' }, 'include'],
        ];
        for (const [extra, param] of cases) {
            expect(refused(base(extra)).param, JSON.stringify(extra)).toBe(param);
        }
        const remote = refused(
            base({
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'out',
                        schema: { $ref: 'https://evil.test/s.json' },
                    },
                },
            }),
        );
        expect(remote.code).toBe('unsupported_schema');
        expect(remote.param).toBe('text.format.schema');
    });

    it('requires a stream on a personal plan', () => {
        for (const stream of [undefined, false]) {
            const result = refused(base({ stream }), PLAN);
            expect(result.code).toBe('stream_required');
            expect(result.param).toBe('stream');
        }
    });
});

describe('what passes', () => {
    it('never forwards what identifies the person, and always sends store: false', () => {
        const result = ok(
            base({
                user: 'person-1',
                metadata: { email: 'someone@example.com' },
                safety_identifier: 'hash-of-person',
                service_tier: 'priority',
                top_logprobs: 3,
                stream_options: { include_obfuscation: false },
                client_metadata: { device: 'x' },
                store: true,
                background: false,
                previous_response_id: null,
            }),
        );
        expect(result.body).toEqual({ input: 'hi', store: false, stream: false });
        expect(result.dropped.sort()).toEqual(
            [
                'user',
                'metadata',
                'safety_identifier',
                'service_tier',
                'top_logprobs',
                'stream_options',
                'client_metadata',
                'store',
                'background',
                'previous_response_id',
            ].sort(),
        );
        const json = JSON.stringify(result.body);
        for (const value of ['person-1', 'someone@example.com', 'hash-of-person']) {
            expect(json).not.toContain(value);
        }
        // store: false from the client is no news.
        expect(ok(base({ store: false })).dropped).toEqual([]);
    });

    it('copies a Codex-shaped conversation, dropping unknown nested fields by name', () => {
        const result = ok(
            {
                model: 'gpt-5-codex',
                instructions: 'You are a coding agent.',
                input: [
                    {
                        type: 'message',
                        role: 'developer',
                        content: [{ type: 'input_text', text: 'rules' }],
                    },
                    {
                        type: 'message',
                        role: 'user',
                        id: 'msg_1',
                        content: [
                            { type: 'input_text', text: 'fix it' },
                            { type: 'input_image', image_url: PNG, detail: 'high' },
                            { type: 'input_image', image_url: PNG, detail: 'original' },
                        ],
                    },
                    {
                        type: 'reasoning',
                        id: 'rs_1',
                        summary: [{ type: 'summary_text', text: 'thinking' }],
                        content: [{ type: 'reasoning_text', text: 'step' }],
                        encrypted_content: 'gAAAA',
                        status: 'completed',
                    },
                    {
                        type: 'function_call',
                        id: 'fc_1',
                        call_id: 'call_1',
                        name: 'shell',
                        arguments: '{"cmd":["ls"]}',
                        status: 'completed',
                    },
                    {
                        type: 'function_call_output',
                        call_id: 'call_1',
                        output: [
                            { type: 'input_text', text: 'a.ts' },
                            { type: 'input_image', image_url: PNG },
                        ],
                    },
                    {
                        type: 'custom_tool_call',
                        id: 'bad id!',
                        call_id: 'call_2',
                        name: 'apply_patch',
                        input: '*** Begin Patch',
                    },
                    {
                        type: 'custom_tool_call_output',
                        call_id: 'call_2',
                        output: 'Done',
                    },
                    {
                        role: 'assistant',
                        content: [
                            {
                                type: 'output_text',
                                text: 'ok',
                                annotations: [],
                                logprobs: [],
                            },
                            { type: 'refusal', refusal: 'no' },
                        ],
                        foo: 1,
                    },
                ],
                tools: [
                    {
                        type: 'function',
                        name: 'shell',
                        description: 'Runs a command',
                        parameters: {
                            type: 'object',
                            properties: { cmd: { $ref: '#/$defs/cmd' } },
                            $defs: { cmd: { type: 'array' } },
                        },
                        strict: false,
                        cache: true,
                    },
                    {
                        type: 'custom',
                        name: 'apply_patch',
                        format: {
                            type: 'grammar',
                            syntax: 'lark',
                            definition: 'start: "x"',
                        },
                    },
                    { type: 'custom', name: 'note', format: { type: 'text' } },
                ],
                tool_choice: 'auto',
                parallel_tool_calls: false,
                reasoning: { effort: 'xhigh', summary: 'auto', generate_summary: 'x' },
                text: { verbosity: 'low', format: { type: 'text' }, extra: 1 },
                include: [
                    'reasoning.encrypted_content',
                    'file_search_call.results',
                    'web_search_call.action.sources',
                    'bad value!',
                ],
                prompt_cache_key: '0199a3f0-5a7e-7c41-b0b3-5a0c4ac0c0aa',
                store: false,
                stream: true,
                max_output_tokens: 4096,
                temperature: 1,
                top_p: 0.9,
                truncation: 'auto',
                max_tool_calls: 50,
            },
            IMAGES,
        );
        expect(result.stream).toBe(true);
        expect(result.requestedCompletion).toBe(4096);
        expect(result.body.model).toBeUndefined();
        expect(result.body.max_output_tokens).toBeUndefined();
        expect(result.body.input).toEqual([
            {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'rules' }],
            },
            {
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: 'fix it' },
                    { type: 'input_image', image_url: PNG, detail: 'high' },
                    { type: 'input_image', image_url: PNG },
                ],
            },
            {
                type: 'reasoning',
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'thinking' }],
                content: [{ type: 'reasoning_text', text: 'step' }],
                encrypted_content: 'gAAAA',
            },
            {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'shell',
                arguments: '{"cmd":["ls"]}',
            },
            {
                type: 'function_call_output',
                call_id: 'call_1',
                output: [
                    { type: 'input_text', text: 'a.ts' },
                    { type: 'input_image', image_url: PNG },
                ],
            },
            {
                type: 'custom_tool_call',
                call_id: 'call_2',
                name: 'apply_patch',
                input: '*** Begin Patch',
            },
            { type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done' },
            {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'output_text', text: 'ok' },
                    { type: 'refusal', refusal: 'no' },
                ],
            },
        ]);
        expect(result.body.tools).toEqual([
            {
                type: 'function',
                name: 'shell',
                description: 'Runs a command',
                parameters: {
                    type: 'object',
                    properties: { cmd: { $ref: '#/$defs/cmd' } },
                    $defs: { cmd: { type: 'array' } },
                },
                strict: false,
            },
            {
                type: 'custom',
                name: 'apply_patch',
                format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' },
            },
            { type: 'custom', name: 'note', format: { type: 'text' } },
        ]);
        expect(result.body).toMatchObject({
            instructions: 'You are a coding agent.',
            tool_choice: 'auto',
            parallel_tool_calls: false,
            reasoning: { effort: 'xhigh', summary: 'auto' },
            text: { verbosity: 'low', format: { type: 'text' } },
            include: ['reasoning.encrypted_content'],
            prompt_cache_key: '0199a3f0-5a7e-7c41-b0b3-5a0c4ac0c0aa',
            store: false,
            stream: true,
            temperature: 1,
            top_p: 0.9,
            truncation: 'auto',
            max_tool_calls: 50,
        });
        expect(result.dropped.sort()).toEqual(
            [
                'input[].id',
                'input[].content[].detail',
                'input[].status',
                'input[].content[].annotations',
                'input[].content[].logprobs',
                'input[].foo',
                'tools[].cache',
                'reasoning.generate_summary',
                'text.extra',
                'include[].file_search_call.results',
                'include[].web_search_call.action.sources',
                'include[]',
            ].sort(),
        );
        // Three images at 1000 tokens each, their bytes not counted.
        expect(result.promptTokens).toBeGreaterThan(3000);
        expect(result.promptTokens).toBeLessThan(3600);
    });

    it('copies a Grok Build-shaped conversation whole (CB-326: its own wire API for xAI models)', () => {
        // What Grok Build 1.0.45's Responses mapping sends (crates/codegen/
        // xai-grok-sampling-types/src/conversation/responses.rs, read from its
        // source): stateless, the conversation id as prompt_cache_key, a
        // reasoning effort with a concise summary, function tools without
        // strict, reasoning items replayed with their reasoning_text content.
        const conversation = '0f9c5f8e-2b8a-4d0e-9b1d-5b3f7d6c2a10';
        const body = {
            model: 'socio-model',
            stream: true,
            prompt_cache_key: conversation,
            reasoning: { effort: 'high', summary: 'concise' },
            tool_choice: 'auto',
            tools: [
                {
                    type: 'function',
                    name: 'run_terminal_cmd',
                    description: 'Run a command',
                    parameters: { type: 'object', properties: { command: { type: 'string' } } },
                },
            ],
            input: [
                { type: 'message', role: 'system', content: 'You are Grok Build.' },
                { type: 'message', role: 'user', content: 'List the files.' },
                {
                    type: 'reasoning',
                    id: 'rs_123',
                    summary: [{ type: 'summary_text', text: 'Listing.' }],
                    content: [{ type: 'reasoning_text', text: 'I should run ls.' }],
                },
                { type: 'message', role: 'assistant', content: 'Running ls.' },
                { type: 'function_call', call_id: 'call_1', name: 'run_terminal_cmd', arguments: '{"command":"ls"}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'README.md' },
            ],
        };
        const result = ok(body);
        expect(result.dropped).toEqual([]);
        const { model: _model, ...rest } = body;
        expect(result.body).toEqual({ ...rest, store: false });
    });

    it('drops a prompt_cache_key that could carry anything', () => {
        for (const key of ['a b', 'x'.repeat(65), 'someone@example.com', 3, '']) {
            expect(ok(base({ prompt_cache_key: key })).dropped).toEqual(['prompt_cache_key']);
        }
        expect(ok(base({ prompt_cache_key: 'sess:1_a.b-c' })).body).toMatchObject({
            prompt_cache_key: 'sess:1_a.b-c',
        });
    });

    it('takes tool_choice that names the request’s tools', () => {
        const tools = [
            { type: 'function', name: 'read' },
            { type: 'custom', name: 'patch' },
        ];
        for (const [choice, expected] of [
            ['none', 'none'],
            ['required', 'required'],
            [
                { type: 'function', name: 'read', extra: 1 },
                { type: 'function', name: 'read' },
            ],
            [
                { type: 'custom', name: 'patch' },
                { type: 'custom', name: 'patch' },
            ],
            [
                {
                    type: 'allowed_tools',
                    mode: 'required',
                    tools: [
                        { type: 'function', name: 'read', x: 1 },
                        { type: 'custom', name: 'patch' },
                    ],
                },
                {
                    type: 'allowed_tools',
                    mode: 'required',
                    tools: [
                        { type: 'function', name: 'read' },
                        { type: 'custom', name: 'patch' },
                    ],
                },
            ],
        ] as const) {
            expect(ok(base({ tools, tool_choice: choice })).body.tool_choice).toEqual(expected);
        }
        expect(ok(base({ tool_choice: 'none' })).body.tool_choice).toBe('none');
    });

    it('takes structured output formats', () => {
        expect(
            ok(
                base({
                    text: {
                        format: {
                            type: 'json_schema',
                            name: 'out',
                            schema: { type: 'object' },
                            strict: true,
                            description: 'd',
                            other: 1,
                        },
                    },
                }),
            ),
        ).toMatchObject({
            body: {
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'out',
                        schema: { type: 'object' },
                        strict: true,
                        description: 'd',
                    },
                },
            },
            dropped: ['text.format.other'],
        });
        expect(ok(base({ text: { format: { type: 'json_object' } } })).body.text).toEqual({
            format: { type: 'json_object' },
        });
    });

    it('sends a personal plan only the Codex CLI’s shape', () => {
        const result = ok(
            base({
                stream: true,
                temperature: 0.2,
                top_p: 0.5,
                truncation: 'auto',
                max_tool_calls: 3,
                max_output_tokens: 1000,
                store: true,
                user: 'person-1',
            }),
            PLAN,
        );
        expect(result.body).toEqual({ input: 'hi', store: false, stream: true });
        expect(result.requestedCompletion).toBe(1000);
        expect(result.dropped.sort()).toEqual(
            ['temperature', 'top_p', 'truncation', 'max_tool_calls', 'store', 'user'].sort(),
        );
        // Out-of-range knobs don't matter when they aren't forwarded.
        expect(ok(base({ stream: true, temperature: 9 }), PLAN).ok).toBe(true);
    });

    it('estimates the prompt from input, instructions and tools', () => {
        const result = ok(
            base({
                input: 'x'.repeat(4000),
                instructions: 'y'.repeat(4000),
                tools: [{ type: 'function', name: 'f' }],
            }),
        );
        const tools = JSON.stringify([{ type: 'function', name: 'f' }]).length;
        expect(result.promptTokens).toBe(Math.ceil((4002 + 4000 + tools) / 4));
    });
});

describe('responses stream meter', () => {
    const sse = (events: Record<string, unknown>[]) =>
        events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');

    const STREAM = sse([
        {
            type: 'response.created',
            response: { id: 'resp_1', status: 'in_progress', usage: null },
        },
        { type: 'response.reasoning_summary_text.delta', delta: 'Plan: ' },
        { type: 'response.reasoning_text.delta', delta: 'abc' },
        { type: 'response.output_text.delta', delta: 'Héllo, ' },
        { type: 'response.output_text.delta', delta: 'world' },
        { type: 'response.output_text.done', text: 'Héllo, world' },
        { type: 'response.refusal.delta', delta: 'no' },
        { type: 'response.function_call_arguments.delta', delta: '{"a":' },
        { type: 'response.function_call_arguments.delta', delta: '1}' },
        { type: 'response.function_call_arguments.done', arguments: '{"a":1}' },
        { type: 'response.custom_tool_call_input.delta', delta: 'patch' },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                status: 'completed',
                usage: {
                    input_tokens: 1200,
                    input_tokens_details: { cached_tokens: 1024 },
                    output_tokens: 40,
                    output_tokens_details: { reasoning_tokens: 12 },
                    total_tokens: 1240,
                },
            },
        },
    ]);
    const OUTPUT = 'Plan: abcHéllo, worldno{"a":1}patch'.length;

    it('counts deltas and reads the final usage at any chunk boundary', () => {
        for (const size of [1, 2, 3, 7, 64, 1000, STREAM.length]) {
            const meter = new ResponsesStreamMeter();
            for (let at = 0; at < STREAM.length; at += size) {
                meter.push(STREAM.slice(at, at + size).replace(/\n/g, '\r\n'));
            }
            expect(meter.outputChars, String(size)).toBe(OUTPUT);
            expect(meter.usage).toEqual({
                promptTokens: 1200,
                completionTokens: 40,
                cachedTokens: 1024,
            });
            expect(meter.done).toBe(true);
            expect(meter.outputTokens).toBe(Math.ceil(OUTPUT / 4));
        }
    });

    it('takes usage from incomplete and failed responses, and none before', () => {
        for (const type of ['response.incomplete', 'response.failed']) {
            const meter = new ResponsesStreamMeter();
            meter.push(
                sse([
                    { type: 'response.output_text.delta', delta: 'abc' },
                    {
                        type,
                        response: { usage: { input_tokens: 5, output_tokens: 3 } },
                    },
                ]),
            );
            expect(meter.usage, type).toEqual({
                promptTokens: 5,
                completionTokens: 3,
                cachedTokens: 0,
            });
        }
        const meter = new ResponsesStreamMeter();
        meter.push(
            sse([
                {
                    type: 'response.in_progress',
                    response: { usage: { input_tokens: 5, output_tokens: 3 } },
                },
                { type: 'response.output_text.delta', delta: 'abc' },
            ]) + 'data: {"type":"response.output_text.delta","delta":"unfinished',
        );
        expect(meter.usage).toBeUndefined();
        expect(meter.outputChars).toBe(3);
        meter.push('data: not json\n\n: comment\n\n');
        expect(meter.outputChars).toBe(3);
    });

    it('discards a pending line past 8 MB', () => {
        const meter = new ResponsesStreamMeter();
        meter.push('data: {"type":"response.output_text.delta","delta":"');
        meter.push('x'.repeat(8 * 1024 * 1024));
        meter.push('"}\n');
        expect(meter.outputChars).toBe(0);
        meter.push(sse([{ type: 'response.output_text.delta', delta: 'ok' }]));
        expect(meter.outputChars).toBe(2);
    });

    it('reads a non-streamed response', () => {
        const body = {
            id: 'resp_1',
            output: [
                {
                    type: 'reasoning',
                    summary: [{ type: 'summary_text', text: 'abcd' }],
                    content: [{ type: 'reasoning_text', text: 'ef' }],
                },
                {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'output_text', text: 'hello', annotations: [] },
                        { type: 'refusal', refusal: 'no' },
                    ],
                },
                {
                    type: 'function_call',
                    call_id: 'c',
                    name: 'shell',
                    arguments: '{"a":1}',
                },
                { type: 'custom_tool_call', call_id: 'd', name: 'p', input: 'patch' },
                { type: 'web_search_call', action: { query: 'zzzzzz' } },
            ],
            usage: {
                input_tokens: 10,
                output_tokens: 20,
                input_tokens_details: { cached_tokens: 4 },
            },
        };
        expect(responsesAnswerChars(body)).toBe(4 + 2 + 5 + 2 + 7 + 5);
        expect(responsesUsageOf(body)).toEqual({
            promptTokens: 10,
            completionTokens: 20,
            cachedTokens: 4,
        });
        for (const value of [
            null,
            {},
            { usage: null },
            { usage: { input_tokens: 1 } },
            { usage: { input_tokens: -1, output_tokens: 2 } },
            { usage: { prompt_tokens: 1, completion_tokens: 2 } },
        ]) {
            expect(responsesUsageOf(value), JSON.stringify(value)).toBeUndefined();
        }
        expect(responsesAnswerChars(null)).toBe(0);
        expect(responsesAnswerChars({ output: 'x' })).toBe(0);
    });
});
