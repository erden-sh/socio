import { expect, it } from 'vitest';

import { GEMINI_API } from '../src/server/gateway/apis.js';
import { geminiTarget, sanitizeGeminiRequest, withGeminiLimit } from '../src/server/gateway/gemini-request.js';
import { GeminiStreamMeter, geminiAnswerChars, geminiUsageOf } from '../src/server/gateway/gemini-stream.js';

// CB-326: what of a Gemini API request reaches a backend: known
// fields checked and rebuilt, everything else dropped by name, and
// provider-side tools and stored content refused.

const shape = { acceptsImages: true, stream: true };
const ok = (body: unknown, s: { acceptsImages: boolean; stream?: boolean } = shape) => {
    const result = sanitizeGeminiRequest(body, s);
    if (!result.ok) {
        throw new Error(`${result.code}: ${result.message}`);
    }
    return result;
};
const refused = (body: unknown, s: { acceptsImages: boolean; stream?: boolean } = shape) => {
    const result = sanitizeGeminiRequest(body, s);
    if (result.ok) {
        throw new Error('expected a refusal');
    }
    return result;
};
const PNG = 'iVBORw0KGgo=';

it('reads the model and streaming from the path, and nothing else', () => {
    expect(geminiTarget('/v1beta/models/orion:streamGenerateContent')).toEqual({ model: 'orion', stream: true });
    expect(geminiTarget('/v1beta/models/qwen3.8%3Aflash:generateContent')).toEqual({
        model: 'qwen3.8:flash',
        stream: false,
    });
    expect(geminiTarget('/v1/models/orion:generateContent')).toEqual({ model: 'orion', stream: false });
    for (const path of [
        '/v1beta/models/orion:countTokens',
        '/v1beta/models/orion:embedContent',
        '/v1beta/models/orion',
        '/v1beta/models/%2E%2E%2Fx:generateContent',
        '/v1beta/models/-x:generateContent',
        '/v1beta/models/%E0%A4%A:generateContent',
        '/v1beta/tunedModels/x:generateContent',
        '/v2/models/x:generateContent',
    ]) {
        expect(geminiTarget(path), path).toBeUndefined();
    }
    expect(GEMINI_API.upstreamPath('gemini-3.5-flash', true)).toBe(
        '/models/gemini-3.5-flash:streamGenerateContent?alt=sse',
    );
    expect(GEMINI_API.upstreamPath('a/b', false)).toBe('/models/a%2Fb:generateContent');
    expect(GEMINI_API.modelInBody).toBe(false);
});

it('rebuilds a Gemini CLI turn: text, thoughts and signatures, function calls and responses, images', () => {
    const body = {
        model: 'ignored',
        labels: { who: 'alice' },
        contents: [
            { role: 'user', parts: [{ text: 'Fix it' }, { inlineData: { mimeType: 'image/png', data: PNG } }] },
            {
                role: 'model',
                parts: [
                    { text: 'thinking…', thought: true, thoughtSignature: 'sig1' },
                    { functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'c1' }, thoughtSignature: 'sig2' },
                ],
            },
            {
                role: 'user',
                parts: [
                    {
                        functionResponse: {
                            name: 'read_file',
                            id: 'c1',
                            response: { output: 'x' },
                            parts: [{ inlineData: { mimeType: 'image/jpeg', data: PNG } }],
                        },
                    },
                ],
            },
        ],
        systemInstruction: { role: 'user', parts: [{ text: 'You are Gemini CLI' }] },
        tools: [
            { functionDeclarations: [{ name: 'read_file', parameters: { type: 'OBJECT' } }] },
            { functionDeclarations: [{ name: 'mcp_x.y', parametersJsonSchema: { type: 'object' }, extra: 1 }] },
        ],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: {
            temperature: 1,
            topP: 0.95,
            topK: 64,
            maxOutputTokens: 1000,
            thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
            mediaResolution: 'X',
        },
        safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    };
    const result = ok(body);
    expect(result.stream).toBe(true);
    expect(result.requestedCompletion).toBe(1000);
    expect(result.body).not.toHaveProperty('model');
    expect(result.body).not.toHaveProperty('labels');
    expect(result.body.contents).toEqual(body.contents);
    expect(result.body.systemInstruction).toEqual({ parts: [{ text: 'You are Gemini CLI' }] });
    expect(result.body.tools).toEqual([
        {
            functionDeclarations: [
                { name: 'read_file', parameters: { type: 'OBJECT' } },
                { name: 'mcp_x.y', parametersJsonSchema: { type: 'object' } },
            ],
        },
    ]);
    expect(result.dropped).toEqual(
        expect.arrayContaining(['labels', 'tools[].functionDeclarations[].extra', 'generationConfig.mediaResolution']),
    );
    expect(withGeminiLimit(result.body, 500).generationConfig).toMatchObject({ maxOutputTokens: 500, topK: 64 });
    expect(withGeminiLimit({ contents: [] }, 7)).toEqual({ contents: [], generationConfig: { maxOutputTokens: 7 } });
    expect(ok(body, { acceptsImages: true }).stream).toBe(false);
});

it('refuses provider-side tools, their results, stored content and URIs', () => {
    const turn = [{ role: 'user', parts: [{ text: 'hi' }] }];
    for (const tool of [
        'googleSearch',
        'googleSearchRetrieval',
        'codeExecution',
        'urlContext',
        'googleMaps',
        'computerUse',
        'fileSearch',
        'retrieval',
    ]) {
        expect(refused({ contents: turn, tools: [{ [tool]: {} }] }).code, tool).toBe('unsupported_tool');
    }
    expect(refused({ contents: turn, cachedContent: 'cachedContents/1' }).code).toBe('unsupported_parameter');
    for (const part of [
        { fileData: { fileUri: 'gs://bucket/x', mimeType: 'image/png' } },
        { executableCode: { code: 'print(1)' } },
        { codeExecutionResult: { output: '1' } },
        { inlineData: { mimeType: 'application/pdf', data: PNG } },
        { text: 'a', functionCall: { name: 'x' } },
        {},
    ]) {
        expect(refused({ contents: [{ role: 'user', parts: [part] }] }).ok, JSON.stringify(part)).toBe(false);
    }
    // A function call in the user's turn, or a response in the model's.
    expect(refused({ contents: [{ role: 'user', parts: [{ functionCall: { name: 'x' } }] }] }).ok).toBe(false);
    expect(
        refused({ contents: [{ role: 'model', parts: [{ functionResponse: { name: 'x', response: {} } }] }] }).ok,
    ).toBe(false);
    // Images only where the model takes them.
    const image = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] }] };
    expect(refused(image, { acceptsImages: false }).message).toContain('doesn’t take images');
    // A remote schema reference stays out.
    expect(
        refused({
            contents: turn,
            tools: [
                { functionDeclarations: [{ name: 'x', parametersJsonSchema: { $ref: 'https://example.test/s' } }] },
            ],
        }).code,
    ).toBe('unsupported_schema');
});

it('checks roles, sampling and calling modes', () => {
    const turn = [{ role: 'user', parts: [{ text: 'hi' }] }];
    for (const body of [
        {},
        { contents: [] },
        { contents: [{ role: 'system', parts: [{ text: 'x' }] }] },
        { contents: turn, generationConfig: { temperature: 3 } },
        { contents: turn, generationConfig: { maxOutputTokens: 0 } },
        { contents: turn, generationConfig: { candidateCount: 2 } },
        { contents: turn, generationConfig: { thinkingConfig: { thinkingLevel: 'ULTRA' } } },
        { contents: turn, toolConfig: { functionCallingConfig: { mode: 'ALWAYS' } } },
        { contents: turn, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['nope'] } } },
        { contents: turn, safetySettings: [{ category: 'x', threshold: 'y' }] },
    ]) {
        expect(sanitizeGeminiRequest(body, shape).ok, JSON.stringify(body)).toBe(false);
    }
    // A turn with no role is the user's.
    expect(ok({ contents: [{ parts: [{ text: 'hi' }] }] }).body.contents).toEqual(turn);
});

it('meters a Gemini answer: usageMetadata, reasoning as output, and characters when it reports none', () => {
    const whole = {
        candidates: [{ content: { parts: [{ text: 'Hello' }, { functionCall: { name: 'f', args: { a: 1 } } }] } }],
        usageMetadata: {
            promptTokenCount: 30,
            toolUsePromptTokenCount: 2,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 3,
            cachedContentTokenCount: 8,
        },
    };
    expect(geminiUsageOf(whole)).toEqual({ promptTokens: 32, completionTokens: 7, cachedTokens: 8 });
    expect(geminiUsageOf({ candidates: [] })).toBeUndefined();
    expect(geminiAnswerChars(whole)).toBe(5 + 1 + JSON.stringify({ a: 1 }).length);

    const meter = new GeminiStreamMeter();
    const chunk = (text: string, usage: Record<string, number>, finish?: string) =>
        `data: ${JSON.stringify({
            candidates: [{ content: { parts: [{ text }] }, ...(finish ? { finishReason: finish } : {}) }],
            usageMetadata: usage,
        })}\r\n\r\n`;
    const first = chunk('Hel', { promptTokenCount: 30 });
    meter.push(first.slice(0, 20));
    meter.push(first.slice(20));
    expect(meter.usage).toBeUndefined();
    expect(meter.outputChars).toBe(3);
    meter.push(chunk('lo', { promptTokenCount: 30, candidatesTokenCount: 2, thoughtsTokenCount: 5 }, 'STOP'));
    expect(meter.usage).toEqual({ promptTokens: 30, completionTokens: 7, cachedTokens: 0 });
    expect(meter.done).toBe(true);
    meter.push('data: {not json\r\n\r\n');
    expect(meter.outputChars).toBe(5);
});

it('answers errors in the Gemini API’s own shape, and ends a stream with an error chunk', async () => {
    const response = GEMINI_API.error(404, 'invalid_request_error', 'model_not_found', 'No such model.');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 404, message: 'No such model.', status: 'NOT_FOUND' } });
    const last = GEMINI_API.streamError('rate_limit_error', 'x', 'Busy.');
    expect(last.startsWith('data: ')).toBe(true);
    expect(JSON.parse(last.slice(6))).toEqual({ error: { code: 429, message: 'Busy.', status: 'RESOURCE_EXHAUSTED' } });
});
