/**
 * What of an OpenAI Responses request may reach a backend (CB-239),
 * as chat-request.ts does for Chat Completions. Known fields are copied
 * and checked as well as named; everything else is dropped, its name
 * (never its value) kept for the session's diagnostics. Nothing
 * identifying the person goes upstream: `user`, `metadata` and
 * `safety_identifier` are always dropped, and `store` is always false.
 *
 * Nothing is kept at the provider, so what relies on state stored there
 * (`previous_response_id`, `conversation`, stored `prompt` templates,
 * `background`, `item_reference` items) is refused: the client sends its
 * items whole. Only function and custom tools, run by the client, pass.
 * Provider-side tools (web search, file search, code execution, MCP,
 * shell, computer use) would fetch from outside the sandbox for the agent,
 * so requests that carry them, or carry their calls, are refused, never
 * forwarded. An image must carry its bytes (`data:` URL), never a link or
 * a provider file id.
 */

import {
    CHARS_PER_TOKEN,
    FIELD_NAME,
    IMAGE_CHARS,
    IMAGE_DATA,
    Refused,
    type SanitizedChat,
    checkSchema,
    isRecord,
} from './chat-request.js';

export interface ResponsesRequestShape {
    /** The model takes image parts (Settings → Coding → Models). */
    acceptsImages: boolean;
    /**
     * A person's own ChatGPT plan through the Codex backend, which takes
     * only the Codex CLI's request shape: streamed, without sampling knobs.
     */
    personalPlan: boolean;
}

/** As for Chat Completions: the body has no `model` and no `max_output_tokens`. */
export type SanitizedResponses = SanitizedChat;

const ROLES = ['user', 'assistant', 'system', 'developer'];
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_ID = /^[A-Za-z0-9_-]{1,200}$/;
const CACHE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SUMMARIES = ['auto', 'concise', 'detailed', 'none'];
const VERBOSITIES = ['low', 'medium', 'high'];
const DETAILS = ['auto', 'low', 'high'];
/** What of `include` may pass: reasoning carried by the client, not stored. */
const INCLUDES = ['reasoning.encrypted_content'];
const MAX_ITEMS = 5000;
const MAX_TOOLS = 256;
const MAX_CALL_ID = 200;
/** The most a reasoning item's `encrypted_content` may hold, in characters. */
export const MAX_ENCRYPTED_CHARS = 2 * 1024 * 1024;
/** The most a custom tool's grammar may hold. */
export const MAX_GRAMMAR_BYTES = 64 * 1024;
/** Fields that point at state stored at the provider. */
const STORED_STATE = ['previous_response_id', 'conversation', 'prompt'];

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

function callId(value: unknown, param: string): string {
    if (typeof value !== 'string' || !value || value.length > MAX_CALL_ID) {
        fail(param, `${param} must be text of 1 to ${MAX_CALL_ID} characters.`);
    }
    return value;
}

/**
 * The request as it may go upstream, or why it can't. `body` is the
 * client's parsed JSON; it is never forwarded as is.
 */
export function sanitizeResponsesRequest(body: unknown, shape: ResponsesRequestShape): SanitizedResponses {
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
    let imageCount = 0;
    try {
        if (!isRecord(body)) {
            throw new Refused('invalid_request', 'The body must be a JSON object.');
        }
        for (const key of STORED_STATE) {
            if (body[key] !== undefined && body[key] !== null) {
                throw new Refused(
                    'unsupported_parameter',
                    `${key} relies on state stored at the provider; the gateway stores nothing there, so send the whole input.`,
                    key,
                );
            }
        }
        if (body.background === true) {
            throw new Refused(
                'unsupported_parameter',
                'Background responses are stored at the provider; the gateway doesn’t forward them.',
                'background',
            );
        }
        const out: Record<string, unknown> = {};
        const KNOWN = new Set([
            'model',
            'input',
            'instructions',
            'tools',
            'tool_choice',
            'parallel_tool_calls',
            'stream',
            'temperature',
            'top_p',
            'max_output_tokens',
            'reasoning',
            'text',
            'include',
            'store',
            'truncation',
            'prompt_cache_key',
            'max_tool_calls',
        ]);
        for (const key of Object.keys(body)) {
            if (!KNOWN.has(key)) {
                drop(key);
            }
        }

        // Content parts, by where they stand: `kinds` are the types that may.
        const image = (part: Record<string, unknown>, at: string) => {
            if (!shape.acceptsImages) {
                unsupported(at, 'This model doesn’t take images.');
            }
            if (part.file_id !== undefined || typeof part.image_url !== 'string') {
                unsupported(
                    at,
                    'Images must be inline data (data:image/…;base64,…); provider file ids are not forwarded.',
                );
            }
            const url = part.image_url as string;
            if (!IMAGE_DATA.test(url)) {
                unsupported(
                    at,
                    'Images must be inline data (data:image/…;base64,…); the gateway doesn’t let a provider fetch links.',
                );
            }
            const next: Record<string, unknown> = {
                type: 'input_image',
                image_url: url,
            };
            if (part.detail !== undefined) {
                if (DETAILS.includes(part.detail as string)) {
                    next.detail = part.detail;
                } else {
                    drop(`${at.replace(/\[\d+\]/g, '[]')}.detail`);
                }
            }
            imageCount++;
            return next;
        };
        const parts = (value: unknown, param: string, kinds: readonly string[]): Record<string, unknown>[] => {
            if (!Array.isArray(value)) {
                fail(param, `${param} must be text or a list of parts.`);
            }
            const path = `${param.replace(/\[\d+\]/g, '[]')}[]`;
            return value.map((raw, index) => {
                const at = `${param}[${index}]`;
                if (!isRecord(raw)) {
                    fail(at, `${at} must be an object.`);
                }
                const type = raw.type;
                if (type === 'input_image' && !kinds.includes('input_image')) {
                    unsupported(at, 'Images may be only in user messages and tool output.');
                }
                if (typeof type !== 'string' || !kinds.includes(type)) {
                    unsupported(at, `${at} has a content type the gateway doesn’t forward here.`);
                }
                switch (type) {
                    case 'input_text':
                    case 'output_text':
                        only(raw, ['type', 'text'], path);
                        return { type, text: text(raw.text, `${at}.text`) };
                    case 'refusal':
                        only(raw, ['type', 'refusal'], path);
                        return { type, refusal: text(raw.refusal, `${at}.refusal`) };
                    default:
                        only(raw, ['type', 'image_url', 'detail', 'file_id'], path);
                        return image(raw, at);
                }
            });
        };
        const KINDS_BY_ROLE: Record<string, readonly string[]> = {
            user: ['input_text', 'input_image'],
            system: ['input_text'],
            developer: ['input_text'],
            assistant: ['input_text', 'output_text', 'refusal'],
        };

        // Input items: messages, client tool calls and their output, reasoning.
        const item = (raw: unknown, index: number) => {
            const at = `input[${index}]`;
            if (!isRecord(raw)) {
                fail(at, `${at} must be an object.`);
            }
            const type = raw.type ?? (raw.role !== undefined ? 'message' : undefined);
            const next: Record<string, unknown> = { type };
            const keepId = () => {
                if (raw.id === undefined) {
                    return;
                }
                if (typeof raw.id === 'string' && ITEM_ID.test(raw.id)) {
                    next.id = raw.id;
                } else {
                    drop('input[].id');
                }
            };
            switch (type) {
                case 'message': {
                    if (!ROLES.includes(raw.role as string)) {
                        fail(`${at}.role`, `${at}.role is not a Responses message role.`);
                    }
                    only(raw, ['type', 'role', 'content'], 'input[]');
                    next.role = raw.role;
                    next.content =
                        typeof raw.content === 'string'
                            ? raw.content
                            : parts(raw.content, `${at}.content`, KINDS_BY_ROLE[raw.role as string]);
                    return next;
                }
                case 'function_call':
                case 'custom_tool_call': {
                    const custom = type === 'custom_tool_call';
                    const payload = custom ? 'input' : 'arguments';
                    only(raw, ['type', 'id', 'call_id', 'name', payload], 'input[]');
                    keepId();
                    next.call_id = callId(raw.call_id, `${at}.call_id`);
                    if (typeof raw.name !== 'string' || !TOOL_NAME.test(raw.name)) {
                        fail(`${at}.name`, `${at} needs a tool name.`);
                    }
                    next.name = raw.name;
                    next[payload] = text(raw[payload], `${at}.${payload}`);
                    return next;
                }
                case 'function_call_output':
                case 'custom_tool_call_output': {
                    only(raw, ['type', 'call_id', 'output'], 'input[]');
                    next.call_id = callId(raw.call_id, `${at}.call_id`);
                    next.output =
                        typeof raw.output === 'string'
                            ? raw.output
                            : parts(
                                  raw.output,
                                  `${at}.output`,
                                  type === 'function_call_output' ? ['input_text', 'input_image'] : ['input_text'],
                              );
                    return next;
                }
                case 'reasoning': {
                    only(raw, ['type', 'id', 'summary', 'encrypted_content', 'content'], 'input[]');
                    keepId();
                    const texts = (value: unknown, param: string, kind: string) => {
                        if (!Array.isArray(value)) {
                            fail(param, `${param} must be a list.`);
                        }
                        return value.map((part, n) => {
                            const where = `${param}[${n}]`;
                            if (!isRecord(part) || part.type !== kind) {
                                fail(where, `${where} must be a ${kind} part.`);
                            }
                            only(part, ['type', 'text'], `${param.replace(/\[\d+\]/g, '[]')}[]`);
                            return { type: kind, text: text(part.text, `${where}.text`) };
                        });
                    };
                    next.summary = texts(raw.summary, `${at}.summary`, 'summary_text');
                    if (raw.content !== undefined && raw.content !== null) {
                        next.content = texts(raw.content, `${at}.content`, 'reasoning_text');
                    }
                    if (raw.encrypted_content !== undefined) {
                        const sealed = text(raw.encrypted_content, `${at}.encrypted_content`);
                        if (sealed.length > MAX_ENCRYPTED_CHARS) {
                            fail(
                                `${at}.encrypted_content`,
                                `encrypted_content may hold at most ${MAX_ENCRYPTED_CHARS / 1024 / 1024} MB.`,
                            );
                        }
                        next.encrypted_content = sealed;
                    }
                    return next;
                }
                case 'item_reference':
                    return unsupported(
                        at,
                        'Nothing is stored at the provider, so items can’t be referenced: send them whole.',
                    );
                default:
                    return unsupported(
                        at,
                        `${at} is an item the gateway doesn’t forward: only messages, function and custom tool calls and their output, and reasoning pass.`,
                    );
            }
        };
        const input = body.input;
        if (typeof input === 'string') {
            out.input = input;
        } else if (Array.isArray(input) && input.length >= 1 && input.length <= MAX_ITEMS) {
            out.input = input.map(item);
        } else {
            fail('input', `input must be text or a list of 1 to ${MAX_ITEMS} items.`);
        }
        if (body.instructions !== undefined && body.instructions !== null) {
            out.instructions = text(body.instructions, 'instructions');
        }

        // Tools: functions and custom tools the client runs, nothing else.
        const toolKinds = new Map<string, string>();
        if (body.tools !== undefined) {
            if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) {
                fail('tools', `tools must be a list of at most ${MAX_TOOLS} tools.`);
            }
            out.tools = (body.tools as unknown[]).map((tool, index) => {
                const at = `tools[${index}]`;
                if (!isRecord(tool) || (tool.type !== 'function' && tool.type !== 'custom')) {
                    throw new Refused(
                        'unsupported_tool',
                        'Only function and custom tools are forwarded; provider-side tools (web search, file search, code execution, MCP, shell, computer use…) are not.',
                        at,
                    );
                }
                const { type, name, description } = tool;
                if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
                    fail(`${at}.name`, `${at} needs a tool name.`);
                }
                if (description !== undefined && typeof description !== 'string') {
                    fail(`${at}.description`, 'A description must be text.');
                }
                const next: Record<string, unknown> = {
                    type,
                    name,
                    ...(description !== undefined ? { description } : {}),
                };
                if (type === 'function') {
                    only(tool, ['type', 'name', 'description', 'parameters', 'strict'], 'tools[]');
                    const { parameters, strict } = tool;
                    if (parameters !== undefined && parameters !== null) {
                        if (!isRecord(parameters)) {
                            fail(`${at}.parameters`, 'A tool’s parameters must be a JSON schema object.');
                        }
                        checkSchema(parameters, `${at}.parameters`);
                        next.parameters = parameters;
                    }
                    if (strict !== undefined && strict !== null) {
                        if (typeof strict !== 'boolean') {
                            fail(`${at}.strict`, 'strict must be true or false.');
                        }
                        next.strict = strict;
                    }
                } else {
                    only(tool, ['type', 'name', 'description', 'format'], 'tools[]');
                    const format = tool.format;
                    if (format !== undefined) {
                        if (!isRecord(format)) {
                            fail(`${at}.format`, 'A custom tool’s format must be an object.');
                        }
                        if (format.type === 'text') {
                            only(format, ['type'], 'tools[].format');
                            next.format = { type: 'text' };
                        } else if (format.type === 'grammar') {
                            only(format, ['type', 'syntax', 'definition'], 'tools[].format');
                            if (format.syntax !== 'lark' && format.syntax !== 'regex') {
                                fail(`${at}.format.syntax`, 'syntax may be lark or regex.');
                            }
                            const definition = text(format.definition, `${at}.format.definition`);
                            if (Buffer.byteLength(definition) > MAX_GRAMMAR_BYTES) {
                                fail(
                                    `${at}.format.definition`,
                                    `A grammar may hold at most ${MAX_GRAMMAR_BYTES / 1024} KB.`,
                                );
                            }
                            next.format = {
                                type: 'grammar',
                                syntax: format.syntax,
                                definition,
                            };
                        } else {
                            fail(`${at}.format.type`, 'format may be text or grammar.');
                        }
                    }
                }
                toolKinds.set(name, type);
                return next;
            });
        }
        if (body.tool_choice !== undefined) {
            const choice = body.tool_choice;
            const named = (value: unknown) =>
                isRecord(value) &&
                (value.type === 'function' || value.type === 'custom') &&
                typeof value.name === 'string' &&
                toolKinds.get(value.name) === value.type;
            if (choice === 'none' || choice === 'auto' || choice === 'required') {
                if (!toolKinds.size && choice !== 'none') {
                    fail('tool_choice', 'tool_choice needs tools.');
                }
                out.tool_choice = choice;
            } else if (named(choice)) {
                const { type, name } = choice as Record<string, unknown>;
                out.tool_choice = { type, name };
            } else if (
                isRecord(choice) &&
                choice.type === 'allowed_tools' &&
                (choice.mode === 'auto' || choice.mode === 'required') &&
                Array.isArray(choice.tools) &&
                choice.tools.length >= 1 &&
                choice.tools.length <= MAX_TOOLS &&
                choice.tools.every(named)
            ) {
                out.tool_choice = {
                    type: 'allowed_tools',
                    mode: choice.mode,
                    tools: (choice.tools as Record<string, unknown>[]).map(({ type, name }) => ({ type, name })),
                };
            } else {
                fail(
                    'tool_choice',
                    'tool_choice may be none, auto, required, one of the request’s tools, or allowed_tools naming only them.',
                );
            }
        }
        if (body.parallel_tool_calls !== undefined) {
            if (typeof body.parallel_tool_calls !== 'boolean') {
                fail('parallel_tool_calls', 'parallel_tool_calls must be true or false.');
            }
            out.parallel_tool_calls = body.parallel_tool_calls;
        }

        // Sampling and limits, checked as numbers in range. The Codex backend
        // of a personal plan takes none of these, so they're dropped there.
        const PLAN_DROPS = ['temperature', 'top_p', 'truncation', 'max_tool_calls'];
        if (shape.personalPlan) {
            for (const key of PLAN_DROPS) {
                if (body[key] !== undefined) {
                    drop(key);
                }
            }
        }
        const number = (key: string, min: number, max: number, integer = false) => {
            const value = body[key];
            if (value === undefined || shape.personalPlan) {
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
        number('temperature', 0, 2);
        number('top_p', 0, 1);
        number('max_tool_calls', 1, 1000, true);
        if (body.truncation !== undefined && !shape.personalPlan) {
            if (body.truncation !== 'auto' && body.truncation !== 'disabled') {
                fail('truncation', 'truncation may be auto or disabled.');
            }
            out.truncation = body.truncation;
        }
        let requestedCompletion: number | undefined;
        if (body.max_output_tokens !== undefined) {
            const value = body.max_output_tokens;
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                fail('max_output_tokens', 'max_output_tokens must be a whole number of at least 1.');
            }
            requestedCompletion = value;
        }
        if (body.reasoning !== undefined && body.reasoning !== null) {
            const reasoning = body.reasoning;
            if (!isRecord(reasoning)) {
                fail('reasoning', 'reasoning must be an object.');
            }
            only(reasoning, ['effort', 'summary'], 'reasoning');
            const next: Record<string, unknown> = {};
            if (reasoning.effort !== undefined && reasoning.effort !== null) {
                if (!EFFORTS.includes(reasoning.effort as string)) {
                    fail('reasoning.effort', 'reasoning.effort is not a known level.');
                }
                next.effort = reasoning.effort;
            }
            if (reasoning.summary !== undefined && reasoning.summary !== null) {
                if (!SUMMARIES.includes(reasoning.summary as string)) {
                    fail('reasoning.summary', 'reasoning.summary is not a known kind.');
                }
                next.summary = reasoning.summary;
            }
            if (Object.keys(next).length) {
                out.reasoning = next;
            }
        }
        if (body.text !== undefined && body.text !== null) {
            const spec = body.text;
            if (!isRecord(spec)) {
                fail('text', 'text must be an object.');
            }
            only(spec, ['format', 'verbosity'], 'text');
            const next: Record<string, unknown> = {};
            if (spec.verbosity !== undefined && spec.verbosity !== null) {
                if (!VERBOSITIES.includes(spec.verbosity as string)) {
                    fail('text.verbosity', 'text.verbosity may be low, medium or high.');
                }
                next.verbosity = spec.verbosity;
            }
            const format = spec.format;
            if (format !== undefined && format !== null) {
                if (!isRecord(format)) {
                    fail('text.format', 'text.format must be an object.');
                }
                if (format.type === 'text' || format.type === 'json_object') {
                    only(format, ['type'], 'text.format');
                    next.format = { type: format.type };
                } else if (format.type === 'json_schema') {
                    only(format, ['type', 'name', 'schema', 'description', 'strict'], 'text.format');
                    const { name, schema, description, strict } = format;
                    if (
                        typeof name !== 'string' ||
                        !SCHEMA_NAME.test(name) ||
                        !isRecord(schema) ||
                        (description !== undefined && typeof description !== 'string') ||
                        (strict !== undefined && strict !== null && typeof strict !== 'boolean')
                    ) {
                        fail('text.format', 'json_schema needs a name and a schema object.');
                    }
                    checkSchema(schema, 'text.format.schema');
                    next.format = {
                        type: 'json_schema',
                        name,
                        schema,
                        ...(description !== undefined ? { description } : {}),
                        ...(typeof strict === 'boolean' ? { strict } : {}),
                    };
                } else {
                    throw new Refused(
                        'unsupported_response_format',
                        'text.format may be text, json_object or json_schema.',
                        'text.format.type',
                    );
                }
            }
            if (Object.keys(next).length) {
                out.text = next;
            }
        }
        if (body.include !== undefined && body.include !== null) {
            if (!Array.isArray(body.include) || body.include.length > 32) {
                fail('include', 'include must be a list of at most 32 names.');
            }
            const kept = new Set<string>();
            for (const value of body.include as unknown[]) {
                if (INCLUDES.includes(value as string)) {
                    kept.add(value as string);
                } else {
                    const name = `include[].${String(value)}`;
                    dropped.add(FIELD_NAME.test(name) ? name : 'include[]');
                }
            }
            if (kept.size) {
                out.include = [...kept];
            }
        }
        if (body.prompt_cache_key !== undefined) {
            if (typeof body.prompt_cache_key === 'string' && CACHE_KEY.test(body.prompt_cache_key)) {
                out.prompt_cache_key = body.prompt_cache_key;
            } else {
                drop('prompt_cache_key');
            }
        }
        // Nothing is stored at the provider: a client's `store: true` is not
        // forwarded.
        if (body.store !== undefined && body.store !== false) {
            drop('store');
        }
        out.store = false;
        let stream = false;
        if (body.stream !== undefined) {
            if (typeof body.stream !== 'boolean') {
                fail('stream', 'stream must be true or false.');
            }
            stream = body.stream;
        }
        if (shape.personalPlan && !stream) {
            throw new Refused(
                'stream_required',
                'A ChatGPT plan answers only streamed requests: set stream to true.',
                'stream',
            );
        }
        out.stream = stream;

        const chars =
            JSON.stringify(out.input, (key, value: unknown) =>
                key === 'image_url' && typeof value === 'string' && value.startsWith('data:') ? '' : value,
            ).length +
            (typeof out.instructions === 'string' ? out.instructions.length : 0) +
            (out.tools ? JSON.stringify(out.tools).length : 0) +
            imageCount * IMAGE_CHARS;
        return {
            ok: true,
            body: out,
            stream,
            ...(requestedCompletion !== undefined ? { requestedCompletion } : {}),
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
