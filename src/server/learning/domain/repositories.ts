import type { LearningDropReason } from '@socio/shared/learning';

import type { AnalysisRun, ContainerRevision, ProposalStatus, SkillRevision } from '../contract.js';

/**
 * Learning's repositories (CB-110): evidence and its cursors,
 * published skills with their container revisions and pins, analysis runs
 * and their proposals. Only `learning/infra` implements them.
 *
 * Methods named `…Now` are synchronous: they run at once on the
 * connection, in the caller's transaction if one is open, exactly as the
 * raw statements they replaced did. Learning's stores are synchronous for
 * their callers: the review routes, and the analysis, which groups its
 * writes in `transaction()` (a batch of proposals, a run's end with its
 * cursor). A run's start, which nothing reads back at once, is written
 * soon, as `writeSoon` writes it.
 */

/** A thread's latest run, as evidence for its learning container. */
export interface EvidenceEntry {
    threadId: string;
    containerId: string;
    dotId: string;
    ownerId: string;
    /** Finished: eligible, at `at`. Failed or stopped: no longer eligible. */
    finished: boolean;
    at: number;
}

export interface EvidenceRepository {
    /**
     * Records a thread's latest run. A failed or stopped run keeps the last
     * finish time but drops eligibility; the thread keeps its container.
     */
    recordNow(entry: EvidenceEntry): void;
    /** Marks evidence through `cutoff` analyzed; the cursor never goes back. */
    markAnalyzedNow(containerId: string, cutoff: number): void;
}

/** Published skills: immutable revisions, container revisions and pins. */
export interface PublishedSkillRepository {
    insertRevisionNow(revision: SkillRevision): void;
    insertContainerRevisionNow(revision: ContainerRevision): void;
    /** Delivers a container revision until unpinned. */
    pinNow(containerId: string, revision: number): void;
    unpinNow(containerId: string): void;
}

/** A run as it starts. */
export type NewAnalysisRun = Pick<AnalysisRun, 'id' | 'containerId' | 'trigger' | 'startedAt' | 'startedBy'>;

export interface AnalysisRunRepository {
    /** A run that started, written soon (never awaited). */
    startSoon(run: NewAnalysisRun): void;
    /** Ends every run still marked running as failed; how many. */
    failRunningNow(error: string, at: number): number;
    /** A run's end: its status, counts, usage and error. */
    finishNow(run: AnalysisRun): void;
    recordDropsNow(id: string, dropped: number, dropReasons: Partial<Record<LearningDropReason, number>>): void;
    recordProposalCountNow(id: string, proposals: number): void;
}

/** A proposal a run made: pending review. */
export interface NewProposal {
    id: string;
    containerId: string;
    runId: string;
    name: string;
    description: string;
    skillMd: string;
    rationale: string;
    evidenceThreadIds: string[];
    createdAt: number;
}

/** An admin's review of a proposal: its edits and status. */
export interface ProposalReview {
    name: string;
    description: string;
    skillMd: string;
    status: ProposalStatus;
    revisionId: string | null;
    reviewedBy: string;
    reviewedAt: number;
}

export interface ProposalRepository {
    insertNow(proposal: NewProposal): void;
    reviewNow(id: string, review: ProposalReview): void;
}

export interface LearningRepositories {
    evidence: EvidenceRepository;
    skills: PublishedSkillRepository;
    runs: AnalysisRunRepository;
    proposals: ProposalRepository;
}
