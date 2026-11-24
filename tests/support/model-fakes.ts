import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Loopback fakes of an OpenAI Responses backend, an Anthropic Messages
 * backend (CB-239) and a Gemini API backend (CB-326), recording what reached them (path, headers, body)
 * so tests can say what never did. Nothing leaves the machine.
 */

export interface SeenRequest {
    path: string;
    headers: IncomingMessage['headers'];
    body: Record<string, unknown>;
}

export interface ModelFakeMode {
    /** Answer this status (and a body naming the key's account) instead. */
    status?: number;
    /** The answer's text, streamed in two deltas. */
    text: string;
    /** Stream the first event, then nothing (a hung stream). */
    hang?: boolean;
}

const RESPONSES_USAGE = {
    input_tokens: 50,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 55,
};

const MESSAGES_USAGE = {
    input_tokens: 40,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 4,
    output_tokens: 6,
};

const GEMINI_USAGE = {
    promptTokenCount: 30,
    cachedContentTokenCount: 8,
    candidatesTokenCount: 4,
    thoughtsTokenCount: 3,
    totalTokenCount: 37,
};

/** The SSE chunks of a Gemini answer (`?alt=sse`), each a whole response with the counts so far. */
export function geminiChunks(text: string) {
    const half = Math.ceil(text.length / 2);
    const chunk = (piece: string, last: boolean) => ({
        candidates: [
            {
                content: { role: 'model', parts: [{ text: piece }] },
                index: 0,
                ...(last ? { finishReason: 'STOP' } : {}),
            },
        ],
        usageMetadata: last ? GEMINI_USAGE : { promptTokenCount: GEMINI_USAGE.promptTokenCount },
        modelVersion: 'gemini-x-upstream',
    });
    return [chunk(text.slice(0, half), false), chunk(text.slice(half), true)];
}

/** The SSE events of a Responses answer, as OpenAI streams them. */
export function responsesEvents(text: string) {
    const half = Math.ceil(text.length / 2);
    const message = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
    return [
        { type: 'response.created', response: { id: 'resp_1' } },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: text.slice(0, half),
        },
        {
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: text.slice(half),
        },
        {
            type: 'response.completed',
            response: {
                id: 'resp_1',
                status: 'completed',
                output: [message],
                usage: RESPONSES_USAGE,
            },
        },
    ];
}

/** The SSE events of a Messages answer, as Anthropic streams them. */
export function messagesEvents(text: string) {
    const half = Math.ceil(text.length / 2);
    return [
        {
            type: 'message_start',
            message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [],
                usage: { ...MESSAGES_USAGE, output_tokens: 1 },
            },
        },
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: text.slice(0, half) },
        },
        {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: text.slice(half) },
        },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: MESSAGES_USAGE.output_tokens },
        },
        { type: 'message_stop' },
    ];
}

/** One fake serving `/v1/responses` and `/v1/messages`. */
export async function fakeModelApis() {
    const seen: SeenRequest[] = [];
    const mode: ModelFakeMode = { text: 'Hello from the fake.' };
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = chunks.length
                ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
                : {};
            const path = req.url ?? '';
            seen.push({ path, headers: req.headers, body });
            if (mode.status) {
                res.writeHead(mode.status, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        error: { message: 'nope for org-SECRET-ACCOUNT, key sk-abc' },
                    }),
                );
                return;
            }
            const sse = (events: { type: string }[]) => {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                if (mode.hang) {
                    const [first] = events;
                    res.write(`event: ${first!.type}\ndata: ${JSON.stringify(first)}\n\n`);
                    return;
                }
                for (const event of events) {
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                }
                res.end();
            };
            if (path === '/v1/responses') {
                if (body.stream) {
                    return sse(responsesEvents(mode.text));
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: 'resp_1',
                        object: 'response',
                        status: 'completed',
                        output: [
                            {
                                type: 'message',
                                role: 'assistant',
                                content: [{ type: 'output_text', text: mode.text }],
                            },
                        ],
                        usage: RESPONSES_USAGE,
                    }),
                );
                return;
            }
            if (path === '/v1/messages') {
                if (body.stream) {
                    return sse(messagesEvents(mode.text));
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        id: 'msg_1',
                        type: 'message',
                        role: 'assistant',
                        content: [{ type: 'text', text: mode.text }],
                        usage: MESSAGES_USAGE,
                    }),
                );
                return;
            }
            const gemini = /^\/v1\/models\/([^/:]+):(generateContent|streamGenerateContent\?alt=sse)$/.exec(path);
            if (gemini) {
                if (gemini[2] !== 'generateContent') {
                    res.writeHead(200, { 'content-type': 'text/event-stream' });
                    for (const chunk of geminiChunks(mode.text)) {
                        res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
                        if (mode.hang) {
                            return;
                        }
                    }
                    res.end();
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        candidates: [
                            {
                                content: { role: 'model', parts: [{ text: mode.text }] },
                                finishReason: 'STOP',
                                index: 0,
                            },
                        ],
                        usageMetadata: GEMINI_USAGE,
                    }),
                );
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{}');
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        seen,
        mode,
        url: `http://127.0.0.1:${port}/v1`,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** Reads an SSE answer whole and parses its `data:` events. */
export async function sseEvents(response: Response) {
    const text = await response.text();
    return text
        .split(/\r?\n\r?\n/)
        .map((block) =>
            block
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join(''),
        )
        .filter((data) => data && data !== '[DONE]')
        .map((data) => JSON.parse(data) as Record<string, unknown>);
}
