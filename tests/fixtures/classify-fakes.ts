import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ClassifyProvider, ProviderReply, ProviderRequest } from '../../src/server/classify/contract.js';

// Loopback fakes for the classification seam's providers (CB-198): no call
// leaves the machine. `loopbackModel` is an OpenAI-compatible server on
// 127.0.0.1 for the `workspace` provider; `fakeProvider` stands in for
// providers that don't ship (`self-hosted`, `jev`) in the fallback tests.

export interface LoopbackRequest {
    path: string;
    headers: IncomingMessage['headers'];
    body: {
        model?: string;
        max_completion_tokens?: number;
        messages?: { role: string; content: string }[];
        [key: string]: unknown;
    };
}

export async function loopbackModel(
    answer: (request: LoopbackRequest) => {
        status?: number;
        json: unknown;
    },
) {
    const requests: LoopbackRequest[] = [];
    const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
        req.on('end', () => {
            const request: LoopbackRequest = {
                path: req.url ?? '',
                headers: req.headers,
                body: raw ? (JSON.parse(raw) as LoopbackRequest['body']) : {},
            };
            requests.push(request);
            const reply = answer(request);
            res.writeHead(reply.status ?? 200, {
                'Content-Type': 'application/json',
            });
            res.end(JSON.stringify(reply.json));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

/** A chat completion whose text is `content`, with usage. */
export const completion = (
    content: string,
    usage: Record<string, number> = { prompt_tokens: 120, completion_tokens: 12 },
) => ({ choices: [{ message: { role: 'assistant', content } }], usage });

/** A JSON answer to the failures question. */
export const categoryAnswer = (answer: string, confidence: number) =>
    JSON.stringify({ category: { answer, confidence } });

/**
 * A provider that answers from `reply` (text, or an error to throw), and
 * records what it was sent. `version` null: not set up.
 */
export function fakeProvider(
    id: string,
    reply: (request: ProviderRequest) => string | Error,
    version: string | null = 'fake-1',
): ClassifyProvider & { requests: ProviderRequest[] } {
    const requests: ProviderRequest[] = [];
    return {
        id,
        requests,
        version: async () => version ?? undefined,
        async complete(request): Promise<ProviderReply> {
            requests.push(request);
            const text = reply(request);
            if (text instanceof Error) {
                throw text;
            }
            return { text, inputTokens: 100, outputTokens: 10, costUsd: 0.0002 };
        },
    };
}
