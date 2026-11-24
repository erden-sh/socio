import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    RECONNECT_MAX_MS,
    reconnectDelay,
    recoverTurn as recoverWith,
    refusedForUpdate,
    refusedTurn,
    serverAway,
    sleep,
    type Outcome,
} from '@socio/shared/reconnect';

// CB-108: riding out a restart, shared by the web and the native app. Waiting
// with backoff, and sending a turn again only when the next server doesn't have
// it. Each client reads its own errors (packages/client/tests/reconnect.test.ts,
// apps/mobile/tests/net/reconnect.test.ts); here an error the server is away
// with says so (`cutOff`), or is a refusal while draining.
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** An HTTP error as a client throws it: a status, and the body it read. */
const httpError = (status: number, payload: unknown) =>
    Object.assign(new Error(`HTTP ${status}: ${JSON.stringify(payload)}`), {
        status,
        payload,
    });
const draining = httpError(503, {
    error: 'Socio is updating. Try again in a minute.',
    code: 'draining',
});
/** A request that broke off, or a proxy's page: the server is away. */
const cutOff = (message = 'network error') => Object.assign(new Error(message), { away: true });
const away = (error: unknown) =>
    refusedForUpdate(error) || (!!error && typeof error === 'object' && (error as { away?: unknown }).away === true);

/** A message as recovery sees it (the clients' are AG-UI's). */
interface Message {
    id: string;
    role: string;
    content: string;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}

/** Shared's `recoverTurn`, reading errors with `away`. */
const recoverTurn = <T>(options: Omit<Parameters<typeof recoverWith<Message, T>>[0], 'away'>) =>
    recoverWith<Message, T>({ away, ...options });

it('backs off from 1 s, doubling up to 10 s, with jitter', () => {
    const middle = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 10].map((attempt) => reconnectDelay(attempt, middle))).toEqual([
        1000, 2000, 4000, 8000, 10_000, 10_000, 10_000,
    ]);
    expect(reconnectDelay(0, () => 0)).toBe(750);
    expect(reconnectDelay(0, () => 0.999)).toBeLessThanOrEqual(1250);
    expect(reconnectDelay(9, () => 0.999)).toBe(RECONNECT_MAX_MS);
});

describe('serverAway', () => {
    it('is away when refused while draining, behind a proxy that answers for it, or with no answer', () => {
        for (const failure of [
            { status: 503, code: 'draining' },
            { code: 'draining' },
            { status: 502 },
            { status: 504 },
            { status: 502, unreadable: true },
            { status: 503, unreadable: true },
            { network: true },
        ]) {
            expect(serverAway(failure), JSON.stringify(failure)).toBe(true);
        }
    });

    it('is not away for an error the server explained, or a stop', () => {
        for (const failure of [
            { status: 503 },
            { status: 503, code: 'setup' },
            { status: 500 },
            { status: 401, code: 'sign_in' },
            { status: 404, unreadable: true },
            { aborted: true },
            { aborted: true, network: true },
            { aborted: true, code: 'draining' },
            { status: 500, network: true },
            {},
        ]) {
            expect(serverAway(failure), JSON.stringify(failure)).toBe(false);
        }
    });
});

it('reads a refusal while draining from the error or its body', () => {
    expect(refusedForUpdate(draining)).toBe(true);
    expect(refusedForUpdate(Object.assign(new Error('Socio is updating.'), { status: 503, code: 'draining' }))).toBe(
        true,
    );
    expect(refusedForUpdate(httpError(503, { error: 'Setup required: a model.' }))).toBe(false);
    expect(refusedForUpdate(httpError(503, '{"code":"draining"}'))).toBe(false);
    expect(refusedForUpdate(undefined)).toBe(false);
    expect(refusedForUpdate('draining')).toBe(false);
});

it('sleeps, or stops with the signal', async () => {
    vi.useFakeTimers();
    let slept = false;
    void sleep(1000).then(() => (slept = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(slept).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(slept).toBe(true);
    const stop = new AbortController();
    const waiting = sleep(1000, stop.signal);
    stop.abort(new Error('stopped'));
    await expect(waiting).rejects.toThrow('stopped');
    await expect(sleep(1000, stop.signal)).rejects.toThrow('stopped');
});

/** An agent whose messages the server's replay sets, as the clients' are. */
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

it('sends a refused turn again once the next server is up, with the same message', async () => {
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

it('never sends a turn twice: one the server accepted shows from its replay', async () => {
    const agent = agentWith([...earlier, turn]);
    // Cut off after the server took it: its replay has the turn and what
    // it stored (an answer, or the restart's notice).
    const stored: Message[] = [
        ...earlier,
        turn,
        { id: 'a1', role: 'assistant', content: 'Answered before the restart' },
    ];
    const connect = vi.fn(async () => {
        agent.setMessages(stored);
        return {};
    });
    const run = vi.fn(async () => ({ value: 'twice' }));
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: cutOff(),
        connect,
        run,
        ready,
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ resent: false });
    expect(run).not.toHaveBeenCalled();
    expect(agent.messages).toEqual(stored);
});

it('checks again after a resend breaks off, so a turn the server took is not sent a third time', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = agentWith([...earlier, turn]);
    let accepted = false;
    const connect = vi.fn(async (): Promise<Outcome<unknown>> => {
        // The first connect fails (the proxy's 502), the second one comes
        // before the resend, the third after it.
        if (connect.mock.calls.length === 1) {
            return { error: cutOff('<html>Bad gateway</html>') };
        }
        agent.setMessages(accepted ? [...earlier, turn] : [...earlier]);
        return {};
    });
    const run = vi.fn(async (): Promise<Outcome<string>> => {
        accepted = true;
        return { error: cutOff() };
    });
    const waits: number[] = [];
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect,
        run,
        ready,
        onWait: () => waits.push(connect.mock.calls.length),
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ resent: false });
    expect(connect).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([0, 1, 2]);
});

it('keeps the transcript shown when a replay fails, and returns an error the server explained', async () => {
    const agent = agentWith([...earlier, turn]);
    const refused = httpError(403, { error: 'Conversation scope denied.' });
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect: async () => ({ error: refused }),
        run: async () => ({ value: 'never' }),
        ready,
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ error: refused, resent: false });
    expect(agent.messages).toEqual([...earlier, turn]);
    const failed = new Error('The model refused.');
    const agentAgain = agentWith([...earlier, turn]);
    expect(
        await recoverTurn({
            agent: agentAgain,
            message: turn,
            failed: draining,
            connect: async () => {
                agentAgain.setMessages([...earlier]);
                return {};
            },
            run: async () => ({ error: failed }),
            ready,
            signal: new AbortController().signal,
        }),
    ).toEqual({ error: failed, resent: true });
});

/** A `ready` that waits until its signal aborts: the server stays away. */
const never = ({ signal }: { signal: AbortSignal }) =>
    new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));

it('gives up when stopped while waiting, knowing whether the server has the turn', async () => {
    for (const [failed, unsent] of [
        // Refused while draining: the server never took it.
        [draining, true],
        // Cut off: it may have.
        [cutOff(), false],
    ] as const) {
        const stop = new AbortController();
        const run = vi.fn(async () => ({ value: 'never' }));
        const waiting = recoverTurn({
            agent: agentWith([...earlier, turn]),
            message: turn,
            failed,
            connect: async () => ({}),
            run,
            ready: never,
            signal: stop.signal,
        });
        stop.abort();
        expect(await waiting).toEqual({ resent: false, gaveUp: 'stopped', unsent });
        expect(run).not.toHaveBeenCalled();
    }
});

it('shows the turn the server has when stopped while its replay streams, and never sends it', async () => {
    const stop = new AbortController();
    const agent = agentWith([...earlier, turn]);
    const run = vi.fn(async () => ({ value: 'twice' }));
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: cutOff(),
        // Reattached to the run still going: the person stops it mid-reply.
        connect: async () => {
            agent.setMessages([...earlier, turn]);
            stop.abort();
            agent.addMessage({ id: 'a1', role: 'assistant', content: 'Half an' });
            return {};
        },
        run,
        ready,
        signal: stop.signal,
    });
    expect(result).toEqual({ resent: false });
    expect(run).not.toHaveBeenCalled();
    expect(agent.messages.map((message) => message.id)).toEqual(['u0', 'a0', 'u1', 'a1']);
});

it('gives up waiting after the limit, counted from when the server last answered', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = agentWith([...earlier, turn]);
    let back = true;
    // A resend the server takes and answers for 5 s, then the stream breaks.
    const run = vi.fn(async (): Promise<Outcome<string>> => {
        back = false;
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { error: cutOff() };
    });
    let result: unknown;
    void recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect: async () => {
            agent.setMessages([...earlier]);
            return {};
        },
        run,
        ready: (options) => (back ? Promise.resolve() : never(options)),
        limit: 2000,
        signal: new AbortController().signal,
    }).then((ended) => (result = ended));
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
    // Past the limit since it started, but not since the server answered.
    await vi.advanceTimersByTimeAsync(1999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // The server may have it: never "not sent".
    expect(result).toEqual({ resent: false, gaveUp: 'timeout', unsent: false });
    expect(run).toHaveBeenCalledTimes(1);
});

// A page review the socio asked for, and the person's approval, shown.
const review: Message = {
    id: 'a1',
    role: 'assistant',
    content: '',
    toolCalls: [
        {
            id: 'review1',
            type: 'function',
            function: { name: 'review_space_page', arguments: '{}' },
        },
    ],
};
const approval: Message = {
    id: 't1',
    role: 'tool',
    toolCallId: 'review1',
    content: '{"approved":true}',
};

it('tells the turn refused while draining from the run carrying on after its review', () => {
    expect(refusedTurn(agentWith([...earlier, turn]), turn, draining)).toBe(true);
    expect(refusedTurn(agentWith([...earlier, turn, review, approval]), turn, draining)).toBe(false);
    expect(refusedTurn(agentWith([...earlier, turn]), turn, cutOff())).toBe(false);
});

it('knows the server has a turn whose review was approved while draining, stopped or timed out', async () => {
    for (const gaveUp of ['stopped', 'timeout'] as const) {
        const stop = new AbortController();
        const agent = agentWith([...earlier, turn, review, approval]);
        const run = vi.fn(async () => ({ value: 'twice' }));
        const waiting = recoverTurn({
            agent,
            message: turn,
            // The client's run reports the refusal of the run carrying on.
            failed: draining,
            connect: async () => ({}),
            run,
            ready: never,
            limit: gaveUp === 'timeout' ? 10 : undefined,
            signal: stop.signal,
        });
        if (gaveUp === 'stopped') {
            stop.abort();
        }
        expect(await waiting).toEqual({ resent: false, gaveUp, unsent: false });
        expect(run).not.toHaveBeenCalled();
    }
});

it('shows the review again from the replay once the server is back, never sending the turn', async () => {
    const agent = agentWith([...earlier, turn, review, approval]);
    const stored = [...earlier, turn, review];
    const run = vi.fn(async () => ({ value: 'twice' }));
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect: async () => {
            agent.setMessages([...agent.messages, ...stored]);
            return {};
        },
        run,
        ready,
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ resent: false });
    expect(run).not.toHaveBeenCalled();
    // Without the approval the server never got: the review is open again.
    expect(agent.messages).toEqual(stored);
});

it('knows the server has a resent turn once the run carrying on after it is refused', async () => {
    const stop = new AbortController();
    const agent = agentWith([...earlier, turn]);
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        connect: async () => {
            agent.setMessages([...earlier]);
            return {};
        },
        run: async () => {
            // The resend is answered with a review; the person approves and
            // stops as the run carrying on is refused.
            agent.addMessage(review);
            agent.addMessage(approval);
            stop.abort();
            return { error: draining };
        },
        ready,
        signal: stop.signal,
    });
    expect(result).toEqual({ resent: true, gaveUp: 'stopped', unsent: false });
});

it('counts the limit from the end of a replay that streamed, then broke off', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = agentWith([...earlier, turn]);
    let back = true;
    let result: unknown;
    void recoverTurn({
        agent,
        message: turn,
        failed: cutOff(),
        // The replay streams for 5 s (another run on the thread), then breaks.
        connect: async () => {
            back = false;
            agent.setMessages([...earlier]);
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return { error: cutOff() };
        },
        run: async () => ({ value: 'never' }),
        ready: (options) => (back ? Promise.resolve() : never(options)),
        limit: 2000,
        signal: new AbortController().signal,
    }).then((ended) => (result = ended));
    await vi.advanceTimersByTimeAsync(5000 + 1999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ resent: false, gaveUp: 'timeout', unsent: false });
    // The transcript shown stays.
    expect(agent.messages).toEqual([...earlier, turn]);
});

it('waits between attempts with the pause it is given, backing off', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const agent = agentWith([...earlier, turn]);
    const pauses: number[] = [];
    let connects = 0;
    const result = await recoverTurn({
        agent,
        message: turn,
        failed: draining,
        // Two connects break off before the third replays the conversation.
        connect: async () => {
            if (++connects < 3) {
                return { error: cutOff() };
            }
            agent.setMessages([...earlier]);
            return {};
        },
        run: async () => ({ value: 'answered' }),
        ready,
        pause: async (ms) => {
            pauses.push(ms);
        },
        signal: new AbortController().signal,
    });
    expect(result).toEqual({ value: 'answered', resent: true });
    expect(pauses).toEqual([1000, 2000]);
});
