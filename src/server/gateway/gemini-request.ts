/**
 * What of a Gemini API `generateContent` request may reach a backend
 * (CB-326, for Gemini CLI; CB-239), as messages-request.ts
 * does for Anthropic Messages. Known fields are copied and checked as well
 * as named; everything else is dropped, its name (never its value) kept for
 * the session's diagnostics. Nothing identifying the person goes upstream:
 * `labels` are always dropped.
 *
 * The model and whether to stream are in the request's path
 * (`/v1beta/models/<model>:streamGenerateContent`), not its body; the
 * gateway reads them there and puts the backend's own model in the
 * upstream path.
 *
 * Only function declarations, run by the client, pass. Provider-side tools
 * (Google Search and its retrieval, code execution, URL context, Maps,
 * file search, computer use, enterprise web search, MCP servers) would
 * fetch or run outside the sandbox for the agent, so requests that carry
 * them, or their results (`executableCode`, `codeExecutionResult`), are
 * refused, never forwarded. So are references to content stored at the
 * provider (`cachedContent`, a part's `fileData`): an image must carry its
 * bytes (`inlineData`).
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

export interface GeminiRequestShape {
    /** The model takes images (Settings → Coding → Models). */
    acceptsImages: boolean;
    /** The path asked for `streamGenerateContent`. */
    stream?: boolean;
}

/** As for Chat Completions: the body has no model and no completion limit of its own. */
export type SanitizedGemini = SanitizedChat;

/** A function's name, as the Gemini API takes it. */
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_CONTENTS = 5000;
const MAX_FUNCTIONS = 256;
/** The gateway model names in a path: the session's own (`CODING_MODEL_ID`'s alphabet). */
const PATH_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** What a tool may hold besides function declarations: all provider-side. */
const TOOL_KINDS = ['functionDeclarations'];
const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'THINKING_LEVEL_UNSPECIFIED'];
const CALLING_MODES = ['AUTO', 'ANY', 'NONE', 'VALIDATED', 'MODE_UNSPECIFIED'];
const HARM_CATEGORY = /^HARM_CATEGORY_[A-Z_]{1,60}$/;
const HARM_THRESHOLD = /^(BLOCK_[A-Z_]{1,40}|HARM_BLOCK_THRESHOLD_UNSPECIFIED|OFF)$/;

/**
 * The Gemini API's request path for one session: `/v1beta/models/<model>:
 * generateContent` or `:streamGenerateContent` (the SDK adds `?alt=sse`),
 * or undefined for anything else (`countTokens`, `embedContent` and the
 * rest are not served).
 */
export function geminiTarget(path: string): { model: string; stream: boolean } | undefined {
    const match = /^\/v1(?:beta|alpha)?\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path);
    if (!match) {
        return undefined;
    }
    let model: string;
    try {
        model = decodeURIComponent(match[1]!);
    } catch {
        return undefined;
    }
    if (!PATH_MODEL.test(model)) {
        return undefined;
    }
    return { model, stream: match[2] === 'streamGenerateContent' };
}

function fail(param: string, message: string, code = 'invalid_value'): never {
    throw new Refused(code, message, param);
}

function unsupported(param: string, message: string): never {
    throw new Refused('unsupported_content', message, param);
}

/**
 * The request as it may go upstream, or why it can't. `body` is the
 * client's parsed JSON; it is never forwarded as is.
 */
export function sanitizeGeminiRequest(body: unknown, shape: GeminiRequestShape): SanitizedGemini {
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
    const object = (value: unknown, param: string): Record<string, unknown> => {
        if (!isRecord(value)) {
            fail(param, `${param} must be an object.`);
        }
        return value;
    };
    let imageCount = 0;
    try {
        if (!isRecord(body)) {
            throw new Refused('invalid_request', 'The body must be a JSON object.');
        }
        if (body.cachedContent !== undefined && body.cachedContent !== null) {
            throw new Refused(
                'unsupported_parameter',
                'cachedContent names content stored at the provider; the gateway doesn’t forward it.',
                'cachedContent',
            );
        }
        const out: Record<string, unknown> = {};
        const KNOWN = new Set([
            'model',
            'contents',
            'systemInstruction',
            'tools',
            'toolConfig',
            'generationConfig',
            'safetySettings',
        ]);
        // `labels`, `serviceTier`, `store` and anything else land here; the
        // model is the path's.
        for (const key of Object.keys(body)) {
            if (!KNOWN.has(key)) {
                drop(key);
            }
        }

        const image = (data: unknown, at: string, path: string) => {
            const inline = object(data, at);
            if (!MIME_TYPES.includes(inline.mimeType as string)) {
                unsupported(`${at}.mimeType`, 'Inline data may be a PNG, JPEG, GIF, WebP or HEIC image only.');
            }
            if (!shape.acceptsImages) {
                unsupported(at, 'This model doesn’t take images.');
            }
            if (typeof inline.data !== 'string' || !BASE64.test(inline.data)) {
                fail(`${at}.data`, 'An image’s data must be base64.');
            }
            only(inline, ['mimeType', 'data'], path);
            imageCount++;
            return { mimeType: inline.mimeType, data: inline.data };
        };
        /** One part: exactly one kind of data, checked and rebuilt. */
        const part = (raw: unknown, at: string, path: string, kinds: readonly string[]) => {
            const value = object(raw, at);
            const DATA = [
                'text',
                'inlineData',
                'functionCall',
                'functionResponse',
                'fileData',
                'executableCode',
                'codeExecutionResult',
            ];
            const present = DATA.filter((key) => value[key] !== undefined && value[key] !== null);
            if (present.length !== 1) {
                fail(at, `${at} must hold one kind of data.`);
            }
            const kind = present[0]!;
            if (kind === 'fileData') {
                unsupported(
                    `${at}.fileData`,
                    'Files must be inline data; the gateway doesn’t let a provider fetch URIs or stored files.',
                );
            }
            if (kind === 'executableCode' || kind === 'codeExecutionResult') {
                unsupported(`${at}.${kind}`, 'Provider-side code execution isn’t forwarded.');
            }
            if (!kinds.includes(kind)) {
                unsupported(at, `${at} has a kind of part the gateway doesn’t forward here.`);
            }
            const next: Record<string, unknown> = {};
            switch (kind) {
                case 'text':
                    if (typeof value.text !== 'string') {
                        fail(`${at}.text`, `${at}.text must be text.`);
                    }
                    next.text = value.text;
                    if (value.thought !== undefined) {
                        if (typeof value.thought !== 'boolean') {
                            fail(`${at}.thought`, 'thought must be true or false.');
                        }
                        next.thought = value.thought;
                    }
                    break;
                case 'inlineData':
                    next.inlineData = image(value.inlineData, `${at}.inlineData`, `${path}.inlineData`);
                    break;
                case 'functionCall': {
                    const call = object(value.functionCall, `${at}.functionCall`);
                    if (typeof call.name !== 'string' || !FUNCTION_NAME.test(call.name)) {
                        fail(`${at}.functionCall.name`, `${at} needs a function name.`);
                    }
                    if (call.args !== undefined && call.args !== null && !isRecord(call.args)) {
                        fail(`${at}.functionCall.args`, 'A function call’s args must be an object.');
                    }
                    if (call.id !== undefined && (typeof call.id !== 'string' || !CALL_ID.test(call.id))) {
                        fail(`${at}.functionCall.id`, 'A function call’s id must be a short name.');
                    }
                    only(call, ['name', 'args', 'id'], `${path}.functionCall`);
                    next.functionCall = {
                        name: call.name,
                        ...(isRecord(call.args) ? { args: call.args } : {}),
                        ...(call.id !== undefined ? { id: call.id } : {}),
                    };
                    break;
                }
                case 'functionResponse': {
                    const result = object(value.functionResponse, `${at}.functionResponse`);
                    if (typeof result.name !== 'string' || !FUNCTION_NAME.test(result.name)) {
                        fail(`${at}.functionResponse.name`, `${at} needs a function name.`);
                    }
                    if (!isRecord(result.response)) {
                        fail(`${at}.functionResponse.response`, 'A function response must be an object.');
                    }
                    if (result.id !== undefined && (typeof result.id !== 'string' || !CALL_ID.test(result.id))) {
                        fail(`${at}.functionResponse.id`, 'A function response’s id must be a short name.');
                    }
                    only(result, ['name', 'response', 'id', 'parts'], `${path}.functionResponse`);
                    const response: Record<string, unknown> = { name: result.name, response: result.response };
                    if (result.id !== undefined) {
                        response.id = result.id;
                    }
                    // Images a tool returned (multimodal function responses).
                    if (result.parts !== undefined && result.parts !== null) {
                        if (!Array.isArray(result.parts) || result.parts.length > 64) {
                            fail(`${at}.functionResponse.parts`, 'A function response’s parts must be a list.');
                        }
                        response.parts = result.parts.map((item, index) => {
                            const where = `${at}.functionResponse.parts[${index}]`;
                            const inner = object(item, where);
                            if (inner.inlineData === undefined || inner.inlineData === null) {
                                unsupported(where, 'A function response’s parts may be inline images only.');
                            }
                            only(inner, ['inlineData'], `${path}.functionResponse.parts[]`);
                            return {
                                inlineData: image(
                                    inner.inlineData,
                                    `${where}.inlineData`,
                                    `${path}.functionResponse.parts[].inlineData`,
                                ),
                            };
                        });
                    }
                    next.functionResponse = response;
                    break;
                }
            }
            // The model's own signature over its reasoning, sent back as given.
            if (value.thoughtSignature !== undefined) {
                if (typeof value.thoughtSignature !== 'string' || value.thoughtSignature.length > 1024 * 1024) {
                    fail(`${at}.thoughtSignature`, 'thoughtSignature must be text.');
                }
                next.thoughtSignature = value.thoughtSignature;
            }
            only(value, [kind, 'thought', 'thoughtSignature'], path);
            return next;
        };
        const parts = (value: unknown, at: string, kinds: readonly string[]) => {
            if (!Array.isArray(value) || value.length > 4096) {
                fail(at, `${at} must be a list of parts.`);
            }
            const path = `${at.replace(/\[\d+\]/g, '[]')}[]`;
            return value.map((raw, index) => part(raw, `${at}[${index}]`, path, kinds));
        };
        const KINDS_BY_ROLE: Record<string, readonly string[]> = {
            user: ['text', 'inlineData', 'functionResponse'],
            model: ['text', 'functionCall'],
        };

        // Contents: user and model turns of parts.
        const contents = body.contents;
        if (!Array.isArray(contents) || !contents.length || contents.length > MAX_CONTENTS) {
            fail('contents', `contents must be a list of 1 to ${MAX_CONTENTS} turns.`);
        }
        out.contents = contents.map((raw, index) => {
            const at = `contents[${index}]`;
            const turn = object(raw, at);
            const role = turn.role ?? 'user';
            if (role !== 'user' && role !== 'model') {
                fail(`${at}.role`, `${at}.role may be user or model.`);
            }
            only(turn, ['role', 'parts'], 'contents[]');
            return { role, parts: parts(turn.parts, `${at}.parts`, KINDS_BY_ROLE[role]!) };
        });
        if (body.systemInstruction !== undefined && body.systemInstruction !== null) {
            const system = body.systemInstruction;
            if (typeof system === 'string') {
                out.systemInstruction = { parts: [{ text: system }] };
            } else {
                const record = object(system, 'systemInstruction');
                only(record, ['role', 'parts'], 'systemInstruction');
                out.systemInstruction = { parts: parts(record.parts, 'systemInstruction.parts', ['text']) };
            }
        }

        // Tools: function declarations the client runs, nothing else.
        const names = new Set<string>();
        if (body.tools !== undefined && body.tools !== null) {
            if (!Array.isArray(body.tools) || body.tools.length > 16) {
                fail('tools', 'tools must be a list.');
            }
            const declarations: Record<string, unknown>[] = [];
            body.tools.forEach((raw, index) => {
                const at = `tools[${index}]`;
                const tool = object(raw, at);
                const other = Object.keys(tool).filter((key) => !TOOL_KINDS.includes(key) && tool[key] != null);
                if (other.length) {
                    throw new Refused(
                        'unsupported_tool',
                        'Only function declarations are forwarded; provider-side tools (Google Search, code execution, URL context, Maps, file search, computer use, MCP…) are not.',
                        `${at}.${other[0]}`,
                    );
                }
                const list = tool.functionDeclarations ?? [];
                if (!Array.isArray(list)) {
                    fail(`${at}.functionDeclarations`, 'functionDeclarations must be a list.');
                }
                list.forEach((item, position) => {
                    const where = `${at}.functionDeclarations[${position}]`;
                    const fn = object(item, where);
                    only(
                        fn,
                        ['name', 'description', 'parameters', 'parametersJsonSchema', 'behavior'],
                        'tools[].functionDeclarations[]',
                    );
                    if (typeof fn.name !== 'string' || !FUNCTION_NAME.test(fn.name)) {
                        fail(`${where}.name`, `${where} needs a function name.`);
                    }
                    if (fn.description !== undefined && typeof fn.description !== 'string') {
                        fail(`${where}.description`, 'A description must be text.');
                    }
                    const next: Record<string, unknown> = { name: fn.name };
                    if (fn.description !== undefined) {
                        next.description = fn.description;
                    }
                    for (const key of ['parameters', 'parametersJsonSchema'] as const) {
                        if (fn[key] === undefined || fn[key] === null) {
                            continue;
                        }
                        const schema = object(fn[key], `${where}.${key}`);
                        checkSchema(schema, `${where}.${key}`);
                        next[key] = schema;
                    }
                    if (fn.behavior === 'BLOCKING' || fn.behavior === 'NON_BLOCKING') {
                        next.behavior = fn.behavior;
                    } else if (fn.behavior !== undefined) {
                        drop('tools[].functionDeclarations[].behavior');
                    }
                    names.add(fn.name);
                    declarations.push(next);
                });
            });
            if (declarations.length > MAX_FUNCTIONS) {
                fail('tools', `tools may declare at most ${MAX_FUNCTIONS} functions.`);
            }
            if (declarations.length) {
                out.tools = [{ functionDeclarations: declarations }];
            }
        }
        if (body.toolConfig !== undefined && body.toolConfig !== null) {
            const config = object(body.toolConfig, 'toolConfig');
            only(config, ['functionCallingConfig'], 'toolConfig');
            if (config.functionCallingConfig !== undefined && config.functionCallingConfig !== null) {
                const calling = object(config.functionCallingConfig, 'toolConfig.functionCallingConfig');
                only(calling, ['mode', 'allowedFunctionNames'], 'toolConfig.functionCallingConfig');
                const next: Record<string, unknown> = {};
                if (calling.mode !== undefined) {
                    if (!CALLING_MODES.includes(calling.mode as string)) {
                        fail('toolConfig.functionCallingConfig.mode', 'mode may be AUTO, ANY, NONE or VALIDATED.');
                    }
                    next.mode = calling.mode;
                }
                if (calling.allowedFunctionNames !== undefined) {
                    const allowed = calling.allowedFunctionNames;
                    if (
                        !Array.isArray(allowed) ||
                        !allowed.every((name) => typeof name === 'string' && names.has(name))
                    ) {
                        fail(
                            'toolConfig.functionCallingConfig.allowedFunctionNames',
                            'allowedFunctionNames may name only the request’s functions.',
                        );
                    }
                    next.allowedFunctionNames = allowed;
                }
                out.toolConfig = { functionCallingConfig: next };
            }
        }

        // Generation: sampling and limits, checked as numbers in range.
        let requestedCompletion: number | undefined;
        if (body.generationConfig !== undefined && body.generationConfig !== null) {
            const config = object(body.generationConfig, 'generationConfig');
            const next: Record<string, unknown> = {};
            const number = (key: string, min: number, max: number, integer = false) => {
                const value = config[key];
                if (value === undefined || value === null) {
                    return;
                }
                if (
                    typeof value !== 'number' ||
                    !Number.isFinite(value) ||
                    value < min ||
                    value > max ||
                    (integer && !Number.isInteger(value))
                ) {
                    fail(`generationConfig.${key}`, `${key} must be a number from ${min} to ${max}.`);
                }
                next[key] = value;
            };
            number('temperature', 0, 2);
            number('topP', 0, 1);
            number('topK', 0, 1000, true);
            number('presencePenalty', -2, 2);
            number('frequencyPenalty', -2, 2);
            number('seed', -2147483648, 2147483647, true);
            if (config.candidateCount !== undefined && config.candidateCount !== 1) {
                fail('generationConfig.candidateCount', 'candidateCount may only be 1.');
            }
            if (config.stopSequences !== undefined) {
                const stop = config.stopSequences;
                if (
                    !Array.isArray(stop) ||
                    stop.length > 5 ||
                    !stop.every((item) => typeof item === 'string' && item.length <= 200)
                ) {
                    fail('generationConfig.stopSequences', 'stopSequences must be up to 5 strings.');
                }
                next.stopSequences = stop;
            }
            const max = config.maxOutputTokens;
            if (max !== undefined && max !== null) {
                if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
                    fail('generationConfig.maxOutputTokens', 'maxOutputTokens must be a whole number of at least 1.');
                }
                requestedCompletion = max;
            }
            if (config.responseMimeType !== undefined) {
                if (config.responseMimeType !== 'text/plain' && config.responseMimeType !== 'application/json') {
                    fail(
                        'generationConfig.responseMimeType',
                        'responseMimeType may be text/plain or application/json.',
                    );
                }
                next.responseMimeType = config.responseMimeType;
            }
            for (const key of ['responseSchema', 'responseJsonSchema'] as const) {
                if (config[key] === undefined || config[key] === null) {
                    continue;
                }
                const schema = object(config[key], `generationConfig.${key}`);
                checkSchema(schema, `generationConfig.${key}`);
                next[key] = schema;
            }
            if (config.thinkingConfig !== undefined && config.thinkingConfig !== null) {
                const thinking = object(config.thinkingConfig, 'generationConfig.thinkingConfig');
                only(
                    thinking,
                    ['includeThoughts', 'thinkingBudget', 'thinkingLevel'],
                    'generationConfig.thinkingConfig',
                );
                const out: Record<string, unknown> = {};
                if (thinking.includeThoughts !== undefined) {
                    if (typeof thinking.includeThoughts !== 'boolean') {
                        fail(
                            'generationConfig.thinkingConfig.includeThoughts',
                            'includeThoughts must be true or false.',
                        );
                    }
                    out.includeThoughts = thinking.includeThoughts;
                }
                if (thinking.thinkingBudget !== undefined) {
                    const budget = thinking.thinkingBudget;
                    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < -1) {
                        fail(
                            'generationConfig.thinkingConfig.thinkingBudget',
                            'thinkingBudget must be a whole number (-1 for dynamic).',
                        );
                    }
                    out.thinkingBudget = budget;
                }
                if (thinking.thinkingLevel !== undefined) {
                    if (!THINKING_LEVELS.includes(thinking.thinkingLevel as string)) {
                        fail('generationConfig.thinkingConfig.thinkingLevel', 'thinkingLevel is not a known level.');
                    }
                    out.thinkingLevel = thinking.thinkingLevel;
                }
                next.thinkingConfig = out;
            }
            only(
                config,
                [
                    'temperature',
                    'topP',
                    'topK',
                    'presencePenalty',
                    'frequencyPenalty',
                    'seed',
                    'candidateCount',
                    'stopSequences',
                    'maxOutputTokens',
                    'responseMimeType',
                    'responseSchema',
                    'responseJsonSchema',
                    'thinkingConfig',
                ],
                'generationConfig',
            );
            out.generationConfig = next;
        }
        if (body.safetySettings !== undefined && body.safetySettings !== null) {
            const settings = body.safetySettings;
            if (
                !Array.isArray(settings) ||
                settings.length > 16 ||
                !settings.every(
                    (item) =>
                        isRecord(item) &&
                        typeof item.category === 'string' &&
                        HARM_CATEGORY.test(item.category) &&
                        typeof item.threshold === 'string' &&
                        HARM_THRESHOLD.test(item.threshold),
                )
            ) {
                fail('safetySettings', 'safetySettings must be a list of categories and thresholds.');
            }
            out.safetySettings = (settings as Record<string, unknown>[]).map((item) => ({
                category: item.category,
                threshold: item.threshold,
            }));
        }
        const stream = shape.stream === true;

        // Image bytes count as a flat amount each, not as their base64.
        const blank = function (this: unknown, key: string, value: unknown) {
            return key === 'data' && isRecord(this) && typeof this.mimeType === 'string' ? '' : value;
        };
        const chars =
            JSON.stringify(out.contents, blank).length +
            (out.systemInstruction !== undefined ? JSON.stringify(out.systemInstruction).length : 0) +
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

/**
 * The body with the clamped completion limit: the Gemini API takes
 * it inside `generationConfig`.
 */
export function withGeminiLimit(body: Record<string, unknown>, maxOutputTokens: number): Record<string, unknown> {
    const config = isRecord(body.generationConfig) ? body.generationConfig : {};
    return { ...body, generationConfig: { ...config, maxOutputTokens } };
}
