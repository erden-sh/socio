/**
 * What of a Chat Completions request may reach a backend (CB-239).
 * Known fields are copied and checked as well as named; everything else is
 * dropped, its name (never its value) kept for the session's diagnostics.
 * Nothing identifying the person goes upstream: `user`, `metadata` and
 * `store` are always dropped, and messages carry no `name`.
 *
 * Only plain `function` tools pass. Backends that offer provider-side
 * tools (web search, URL fetch, code execution) through other tool types
 * or extra fields would fetch from outside the sandbox for the agent, so
 * those requests are refused, never forwarded. For the same reason an
 * image part must carry its bytes (`data:` URL): a link would have the
 * provider fetch it.
 */

/** Request bodies past this are refused. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Characters a token, for estimates when a backend reports none. */
export const CHARS_PER_TOKEN = 4;
/** What one image counts for in the prompt estimate, in characters. */
export const IMAGE_CHARS = 4_000;

const ROLES = ['system', 'developer', 'user', 'assistant', 'tool'] as const;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REASONING = ['none', 'minimal', 'low', 'medium', 'high'];
export const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const FIELD_NAME = /^[A-Za-z0-9_.[\]-]{1,64}$/;
/** How deep a tool's or a response format's JSON schema may nest. */
export const MAX_SCHEMA_DEPTH = 32;
/** The most a tool's or a response format's JSON schema may hold, as JSON. */
export const MAX_SCHEMA_BYTES = 64 * 1024;
/** Schema keywords that point at another schema, by URI. */
const REF_KEYS = new Set(['$ref', '$dynamicRef', '$recursiveRef']);

export interface ChatRequestShape {
    /** The model takes image parts (Settings → Coding → Models). */
    acceptsImages: boolean;
}

export type SanitizedChat =
    | {
          ok: true;
          /** The upstream body, without `model` and the completion limit yet. */
          body: Record<string, unknown>;
          stream: boolean;
          /** What the request asked for as its completion limit, if anything. */
          requestedCompletion?: number;
          /** The prompt's estimate, in tokens. */
          promptTokens: number;
          /** Names of the fields dropped, for diagnostics. */
          dropped: string[];
      }
    | { ok: false; code: string; message: string; param?: string };

/** Why a request can't go upstream (`checkSchema` throws it too). */
export class Refused extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly param?: string,
    ) {
        super(message);
    }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(param: string, message: string, code = 'invalid_value'): never {
    throw new Refused(code, message, param);
}

/**
 * A JSON schema the request carries (a tool's `parameters`, a response
 * format's `schema`), checked before it goes upstream: a reference must
 * stay inside the schema (`#…`), since a remote one could have the
 * backend's schema library fetch it; and its depth and size are capped.
 */
export function checkSchema(schema: Record<string, unknown>, param: string) {
    if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) {
        throw new Refused('unsupported_schema', `A schema may hold at most ${MAX_SCHEMA_BYTES / 1024} KB.`, param);
    }
    const walk = (value: unknown, depth: number) => {
        if (typeof value !== 'object' || value === null) {
            return;
        }
        if (depth > MAX_SCHEMA_DEPTH) {
            throw new Refused('unsupported_schema', `A schema may nest at most ${MAX_SCHEMA_DEPTH} levels.`, param);
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item, depth + 1);
            }
            return;
        }
        for (const [key, item] of Object.entries(value)) {
            if (REF_KEYS.has(key) && (typeof item !== 'string' || !item.startsWith('#'))) {
                throw new Refused(
                    'unsupported_schema',
                    `A schema's ${key} must point inside it (#…); the gateway doesn’t let a provider fetch schemas.`,
                    param,
                );
            }
            walk(item, depth + 1);
        }
    };
    walk(schema, 1);
}

/** The model a request names, before anything else is read. */
export function requestedModel(body: unknown): string | undefined {
    return isRecord(body) && typeof body.model === 'string' ? body.model : undefined;
}

/**
 * The request as it may go upstream, or why it can't. `body` is the
 * client's parsed JSON; it is never forwarded as is.
 */
export function sanitizeChatRequest(body: unknown, shape: ChatRequestShape): SanitizedChat {
    const dropped = new Set<string>();
    const drop = (name: string) => dropped.add(FIELD_NAME.test(name) ? name : 'other');
    let imageCount = 0;
    try {
        if (!isRecord(body)) {
            throw new Refused('invalid_request', 'The body must be a JSON object.');
        }
        const out: Record<string, unknown> = {};
        const KNOWN = new Set([
            'model',
            'messages',
            'tools',
            'tool_choice',
            'parallel_tool_calls',
            'stream',
            'temperature',
            'top_p',
            'stop',
            'seed',
            'max_tokens',
            'max_completion_tokens',
            'reasoning_effort',
            'response_format',
        ]);
        for (const key of Object.keys(body)) {
            if (!KNOWN.has(key)) {
                drop(key);
            }
        }

        // Messages: roles and content parts of Chat Completions only.
        const messages = body.messages;
        if (!Array.isArray(messages) || !messages.length || messages.length > 5000) {
            fail('messages', 'messages must be a list of 1 to 5000 messages.');
        }
        const text = (value: unknown, param: string) => {
            if (typeof value !== 'string') {
                fail(param, `${param} must be text.`);
            }
            return value as string;
        };
        const textParts = (parts: unknown[], param: string, images: boolean) =>
            parts.map((part, index) => {
                const at = `${param}[${index}]`;
                if (!isRecord(part)) {
                    fail(at, `${at} must be an object.`);
                }
                const record = part as Record<string, unknown>;
                for (const key of Object.keys(record)) {
                    if (
                        key !== 'type' &&
                        !(record.type === 'text' && key === 'text') &&
                        !(record.type === 'image_url' && key === 'image_url')
                    ) {
                        drop(`${param.replace(/\[\d+\]/g, '[]')}[].${key}`);
                    }
                }
                if (record.type === 'text') {
                    return { type: 'text', text: text(record.text, `${at}.text`) };
                }
                if (record.type === 'image_url' && images) {
                    if (!shape.acceptsImages) {
                        throw new Refused('unsupported_content', 'This model doesn’t take images.', at);
                    }
                    const image = record.image_url;
                    if (!isRecord(image) || typeof image.url !== 'string') {
                        fail(at, `${at}.image_url.url must be text.`);
                    }
                    const { url, detail } = image as Record<string, unknown>;
                    if (!IMAGE_DATA.test(url as string)) {
                        throw new Refused(
                            'unsupported_content',
                            'Images must be inline data (data:image/…;base64,…); the gateway doesn’t let a provider fetch links.',
                            at,
                        );
                    }
                    for (const key of Object.keys(image as object)) {
                        if (key !== 'url' && key !== 'detail') {
                            drop('image_url.' + key);
                        }
                    }
                    imageCount++;
                    return {
                        type: 'image_url',
                        image_url: {
                            url,
                            ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}),
                        },
                    };
                }
                throw new Refused('unsupported_content', `${at} has a content type the gateway doesn’t forward.`, at);
            });
        const content = (value: unknown, param: string, options: { images: boolean; nullable?: boolean }) => {
            if (value === null && options.nullable) {
                return null;
            }
            if (typeof value === 'string') {
                return value;
            }
            if (Array.isArray(value)) {
                return textParts(value, `${param}`, options.images);
            }
            return fail(param, `${param} must be text or a list of parts.`);
        };
        out.messages = (messages as unknown[]).map((raw, index) => {
            const at = `messages[${index}]`;
            if (!isRecord(raw)) {
                fail(at, `${at} must be an object.`);
            }
            const message = raw as Record<string, unknown>;
            const role = message.role;
            if (!(ROLES as readonly unknown[]).includes(role)) {
                fail(`${at}.role`, `${at}.role is not a Chat Completions role.`);
            }
            const allowed = new Set(['role', 'content']);
            const next: Record<string, unknown> = { role };
            if (role === 'assistant') {
                allowed.add('tool_calls');
                if (message.content !== undefined) {
                    next.content = content(message.content, `${at}.content`, {
                        images: false,
                        nullable: true,
                    });
                }
                if (message.tool_calls !== undefined) {
                    if (!Array.isArray(message.tool_calls)) {
                        fail(`${at}.tool_calls`, 'tool_calls must be a list.');
                    }
                    next.tool_calls = (message.tool_calls as unknown[]).map((call, n) => {
                        const param = `${at}.tool_calls[${n}]`;
                        if (!isRecord(call) || call.type !== 'function') {
                            throw new Refused('unsupported_tool', `${param} is not a function call.`, param);
                        }
                        const fn = call.function;
                        if (
                            !isRecord(fn) ||
                            typeof fn.name !== 'string' ||
                            typeof fn.arguments !== 'string' ||
                            typeof call.id !== 'string' ||
                            call.id.length > 200
                        ) {
                            fail(param, `${param} needs an id, a name and arguments.`);
                        }
                        for (const key of Object.keys(call)) {
                            if (!['id', 'type', 'function'].includes(key)) {
                                drop(`tool_calls[].${key}`);
                            }
                        }
                        for (const key of Object.keys(fn as object)) {
                            if (key !== 'name' && key !== 'arguments') {
                                drop(`tool_calls[].function.${key}`);
                            }
                        }
                        const { name, arguments: args } = fn as {
                            name: string;
                            arguments: string;
                        };
                        return {
                            id: call.id,
                            type: 'function',
                            function: { name, arguments: args },
                        };
                    });
                }
                if (next.content === undefined && next.tool_calls === undefined) {
                    fail(`${at}.content`, `${at} needs content or tool calls.`);
                }
            } else if (role === 'tool') {
                allowed.add('tool_call_id');
                const id = message.tool_call_id;
                if (typeof id !== 'string' || !id || id.length > 200) {
                    fail(`${at}.tool_call_id`, `${at}.tool_call_id must be text.`);
                }
                next.tool_call_id = id;
                next.content = content(message.content, `${at}.content`, {
                    images: false,
                });
            } else {
                next.content = content(message.content, `${at}.content`, {
                    images: role === 'user',
                });
            }
            for (const key of Object.keys(message)) {
                if (!allowed.has(key)) {
                    drop(`messages[].${key}`);
                }
            }
            return next;
        });

        // Tools: plain functions with a JSON-schema object, nothing else.
        const toolNames = new Set<string>();
        if (body.tools !== undefined) {
            if (!Array.isArray(body.tools) || body.tools.length > 256) {
                fail('tools', 'tools must be a list of at most 256 functions.');
            }
            out.tools = (body.tools as unknown[]).map((tool, index) => {
                const at = `tools[${index}]`;
                if (!isRecord(tool) || tool.type !== 'function') {
                    throw new Refused(
                        'unsupported_tool',
                        'Only function tools are forwarded; provider-side tools are not.',
                        at,
                    );
                }
                const fn = tool.function;
                if (!isRecord(fn) || typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name)) {
                    fail(`${at}.function.name`, `${at} needs a function name.`);
                }
                const { name, description, parameters, strict } = fn as Record<string, unknown>;
                if (parameters !== undefined && !isRecord(parameters)) {
                    fail(`${at}.function.parameters`, 'A tool’s parameters must be a JSON schema object.');
                }
                if (parameters !== undefined) {
                    checkSchema(parameters as Record<string, unknown>, `${at}.function.parameters`);
                }
                if (description !== undefined && typeof description !== 'string') {
                    fail(`${at}.function.description`, 'A description must be text.');
                }
                for (const key of Object.keys(tool)) {
                    if (key !== 'type' && key !== 'function') {
                        drop(`tools[].${key}`);
                    }
                }
                for (const key of Object.keys(fn as object)) {
                    if (!['name', 'description', 'parameters', 'strict'].includes(key)) {
                        drop(`tools[].function.${key}`);
                    }
                }
                toolNames.add(name as string);
                return {
                    type: 'function',
                    function: {
                        name,
                        ...(description !== undefined ? { description } : {}),
                        parameters: parameters ?? { type: 'object', properties: {} },
                        ...(typeof strict === 'boolean' ? { strict } : {}),
                    },
                };
            });
        }
        if (body.tool_choice !== undefined) {
            const choice = body.tool_choice;
            if (choice === 'none' || choice === 'auto' || choice === 'required') {
                if (!toolNames.size && choice !== 'none') {
                    fail('tool_choice', 'tool_choice needs tools.');
                }
                out.tool_choice = choice;
            } else if (
                isRecord(choice) &&
                choice.type === 'function' &&
                isRecord(choice.function) &&
                typeof choice.function.name === 'string' &&
                toolNames.has(choice.function.name)
            ) {
                out.tool_choice = {
                    type: 'function',
                    function: { name: choice.function.name },
                };
            } else {
                fail('tool_choice', 'tool_choice may be none, auto, required, or one of the request’s functions.');
            }
        }
        if (body.parallel_tool_calls !== undefined) {
            if (typeof body.parallel_tool_calls !== 'boolean') {
                fail('parallel_tool_calls', 'parallel_tool_calls must be true or false.');
            }
            out.parallel_tool_calls = body.parallel_tool_calls;
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
        number('temperature', 0, 2);
        number('top_p', 0, 1);
        number('seed', -(2 ** 53) + 1, 2 ** 53 - 1, true);
        if (body.stop !== undefined) {
            const stop = body.stop;
            const ok =
                (typeof stop === 'string' && stop.length <= 200) ||
                (Array.isArray(stop) &&
                    stop.length <= 4 &&
                    stop.every((item) => typeof item === 'string' && item.length <= 200));
            if (!ok) {
                fail('stop', 'stop must be text or up to 4 strings.');
            }
            out.stop = stop;
        }
        let requestedCompletion: number | undefined;
        for (const key of ['max_tokens', 'max_completion_tokens']) {
            const value = body[key];
            if (value === undefined) {
                continue;
            }
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
                fail(key, `${key} must be a whole number of at least 1.`);
            }
            requestedCompletion = Math.min(requestedCompletion ?? Infinity, value as number);
        }
        if (body.reasoning_effort !== undefined) {
            if (!REASONING.includes(body.reasoning_effort as string)) {
                fail('reasoning_effort', 'reasoning_effort is not a known level.');
            }
            out.reasoning_effort = body.reasoning_effort;
        }
        if (body.response_format !== undefined) {
            const format = body.response_format;
            if (!isRecord(format)) {
                fail('response_format', 'response_format must be an object.');
            }
            const record = format as Record<string, unknown>;
            if (record.type === 'text' || record.type === 'json_object') {
                out.response_format = { type: record.type };
            } else if (record.type === 'json_schema') {
                const spec = record.json_schema;
                if (
                    !isRecord(spec) ||
                    typeof spec.name !== 'string' ||
                    !SCHEMA_NAME.test(spec.name) ||
                    (spec.schema !== undefined && !isRecord(spec.schema)) ||
                    (spec.description !== undefined && typeof spec.description !== 'string') ||
                    (spec.strict !== undefined && typeof spec.strict !== 'boolean')
                ) {
                    fail('response_format.json_schema', 'json_schema needs a name and a schema object.');
                }
                const { name, schema, description, strict } = spec as Record<string, unknown>;
                if (schema !== undefined) {
                    checkSchema(schema as Record<string, unknown>, 'response_format.json_schema.schema');
                }
                for (const key of Object.keys(spec as object)) {
                    if (!['name', 'schema', 'description', 'strict'].includes(key)) {
                        drop(`response_format.json_schema.${key}`);
                    }
                }
                out.response_format = {
                    type: 'json_schema',
                    json_schema: {
                        name,
                        ...(description !== undefined ? { description } : {}),
                        ...(schema !== undefined ? { schema } : {}),
                        ...(strict !== undefined ? { strict } : {}),
                    },
                };
            } else {
                throw new Refused(
                    'unsupported_response_format',
                    'response_format may be text, json_object or json_schema.',
                    'response_format.type',
                );
            }
            for (const key of Object.keys(record)) {
                if (key !== 'type' && key !== 'json_schema') {
                    drop(`response_format.${key}`);
                }
            }
        }
        let stream = false;
        if (body.stream !== undefined) {
            if (typeof body.stream !== 'boolean') {
                fail('stream', 'stream must be true or false.');
            }
            stream = body.stream as boolean;
        }
        out.stream = stream;
        // Usage comes in the last chunk of a stream.
        if (stream) {
            out.stream_options = { include_usage: true };
        }

        const chars =
            JSON.stringify(out.messages, (key, value: unknown) =>
                key === 'url' && typeof value === 'string' && value.startsWith('data:') ? '' : value,
            ).length +
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
