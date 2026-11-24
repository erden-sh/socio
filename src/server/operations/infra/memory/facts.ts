/**
 * The facts the in-memory reader answers from, as the analytics store keeps
 * them (`f_turn`, `f_cycle`, `f_message`): split from `reader.ts`, so each
 * section's file (Activity, Cost, Health, Reliability) reads them without
 * importing the reader that imports it.
 */
import type { FailureCategory } from '@socio/shared/failure-taxonomy';
import type { CostBasis } from '@socio/shared/operations/operations-cost';
import type { AgentRunStatus } from '@socio/shared/types';

/** A turn, as the analytics store's `f_turn` keeps it (the fields read here). */
export interface TurnFact {
    runId: string;
    threadId: string;
    socioId: string;
    socioName?: string | null;
    /** The socio's Space. */
    spaceId?: string | null;
    /** The person whose message started it, when a person did. */
    personId?: string | null;
    source: string;
    status: AgentRunStatus;
    startedAt: number;
    finishedAt?: number | null;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls?: number;
    toolErrors?: number;
    // Reliability's (CB-189): the failure taxonomy's category and rule.
    failureCategory?: FailureCategory | null;
    failureRule?: string;
    failureCode?: string | null;
    endReason?: string | null;
    model?: string | null;
    retries?: number;
    /** It moved to the shared model. */
    fallback?: boolean;
    // What Health reads (CB-192), as `f_turn` keeps it.
    cachedTokens?: number;
    reasoningTokens?: number | null;
    /** summary | raw | hidden | none | mixed | unknown (the default). */
    reasoningKind?: string;
    reasoningTokensReported?: boolean;
    receivedAt?: number | null;
    /** Model rounds; 0 for a turn without a trace. */
    rounds?: number;
    attribution?: 'exact' | 'owner' | 'source';
    /** Who started it (CB-185), for collaboration: a socio for another. */
    triggerKind?: string;
    triggerId?: string | null;
    // What it cost (CB-195, CB-196), as the cost step prices it.
    backendKey?: string | null;
    costBackend?: string | null;
    costUsd?: number | null;
    costBasis?: CostBasis | null;
    refCostUsd?: number | null;
    // Rooms (CB-218): where it ran, its work cycle, who acted and paid.
    /** person (the default), team or room. */
    containerKind?: 'person' | 'team' | 'room';
    cycleId?: string | null;
    hop?: number | null;
    actingId?: string | null;
    payerKind?: 'person' | 'workspace' | null;
    payerId?: string | null;
}

/** A work cycle, as `f_cycle` keeps it (the fields read here, CB-218). */
export interface CycleFact {
    id: string;
    threadId: string;
    kind: 'private' | 'room';
    startedAt: number;
    endedAt?: number | null;
    elapsedMs?: number;
    /** Its ledger's spend is known (the default). */
    costKnown?: boolean;
    endReason?: string | null;
}

/** A message, as `f_message` keeps it, with its turn's socio, Space and source. */
export interface MessageFact {
    messageId: string;
    threadId: string;
    socioId: string;
    spaceId?: string | null;
    source: string;
    at: number;
    authorKind: 'person' | 'socio';
    authorId: string;
    /** The turn that added it. */
    runId?: string;
}
