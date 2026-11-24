/**
 * What other features may know of Learning: its tags, the slices of its
 * services they call, the constants the classification seam reads, and
 * plain types (CB-110, CB-133, CB-198, CB-200). It imports only `effect`,
 * `@socio/*`, other features' contracts and `import type` from the
 * allowlist, and holds no logic.
 *
 * The types and constants here moved from the files that defined them
 * (`analysis.ts`, `skills.ts`, `triage.ts`), which re-export them, so every
 * importer keeps compiling until that importer switches to the contract. The
 * privacy filters (`scrub`, `leaksPrivateData`) moved to
 * `@socio/foundation/learning/scrub`; skill delivery (`learnedSkillsFor`,
 * delivery.ts) is behind `SkillDelivery`. The classes implement these shapes;
 * `layer.ts` provides the tags.
 *
 * Five services:
 * - `Learning`: the analysis job (`LearningAnalysis`, analysis.ts), as the
 *   Learning views (views.ts) and the runner's evidence hook
 *   (`composition/learning.ts`) call it. `LegacyLearning`.
 * - `Evidence`: the evidence ledger (`EvidenceLedger`, evidence.ts),
 *   `WorkspaceStore.evidence`.
 * - `Skills`: the published skills (`SkillStore`, skills.ts),
 *   `WorkspaceStore.skills`.
 * - `SkillDelivery`: a turn's `learnedSkills` option (delivery.ts) over
 *   the published skills; `skillDelivery(skills)` builds it.
 * - `LearningViews`: the views Learning's routes and pages answer
 *   (views.ts), which the pages read here.
 *
 * Not here, on purpose:
 * - `useSeam`: wiring the composition root does once
 *   (`composition/learning.ts`), with the seam's `EvidenceTriage`.
 * - `recoverInterrupted`, `tick`, `triageTick` and `stop`: Learning's own
 *   module hooks (module.ts), on the analysis `LegacyLearning` holds.
 * - What only Learning's routes call (`analyze`, `cancel`, `review`,
 *   `proposal`, `proposals`, `reviewed`, `triage`; `saveRevision`,
 *   `publish`, `revoke`, `pin`, `history`, `revoked`, `skillRevision`,
 *   `containerRevision`, `snapshot`; `pending`, `containerOf`,
 *   `markAnalyzed`): inside `learning/`.
 * - `EvidenceTriage` and its questions other than `TRIAGE_QUESTIONS`:
 *   built by the composition root over the classification seam.
 * - The repositories and `sqliteLearningRepositories`: construction over a
 *   connection.
 * - A `LearningConfig` tag: `learning/` reads no `PlatformConfig` field.
 *   Its model is the default shared backend's endpoint, which the
 *   composition root hands `LearningAnalysis` as a function (spec 4.3).
 */
import type { CopilotKitIntelligence } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { ThreadFollower } from '@socio/shared/auth';
import { LEARNING_INPUT_CHARS, LEARNING_LABELS_VERSION } from '@socio/shared/classify';
import type {
    LearningContainerDetail,
    LearningContainerSummary,
    LearningDropReason,
    LearningProposalPage,
    LearningSeamView,
    PublishedSkills,
} from '@socio/shared/learning';

import type { RunStatus as TurnRunStatus } from '../turns/contract.js';

// ── Analysis (`analysis.ts`) ─────────────────────────────────────────────

/** What started an analysis run. */
export type RunTrigger = 'threshold' | 'schedule' | 'manual' | 'intent';
/** An analysis run's state (`RunStatus` in analysis.ts). */
export type AnalysisRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface AnalysisRun {
    id: string;
    containerId: string;
    trigger: RunTrigger;
    status: AnalysisRunStatus;
    startedAt: number;
    finishedAt: number | null;
    threads: number;
    proposals: number;
    dropped: number;
    dropReasons: Partial<Record<LearningDropReason, number>>;
    /** Threads triage kept from the analysis (CB-200). */
    skipped: number;
    /** What the analysis calls used, as the model reported it; null: not reported. */
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    error: string | null;
    startedBy: string | null;
}
export type ProposalStatus = 'pending' | 'published' | 'rejected';
export interface Proposal {
    id: string;
    containerId: string;
    runId: string;
    name: string;
    description: string;
    skillMd: string;
    rationale: string;
    evidenceThreadIds: string[];
    status: ProposalStatus;
    createdAt: number;
    reviewedBy: string | null;
    reviewedAt: number | null;
    revisionId: string | null;
}

/** Where a page of proposals ends: the last one's createdAt and id. */
export interface ProposalKey {
    createdAt: number;
    id: string;
}

// ── Published skills (`skills.ts`) ───────────────────────────────────────

export interface SkillFile {
    path: string;
    content: string;
}
export interface SkillRevision {
    id: string;
    containerId: string;
    name: string;
    revision: number;
    description: string;
    files: SkillFile[];
    createdAt: number;
    createdBy: string;
}
export interface ContainerRevision {
    containerId: string;
    revision: number;
    skills: Array<{ name: string; revisionId: string }>;
    createdAt: number;
    createdBy: string;
}
/** A container's skills as the runtime's zip (`Snapshot` in skills.ts). */
export interface SkillsSnapshot {
    status: 'snapshot';
    bytes: Uint8Array;
    revision: string;
    etag: string;
    contentType: 'application/zip';
}

// ── Learning on the classification seam (`triage.ts`, CB-200) ────────────

/*
 * Typed as the seam's `UseDefinition` and `Question` (classify/seam.ts),
 * written out here: `classify/` has no contract yet, and these are the same
 * shapes.
 */

/** The prompt's version: a change needs a new evaluation. */
const LEARNING_PROMPT = 1;

/** Learning's use of the classification seam. */
export const LEARNING_USE: {
    labelsVersion: number;
    maxChars: number;
    subject: string;
    promptVersion: number;
} = {
    labelsVersion: LEARNING_LABELS_VERSION,
    maxChars: LEARNING_INPUT_CHARS,
    subject:
        'Records from Learning, which turns a team’s finished conversations with an AI assistant at work into reusable skills (written procedures). The state is either a conversation (its title and what the people asked) or a proposed skill.',
    promptVersion: LEARNING_PROMPT,
};

/** What triage asks of each conversation. */
export const TRIAGE_QUESTIONS: readonly {
    id: string;
    ask: string;
    options: readonly { value: string; hint: string }[];
}[] = [
    {
        id: 'procedure',
        ask: 'Does this conversation show a procedure the team would repeat: a kind of task with steps that a written checklist would help with next time?',
        options: [
            {
                value: 'repeatable',
                hint: 'A kind of task that will come up again with similar steps, such as a report, a review, a set-up or a recurring analysis.',
            },
            {
                value: 'one-off',
                hint: 'A single question, small talk, or a task unlikely to recur the same way.',
            },
        ],
    },
];

// ── Tags ─────────────────────────────────────────────────────────────────

/** Learning's triage on the seam, as its page reads it (`EvidenceTriage`). */
export interface LearningTriageShape {
    view(containerId: string, analyzedThrough: number): Promise<LearningSeamView>;
}

/** The analysis job (`LearningAnalysis`), as other features call it. */
export interface LearningShape {
    /** Whether there is a model to analyze with (the default shared backend). */
    configured(): Promise<boolean>;
    running(containerId: string): boolean;
    runs(containerId: string, limit?: number): AnalysisRun[];
    /**
     * One page of a container's proposals, newest first: at most `limit`,
     * older than `after`, and the key of this page's last one when there
     * are more.
     */
    proposalPage(
        containerId: string,
        page: { limit: number; after?: ProposalKey },
    ): { items: Proposal[]; next?: ProposalKey };
    /** How many of a container's proposals have `status`. */
    proposalCount(containerId: string, status: ProposalStatus): number;
    /** The seam's triage, on or off (Learning's page shows its state). */
    seamTriage(): LearningTriageShape | undefined;
    /**
     * Threshold trigger, called after evidence is recorded; resolves once
     * the run has started, or it isn't due.
     */
    maybeAnalyze(containerId: string): Promise<void>;
}

/** The evidence ledger (`EvidenceLedger`), as other features call it. */
export interface EvidenceShape {
    /** Runner hook, after every stored run: the thread's container when recorded. */
    record(threadId: string, status: TurnRunStatus, at?: number): string | undefined;
    /** Eligible threads finished since the container's last analysis. */
    count(containerId: string): number;
    /** Containers with any recorded evidence. */
    containers(): string[];
    analyzedThrough(containerId: string): number;
}

/** The published skills (`SkillStore`), as other features read them. */
export interface SkillsShape {
    /** Containers with any container revision. */
    containers(): string[];
    /** Published skills (latest container revision) with their revisions. */
    published(containerId: string): SkillRevision[];
    latest(containerId: string): ContainerRevision | undefined;
    /** The container revision delivered to Dots: the pin, else the latest. */
    current(containerId: string): ContainerRevision | undefined;
    pinned(containerId: string): number | undefined;
}

/** A turn's `learnedSkills` option (`BuiltInAgent`). */
export interface LearnedSkillsOption {
    client: CopilotKitIntelligence;
    containerId: string;
    freshnessWindowMs: number;
}

/** Skill delivery for a turn (delivery.ts). */
export interface SkillDeliveryShape {
    /** The `learnedSkills` option for a conversation, or undefined when off. */
    learnedSkillsFor(
        deliveryEnabled: boolean | undefined,
        containerId: string | null | undefined,
    ): LearnedSkillsOption | undefined;
}

/**
 * Learning's views (`views.ts`, moved from `live/views/learning.ts`): what
 * its routes and the pages' loaders answer, read from the analysis, the
 * evidence, the published skills and the socios when called.
 */
export interface LearningViewsShape {
    /** Every learning container: set on a Dot, with evidence, or published to. */
    containerIds(): string[];
    /** `GET /api/learning/skills`: everyone's published skills, by container. */
    publishedSkills(): PublishedSkills;
    /** `GET /api/learning/containers` (admins): each container's state. */
    containers(): LearningContainerSummary[];
    /**
     * `GET /api/learning/containers/:id` (admins): runs, the first page of
     * proposals, what is published and delivered, and the seam's triage.
     * `bodies: false` leaves out each proposal's SKILL.md and rationale.
     */
    container(id: string, options?: { bodies?: boolean }): Promise<LearningContainerDetail>;
    /**
     * `GET /api/learning/containers/:id/proposals` (admins): a page of the
     * container's proposals, newest first, after `after`.
     */
    proposals(id: string, options?: { limit?: number; after?: ProposalKey; bodies?: boolean }): LearningProposalPage;
    /** Reads `?cursor=`; undefined when it is not one this server gave out. */
    parseProposalCursor(value: string): ProposalKey | undefined;
}

export class Learning extends Context.Service<Learning, LearningShape>()('socio/learning/Learning') {}

export class Evidence extends Context.Service<Evidence, EvidenceShape>()('socio/learning/Evidence') {}

export class Skills extends Context.Service<Skills, SkillsShape>()('socio/learning/Skills') {}

export class SkillDelivery extends Context.Service<SkillDelivery, SkillDeliveryShape>()(
    'socio/learning/SkillDelivery',
) {}

export class LearningViews extends Context.Service<LearningViews, LearningViewsShape>()(
    'socio/learning/LearningViews',
) {}

/**
 * A moved conversation's learning evidence (CB-360's transfer): it names
 * the conversation's owner, and follows it. `infra/sqlite/ownership.ts`
 * implements it.
 */
export type EvidenceOwnershipShape = ThreadFollower;
