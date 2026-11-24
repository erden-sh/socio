import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parsePageReviewArgs } from '@socio/shared/pages/page-review';

import {
    SMOKE_20K_INTERVAL_MS,
    SMOKE_20K_SLICE,
    SMOKE_SLOW_INTERVAL_MS,
    smoke20kAnswer,
    smoke20kParts,
    smokeReviewAnswer,
    smokeReviewDraft,
    smokeSlowParts,
} from './fixtures/fake-model-chats.js';

// The fake model's chat scripts for the native app: the scripts
// themselves, then the served streams, on a fake model started from source.

const fences = (markdown: string) => markdown.split('\n').filter((line) => line.startsWith('```')).length;

describe('the chat scripts', () => {
    it('smoke review asks for a draft the review tool accepts', () => {
        expect(parsePageReviewArgs(smokeReviewDraft).success).toBe(true);
    });

    it('smoke review answers each kind of result', () => {
        expect(
            smokeReviewAnswer(JSON.stringify({ approved: true, pageId: 'p', spaceId: 's', url: '/spaces/s/p' })),
        ).toBe('Saved the review as [Smoke review](/spaces/s/p).');
        expect(smokeReviewAnswer(JSON.stringify({ approved: false, message: 'declined' }))).toBe(
            'Not saved: you declined the draft.',
        );
        // Synthetic only: the real server orders a skipped result before the next user message, which the fake model never reads.
        expect(smokeReviewAnswer(JSON.stringify({ skipped: true }))).toMatch(/closed without an answer/);
        expect(smokeReviewAnswer('not json')).toBe('Not saved: you declined the draft.');
    });

    it('smoke 20k has tables, lists, closed fences and an unclosed one, in fixed slices', () => {
        const answer = smoke20kAnswer();
        expect(answer.length).toBeGreaterThanOrEqual(20_000);
        expect(answer.length).toBeLessThan(22_000);
        expect(answer).toMatch(/^\| --- \| ---: \|/m);
        expect(answer).toMatch(/^ {2}- a nested point/m);
        expect(answer).toMatch(/^1\. Step one/m);
        // Closed fences in pairs, and one left open at the end.
        expect(fences(answer) % 2).toBe(1);
        expect(fences(answer)).toBeGreaterThan(10);
        expect(answer.slice(answer.lastIndexOf('```'))).toMatch(/^```sql\n[^`]+$/);
        const parts = smoke20kParts();
        expect(parts.join('')).toBe(answer);
        expect(parts.slice(0, -1).every((part) => part.length === SMOKE_20K_SLICE)).toBe(true);
        expect(parts.length * SMOKE_20K_INTERVAL_MS).toBeLessThan(6_000);
        // Some slices end inside a fence, as a stream cut mid-block does.
        expect(parts.some((_, index) => fences(parts.slice(0, index + 1).join('')) % 2 === 1)).toBe(true);
    });

    it('smoke slow-stream sends a line a second for 60 s', () => {
        const parts = smokeSlowParts();
        expect(parts).toHaveLength(60);
        expect(parts.length * SMOKE_SLOW_INTERVAL_MS).toBe(60_000);
        expect(parts[0]).toBe('Second 1. ');
        expect(parts[9]).toBe('Second 10.\n\n');
        expect(parts.at(-1)).toBe('Second 60. Done streaming slowly.');
    });
});

describe('the served streams', () => {
    let model: ChildProcess;
    let base = '';

    beforeAll(async () => {
        const probe = createServer().listen(0, '127.0.0.1');
        await once(probe, 'listening');
        const port = (probe.address() as { port: number }).port;
        await new Promise((resolve) => probe.close(resolve));
        model = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/serve-fake-model.ts', String(port)], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        await once(model.stdout!, 'data');
        base = `http://127.0.0.1:${port}/v1`;
    }, 30_000);

    afterAll(() => {
        model?.kill();
    });

    type Delta = {
        content?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    /** The streamed chunks' deltas and finish reasons, with each one's arrival time. */
    async function stream(messages: unknown[], limit = Infinity) {
        const controller = new AbortController();
        const started = Date.now();
        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'fake-model', stream: true, messages }),
            signal: controller.signal,
        });
        const chunks: Array<{ delta: Delta; finish: string | null; at: number }> = [];
        let done = false;
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const bytes of response.body!) {
            buffer += decoder.decode(bytes, { stream: true });
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, end).replace(/^data: /, '');
                buffer = buffer.slice(end + 2);
                if (frame === '[DONE]') {
                    done = true;
                    continue;
                }
                const parsed = JSON.parse(frame);
                chunks.push({
                    delta: parsed.choices[0].delta,
                    finish: parsed.choices[0].finish_reason,
                    at: Date.now() - started,
                });
            }
            if (chunks.length >= limit) {
                break;
            }
        }
        // Leaving the loop cancels the body; this drops the connection too.
        controller.abort();
        return { chunks, done };
    }

    it('smoke review calls review_space_page, then answers its result', async () => {
        const first = await stream([{ role: 'user', content: 'smoke review please' }]);
        expect(first.done).toBe(true);
        const call = first.chunks[0]!.delta.tool_calls![0]!;
        expect(call.function.name).toBe('review_space_page');
        expect(JSON.parse(call.function.arguments)).toEqual(smokeReviewDraft);
        expect(first.chunks.at(-1)!.finish).toBe('tool_calls');

        const result = { approved: true, pageId: 'p1', spaceId: 's1', url: '/spaces/s1/p1' };
        const second = await stream([
            { role: 'user', content: 'smoke review please' },
            { role: 'assistant', tool_calls: [{ id: call.id, type: 'function', function: call.function }] },
            { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) },
        ]);
        expect(second.chunks[0]!.delta.content).toBe('Saved the review as [Smoke review](/spaces/s1/p1).');
        expect(second.chunks.at(-1)!.finish).toBe('stop');
    });

    it('smoke 20k streams its slices in order, at a fixed rate', async () => {
        const { chunks, done } = await stream([{ role: 'user', content: 'smoke 20k' }]);
        expect(done).toBe(true);
        const content = chunks.filter((chunk) => chunk.delta.content).map((chunk) => chunk.delta.content);
        expect(content).toEqual(smoke20kParts());
        expect(chunks.at(-1)!.finish).toBe('stop');
        // Paced, not sent at once: the last slice comes well after the first.
        expect(chunks.at(-1)!.at - chunks[0]!.at).toBeGreaterThan(SMOKE_20K_INTERVAL_MS * (content.length / 2));
    }, 30_000);

    it('smoke slow-stream sends a line a second', async () => {
        const { chunks } = await stream([{ role: 'user', content: 'smoke slow-stream' }], 2);
        expect(chunks.map((chunk) => chunk.delta.content)).toEqual(smokeSlowParts().slice(0, 2));
        expect(chunks[1]!.at - chunks[0]!.at).toBeGreaterThanOrEqual(SMOKE_SLOW_INTERVAL_MS * 0.8);
    }, 30_000);

    it('leaves the other scripts as they were', async () => {
        const { chunks } = await stream([{ role: 'user', content: 'smoke stream' }], 1);
        expect(chunks[0]!.delta.content).toBe('## A long answer\n\n');
        const plain = await stream([{ role: 'user', content: 'Reply with exactly the word: pelican' }]);
        expect(plain.chunks[0]!.delta.content).toBe('pelican, from the fake model.');
    }, 30_000);
});
