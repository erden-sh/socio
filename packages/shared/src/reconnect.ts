/**
 * Riding out a restart (CB-108), for the web and the native app. A deploy
 * drains the old server (running turns finish, new ones get 503 `draining`),
 * then the proxy answers 502 or nothing until the new one listens. A client
 * waits for the next server instead of showing an error, with backoff, and
 * sends a refused turn again once it is up, never one the server already has.
 *
 * Nothing here knows a platform: each client turns its own errors into a
 * `Failure` for `serverAway`, and hands `recoverTurn` how to wait for the
 * server (`ready`) and how to read its errors (`away`). Hermes runs this too.
 */

/** The first wait between attempts; it doubles up to `RECONNECT_MAX_MS`. */
export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 10_000;
/** How long a turn waits for the server before it gives up. */
export const RECOVERY_LIMIT_MS = 10 * 60_000;

/** What a failed request says when the answer isn't the API's JSON. */
export const UNREADABLE_RESPONSE = 'Server returned an unreadable response.';

/**
 * The wait before attempt `attempt + 1`: 1 s, 2 s, 4 s… up to 10 s, give or
 * take a quarter, so the clients of a whole team don't all ask at once.
 */
export function reconnectDelay(attempt: number, random = Math.random) {
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** attempt);
    return Math.min(RECONNECT_MAX_MS, Math.round(base * (0.75 + random() * 0.5)));
}

/**
 * Whether the server refused the request because it is draining (503
 * `draining`): it never took it, so sending it again is safe. Reads the
 * error's `code`, or its `payload`'s (the API's JSON body).
 */
export function refusedForUpdate(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const { payload, code } = error as { payload?: unknown; code?: unknown };
    return (
        code === 'draining' ||
        (!!payload && typeof payload === 'object' && (payload as { code?: unknown }).code === 'draining')
    );
}

/** What a client knows about a failed request, for `serverAway`. */
export interface Failure {
    /** The HTTP status, when the server or a proxy answered. */
    status?: number;
    /** The API's error code, from its JSON body (`draining`, `sign_in`…). */
    code?: string;
    /** The body wasn't the API's JSON: a proxy's page, not the server's answer. */
    unreadable?: boolean;
    /** No answer at all, or one that broke off. */
    network?: boolean;
    /** A stop the person or the app asked for. */
    aborted?: boolean;
}

/**
 * Whether a failed request means the server is away or restarting, so waiting
 * and trying again will do: refused while draining (503 `draining`), the
 * proxy's 502 or 504 or a page that isn't the API's (an unreadable 503), or no
 * answer at all. Never a stop the person or the app asked for, nor an error
 * the server explained.
 */
export function serverAway({ status, code, unreadable, network, aborted }: Failure): boolean {
    if (aborted) {
        return false;
    }
    if (code === 'draining') {
        return true;
    }
    if (status !== undefined) {
        // The API answers in JSON; a proxy's error page doesn't.
        return status === 502 || status === 504 || (status === 503 && !!unreadable);
    }
    return !!network;
}

/** Waits `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            return reject(signal.reason);
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', stop);
            resolve();
        }, ms);
        const stop = () => {
            clearTimeout(timer);
            reject(signal!.reason);
        };
        signal?.addEventListener('abort', stop, { once: true });
    });
}

/** One try: what it returned, or the error it ended with. */
export interface Outcome<T> {
    value?: T;
    error?: unknown;
}

/** How a turn's recovery ended (`recoverTurn`). */
export interface Recovery<T> extends Outcome<T> {
    /** The outcome is that of sending the turn again. */
    resent: boolean;
    /** It stopped waiting: a stop, or the server didn't come back in time. */
    gaveUp?: 'stopped' | 'timeout';
    /**
     * With `gaveUp`: the server is known not to have the turn, because it
     * refused it while draining before answering any of it (`refusedTurn`).
     * Otherwise the server may have it.
     */
    unsent?: boolean;
}

/** A message, as far as recovery reads it: its id. */
export interface Identified {
    id: string;
}

/** The conversation a client shows, which a connect's replay sets. */
export interface RecoveringAgent<M extends Identified = Identified> {
    messages: M[];
    setMessages(messages: M[]): void;
    addMessage(message: M): void;
}

/**
 * Whether `error` says the server never took the turn `message`: it was
 * refused while draining (`refusedForUpdate`) and nothing came back after it.
 * A run also carries on after a frontend tool (a page review's approval), and
 * its error is that run's: once the reply follows the turn, a refusal is one
 * of those, and the server has the turn.
 */
export function refusedTurn<M extends Identified>(agent: { messages: M[] }, message: M, error: unknown): boolean {
    return refusedForUpdate(error) && agent.messages.at(-1)?.id === message.id;
}

/**
 * A turn whose request the server didn't take or didn't finish answering
 * because it went away (`away`, with the error it `failed` with): waits for
 * the next server (`ready`), then reconnects, which replays the conversation
 * as the server stored it. If the replay has `message` (its id), or the server
 * says it stored it (`stored`: a chat whose replay holds only its newest turns,
 * CB-136), the server accepted the turn before it went away: the replay shows
 * what it stored, and streams the run if it is still going, and the turn is
 * never sent again. What the server never got goes, such as a page review's
 * approval whose run was refused: the client opens the review again for a
 * decision. If not, the turn is sent again with the same message. Breaking off
 * again starts over, with backoff (`pause`).
 *
 * `signal` stops it. While it waits, that gives up at once (`gaveUp`); once the
 * server is back (`onBack`) the connect or resend is the person's run, which
 * the caller stops, and a replay with the turn is still shown. Waiting gives up
 * by itself after `limit` without hearing from the server.
 */
export async function recoverTurn<M extends Identified, T>({
    agent,
    message,
    failed,
    connect,
    run,
    signal,
    ready,
    away,
    pause = sleep,
    limit = RECOVERY_LIMIT_MS,
    stored,
    onWait,
    onBack,
}: {
    agent: RecoveringAgent<M>;
    message: M;
    /** The error the first try ended with. */
    failed: unknown;
    connect: () => Promise<Outcome<unknown>>;
    run: () => Promise<Outcome<T>>;
    signal: AbortSignal;
    /** Resolves once the server is up and taking turns; rejects once its signal aborts. */
    ready: (options: { signal: AbortSignal }) => Promise<void>;
    /** Whether an error means the server is away (the client's `serverAway`). */
    away: (error: unknown) => boolean;
    /** The wait between attempts (`sleep`, or one that ends early when the network is back). */
    pause?: (ms: number, signal: AbortSignal) => Promise<void>;
    limit?: number;
    /**
     * Whether the server stored a message, asked after a connect whose
     * replay doesn't have it: a chat that shows its history from its store
     * (CB-136) replays only its newest turns.
     */
    stored?: (id: string) => Promise<boolean>;
    /** Waiting for the server (each time it went away). */
    onWait?: () => void;
    /** The server is back: connecting, then sending again if it must. */
    onBack?: () => void;
}): Promise<Recovery<T>> {
    let unsent = refusedTurn(agent, message, failed);
    let deadline = Date.now() + limit;
    for (let attempt = 0; ; attempt++) {
        onWait?.();
        const gaveUp = await waitUntil(deadline, signal, async (waiting) => {
            if (attempt) {
                await pause(reconnectDelay(attempt - 1), waiting);
            }
            await ready({ signal: waiting });
        });
        if (gaveUp) {
            return { resent: false, gaveUp, unsent };
        }
        onBack?.();
        const shown = agent.messages;
        // The connection replays the whole conversation: start from none.
        agent.setMessages([]);
        const connected = await connect();
        const stopped = signal.aborted;
        // The limit counts from when the server last answered: a replay that
        // streamed, however long, before it broke off.
        if (agent.messages.length) {
            deadline = Date.now() + limit;
        }
        if (
            agent.messages.some((shown) => shown.id === message.id) ||
            (!connected.error && !signal.aborted && !!stored && (await stored(message.id).catch(() => false)))
        ) {
            // The server has the turn. Only a replay cut short asks again.
            if (stopped) {
                return { resent: false };
            }
            if (!connected.error || !away(connected.error)) {
                return { error: connected.error, resent: false };
            }
            unsent = false;
            continue;
        }
        if (connected.error || stopped) {
            // A replay cut short leaves a partial transcript: keep the one shown.
            // Nor does it say the server doesn't have the turn.
            if (agent.messages.length < shown.length) {
                agent.setMessages(shown);
            }
            if (stopped) {
                return { resent: false, gaveUp: 'stopped', unsent };
            }
            if (away(connected.error)) {
                continue;
            }
            return { error: connected.error, resent: false };
        }
        agent.addMessage(message);
        const sent = await run();
        // The limit counts from when the server last answered.
        deadline = Date.now() + limit;
        if (sent.error && away(sent.error)) {
            unsent = refusedTurn(agent, message, sent.error);
            if (signal.aborted) {
                return { resent: true, gaveUp: 'stopped', unsent };
            }
            continue;
        }
        return { ...sent, resent: true };
    }
}

/** The reason a wait past its deadline aborts with. */
function timedOut() {
    const error = new Error('Waited too long.');
    error.name = 'TimeoutError';
    return error;
}

/**
 * Runs `wait` with a signal that aborts when `signal` does or `deadline`
 * passes. Which one ended it, or nothing once it finished.
 */
async function waitUntil(
    deadline: number,
    signal: AbortSignal,
    wait: (signal: AbortSignal) => Promise<void>,
): Promise<Recovery<unknown>['gaveUp']> {
    const waiting = new AbortController();
    const stop = () => waiting.abort(signal.reason);
    const timer = setTimeout(() => waiting.abort(timedOut()), Math.max(0, deadline - Date.now()));
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) {
        stop();
    }
    try {
        await wait(waiting.signal);
        return undefined;
    } catch (error) {
        if (signal.aborted) {
            return 'stopped';
        }
        if (waiting.signal.aborted) {
            return 'timeout';
        }
        throw error;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
    }
}
