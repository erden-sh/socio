/**
 * What of an Anthropic Messages request may reach a backend (CB-239),
 * as chat-request.ts does for Chat Completions. Known fields are copied
 * and checked as well as named; everything else is dropped, its name
 * (never its value) kept for the session's diagnostics. Nothing
 * identifying the person goes upstream: `metadata` (its `user_id`) is
 * always dropped.
 *
 * Only custom tools, run by the client, pass. Server tools (web search,
 * web fetch, code execution, bash, text editor, computer use, memory, tool
 * search, MCP toolsets, MCP servers, containers) would fetch or run outside
 * the sandbox for the agent, so requests that carry them, or carry their
 * results, are refused, never forwarded; so are the betas that turn them
 * on. An image must carry its bytes (`base64`), never a URL or a file id.
 */

import {
    CHARS_PER_TOKEN,
    FIELD_NAME,
    IMAGE_CHARS,
    Refused,
    type SanitizedChat,
    checkSchema,
    isRecord,
} from './chat-request.js';

export interface MessagesRequestShape {
    /** The model takes image blocks (Settings → Coding → Models). */
    acceptsImages: boolean;
}

/** As for Chat Completions: the body has no `model` and no `max_tokens`. */
export type SanitizedMessages = SanitizedChat;

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_MESSAGES = 5000;
const MAX_TOOLS = 256;
/** Fields that would have the provider fetch or run things for the agent. */
const PROVIDER_SIDE = ['mcp_servers', 'container'];
/** Beta names that turn on provider-side tools or stored files. */
const REFUSED_BETAS = [
    'mcp',
    'code-execution',
    'web-search',
    'web-fetch',
    'files-api',
    'skills',
    'computer-use',
    'container',
];
const BETA = /^[a-z0-9-]{1,64}$/;
const MAX_BETAS = 16;

function fail(param: string, message: string, code = 'invalid_value'): never {
    throw new Refused(code, message, param);
}

function unsupported(param: string, message: string): never {
    throw new Refused('unsupported_content', message, param);
}

function text(value: unknown, param: string): string {
    if (typeof value !== 'string') {
        fail(param, `${param} must be text.`);
    }
    return value;
}

/**
 * The `anthropic-beta` header as it may go upstream: well-formed names
 * only, none that turns on a provider-side tool or stored files, at most
 * 16; `undefined` when none remain.
 */
export function anthropicBetas(header: string | null | undefined): string | undefined {
    if (!header) {
        return undefined;
    }
    const kept = header
        .split(',')
        .map((name) => name.trim())
        .filter((name) => BETA.test(name) && !REFUSED_BETAS.some((part) => name.includes(part)))
        .slice(0, MAX_BETAS);
    return kept.length ? kept.join(',') : undefined;
}

/**
 * The request as it may go upstream, or why it can't. `body` is the
 * client's parsed JSON; it is never forwarded as is.
 */
export function sanitizeMessagesRequest(body: unknown, shape: MessagesRequestShape): SanitizedMessages {
    const dropped = new Set<string>();
    const drop = (name: string) => dropped.add(FIELD_NAME.test(name) ? name : 'other');
    /** Drops (and names) the keys of `record` outside `allowed`. */
    const only = (record: Record<string, unknown>, allowed: readonly string[], path: string) => {
        for (const key of Object.keys(record)) {
            if (!allowed.includes(key)) {
                drop(`${path}.${key}`);
            }
        }
    };
    /** Copies a block's `cache_control` when it is one Anthropic caches by. */
    const cacheControl = (block: Record<string, unknown>, next: Record<string, unknown>, path: string) => {
        const value = block.cache_control;
        if (value === undefined || value === null) {
            return next;
        }
        if (
            isRecord(value) &&
            value.type === 'ephemeral' &&
            (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h') &&
            Object.keys(value).every((key) => key === 'type' || key === 'ttl')
        ) {
            next.cache_control = {
                type: 'ephemeral',
                ...(value.ttl !== undefined ? { ttl: value.ttl } : {}),
            };
        } else {
            drop(`${path}.cache_control`);
        }
        return next;
    };
    let imageCount = 0;
    try {
        if (!isRecord(body)) {
            throw new Refused('invalid_request', 'The body must be a JSON object.');
        }
        for (const key of PROVIDER_SIDE) {
            if (body[key] !== undefined && body[key] !== null) {
                throw new Refused(
                    'unsupported_parameter',
                    `${key} would have the provider fetch or run things outside the sandbox; the gateway doesn’t forward it.`,
                    key,
                );
            }
        }
        const out: Record<string, unknown> = {};
        const KNOWN = new Set([
            'model',
            'messages',
            'system',
            'max_tokens',
            'tools',
            'tool_choice',
            'stream',
            'temperature',
            'top_p',
            'top_k',
            'stop_sequences',
            'thinking',
            'output_config',
        ]);
        // `metadata`, `service_tier`, `context_management`, `inference_geo`
        // and anything else land here.
        for (const key of Object.keys(body)) {
            if (!KNOWN.has(key)) {
                drop(key);
            }
        }

        // Blocks, by where they stand: `kinds` are the types that may.
        const image = (block: Record<string, unknown>, at: string, path: string) => {
            if (!shape.acceptsImages) {
                unsupported(at, 'This model doesn’t take images.');
            }
            const source = block.source;
            if (!isRecord(source) || source.type !== 'base64') {
                unsupported(
                    `${at}.source`,
                    'Images must be inline base64 data; the gateway doesn’t let a provider fetch URLs or files.',
                );
            }
            if (!MEDIA_TYPES.includes(source.media_type as string)) {
                unsupported(`${at}.source.media_type`, 'Images may be PNG, JPEG, GIF or WebP.');
            }
            if (typeof source.data !== 'string' || !BASE64.test(source.data)) {
                fail(`${at}.source.data`, 'An image’s data must be base64.');
            }
            only(block, ['type', 'source', 'cache_control'], path);
            only(source, ['type', 'media_type', 'data'], `${path}.source`);
            imageCount++;
            return cacheControl(
                block,
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: source.media_type,
                        data: source.data,
                    },
                },
                path,
            );
        };
        const textBlock = (block: Record<string, unknown>, at: string, path: string) => {
            only(block, ['type', 'text', 'cache_control'], path);
            return cacheControl(block, { type: 'text', text: text(block.text, `${at}.text`) }, path);
        };
        const blocks = (value: unknown, param: string, kinds: readonly string[]): Record<string, unknown>[] => {
            if (!Array.isArray(value)) {
                fail(param, `${param} must be text or a list of blocks.`);
            }
            const path = `${param.replace(/\[\d+\]/g, '[]')}[]`;
            return value.map((raw, index) => {
                const at = `${param}[${index}]`;
                if (!isRecord(raw)) {
                    fail(at, `${at} must be an object.`);
                }
                const type = raw.type;
                if (typeof type !== 'string' || !kinds.includes(type)) {
                    unsupported(at, `${at} has a block type the gateway doesn’t forward here.`);
                }
                switch (type) {
                    case 'text':
                        return textBlock(raw, at, path);
                    case 'image':
                        return image(raw, at, path);
                    case 'tool_use': {
                        only(raw, ['type', 'id', 'name', 'input', 'cache_control'], path);
                        if (typeof raw.id !== 'string' || !TOOL_USE_ID.test(raw.id)) {
                            fail(`${at}.id`, `${at} needs a tool use id.`);
                        }
                        if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) {
                            fail(`${at}.name`, `${at} needs a tool name.`);
                        }
                        if (!isRecord(raw.input)) {
                            fail(`${at}.input`, `${at}.input must be an object.`);
                        }
                        return cacheControl(raw, { type, id: raw.id, name: raw.name, input: raw.input }, path);
                    }
                    case 'tool_result': {
                        only(raw, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], path);
                        const id = raw.tool_use_id;
                        if (typeof id !== 'string' || !TOOL_USE_ID.test(id)) {
                            fail(`${at}.tool_use_id`, `${at} needs a tool use id.`);
                        }
                        const next: Record<string, unknown> = { type, tool_use_id: id };
                        if (raw.content !== undefined && raw.content !== null) {
                            next.content =
                                typeof raw.content === 'string'
                                    ? raw.content
                                    : blocks(raw.content, `${at}.content`, ['text', 'image']);
                        }
                        if (raw.is_error !== undefined) {
                            if (typeof raw.is_error !== 'boolean') {
                                fail(`${at}.is_error`, 'is_error must be true or false.');
                            }
                            next.is_error = raw.is_error;
                        }
                        return cacheControl(raw, next, path);
                    }
                    case 'thinking':
                        only(raw, ['type', 'thinking', 'signature'], path);
                        return {
                            type,
                            thinking: text(raw.thinking, `${at}.thinking`),
                            signature: text(raw.signature, `${at}.signature`),
                        };
                    default:
                        only(raw, ['type', 'data'], path);
                        return { type, data: text(raw.data, `${at}.data`) };
                }
            });
        };
        const KINDS_BY_ROLE: Record<string, readonly string[]> = {
            user: ['text', 'image', 'tool_result'],
            assistant: ['text', 'tool_use', 'thinking', 'redacted_thinking'],
        };

        // Messages: user and assistant turns of plain blocks.
        const messages = body.messages;
        if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) {
            fail('messages', `messages must be a list of 1 to ${MAX_MESSAGES} messages.`);
        }
        out.messages = messages.map((raw, index) => {
            const at = `messages[${index}]`;
            if (!isRecord(raw)) {
                fail(at, `${at} must be an object.`);
            }
            const role = raw.role;
            if (role !== 'user' && role !== 'assistant') {
                fail(`${at}.role`, `${at}.role may be user or assistant.`);
            }
            only(raw, ['role', 'content'], 'messages[]');
            return {
                role,
                content:
                    typeof raw.content === 'string'
                        ? raw.content
                        : blocks(raw.content, `${at}.content`, KINDS_BY_ROLE[role]),
            };
        });
        if (body.system !== undefined && body.system !== null) {
            out.system = typeof body.system === 'string' ? body.system : blocks(body.system, 'system', ['text']);
        }

        // Tools: custom tools the client runs, nothing else.
        const toolNames = new Set<string>();
        if (body.tools !== undefined) {
            if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) {
                fail('tools', `tools must be a list of at most ${MAX_TOOLS} tools.`);
            }
            out.tools = (body.tools as unknown[]).map((tool, index) => {
                const at = `tools[${index}]`;
                if (!isRecord(tool) || (tool.type !== undefined && tool.type !== null && tool.type !== 'custom')) {
                    throw new Refused(
                        'unsupported_tool',
                        'Only custom tools are forwarded; server tools (web search, web fetch, code execution, bash, text editor, computer use, memory, MCP…) are not.',
                        at,
                    );
                }
                only(tool, ['type', 'name', 'description', 'input_schema', 'cache_control'], 'tools[]');
                const { name, description, input_schema: schema } = tool;
                if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
                    fail(`${at}.name`, `${at} needs a tool name.`);
                }
                if (description !== undefined && typeof description !== 'string') {
                    fail(`${at}.description`, 'A description must be text.');
                }
                if (!isRecord(schema)) {
                    fail(`${at}.input_schema`, 'A tool’s input_schema must be a JSON schema object.');
                }
                checkSchema(schema, `${at}.input_schema`);
                toolNames.add(name);
                return cacheControl(
                    tool,
                    {
                        ...(tool.type === 'custom' ? { type: 'custom' } : {}),
                        name,
                        ...(description !== undefined ? { description } : {}),
                        input_schema: schema,
                    },
                    'tools[]',
                );
            });
        }
        if (body.tool_choice !== undefined) {
            const choice = body.tool_choice;
            if (!isRecord(choice)) {
                fail('tool_choice', 'tool_choice must be an object.');
            }
            const { type, name, disable_parallel_tool_use: serial } = choice;
            if (serial !== undefined && typeof serial !== 'boolean') {
                fail('tool_choice.disable_parallel_tool_use', 'disable_parallel_tool_use must be true or false.');
            }
            const ok =
                type === 'none' ||
                ((type === 'auto' || type === 'any') && toolNames.size > 0) ||
                (type === 'tool' && typeof name === 'string' && toolNames.has(name));
            if (!ok) {
                fail('tool_choice', 'tool_choice may be auto, any or none, or name one of the request’s tools.');
            }
            only(
                choice,
                type === 'tool' ? ['type', 'name', 'disable_parallel_tool_use'] : ['type', 'disable_parallel_tool_use'],
                'tool_choice',
            );
            out.tool_choice = {
                type,
                ...(type === 'tool' ? { name } : {}),
                ...(serial !== undefined ? { disable_parallel_tool_use: serial } : {}),
            };
        }

        // Sampling and limits, checked as numbers in range.
        const number = (key: string, min: number, max: number, integer = false) => {
            const value = body[key];
            if (value === undefined) {
                return;
            }
            if (
                typeof value !== 'number' ||
                !Number.isFinite(value) ||
                value < min ||
                value > max ||
                (integer && !Number.isInteger(value))
            ) {
                fail(key, `${key} must be a number from ${min} to ${max}.`);
            }
            out[key] = value;
        };
        number('temperature', 0, 1);
        number('top_p', 0, 1);
        number('top_k', 0, 1000, true);
        if (body.stop_sequences !== undefined) {
            const stop = body.stop_sequences;
            if (
                !Array.isArray(stop) ||
                stop.length > 8 ||
                !stop.every((item) => typeof item === 'string' && item.length <= 200)
            ) {
                fail('stop_sequences', 'stop_sequences must be up to 8 strings.');
            }
            out.stop_sequences = stop;
        }
        const max = body.max_tokens;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
            fail('max_tokens', 'max_tokens must be a whole number of at least 1.');
        }
        const requestedCompletion = max;
        if (body.thinking !== undefined && body.thinking !== null) {
            const thinking = body.thinking;
            if (!isRecord(thinking)) {
                fail('thinking', 'thinking must be an object.');
            }
            if (thinking.type === 'enabled') {
                const budget = thinking.budget_tokens;
                if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1) {
                    fail('thinking.budget_tokens', 'budget_tokens must be a whole number of at least 1.');
                }
                only(thinking, ['type', 'budget_tokens'], 'thinking');
                out.thinking = { type: 'enabled', budget_tokens: budget };
            } else if (thinking.type === 'disabled' || thinking.type === 'adaptive') {
                only(thinking, ['type'], 'thinking');
                out.thinking = { type: thinking.type };
            } else {
                fail('thinking.type', 'thinking may be enabled, disabled or adaptive.');
            }
        }
        if (body.output_config !== undefined && body.output_config !== null) {
            const config = body.output_config;
            if (!isRecord(config)) {
                fail('output_config', 'output_config must be an object.');
            }
            only(config, ['effort'], 'output_config');
            if (config.effort !== undefined && config.effort !== null) {
                if (!EFFORTS.includes(config.effort as string)) {
                    fail('output_config.effort', 'effort is not a known level.');
                }
                out.output_config = { effort: config.effort };
            }
        }
        let stream = false;
        if (body.stream !== undefined) {
            if (typeof body.stream !== 'boolean') {
                fail('stream', 'stream must be true or false.');
            }
            stream = body.stream;
        }
        out.stream = stream;

        // Image bytes count as a flat amount each, not as their base64.
        const blank = function (this: unknown, key: string, value: unknown) {
            return key === 'data' && isRecord(this) && this.type === 'base64' ? '' : value;
        };
        const chars =
            JSON.stringify(out.messages, blank).length +
            (out.system !== undefined ? JSON.stringify(out.system).length : 0) +
            (out.tools ? JSON.stringify(out.tools).length : 0) +
            imageCount * IMAGE_CHARS;
        return {
            ok: true,
            body: out,
            stream,
            requestedCompletion,
            promptTokens: Math.ceil(chars / CHARS_PER_TOKEN),
            dropped: [...dropped],
        };
    } catch (error) {
        if (error instanceof Refused) {
            return {
                ok: false,
                code: error.code,
                message: error.message,
                ...(error.param ? { param: error.param } : {}),
            };
        }
        throw error;
    }
}
