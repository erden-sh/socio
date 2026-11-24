import { describe, expect, it } from 'vitest';

import { anthropicBetas, sanitizeMessagesRequest } from '../src/server/gateway/messages-request.js';
import { MessagesStreamMeter, messagesAnswerChars, messagesUsageOf } from '../src/server/gateway/messages-stream.js';

// CB-239: what of an Anthropic Messages request may reach a
// backend, and reading its answer. Negative cases first.

const PLAIN = { acceptsImages: false };
const IMAGES = { acceptsImages: true };
const PIXEL = 'iVBORw0KGgo=';
const pngSource = { type: 'base64', media_type: 'image/png', data: PIXEL };

const base = (extra: Record<string, unknown> = {}) => ({
    model: 'claude-like',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    ...extra,
});
const user = (content: unknown) => ({ role: 'user', content });
const assistant = (content: unknown) => ({ role: 'assistant', content });
const tool = { name: 'read', input_schema: { type: 'object' } };

function ok(body: unknown, shape = PLAIN) {
    const result = sanitizeMessagesRequest(body, shape);
    if (!result.ok) {
        throw new Error(`refused: ${JSON.stringify(result)}`);
    }
    return result;
}

function refused(body: unknown, shape = PLAIN) {
    const result = sanitizeMessagesRequest(body, shape);
    if (result.ok) {
        throw new Error(`passed: ${JSON.stringify(result.body)}`);
    }
    return result;
}

describe('refusals', () => {
    it('refuses a body that is not an object, bad messages and a missing max_tokens', () => {
        for (const body of [null, 'x', [], 3]) {
            expect(refused(body).code).toBe('invalid_request');
        }
        expect(refused(base({ messages: [] })).param).toBe('messages');
        expect(refused(base({ messages: 'hi' })).param).toBe('messages');
        expect(refused(base({ messages: Array.from({ length: 5001 }, () => user('x')) })).param).toBe('messages');
        for (const max_tokens of [undefined, 0, 1.5, '100']) {
            expect(refused(base({ max_tokens })).param).toBe('max_tokens');
        }
        expect(refused(base({ messages: [{ role: 'system', content: 'x' }] })).param).toBe('messages[0].role');
    });

    it('refuses MCP servers and containers', () => {
        for (const [key, value] of [
            ['mcp_servers', [{ type: 'url', url: 'https://mcp.example', name: 'x' }]],
            ['mcp_servers', []],
            ['container', 'container_123'],
            ['container', { id: 'c', skills: [] }],
        ] as const) {
            const result = refused(base({ [key]: value }));
            expect(result.code, key).toBe('unsupported_parameter');
            expect(result.param).toBe(key);
        }
    });

    it('refuses every server tool type', () => {
        for (const type of [
            'web_search_20250305',
            'web_search_20260209',
            'web_fetch_20250910',
            'code_execution_20250522',
            'code_execution_20250825',
            'bash_20250124',
            'text_editor_20250728',
            'computer_20250124',
            'memory_20250818',
            'tool_search_tool_regex_20251119',
            'tool_search_tool_bm25_20251119',
            'mcp_toolset',
            'function',
        ]) {
            const result = refused(
                base({
                    tools: [{ type, name: 'x', input_schema: { type: 'object' } }],
                }),
            );
            expect(result.code, type).toBe('unsupported_tool');
            expect(result.param).toBe('tools[0]');
        }
        expect(refused(base({ tools: ['web_search'] })).code).toBe('unsupported_tool');
        expect(
            refused(
                base({
                    tools: Array.from({ length: 257 }, (_, n) => ({
                        ...tool,
                        name: `t${n}`,
                    })),
                }),
            ).param,
        ).toBe('tools');
    });

    it('refuses every block type outside plain client content', () => {
        const blocks: Record<string, unknown>[] = [
            {
                type: 'document',
                source: { type: 'url', url: 'https://x.test/a.pdf' },
            },
            {
                type: 'document',
                source: { type: 'text', media_type: 'text/plain', data: 'x' },
            },
            { type: 'search_result', source: 'x', title: 't', content: [] },
            {
                type: 'server_tool_use',
                id: 'srvtoolu_1',
                name: 'web_search',
                input: {},
            },
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: [],
            },
            { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: {} },
            {
                type: 'code_execution_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: {},
            },
            {
                type: 'bash_code_execution_tool_result',
                tool_use_id: 's',
                content: {},
            },
            {
                type: 'mcp_tool_use',
                id: 'mcptoolu_1',
                name: 'x',
                server_name: 's',
                input: {},
            },
            { type: 'mcp_tool_result', tool_use_id: 'mcptoolu_1', content: [] },
            { type: 'container_upload', file_id: 'file_1' },
            { type: 'tool_reference', tool_name: 'x' },
            { text: 'untyped' },
        ];
        for (const block of blocks) {
            for (const message of [user([block]), assistant([block])]) {
                expect(refused(base({ messages: [message] }), IMAGES).code, JSON.stringify(message)).toBe(
                    'unsupported_content',
                );
            }
        }
    });

    it('keeps blocks to their roles', () => {
        const cases: Record<string, unknown>[] = [
            assistant([{ type: 'image', source: pngSource }]),
            assistant([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }]),
            user([{ type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }]),
            user([{ type: 'thinking', thinking: 'x', signature: 's' }]),
            user([{ type: 'redacted_thinking', data: 'x' }]),
        ];
        for (const message of cases) {
            expect(refused(base({ messages: [message] }), IMAGES).code, JSON.stringify(message)).toBe(
                'unsupported_content',
            );
        }
        // System blocks are text only.
        expect(refused(base({ system: [{ type: 'image', source: pngSource }] }), IMAGES).param).toBe('system[0]');
    });

    it('takes images only as inline base64, for models that take them', () => {
        const image = (source: unknown) => base({ messages: [user([{ type: 'image', source }])] });
        expect(refused(image(pngSource)).message).toMatch(/images/);
        for (const source of [
            { type: 'url', url: 'https://x.test/a.png' },
            { type: 'file', file_id: 'file_1' },
            { type: 'base64', media_type: 'image/svg+xml', data: PIXEL },
            'https://x.test/a.png',
        ]) {
            expect(refused(image(source), IMAGES).code, JSON.stringify(source)).toBe('unsupported_content');
        }
        expect(refused(image({ ...pngSource, data: 'not base64!' }), IMAGES).param).toBe(
            'messages[0].content[0].source.data',
        );
        // Inside a tool result too.
        expect(
            refused(
                base({
                    messages: [
                        user([
                            {
                                type: 'tool_result',
                                tool_use_id: 'toolu_1',
                                content: [{ type: 'image', source: { type: 'url', url: 'https://x' } }],
                            },
                        ]),
                    ],
                }),
                IMAGES,
            ).code,
        ).toBe('unsupported_content');
        expect(
            refused(
                base({
                    messages: [
                        user([
                            {
                                type: 'tool_result',
                                tool_use_id: 'toolu_1',
                                content: [{ type: 'image', source: pngSource }],
                            },
                        ]),
                    ],
                }),
            ).code,
        ).toBe('unsupported_content');
        expect(
            refused(
                base({
                    messages: [
                        user([
                            {
                                type: 'tool_result',
                                tool_use_id: 'toolu_1',
                                content: [
                                    {
                                        type: 'document',
                                        source: { type: 'url', url: 'https://x' },
                                    },
                                ],
                            },
                        ]),
                    ],
                }),
            ).code,
        ).toBe('unsupported_content');
    });

    it('checks the shape of allowed blocks', () => {
        const cases: [Record<string, unknown>, string][] = [
            [user([{ type: 'text', text: 3 }]), 'messages[0].content[0].text'],
            [user(3), 'messages[0].content'],
            [assistant([{ type: 'tool_use', id: 'bad id', name: 'read', input: {} }]), 'messages[0].content[0].id'],
            [assistant([{ type: 'tool_use', id: 'toolu_1', name: 'a b', input: {} }]), 'messages[0].content[0].name'],
            [
                assistant([{ type: 'tool_use', id: 'toolu_1', name: 'read', input: '{}' }]),
                'messages[0].content[0].input',
            ],
            [user([{ type: 'tool_result', tool_use_id: '../x', content: 'x' }]), 'messages[0].content[0].tool_use_id'],
            [user([{ type: 'tool_result', tool_use_id: 't', is_error: 'yes' }]), 'messages[0].content[0].is_error'],
            [assistant([{ type: 'thinking', thinking: 'x' }]), 'messages[0].content[0].signature'],
            [assistant([{ type: 'redacted_thinking' }]), 'messages[0].content[0].data'],
        ];
        for (const [message, param] of cases) {
            const result = refused(base({ messages: [message] }));
            expect(result.code, param).toBe('invalid_value');
            expect(result.param).toBe(param);
        }
    });

    it('checks tools, including their schemas', () => {
        const one = (extra: Record<string, unknown>) => base({ tools: [{ ...tool, ...extra }] });
        expect(refused(one({ name: 'has space' })).param).toBe('tools[0].name');
        expect(refused(one({ name: 'x'.repeat(129) })).param).toBe('tools[0].name');
        expect(refused(one({ description: 3 })).param).toBe('tools[0].description');
        expect(refused(one({ input_schema: undefined })).param).toBe('tools[0].input_schema');
        for (const $ref of ['https://evil.test/s.json', 'file:///etc/passwd']) {
            const result = refused(one({ input_schema: { type: 'object', properties: { a: { $ref } } } }));
            expect(result.code).toBe('unsupported_schema');
            expect(result.param).toBe('tools[0].input_schema');
        }
        expect(refused(one({ input_schema: { $dynamicRef: 'https://x' } })).code).toBe('unsupported_schema');
    });

    it('lets tool_choice name only the request’s own tools', () => {
        for (const choice of [{ type: 'auto' }, { type: 'any' }, { type: 'tool', name: 'read' }]) {
            expect(refused(base({ tool_choice: choice })).param).toBe('tool_choice');
        }
        for (const choice of [
            'auto',
            { type: 'tool', name: 'other' },
            { type: 'tool' },
            { type: 'required' },
            { type: 'web_search' },
        ]) {
            expect(refused(base({ tools: [tool], tool_choice: choice })).param, JSON.stringify(choice)).toBe(
                'tool_choice',
            );
        }
        expect(
            refused(
                base({
                    tools: [tool],
                    tool_choice: { type: 'auto', disable_parallel_tool_use: 'yes' },
                }),
            ).param,
        ).toBe('tool_choice.disable_parallel_tool_use');
    });

    it('checks the other known fields', () => {
        const cases: [Record<string, unknown>, string][] = [
            [{ temperature: 1.5 }, 'temperature'],
            [{ top_p: 2 }, 'top_p'],
            [{ top_k: 1.5 }, 'top_k'],
            [{ top_k: 1001 }, 'top_k'],
            [{ stop_sequences: 'END' }, 'stop_sequences'],
            [{ stop_sequences: Array(9).fill('x') }, 'stop_sequences'],
            [{ stop_sequences: ['x'.repeat(201)] }, 'stop_sequences'],
            [{ stream: 'yes' }, 'stream'],
            [{ system: 3 }, 'system'],
            [{ system: [{ type: 'text' }] }, 'system[0].text'],
            [{ thinking: 'on' }, 'thinking'],
            [{ thinking: { type: 'enabled' } }, 'thinking.budget_tokens'],
            [{ thinking: { type: 'enabled', budget_tokens: 0 } }, 'thinking.budget_tokens'],
            [{ thinking: { type: 'auto' } }, 'thinking.type'],
            [{ output_config: { effort: 'extreme' } }, 'output_config.effort'],
            [{ output_config: 'high' }, 'output_config'],
        ];
        for (const [extra, param] of cases) {
            expect(refused(base(extra)).param, JSON.stringify(extra)).toBe(param);
        }
    });
});

describe('what passes', () => {
    it('never forwards what identifies the person', () => {
        const result = ok(
            base({
                metadata: { user_id: 'user_hash_of_person' },
                service_tier: 'auto',
                context_management: { edits: [] },
                inference_geo: 'us',
                speculative: true,
            }),
        );
        expect(result.body).toEqual({
            messages: [{ role: 'user', content: 'hi' }],
            stream: false,
        });
        expect(result.requestedCompletion).toBe(1024);
        expect(result.dropped.sort()).toEqual(
            ['metadata', 'service_tier', 'context_management', 'inference_geo', 'speculative'].sort(),
        );
        expect(JSON.stringify(result.body)).not.toContain('user_hash_of_person');
    });

    it('copies a Claude Code-shaped conversation, dropping unknown nested fields by name', () => {
        const result = ok(
            {
                model: 'claude-like',
                max_tokens: 32000,
                stream: true,
                system: [
                    {
                        type: 'text',
                        text: 'You are a coding agent.',
                        cache_control: { type: 'ephemeral', ttl: '1h' },
                    },
                    {
                        type: 'text',
                        text: 'Rules.',
                        cache_control: { type: 'persistent' },
                    },
                ],
                messages: [
                    user([
                        { type: 'text', text: 'fix it', citations: [] },
                        {
                            type: 'image',
                            source: pngSource,
                            cache_control: { type: 'ephemeral' },
                        },
                    ]),
                    assistant([
                        { type: 'thinking', thinking: 'plan', signature: 'sig' },
                        { type: 'redacted_thinking', data: 'opaque' },
                        { type: 'text', text: 'Reading.' },
                        {
                            type: 'tool_use',
                            id: 'toolu_01',
                            name: 'mcp__fs.read',
                            input: { path: 'a.ts' },
                            caller: { type: 'direct' },
                        },
                    ]),
                    user([
                        {
                            type: 'tool_result',
                            tool_use_id: 'toolu_01',
                            content: [
                                { type: 'text', text: 'file' },
                                { type: 'image', source: pngSource },
                            ],
                            is_error: false,
                            cache_control: { type: 'ephemeral', ttl: '5m', scope: 'x' },
                        },
                    ]),
                ],
                tools: [
                    {
                        name: 'mcp__fs.read',
                        description: 'Reads a file',
                        input_schema: {
                            type: 'object',
                            properties: { path: { $ref: '#/$defs/path' } },
                            $defs: { path: { type: 'string' } },
                        },
                        cache_control: { type: 'ephemeral' },
                        allowed_callers: ['code_execution_20250825'],
                        defer_loading: true,
                    },
                    { type: 'custom', name: 'note', input_schema: { type: 'object' } },
                ],
                tool_choice: { type: 'auto', disable_parallel_tool_use: true },
                temperature: 1,
                top_p: 0.9,
                top_k: 40,
                stop_sequences: ['END'],
                thinking: { type: 'enabled', budget_tokens: 16000 },
                output_config: { effort: 'high', format: { type: 'json_schema' } },
                metadata: { user_id: 'x' },
            },
            IMAGES,
        );
        expect(result.stream).toBe(true);
        expect(result.requestedCompletion).toBe(32000);
        expect(result.body.model).toBeUndefined();
        expect(result.body.max_tokens).toBeUndefined();
        expect(result.body).toEqual({
            system: [
                {
                    type: 'text',
                    text: 'You are a coding agent.',
                    cache_control: { type: 'ephemeral', ttl: '1h' },
                },
                { type: 'text', text: 'Rules.' },
            ],
            messages: [
                user([
                    { type: 'text', text: 'fix it' },
                    {
                        type: 'image',
                        source: pngSource,
                        cache_control: { type: 'ephemeral' },
                    },
                ]),
                assistant([
                    { type: 'thinking', thinking: 'plan', signature: 'sig' },
                    { type: 'redacted_thinking', data: 'opaque' },
                    { type: 'text', text: 'Reading.' },
                    {
                        type: 'tool_use',
                        id: 'toolu_01',
                        name: 'mcp__fs.read',
                        input: { path: 'a.ts' },
                    },
                ]),
                user([
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_01',
                        content: [
                            { type: 'text', text: 'file' },
                            { type: 'image', source: pngSource },
                        ],
                        is_error: false,
                    },
                ]),
            ],
            tools: [
                {
                    name: 'mcp__fs.read',
                    description: 'Reads a file',
                    input_schema: {
                        type: 'object',
                        properties: { path: { $ref: '#/$defs/path' } },
                        $defs: { path: { type: 'string' } },
                    },
                    cache_control: { type: 'ephemeral' },
                },
                { type: 'custom', name: 'note', input_schema: { type: 'object' } },
            ],
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
            temperature: 1,
            top_p: 0.9,
            top_k: 40,
            stop_sequences: ['END'],
            thinking: { type: 'enabled', budget_tokens: 16000 },
            output_config: { effort: 'high' },
            stream: true,
        });
        expect(result.dropped.sort()).toEqual(
            [
                'system[].cache_control',
                'messages[].content[].citations',
                'messages[].content[].caller',
                'messages[].content[].cache_control',
                'tools[].allowed_callers',
                'tools[].defer_loading',
                'output_config.format',
                'metadata',
            ].sort(),
        );
        // Two images at 1000 tokens each, their bytes not counted.
        expect(result.promptTokens).toBeGreaterThan(2000);
        expect(result.promptTokens).toBeLessThan(2400);
    });

    it('takes the other tool choices and thinking modes', () => {
        for (const [choice, expected] of [
            [{ type: 'none' }, { type: 'none' }],
            [{ type: 'any', name: 'x' }, { type: 'any' }],
            [
                { type: 'tool', name: 'read' },
                { type: 'tool', name: 'read' },
            ],
        ] as const) {
            expect(ok(base({ tools: [tool], tool_choice: choice })).body.tool_choice).toEqual(expected);
        }
        expect(ok(base({ tool_choice: { type: 'none' } })).body.tool_choice).toEqual({
            type: 'none',
        });
        for (const type of ['disabled', 'adaptive']) {
            expect(ok(base({ thinking: { type, budget_tokens: 5 } })).body.thinking).toEqual({
                type,
            });
        }
        expect(ok(base({ output_config: { format: {} } })).body.output_config).toBeUndefined();
    });

    it('estimates the prompt from system, messages and tools', () => {
        const result = ok(
            base({
                system: 'y'.repeat(4000),
                messages: [user('x'.repeat(4000))],
                tools: [tool],
            }),
        );
        const chars = JSON.stringify([user('x'.repeat(4000))]).length + 4002 + JSON.stringify([tool]).length;
        expect(result.promptTokens).toBe(Math.ceil(chars / 4));
    });
});

describe('anthropic betas', () => {
    it('drops betas that turn on provider-side tools or stored files', () => {
        expect(anthropicBetas(undefined)).toBeUndefined();
        expect(anthropicBetas(null)).toBeUndefined();
        expect(anthropicBetas('')).toBeUndefined();
        expect(
            anthropicBetas(
                [
                    'mcp-client-2025-04-04',
                    'code-execution-2025-08-25',
                    'web-search-2025-03-05',
                    'web-fetch-2025-09-10',
                    'files-api-2025-04-14',
                    'skills-2025-10-02',
                    'computer-use-2025-01-24',
                    'container-2025-01-01',
                    'Has-Caps',
                    'has space',
                    'x'.repeat(65),
                    'semi;colon',
                ].join(','),
            ),
        ).toBeUndefined();
        expect(
            anthropicBetas(
                ' interleaved-thinking-2025-05-14 , mcp-client-2025-11-20,context-1m-2025-08-07,,fine-grained-tool-streaming-2025-05-14',
            ),
        ).toBe('interleaved-thinking-2025-05-14,context-1m-2025-08-07,fine-grained-tool-streaming-2025-05-14');
        const many = Array.from({ length: 20 }, (_, n) => `beta-${n}`).join(',');
        expect(anthropicBetas(many)?.split(',')).toHaveLength(16);
    });
});

describe('messages stream meter', () => {
    const sse = (events: Record<string, unknown>[]) =>
        events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');

    const STREAM = sse([
        {
            type: 'message_start',
            message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [],
                usage: {
                    input_tokens: 20,
                    cache_creation_input_tokens: 100,
                    cache_read_input_tokens: 2000,
                    output_tokens: 1,
                },
            },
        },
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Plan.' },
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sigsigsig' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'ping' },
        {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'Héllo ' },
        },
        {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'world' },
        },
        {
            type: 'content_block_start',
            index: 2,
            content_block: {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'read',
                input: {},
            },
        },
        {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"path":' },
        },
        {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '"a.ts"}' },
        },
        {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 57 },
        },
        { type: 'message_stop' },
    ]);
    const OUTPUT = 'Plan.Héllo world{"path":"a.ts"}'.length;

    it('counts deltas and reads usage at any chunk boundary', () => {
        for (const size of [1, 2, 5, 13, 100, STREAM.length]) {
            const meter = new MessagesStreamMeter();
            for (let at = 0; at < STREAM.length; at += size) {
                meter.push(STREAM.slice(at, at + size));
            }
            expect(meter.outputChars, String(size)).toBe(OUTPUT);
            expect(meter.usage).toEqual({
                promptTokens: 2120,
                completionTokens: 57,
                cachedTokens: 2000,
            });
            expect(meter.done).toBe(true);
            expect(meter.outputTokens).toBe(Math.ceil(OUTPUT / 4));
        }
    });

    it('has no usage until a message_delta with output follows message_start', () => {
        const meter = new MessagesStreamMeter();
        // A delta before any start is ignored.
        meter.push(sse([{ type: 'message_delta', usage: { output_tokens: 9 } }]));
        expect(meter.usage).toBeUndefined();
        meter.push(
            sse([
                {
                    type: 'message_start',
                    message: { usage: { input_tokens: 10, output_tokens: 1 } },
                },
            ]),
        );
        expect(meter.usage).toBeUndefined();
        meter.push(sse([{ type: 'message_delta', delta: {}, usage: {} }]));
        expect(meter.usage).toBeUndefined();
        // Later counts (input and cache too) replace the start's.
        meter.push(
            sse([
                {
                    type: 'message_delta',
                    usage: {
                        output_tokens: 30,
                        input_tokens: 12,
                        cache_read_input_tokens: 4,
                    },
                },
            ]),
        );
        expect(meter.usage).toEqual({
            promptTokens: 16,
            completionTokens: 30,
            cachedTokens: 4,
        });
        meter.push('data: {"type":"message_delta","usage":{"output_tokens":99');
        expect(meter.usage?.completionTokens).toBe(30);
        meter.push('}}\r\n\r\n');
        expect(meter.usage?.completionTokens).toBe(99);
    });

    it('ignores junk and discards a pending line past 8 MB', () => {
        const meter = new MessagesStreamMeter();
        meter.push('data: not json\n: comment\nevent: x\ndata: [1,2]\n\n');
        meter.push('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"');
        meter.push('x'.repeat(8 * 1024 * 1024));
        meter.push('"}}\n');
        expect(meter.outputChars).toBe(0);
        meter.push(
            sse([
                {
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: 'ok' },
                },
            ]),
        );
        expect(meter.outputChars).toBe(2);
    });

    it('reads a non-streamed answer', () => {
        const body = {
            id: 'msg_1',
            type: 'message',
            content: [
                { type: 'thinking', thinking: 'abcd', signature: 'long-signature' },
                { type: 'redacted_thinking', data: 'zzzzzz' },
                { type: 'text', text: 'hello' },
                { type: 'tool_use', id: 'toolu_1', name: 'read', input: { a: 1 } },
            ],
            usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 40,
            },
        };
        expect(messagesAnswerChars(body)).toBe(4 + 5 + '{"a":1}'.length);
        expect(messagesUsageOf(body)).toEqual({
            promptTokens: 80,
            completionTokens: 20,
            cachedTokens: 30,
        });
        expect(messagesUsageOf({ usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({
            promptTokens: 1,
            completionTokens: 2,
            cachedTokens: 0,
        });
        for (const value of [
            null,
            {},
            { usage: { input_tokens: 1 } },
            { usage: { prompt_tokens: 1, completion_tokens: 2 } },
            { usage: { input_tokens: 'x', output_tokens: 2 } },
        ]) {
            expect(messagesUsageOf(value), JSON.stringify(value)).toBeUndefined();
        }
        expect(messagesAnswerChars(null)).toBe(0);
        expect(messagesAnswerChars({ content: 'x' })).toBe(0);
    });
});
