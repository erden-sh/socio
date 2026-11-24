/**
 * A fake `codex app-server` peer for the session-host test
 * (tests/coding-session-host.test.ts). Speaks the JSON-RPC newline protocol the
 * vendored `effect-codex-app-server` client expects: reads requests from stdin,
 * writes responses + notifications to stdout.
 *
 * The codex client strictly decodes every known notification/response against
 * its generated schema and *drops* anything that fails, so the peer emits
 * schema-valid payloads. The minimal seeds below were validated once with
 * `Schema.decodeUnknownSync` against `effect-codex-app-server/schema`; they
 * are inlined here as plain JSON so the fixture does not depend on the
 * generated schema module at lint/runtime.
 *
 * Behavior:
 *  - `initialize` → mock userAgent.
 *  - `initialized` → no-op (the client treats the session as ready).
 *  - `thread/start` → responds with a valid thread, emits `thread/started`.
 *  - `turn/start` → responds with a running turn, emits `turn/started` then
 *    `turn/completed` (the adapter maps these to `provider_turn.updated` +
 *    `turn.terminal(completed)`).
 *  - `turn/steer`/`turn/interrupt` → empty response.
 *
 * Run as a script: `node --import tsx tests/support/fake-codex-peer.ts`.
 * The session-host entry spawns it via `SOCIO_HOST_CODEX_BIN`.
 */

const writeMessage = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};

const respond = (id: number | string, result: unknown): void => {
    writeMessage({ id, result });
};

const threadId = 'thread-1';
const turnId = 'turn-1';
const now = () => Math.floor(Date.now() / 1000);
let forkCounter = 0;

// Minimal schema-valid payloads (validated once against the client's schema).
const threadStartResult = {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    cwd: '/work/repo',
    model: 'gpt-5',
    modelProvider: 'socio',
    sandbox: { type: 'dangerFullAccess' },
    thread: {
        id: threadId,
        cliVersion: '0',
        createdAt: now(),
        cwd: '/work/repo',
        ephemeral: false,
        modelProvider: 'socio',
        preview: 'p',
        projectId: null,
        sessionId: 's1',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
        updatedAt: now(),
    },
};

const turnStartResult = {
    turn: { id: turnId, status: 'inProgress', items: [] },
};

const threadStartedParams = {
    thread: {
        id: threadId,
        cliVersion: '0',
        createdAt: now(),
        cwd: '/work/repo',
        ephemeral: false,
        modelProvider: 'socio',
        preview: 'p',
        projectId: null,
        sessionId: 's1',
        source: 'appServer',
        status: { type: 'idle' },
        turns: [],
        updatedAt: now(),
    },
};

const turnStartedParams = {
    threadId,
    turn: { id: turnId, status: 'inProgress', items: [] },
};

const turnCompletedParams = {
    threadId,
    turn: { id: turnId, status: 'completed', items: [] },
};

const handleRequest = (message: Record<string, unknown>): void => {
    const method = message.method;
    const id = message.id as number | string | undefined;
    if (typeof method !== 'string') {
        return;
    }
    switch (method) {
        case 'initialize': {
            respond(id!, {
                userAgent: 'fake-codex-peer',
                codexHome: process.cwd(),
                platformFamily: 'unix',
                platformOs: 'linux',
            });
            return;
        }
        case 'initialized': {
            return;
        }
        case 'thread/start': {
            respond(id!, threadStartResult);
            writeMessage({ method: 'thread/started', params: threadStartedParams });
            return;
        }
        case 'turn/start': {
            respond(id!, turnStartResult);
            writeMessage({ method: 'turn/started', params: turnStartedParams });
            // The turn completes immediately in the fake; the adapter maps
            // turn/completed → turn.terminal(completed).
            writeMessage({ method: 'turn/completed', params: turnCompletedParams });
            return;
        }
        case 'turn/steer':
        case 'turn/interrupt': {
            respond(id!, {});
            return;
        }
        case 'thread/read': {
            // thread/read returns the thread metadata; the adapter only needs it
            // to confirm the thread exists before listing turns.
            respond(id!, threadStartResult);
            return;
        }
        case 'thread/turns/list': {
            respond(id!, {
                data: [{ id: turnId, status: 'completed', items: [], startedAt: now(), completedAt: now() }],
                nextCursor: null,
            });
            return;
        }
        case 'thread/revert': {
            // thread/revert replaces durable history before beforeTurnId; respond
            // with the (now-truncated) thread and emit thread/reverted so the
            // adapter maps it to provider_thread.updated.
            respond(id!, threadStartResult);
            writeMessage({ method: 'thread/reverted', params: { threadId } });
            return;
        }
        case 'thread/fork': {
            // thread/fork creates a new native thread from the source; respond
            // with a new thread id so forkThread returns a distinct providerThread.
            forkCounter += 1;
            const forkedId = `thread-fork-${forkCounter}`;
            respond(id!, {
                ...threadStartResult,
                thread: { ...threadStartResult.thread, id: forkedId },
            });
            return;
        }
        default: {
            if (id !== undefined) {
                respond(id, {});
            }
        }
    }
};

let remainder = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    remainder += chunk;
    const lines = remainder.split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const message = JSON.parse(trimmed) as Record<string, unknown>;
            if ('method' in message) {
                handleRequest(message);
            }
        } catch {
            // A malformed line is ignored.
        }
    }
});

process.stdin.on('end', () => {
    process.exit(0);
});
