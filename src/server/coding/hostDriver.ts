import { CODING_RUNTIME_CAPABILITY_OF, CODING_RUNTIME_DECISION_OF } from '@socio/shared/coding/coding-sessions';

import type { ApprovalsShape } from '../approvals/contract.js';

import { ThreadEventRows } from './infra/rows.js';
import type { RuntimePayload } from './runtimeApprovals.js';
import { RUNTIME_KIND_LABEL } from './runtimeApprovals.js';
import type { SandboxSupervisor } from './supervisor.js';

/**
 * The session host driver (CB-326 step 3): starts the
 * session host process in a sandbox, drains its ndjson event stream into
 * `coding_thread_events` (via the thread-event sink), and is the seam
 * CB-326 step 4 hooks runtime-request approvals into. One driver per
 * host-backed session, running for the session's life behind
 * `CODING_HOST_MODE`.
 *
 * The supervisor stream routes (POST /sandboxes/:id/host, GET .../host/stream,
 * POST .../host/command) are thelab-b6's (deployment/computers/coding-
 * sandbox.mjs, 93ef4ea0). This driver is the app-side client of them.
 *
 * Events arrive as ndjson lines (`{type, ...}`); the driver writes each to the
 * thread-event store. Heartbeat lines (`{type:"heartbeat"}`) are not stored.
 * Step 4 (CB-326): on `runtime_request.updated` (status pending) the driver
 * files a `coding_runtime_*` approval (the person's card), polls for the
 * decision, consumes it, and sends a `respond_runtime` command back to the
 * host carrying the T3 `ProviderApprovalDecision` (accept/decline).
 */
export interface HostDriverDeps {
    readonly supervisor: SandboxSupervisor;
    readonly rows: ThreadEventRows;
    readonly approvals: ApprovalsShape;
    readonly sessionId: string;
    readonly personId: string;
    /** The socio's id (the approval's `dotId`). */
    readonly socioId: string;
    /** The socio's name, for the card. */
    readonly socioName: string;
    /** The repository, for the card. */
    readonly repository: string;
    /** The thread the session lives in (the approval's `threadId`). */
    readonly threadId: string;
    readonly kind: string;
    readonly model?: string;
    /**
     * CB-326 step 3: called when the host emits `turn.terminal` for the
     * session's live turn. The service settles the matching run (done/failed)
     * from the event's status, so a host-backed `coding_prompt` completes
     * without a one-shot exec. Optional: only the service sets it.
     */
    readonly onTurnTerminal?: (event: { status?: string; failure?: unknown }) => void;
}

/** One host-backed session's driver, drained in the background. */
export class HostDriver {
    private readonly abort = new AbortController();
    private draining: Promise<void> | undefined;

    constructor(private readonly deps: HostDriverDeps) {}

    /** Starts the host and begins draining its event stream. Idempotent. */
    async start(): Promise<void> {
        await this.deps.supervisor.startHost(this.deps.sessionId, this.deps.kind, this.deps.model, this.abort.signal);
        this.draining = this.drain();
    }

    /** Sends a command to the host (turn/steer/interrupt/resume/snapshot/rollback/fork/close/respond_runtime). */
    async command(
        op:
            | 'turn_start'
            | 'turn_steer'
            | 'turn_interrupt'
            | 'thread_resume'
            | 'thread_snapshot'
            | 'thread_rollback'
            | 'thread_fork'
            | 'close'
            | 'respond_runtime',
        payload?: unknown,
    ): Promise<void> {
        await this.deps.supervisor.hostCommand(this.deps.sessionId, op, payload, this.abort.signal);
    }

    /** Stops the host (idle stop or session end) and ends the stream. */
    async stop(): Promise<void> {
        this.abort.abort();
        await this.deps.supervisor.hostCommand(this.deps.sessionId, 'close').catch(() => undefined);
        await this.draining?.catch(() => undefined);
    }

    /** Drains the host's event stream into the thread-event store, line by line. */
    private async drain(): Promise<void> {
        let ordinal = 0;
        try {
            for await (const event of this.deps.supervisor.hostStream(this.deps.sessionId, this.abort.signal)) {
                if (event.type === 'heartbeat') {
                    continue;
                }
                ordinal += 1;
                // The thread-event sink (threadEventSink.ts) is the Effect-based
                // writer; here we write directly for the host's raw ndjson shape
                // (the events are already ProviderAdapterV2Event-shaped as the
                // host emits them, or the host's own JSON). The payload is
                // bounded to the column's 16 KiB.
                const payload = JSON.stringify(event).slice(0, 16 * 1024);
                this.deps.rows.insert({
                    id: cryptoRandomId(),
                    sessionId: this.deps.sessionId,
                    personId: this.deps.personId,
                    requesterId: this.deps.socioId,
                    kind: String(event.type ?? 'event'),
                    ordinal,
                    nativeThreadId: typeof event.providerThreadId === 'string' ? event.providerThreadId : null,
                    nativeTurnId: typeof event.providerTurnId === 'string' ? event.providerTurnId : null,
                    nativeItemId: null,
                    payload,
                    createdAt: Date.now(),
                    deletedAt: null,
                    deletedBy: null,
                    deletedWith: null,
                });
                // CB-326 step 4: a provider runtime request (a command to run,
                // a file to change) becomes the person's card. File a
                // coding_runtime_* approval, wait for the decision, and send it
                // back to the host as a `respond_runtime` command the host
                // forwards to the provider's respondToRuntimeRequest.
                if (event.type === 'runtime_request.updated') {
                    void this.handleRuntimeRequest(event);
                }
                // CB-326 step 3: a host-backed prompt's turn ends here. The
                // service settles the matching run from the terminal status.
                if (event.type === 'turn.terminal' && this.deps.onTurnTerminal) {
                    this.deps.onTurnTerminal(event as { status?: string; failure?: unknown });
                }
            }
        } catch {
            // The stream ended (idle stop, session end, or a transient supervisor
            // error). The session's enforceOne/stopHost handles the lifecycle;
            // a dropped stream is not fatal — the next prompt restarts the host.
        }
    }

    /**
     * Files a `coding_runtime_*` approval for one provider runtime request,
     * waits for the person's decision, consumes it, and sends the T3 decision
     * (accept/decline) back to the host (CB-326 step 4).
     * The approval is bound to the session (bindingId) and the request id
     * (digest), so the host picks up its own request; a re-filed request
     * (the provider asks again) makes a fresh card. A denial or an expiry
     * (the 15 min TTL) is a decline; the host forwards it and the provider
     * carries on or stops.
     */
    private async handleRuntimeRequest(event: { type: string; [key: string]: unknown }): Promise<void> {
        const request = event.runtimeRequest as
            | {
                  id?: string;
                  kind?: string;
                  status?: string;
                  payload?: { command?: string; reason?: string; message?: string };
              }
            | undefined;
        if (!request || request.status !== 'pending') {
            return;
        }
        const kind = String(request.kind ?? 'command');
        const capability = CODING_RUNTIME_CAPABILITY_OF[kind] ?? CODING_RUNTIME_CAPABILITY_OF.command;
        const requestId = String(request.id ?? cryptoRandomId());
        const action = String(request.payload?.command ?? request.payload?.reason ?? request.payload?.message ?? '');
        const payload: RuntimePayload = {
            v: 1,
            sessionId: this.deps.sessionId,
            requestId,
            kind,
            action,
            kindLabel: RUNTIME_KIND_LABEL[kind] ?? 'Runtime approval',
            socioName: this.deps.socioName,
            repository: this.deps.repository,
        };
        try {
            const outcome = await this.deps.approvals.requestBound<RuntimePayload>({
                userId: this.deps.personId,
                dotId: this.deps.socioId,
                capability,
                summary: `${payload.kindLabel}: ${action.slice(0, 100)}`,
                details: [`${this.deps.socioName}’s agent asks to ${payload.kindLabel.toLowerCase()}.`],
                payload,
                threadId: this.deps.threadId,
                binding: { digest: requestId, bindingId: this.deps.sessionId },
            });
            const id = outcome.id;
            const decided = await this.awaitDecision(id);
            // `consume` marks the decision spent; the host is the single consumer.
            const approved = decided === 'approved';
            await this.deps.approvals
                .consume(id, { capability, digest: requestId, bindingId: this.deps.sessionId })
                .catch(() => undefined);
            const decision = CODING_RUNTIME_DECISION_OF[decided === 'approved' ? 'approved' : 'denied'];
            await this.command('respond_runtime', { requestId, decision }).catch(() => undefined);
            void approved;
        } catch {
            // Filing failed (the cap, a closed workspace): decline so the
            // provider isn't left blocked. Best-effort: the host's own TTL
            // also unblocks the provider if this command never lands.
            await this.command('respond_runtime', { requestId, decision: 'decline' }).catch(() => undefined);
        }
    }

    /**
     * Polls the approval's status until decided or expired (the 15 min TTL),
     * then returns the status. The approvals service has no per-request
     * awaitable, so a short poll observes the person's click; the TTL bounds
     * it. Returns 'denied' on expiry so the provider is unblocked.
     */
    private async awaitDecision(id: string): Promise<'approved' | 'denied'> {
        const deadline = Date.now() + 16 * 60_000;
        while (Date.now() < deadline && !this.abort.signal.aborted) {
            try {
                const view = await this.deps.approvals.get(id, this.deps.personId);
                if (view.status === 'approved') {
                    return 'approved';
                }
                if (view.status === 'denied' || view.status === 'expired') {
                    return 'denied';
                }
            } catch {
                // The request was consumed or removed: treat as denied.
                return 'denied';
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return 'denied';
    }
}

const cryptoRandomId = (): string => crypto.randomUUID();
