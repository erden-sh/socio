import type { Message } from '@ag-ui/core';
import { afterEach, expect, it, vi } from 'vitest';

import type { Outcome } from '@socio/shared/reconnect';

import { ApiError, UNREADABLE_RESPONSE } from '../src/lib/api';
import { HEALTH_PATH, recoverTurn, serverAway, serverReady, waitForServer } from '../src/shell/reconnect';

// CB-108: riding out a restart, the browser's side. The backoff and the turn's
// recovery are @socio/shared/reconnect's, tested in tests/shared-reconnect.test.ts;
// here, how the browser's errors read and how it waits for the server.
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** What the runtime client throws for an HTTP error (@ag-ui/client). */
const httpError = (status: number, payload: unknown) =>
    Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(payload)}`), {
        status,
        payload,
    });
const draining = httpError(503, {
    error: 'Socio is updating. Try again in a minute.',
    code: 'draining',
});

it('tells a server that is away or restarting from an error it explained', () => {
    for (const away of [
        draining,
        new ApiError('Socio is updating.', 503, 'draining'),
        httpError(502, '<html>Bad gateway</html>'),
        httpError(504, 'Gateway timeout'),
        httpError(503, '<html>Service unavailable</html>'),
        new ApiError(UNREADABLE_RESPONSE, 502),
        new ApiError(UNREADABLE_RESPONSE, 503),
        new TypeError('Failed to fetch'),
        new TypeError('NetworkError when attempting to fetch resource.'),
        new TypeError('Load failed'),
        new TypeError('network error'),
        new TypeError('Error in input stream'),
    ]) {
        expect(serverAway(away), String(away)).toBe(true);
    }
    for (const explained of [
        httpError(503, { error: 'Setup required: a model.' }),
        new ApiError('Setup required: a model.', 503),
        httpError(500, { error: 'Thread already running' }),
        httpError(401, { error: 'Sign in to continue.', code: 'sign_in' }),
        new ApiError('Not found.', 404),
        new Error('The model refused.'),
        new TypeError("Cannot read properties of undefined (reading 'id')"),
        new DOMException('The user aborted a request.', 'AbortError'),
        undefined,
        'Failed to fetch',
    ]) {
        expect(serverAway(explained), String(explained)).toBe(false);
    }
});

it('waits for a server that answers and is not draining, never from a cache', async () => {
    vi.useFakeTimers();
    const answers: Array<() => Promise<Response>> = [
        () => Promise.reject(new TypeError('Failed to fetch')),
        async () => new Response('<html>Bad gateway</html>', { status: 502 }),
        async () => Response.json({ ok: true, draining: true }),
        async () => Response.json({ ok: true, model: true }),
    ];
    const request = vi.fn(async (_path: string | URL | Request, _init?: RequestInit) => answers.shift()!());
    let up = false;
    void waitForServer({
        request: request as typeof fetch,
        random: () => 0.5,
    }).then(() => (up = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    // 1 s, then 2 s, then 4 s between the questions.
    await vi.advanceTimersByTimeAsync(1000);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);
    expect(up).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(request).toHaveBeenCalledTimes(4);
    expect(up).toBe(true);
    expect(request.mock.calls[0]).toEqual([HEALTH_PATH, expect.anything()]);
    expect(request.mock.calls[0]![1]).toMatchObject({ cache: 'no-store' });
});

it('stops waiting when its signal aborts', async () => {
    const stop = new AbortController();
    const waited = waitForServer({
        signal: stop.signal,
        request: (async () => Response.json({ ok: true, draining: true })) as typeof fetch,
    });
    stop.abort();
    await expect(waited).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
        serverReady((async () => {
            throw new TypeError('Failed to fetch');
        }) as typeof fetch),
    ).resolves.toBe(false);
});

/** An agent whose messages the server's replay sets, as CopilotKit's. */
function agentWith(shown: Message[]) {
    const agent = {
        messages: shown,
        setMessages(next: Message[]) {
            agent.messages = next;
        },
        addMessage(message: Message) {
            agent.messages = [...agent.messages, message];
        },
    };
    return agent;
}
const earlier: Message[] = [
    { id: 'u0', role: 'user', content: 'Earlier question' },
    { id: 'a0', role: 'assistant', content: 'Earlier answer' },
];
const turn: Message = { id: 'u1', role: 'user', content: 'Hello again' };
const ready = async () => {};

it("recovers a turn with shared's recoverTurn, reading the browser's errors", async () => {
    const agent = agentWith([...earlier, turn]);
    // The next server's replay: the conversation without the refused turn.
    const connect = vi.fn(async (): Promise<Outcome<unknown>> => {
        agent.setMessages([...earlier]);
        return {};
    });
    const sent: Message[][] = [];
    const run = vi.fn(async (): Promise<Outcome<string>> => {
        sent.push(agent.messages);
        return { value: 'answered' };
    });
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect,
        run,
        ready,
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ value: 'answered', resent: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sent[0]!.map((message) => message.id)).toEqual(['u0', 'a0', 'u1']);
});

it('waits through a broken-off resend the browser reports as a TypeError', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = agentWith([...earlier, turn]);
    let accepted = false;
    const connect = vi.fn(async (): Promise<Outcome<unknown>> => {
        agent.setMessages(accepted ? [...earlier, turn] : [...earlier]);
        return {};
    });
    const run = vi.fn(async (): Promise<Outcome<string>> => {
        accepted = true;
        return { error: new TypeError('network error') };
    });
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect,
        run,
        ready,
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ resent: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
});
