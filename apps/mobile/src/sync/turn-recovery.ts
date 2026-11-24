import type { BaseEvent } from '@ag-ui/core';

import { type Identified, type RecoveringAgent, recoverTurn, RECOVERY_LIMIT_MS } from '@socio/shared/reconnect';
import { AG_UI_EVENT } from '@socio/shared/runs/event-types';

import type { AuthedFetch } from '../net/authed-fetch';
import { NetworkError } from '../net/errors';
import type { RunFailure } from '../net/run-answer';
import { createRunClient } from '../net/run-client';

import { HeldForSignIn } from './outbox';

// A turn's recovery for the durable outbox:
// shared's `recoverTurn`, the web's way back from a turn that broke off,
// wrapped so the outbox stays the one that sends.
//
// - **What it asks.** `connect` replays the chat's runs after the newest one
//   the phone holds and streams the running one: the row's message id in a
//   run's input (RUN_STARTED's `input.messages`) means the server has the
//   turn. A replay without it asks `stored(id)`, a fresh pull of the history.
//   The connect stops at the first run's start, so a check never streams a
//   turn to its end: a run of someone else's that started first says only
//   "not in that one", which the caller takes as "can't tell while a turn
//   runs", never as "not sent".
// - **It never sends.** Where `recoverTurn` would send the turn again, this
//   answers `absent`, and the outbox puts the row back in its lane, whose
//   send pulls and goes as a run or as steering by the rules of the moment.
// - **Waiting** is the outbox's back-off, with no limit, since the row is
//   kept on disk: the first wait for the server is the caller's fresh pull,
//   and a later one (after a replay that broke off) probes once; a server
//   that doesn't answer rejects with a `NetworkError`, which the outbox
//   backs off from. `gaveUp` (the row's request stopped, or `limit` passed)
//   leaves the row `unknown`: it is checked again, never sent on a guess.
// - **After a restart** a row that was in flight is `unknown` (outbox.ts), and its
//   check starts here: `connect`, then `stored(id)`.
//
// No React Native: tests/sync runs it under Node against a fake server.

/** What a turn's recovery found. */
export type TurnRecovery =
    /** The server has the message: a run's input holds it, or its history does. */
    | 'stored'
    /** Neither the replay nor the history has it: where recoverTurn would send it again. */
    | 'absent'
    /** It stopped waiting (`gaveUp`): the row stays `unknown`. */
    | 'gave-up';

export interface TurnRecoveryInput {
    /** The row's message id, which a run carries. */
    readonly id: string;
    readonly dotId: string;
    readonly threadId: string;
    /** The newest stored run's seq the phone holds (after a fresh pull), for `x-cb-history-after`. */
    readonly after: number | null;
    /** The row's request's authedFetch (`context.fetch`). */
    readonly fetch: AuthedFetch;
    /** The row's signal (`context.signal`). */
    readonly signal: AbortSignal;
    readonly newId: () => string;
    /** Whether the server stored the message: a fresh pull of the history, then its ids. */
    readonly stored: (id: string) => Promise<boolean>;
    /** Whether the server answers now (a fresh pull of the chat): after the first try only. */
    readonly probe: () => Promise<boolean>;
    /** How long it waits for the server in all (shared's `RECOVERY_LIMIT_MS`). */
    readonly limit?: number;
}

/** A replay that broke off for a reason other than the person's or the app's stop. */
class ReplayFailed extends Error {
    override name = 'ReplayFailed';

    constructor(readonly failure: RunFailure) {
        super('The replay broke off.');
    }
}

/** The user message ids a replayed event carries: a run's input, or a queued message delivered into a turn. */
function messageIds(event: BaseEvent): string[] {
    if (event.type === AG_UI_EVENT.RUN_STARTED) {
        const messages = (event as { input?: { messages?: unknown } }).input?.messages;
        return Array.isArray(messages)
            ? messages
                  .map((message) => (message as { id?: unknown } | null)?.id)
                  .filter((id): id is string => typeof id === 'string')
            : [];
    }
    if (event.type === AG_UI_EVENT.TEXT_MESSAGE_START && (event as { role?: unknown }).role === 'user') {
        const id = (event as { messageId?: unknown }).messageId;
        return typeof id === 'string' ? [id] : [];
    }
    return [];
}

/** Whether the server has a run's message: shared's `recoverTurn` with the outbox in place of its resend. */
export async function recoverRun(input: TurnRecoveryInput): Promise<TurnRecovery> {
    const { id, dotId, threadId, after, signal, newId, stored, probe, limit = RECOVERY_LIMIT_MS } = input;
    let signIn: unknown = null;
    const fetch: AuthedFetch = async (path, init) => {
        try {
            return await input.fetch(path, init);
        } catch (error) {
            if (error instanceof HeldForSignIn) {
                signIn = error;
            }
            throw error;
        }
    };
    const client = createRunClient({ fetch, newId });
    const agent: RecoveringAgent = {
        messages: [],
        setMessages(messages) {
            agent.messages = [...messages];
        },
        addMessage(message) {
            agent.messages = [...agent.messages, message];
        },
    };
    let tries = 0;
    const recovery = await recoverTurn<Identified, 'absent'>({
        agent,
        message: { id },
        failed: null,
        signal,
        away: (error) => error instanceof ReplayFailed && error.failure.action === 'retry',
        async ready() {
            // The caller pulled the chat just now; after a replay that broke off, ask once.
            if (tries++ > 0 && !(await probe())) {
                throw new NetworkError(`/api/conversations/${encodeURIComponent(threadId)}`);
            }
        },
        limit,
        stored,
        async connect() {
            const stop = new AbortController();
            const relay = () => stop.abort(signal.reason);
            signal.addEventListener('abort', relay, { once: true });
            let enough = false;
            try {
                const outcome = await client.connect(dotId, threadId, {
                    signal: stop.signal,
                    ...(after === null ? {} : { after }),
                    onEvent: (event) => {
                        const ids = messageIds(event);
                        if (ids.length > 0) {
                            agent.setMessages([...agent.messages, ...ids.map((known) => ({ id: known }))]);
                        }
                        if (event.type === AG_UI_EVENT.RUN_STARTED || ids.includes(id)) {
                            // What a check asks is in the first run's start: never stream the turn.
                            enough = true;
                            stop.abort();
                        }
                    },
                });
                if (outcome.kind !== 'failed' || (enough && !signal.aborted)) {
                    return {};
                }
                return { error: new ReplayFailed(outcome.failure) };
            } finally {
                signal.removeEventListener('abort', relay);
            }
        },
        // Where the web sends the turn again, the outbox does, from its lane.
        run: async () => ({ value: 'absent' as const }),
    });
    if (signIn !== null) {
        throw signIn;
    }
    if (recovery.gaveUp !== undefined) {
        return 'gave-up';
    }
    if (recovery.resent) {
        return 'absent';
    }
    if (agent.messages.some((message) => message.id === id) || recovery.error === undefined) {
        return 'stored';
    }
    // A replay that failed for a reason the server explained: can't tell now.
    throw new NetworkError(`/api/copilotkit/agent/${encodeURIComponent(dotId)}/connect`);
}
