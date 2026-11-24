import { z } from 'zod';

export const learningContainerIdSchema = z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use 1–64 lowercase letters, numbers, and single hyphens.')
    .nullable();

export function validateLearningSettings(containerId: string | null, delivery: boolean) {
    if (!learningContainerIdSchema.safeParse(containerId).success) {
        throw new Error('Socio Learning container ID must use 1–64 lowercase letters, numbers, and single hyphens.');
    }
    if (delivery && !containerId) {
        throw new Error('Socio skill delivery requires a Learning container.');
    }
}

/**
 * Why an analysis run dropped a tool call: malformed (not a valid
 * `propose_skill` call), no evidence from the batch, private details left
 * in it, a name this container rejected or revoked, or a published skill
 * (or a rejected revision of it) again. With Learning on the
 * classification seam (CB-200), after those checks: the model judged it
 * the same skill as a rejected or published one (`model-duplicate`), or
 * found private details the patterns missed (`model-private`).
 */
export type LearningDropReason =
    | 'malformed'
    | 'no-evidence'
    | 'private-data'
    | 'rejected'
    | 'published'
    | 'model-duplicate'
    | 'model-private';
export const LEARNING_DROP_REASONS: Record<LearningDropReason, string> = {
    malformed: 'malformed',
    'no-evidence': 'citing no conversation in the batch',
    'private-data': 'with private details',
    rejected: 'already rejected',
    published: 'already published',
    'model-duplicate': 'judged a repeat by the model',
    'model-private': 'judged private by the model',
};
/** A run's drop reasons for its status line: " (2 already rejected, 1 malformed)". */
export function droppedWhy(reasons: LearningRunView['dropReasons'] = {}) {
    const parts = Object.entries(reasons).map(
        ([reason, count]) => `${count} ${LEARNING_DROP_REASONS[reason as LearningDropReason] ?? reason}`,
    );
    return parts.length ? ` (${parts.join(', ')})` : '';
}
/** An analysis run, as the Learning page lists it. */
export interface LearningRunView {
    id: string;
    trigger: string;
    status: string;
    startedAt: number;
    threads: number;
    proposals: number;
    dropped: number;
    /** `dropped`, by reason; runs from before reasons were kept have none. */
    dropReasons: Partial<Record<LearningDropReason, number>>;
    /**
     * Of `threads`, the conversations triage kept from the analysis: in
     * force as one-off (CB-200). They are read, so they don't come back.
     */
    skipped: number;
    /** The analysis's own model calls, as the model reported them; null: not reported. */
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    error: string | null;
}

/**
 * A conversation's triage (CB-200): what the label in force says (an
 * admin's, or the model's once applied), the model's newest answer as a
 * score, and the intent of its sessions (CB-199), when labeled.
 */
export interface LearningTriageView {
    threadId: string;
    title: string;
    finishedAt: number;
    /** Not analyzed yet. */
    pending: boolean;
    /** The label in force; null: none yet, so it goes to the analysis. */
    label: {
        value: 'repeatable' | 'one-off';
        source: 'admin' | 'model';
        at: number;
    } | null;
    /**
     * The model's newest answer as how likely it shows a repeatable
     * procedure (0 to 1), and whether it was applied.
     */
    score: number | null;
    applied: boolean;
    /** The most common intent of its sessions (CB-199), when labeled. */
    intent: string | null;
}

/**
 * Learning's use of the classification seam (CB-200), as its page shows
 * it: the switch and limits are in Operations → Settings → Learning triage.
 */
export interface LearningSeamView {
    enabled: boolean;
    /** A default shared model is set up. */
    available: boolean;
    version: string | null;
    /** That version passed an evaluation: its answers count. */
    passed: boolean;
    threshold: number;
    perDay: number;
    /** The last 24 hours of the use's calls (triage and the checks). */
    callsToday: number;
    tokensToday: number;
    costToday: number | null;
    /** Admin triage labels: the golden set. */
    golden: number;
    /** One intent's sessions among the new conversations that start an analysis. */
    intentRecurrence: number;
    /** This container's conversations, newest first, with their triage. */
    threads: LearningTriageView[];
}
/** A proposal in a container's list: its body only when asked for. */
export interface LearningProposalView {
    id: string;
    name: string;
    description: string;
    skillMd?: string;
    rationale?: string;
    evidenceThreadIds: string[];
    status: 'pending' | 'published' | 'rejected';
    createdAt: number;
}
/** Proposals in a page: the first page's size, and the most one page holds. */
export const PROPOSAL_PAGE = 25;
export const PROPOSAL_PAGE_MAX = 100;
/**
 * `GET /api/learning/containers/:id/proposals?limit=&cursor=`: a page of
 * proposals, newest first. `nextCursor` asks for the page after it; there
 * is none on the last page.
 */
export interface LearningProposalPage {
    items: LearningProposalView[];
    nextCursor?: string;
}
export interface LearningSkillView {
    name: string;
    description: string;
    revision: number;
    revisionId: string;
}
/** `GET /api/learning/skills`: what everyone's Dots can load. */
export type PublishedSkills = Array<{
    containerId: string;
    skills: LearningSkillView[];
}>;
/** `GET /api/learning/containers` (admins). */
export interface LearningContainerSummary {
    id: string;
    dots: Array<{ id: string; name: string; delivery: boolean }>;
    newEvidence: number;
    pendingProposals: number;
    published: number;
    running: boolean;
    lastRun: LearningRunView | null;
}
/** Admin-only scope settings; changing them affects new conversations. */
export interface LearningSocioSettings {
    id: string;
    name: string;
    learningContainerId: string | null;
    skillDeliveryEnabled: boolean;
}
/**
 * `GET /api/learning/containers/:id` (admins). `proposals` is the first
 * page (PROPOSAL_PAGE, newest first); `proposalsCursor` asks
 * `/proposals?cursor=` for the next one, when there are more.
 */
export interface LearningContainerDetail {
    id: string;
    newEvidence: number;
    running: boolean;
    configured: boolean;
    runs: LearningRunView[];
    proposals: LearningProposalView[];
    proposalsCursor?: string;
    published: LearningSkillView[];
    revision: number;
    pinned: number | null;
    delivered: number;
    /** Learning on the classification seam (CB-200); none on servers without it. */
    triage?: LearningSeamView | null;
}
