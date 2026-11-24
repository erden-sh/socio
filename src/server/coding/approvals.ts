import { randomUUID } from 'node:crypto';

import { SCOPE_WORDS } from '@socio/shared/actor-scopes';
import {
    CODING_APPROVAL_TTL_MS,
    CODING_SESSION_CAPABILITIES,
    type CodingSessionCard,
} from '@socio/shared/coding/coding-sessions';
import { minutesText } from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import type { ApprovalDecisionEvent, ApprovalRecord } from '../approvals/contract.js';

import type { CodingParts } from './parts.js';

/**
 * A coding session's approval (CB-239): `coding_session_read` for a
 * session that only reads and `coding_session_push` for one that may push
 * and open draft pull requests. Both are the person's click, every time:
 * never `auto`, never `bypass`. That holds for every session start: a
 * read-only start can't skip the card by the person's opt-in. Approving
 * runs `execute`, which creates the grant and the session from the stored
 * payload, checking everything again (CodingSessions.startFromApproval).
 */

/** What a start request carries: the card's facts, fixed when asked. */
export interface StartPayload {
    v: 1;
    repository: string;
    base: string;
    push: boolean;
    minutes: number;
    model: string;
    modelLabel: string;
    outsideProvider: boolean;
    modelHost: string | null;
    budgetTokens: number;
    branchPrefix: string;
    socioSlug: string;
    socioName: string;
    task: string;
    conversationId: string;
    conversationKind: 'private' | 'room';
    visibleTo: string | null;
    correlationId: string;
    /**
     * The person's own plan the session runs on: its kind (`byo-chatgpt`)
     * and its name for the card; absent for listed models.
     */
    plan?: string;
    planLabel?: string;
    /**
     * The coding agent (CB-326): its id and name for the card.
     * Absent on requests from before, which run OpenCode.
     */
    harness?: string;
    harnessLabel?: string;
}

const NEVER =
    'It can’t change the base or any other branch, change .github/ or CODEOWNERS, merge, or reach the internet beyond package registries.';

/** The start card: platform facts first, the socio's words last. */
export function sessionCard(payload: StartPayload): CodingSessionCard {
    return {
        kind: 'coding_session',
        socioName: inertText(payload.socioName, { max: 80, lines: false }),
        repository: payload.repository,
        base: payload.base,
        branchPattern: `${payload.branchPrefix}/${payload.socioSlug}/…`,
        push: payload.push,
        minutes: payload.minutes,
        model: {
            label: inertText(payload.modelLabel, { max: 80, lines: false }),
            outsideProvider: payload.outsideProvider,
            host: payload.modelHost,
        },
        budgetTokens: payload.budgetTokens,
        plan: payload.plan
            ? {
                  label: inertText(payload.planLabel ?? 'your plan', {
                      max: 80,
                      lines: false,
                  }),
              }
            : null,
        harness: {
            id: payload.harness ?? 'opencode',
            label: inertText(payload.harnessLabel ?? 'OpenCode', { max: 80, lines: false }),
            // Phase 2's harnesses all reach models through Socio's gateway.
            route: 'gateway',
        },
        allows: [
            SCOPE_WORDS['git:read'],
            ...(payload.push
                ? [`push to its own branch under ${payload.branchPrefix}/${payload.socioSlug}/…`, SCOPE_WORDS['git:pr']]
                : []),
            SCOPE_WORDS['model:invoke'],
        ],
        never: NEVER,
        visibleTo: payload.visibleTo,
        task: inertText(payload.task, { max: 500 }),
    };
}

/** One line for the Approvals list and Telegram's notice. */
export function sessionSummary(payload: StartPayload) {
    return `Work on ${payload.repository} for ${minutesText(payload.minutes)}${payload.push ? ', with pushes to its own branch' : ', read only'}`;
}

export const newCodingCorrelation = () => `coding-${randomUUID()}`;

/**
 * Registers both capabilities (once per platform, every runtime), with
 * `execute` from the coding sessions service.
 */
export function registerCodingApprovals(
    parts: Pick<CodingParts, 'approvals' | 'actors'>,
    execute: (request: ApprovalRecord<StartPayload>) => Promise<string>,
) {
    const { approvals, actors } = parts;
    const audit = (request: ApprovalRecord<StartPayload>, event: ApprovalDecisionEvent) =>
        actors.audit.recordIn({
            at: event.at,
            correlationId: request.payload.correlationId,
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
            audience: 'gateway:model gateway:git',
            action: request.capability,
            resourceKind: 'repository',
            resourceId: request.payload.repository.toLowerCase(),
        });
    approvals.register<StartPayload>({
        capability: CODING_SESSION_CAPABILITIES.read,
        label: 'Let a socio start a read-only coding session for you',
        description:
            'A socio asks to run a coding agent on a listed repository for you, in a sandbox of its own, for a limited time: it reads the code and works on it there, and can’t push. Always your decision.',
        // Every coding session starts on the person's click; no bypass, and
        // the decision model can't approve it.
        manualOnly: true,
        auto: { allowed: false },
        ttlMs: CODING_APPROVAL_TTL_MS,
        card: (request) => sessionCard(request.payload),
        onDecision: audit,
        execute,
    });
    approvals.register<StartPayload>({
        capability: CODING_SESSION_CAPABILITIES.push,
        label: 'Let a socio start a coding session that pushes',
        description:
            'A socio asks to run a coding agent on a listed repository for you that may push to its own session branch and open draft pull requests. Always your decision.',
        // Writes and pushes are the person's click; no bypass, and the
        // decision model can't approve it.
        manualOnly: true,
        auto: { allowed: false },
        ttlMs: CODING_APPROVAL_TTL_MS,
        card: (request) => sessionCard(request.payload),
        onDecision: audit,
        execute,
    });
}
