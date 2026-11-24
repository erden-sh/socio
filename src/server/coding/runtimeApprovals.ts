import {
    CODING_APPROVAL_TTL_MS,
    CODING_RUNTIME_CAPABILITY_OF,
    type CodingRuntimeCard,
} from '@socio/shared/coding/coding-sessions';
import { inertText } from '@socio/shared/text/inert-text';

import type { ApprovalRecord } from '../approvals/contract.js';

import type { CodingParts } from './parts.js';

/**
 * The session host's runtime-request approvals (CB-326 step 4): a provider's
 * runtime request (T3 `ProviderRequestKind` — command, file-read, file-change,
 * mcp-elicitation, permission) is filed as a Socio approval under one of the
 * `CODING_RUNTIME_CAPABILITIES`. The person decides; the host consumes the
 * decision and forwards it to the provider's `respondToRuntimeRequest` as a
 * T3 `ProviderApprovalDecision` (accept/decline), so the person's card is the
 * single place a runtime request is decided, modelled on T3's approvals and
 * Socio's existing cards.
 *
 * These are `consumable` capabilities (CB-232): approving runs nothing in
 * Socio — the action runs in the sandbox, through the host, when it consumes
 * the decision. Each request is bound to its runtime-request id (the digest)
 * and its session (the binding id), so the host picks up its own request's
 * decision, and a re-filed request (the provider asks again) makes a fresh
 * card. The decision model can't approve these (manualOnly), matching the
 * shipped coding-session approvals.
 */

/** What a runtime-request approval carries: the host's facts, fixed when asked. */
export interface RuntimePayload {
    v: 1;
    /** The Socio coding session the host is running for. */
    sessionId: string;
    /** The provider's runtime-request id (T3 `RuntimeRequestId`). */
    requestId: string;
    /** The T3 `ProviderRequestKind`. */
    kind: string;
    /** The exact command or change, for monospace display. */
    action: string;
    /** A one-line label for the kind ("Command approval", "File change approval"). */
    kindLabel: string;
    /** The socio's name, for the card. */
    socioName: string;
    /** The repository, for the card. */
    repository: string;
}

/** The card a runtime-request approval shows (modelled on T3). */
export function runtimeCard(payload: RuntimePayload): CodingRuntimeCard {
    return {
        kind: 'coding_runtime',
        socioName: inertText(payload.socioName, { max: 80, lines: false }),
        repository: payload.repository,
        kindLabel: payload.kindLabel,
        action: inertText(payload.action, { max: 2000 }),
    };
}

/** One line for the Approvals list and the notice. */
export function runtimeSummary(payload: RuntimePayload) {
    return `${payload.kindLabel}: ${inertText(payload.action, { max: 120 })}`;
}

/** The T3 kind's card label ("Command approval", …). */
export const RUNTIME_KIND_LABEL: Record<string, string> = {
    command: 'Command approval',
    'file-read': 'File read approval',
    'file-change': 'File change approval',
    'mcp-elicitation': 'Tool input approval',
    permission: 'Permission approval',
};

/**
 * Registers the five runtime-request capabilities (once per platform, every
 * runtime). They are consumable: the person's decision is consumed by the host
 * (through `approvals.consume`), not run by Socio, so there is no `execute`.
 */
export function registerCodingRuntimeApprovals(parts: Pick<CodingParts, 'approvals' | 'actors'>) {
    const { approvals, actors } = parts;
    const audit = (request: ApprovalRecord<RuntimePayload>, event: { status: string; at: number; by: string }) =>
        actors.audit.recordIn({
            at: event.at,
            correlationId: request.payload.requestId,
            phase: 'approval',
            ...(event.status === 'approved'
                ? { decision: 'allow' as const }
                : event.status === 'denied'
                  ? { decision: 'deny' as const }
                  : {}),
            status: event.status,
            personId: request.userId,
            socioId: request.dotId,
            actorBy: event.by,
            audience: 'gateway:model',
            action: request.capability,
            resourceKind: 'coding_session',
            resourceId: request.payload.sessionId,
        });
    for (const kind of Object.keys(CODING_RUNTIME_CAPABILITY_OF)) {
        const capability = CODING_RUNTIME_CAPABILITY_OF[kind];
        approvals.register<RuntimePayload>({
            capability,
            label: RUNTIME_KIND_LABEL[kind],
            description:
                'A coding agent working for you asks to run a command or change a file in its sandbox. Your decision is sent back to the agent, which carries on or stops. Always your decision.',
            consumable: true,
            // The decision model can't approve a runtime request: it is
            // the person's click, every time, like a session start.
            manualOnly: true,
            auto: { allowed: false },
            ttlMs: CODING_APPROVAL_TTL_MS,
            card: (request) => runtimeCard(request.payload),
            onDecision: audit,
        });
    }
}
