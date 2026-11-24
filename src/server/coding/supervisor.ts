import { z } from 'zod';

import { redactSocioTokens, redactUrlUserinfo } from '@socio/foundation/actors/redact';

/**
 * Socio's client of the computer supervisor's sandbox API (CB-239,
 * `deployment/computers/coding-sandbox.mjs`). Every request carries only
 * what that API takes: a session id, a volume key, the proxy credential
 * Socio signed, and execs from the fixed set with their parameters. Never
 * an image, a mount, a capability or a command: the supervisor builds
 * those from its own code. The prompt goes in the exec's parameters, which
 * the supervisor writes to stdin (never argv or the environment).
 *
 * The supervisor's token travels only in the Authorization header, and
 * anything shaped like a Socio credential in an answer is redacted before
 * it is read (CB-232).
 */

export class SupervisorError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

export interface SupervisorOptions {
    /** `COMPUTER_SUPERVISOR_URL`. */
    url: string;
    /** `COMPUTER_SUPERVISOR_TOKEN` (the supervisor's `SUPERVISOR_TOKEN`). */
    token: string;
    fetch?: typeof fetch;
    /** Per request, unless a long poll asks for more. */
    timeoutMs?: number;
}

const created = z.object({
    sessionId: z.string(),
    state: z.literal('network-ready'),
    subnet: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/),
    proxyAddress: z.string().max(64),
});

const execView = z.object({
    runId: z.string(),
    kind: z.string(),
    state: z.enum(['running', 'exited', 'timed-out', 'failed']),
    exitCode: z.number().optional(),
    stdout: z.string().default(''),
    stderr: z.string().default(''),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }).partial().optional(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
});
export type ExecView = z.infer<typeof execView>;

const listing = z.object({
    sandboxes: z.array(
        z.object({
            sessionId: z.string(),
            state: z.string(),
            // A container whose network is gone.
            networkMissing: z.boolean().optional(),
        }),
    ),
});

export interface SocioIdentity {
    name: string;
    email: string;
}

export type ExecRequest =
    | { kind: 'token'; params: { token: string } }
    | {
          kind: 'setup';
          params: {
              repository: string;
              base: string;
              branch: string;
              identity: SocioIdentity;
          };
      }
    | {
          kind: 'prompt';
          params: {
              /** The CLI the supervisor runs (CB-326); `opencode` when left out. */
              harness?: 'opencode' | 'codex' | 'claude-code' | 'gemini-cli' | 'grok';
              /**
               * The harness's own session to continue: OpenCode's, always;
               * Codex's thread or the other harnesses' session (a UUID), absent for
               * a session's first prompt, which starts one.
               */
              session?: string;
              model: string;
              prompt: string;
              seconds?: number;
              identity: SocioIdentity;
              /** OpenCode's API: Responses for a session on the person's own plan. */
              api?: 'chat' | 'responses';
          };
      }
    | { kind: 'status'; params: Record<string, never> }
    | { kind: 'diff'; params: { base: string; path?: string } }
    | { kind: 'changes'; params: { base: string } };

/** The most of an answer read (an exec's output is at most 4 MB). */
const MAX_ANSWER = 6 * 1024 * 1024;

export class SandboxSupervisor {
    private fetchImpl: typeof fetch;
    constructor(private options: SupervisorOptions) {
        this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    }

    private async call(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: unknown,
        timeoutMs = this.options.timeoutMs ?? 30_000,
        signal?: AbortSignal,
    ): Promise<{ status: number; body: unknown }> {
        const base = this.options.url.replace(/\/$/, '');
        const timeout = AbortSignal.timeout(timeoutMs);
        let response: Response;
        try {
            response = await this.fetchImpl(`${base}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.options.token}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                redirect: 'error',
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
        } catch {
            throw new SupervisorError(503, 'The computer supervisor is unreachable.');
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                size += value.length;
                if (size > MAX_ANSWER) {
                    await reader.cancel().catch(() => undefined);
                    throw new SupervisorError(502, 'The supervisor answered too much.');
                }
                chunks.push(value);
            }
        }
        let text = Buffer.concat(chunks).toString('utf8');
        // Its own token never comes back into Socio's records; nor does any
        // credential shape, live or not, nor a URL's password, such as the
        // sandbox's proxy credential in its HTTP_PROXY.
        text = redactUrlUserinfo(redactSocioTokens(text.split(this.options.token).join('[redacted]')));
        let parsed: unknown = undefined;
        if (text.trim()) {
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = undefined;
            }
        }
        return { status: response.status, body: parsed };
    }

    private refused(status: number, body: unknown, what: string): never {
        const reason =
            body && typeof body === 'object' && 'error' in body
                ? String((body as { error: unknown }).error).slice(0, 200)
                : `HTTP ${status}`;
        throw new SupervisorError(status, `${what}: ${reason}`);
    }

    /** `POST /sandboxes`: the network and volume, and the proxy's address. */
    async create(input: { sessionId: string; volumeKey: string; cpus?: number; memoryBytes?: number; pids?: number }) {
        const { status, body } = await this.call('POST', '/sandboxes', input);
        if (status !== 200 && status !== 201) {
            this.refused(status, body, 'The sandbox could not be created');
        }
        const parsed = created.safeParse(body);
        if (!parsed.success || parsed.data.sessionId !== input.sessionId) {
            throw new SupervisorError(502, 'The supervisor answered unexpectedly.');
        }
        return parsed.data;
    }

    /** `POST /sandboxes/:id/start`, with the proxy credential Socio signed. */
    async start(sessionId: string, proxy: { user: string; password: string }) {
        const { status, body } = await this.call(
            'POST',
            `/sandboxes/${encodeURIComponent(sessionId)}/start`,
            { proxyUser: proxy.user, proxyPassword: proxy.password },
            120_000,
        );
        if (status !== 200) {
            this.refused(status, body, 'The sandbox could not be started');
        }
    }

    /**
     * `POST /sandboxes/:id/exec`: one exec from the fixed set, keyed by
     * `runId` (a retry re-attaches to it); waits up to `wait` seconds.
     */
    async exec(sessionId: string, runId: string, request: ExecRequest, wait?: number): Promise<ExecView> {
        const { status, body } = await this.call(
            'POST',
            `/sandboxes/${encodeURIComponent(sessionId)}/exec`,
            {
                runId,
                kind: request.kind,
                params: request.params,
                ...(wait ? { wait } : {}),
            },
            ((wait ?? 0) + 30) * 1000,
        );
        if (status !== 200 && status !== 202) {
            this.refused(status, body, 'The sandbox refused the command');
        }
        return this.view(body);
    }

    /** `GET /sandboxes/:id/exec/:runId`: any runtime may collect it. */
    async collect(sessionId: string, runId: string, wait = 0, signal?: AbortSignal): Promise<ExecView | undefined> {
        const { status, body } = await this.call(
            'GET',
            `/sandboxes/${encodeURIComponent(sessionId)}/exec/${encodeURIComponent(runId)}${wait ? `?wait=${Math.min(60, Math.max(0, Math.floor(wait)))}` : ''}`,
            undefined,
            (wait + 30) * 1000,
            signal,
        );
        if (status === 404) {
            return undefined;
        }
        if (status !== 200) {
            this.refused(status, body, 'The sandbox could not report the command');
        }
        return this.view(body);
    }

    private view(body: unknown): ExecView {
        const parsed = execView.safeParse(body);
        if (!parsed.success) {
            throw new SupervisorError(502, 'The supervisor answered unexpectedly.');
        }
        return parsed.data;
    }

    /** `DELETE /sandboxes/:id/exec/:runId`: forgets an ended run. */
    async forget(sessionId: string, runId: string) {
        await this.call(
            'DELETE',
            `/sandboxes/${encodeURIComponent(sessionId)}/exec/${encodeURIComponent(runId)}`,
        ).catch(() => undefined);
    }

    /**
     * `POST /sandboxes/:id/host` (CB-326 step 3): starts the session host
     * process in the sandbox. Idempotent for the same kind; 409 if a different
     * kind is running. The host reaches models only through Socio's gateway
     * (the `with-token` auth command), not a vendor host.
     */
    async startHost(sessionId: string, kind: string, model?: string, signal?: AbortSignal) {
        const { status, body } = await this.call(
            'POST',
            `/sandboxes/${encodeURIComponent(sessionId)}/host`,
            { kind, ...(model ? { model } : {}) },
            120_000,
            signal,
        );
        if (status !== 200 && status !== 201 && status !== 409) {
            this.refused(status, body, 'The session host could not be started');
        }
        return body as { sessionId: string; hostPid?: number; state: string };
    }

    /**
     * `GET /sandboxes/:id/host/stream` (CB-326 step 3): the long-lived ndjson
     * event stream — one `ProviderAdapterV2Event` (or a heartbeat) per line,
     * in stream order. One stream per session; a second GET gets 409. The
     * caller drains this for the session's life and writes rows to
     * `coding_thread_events` via the thread-event sink. Pass an `AbortSignal`
     * to end the stream (on session end or idle stop).
     */
    async *hostStream(
        sessionId: string,
        signal: AbortSignal,
    ): AsyncGenerator<{ type: string; [key: string]: unknown }> {
        const base = this.options.url.replace(/\/$/, '');
        let response: Response;
        try {
            response = await this.fetchImpl(`${base}/sandboxes/${encodeURIComponent(sessionId)}/host/stream`, {
                headers: { Authorization: `Bearer ${this.options.token}` },
                redirect: 'error',
                signal,
            });
        } catch {
            throw new SupervisorError(503, 'The computer supervisor is unreachable.');
        }
        if (response.status !== 200) {
            throw new SupervisorError(response.status, `The host stream could not be opened: HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
            return;
        }
        let buffer = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += new TextDecoder().decode(value, { stream: true });
            let nl: number;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) {
                    continue;
                }
                try {
                    yield JSON.parse(line) as { type: string; [key: string]: unknown };
                } catch {
                    // A malformed line is skipped; the stream's framing is ndjson.
                }
            }
        }
    }

    /**
     * `POST /sandboxes/:id/host/command` (CB-326 step 3): one command into the
     * host (`turn_start`|`turn_steer`|`turn_interrupt`|`thread_resume`|`close`|
     * `respond_runtime`). The supervisor writes ndjson to the host's stdin and
     * returns its ack. A 504 means the host didn't ack within 10 s; `close`
     * ends the host. `respond_runtime` (CB-326 step 4) carries the person's
     * decision back to a pending runtime-request approval; the host forwards
     * it to the provider's `respondToRuntimeRequest`.
     */
    async hostCommand(
        sessionId: string,
        op:
            | 'turn_start'
            | 'turn_steer'
            | 'turn_interrupt'
            | 'thread_resume'
            | 'thread_snapshot'
            | 'thread_rollback'
            | 'thread_fork'
            | 'respond_runtime'
            | 'close',
        payload?: unknown,
        signal?: AbortSignal,
    ) {
        const { status, body } = await this.call(
            'POST',
            `/sandboxes/${encodeURIComponent(sessionId)}/host/command`,
            { op, ...(payload ? { payload } : {}) },
            30_000,
            signal,
        );
        if (status !== 200 && status !== 204) {
            this.refused(status, body, `The host command ${op} was not acknowledged`);
        }
        return body as { ok?: boolean; error?: string };
    }

    /** `DELETE /sandboxes/:id`: the container and its network (idempotent). */
    async remove(sessionId: string) {
        const { status, body } = await this.call(
            'DELETE',
            `/sandboxes/${encodeURIComponent(sessionId)}`,
            undefined,
            60_000,
        );
        if (status !== 200 && status !== 204 && status !== 404) {
            this.refused(status, body, 'The sandbox could not be removed');
        }
    }

    /** `DELETE /workspaces/:volumeKey`: a volume no sandbox uses. */
    async removeWorkspace(volumeKey: string) {
        const { status, body } = await this.call(
            'DELETE',
            `/workspaces/${encodeURIComponent(volumeKey)}`,
            undefined,
            60_000,
        );
        if (status !== 200 && status !== 204 && status !== 404) {
            this.refused(status, body, 'The workspace could not be removed');
        }
    }

    /** `GET /sandboxes`: what the supervisor runs, for the reaper. */
    async list() {
        const { status, body } = await this.call('GET', '/sandboxes');
        if (status !== 200) {
            this.refused(status, body, 'The sandboxes could not be listed');
        }
        const parsed = listing.safeParse(body);
        if (!parsed.success) {
            throw new SupervisorError(502, 'The supervisor answered unexpectedly.');
        }
        return parsed.data.sandboxes;
    }
}
