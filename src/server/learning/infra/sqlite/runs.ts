import { eq } from 'drizzle-orm';

import type { LearningDropReason } from '@socio/shared/learning';

import type { AnalysisRun } from '../../contract.js';
import type {
    AnalysisRunRepository,
    NewAnalysisRun,
    NewProposal,
    ProposalRepository,
    ProposalReview,
} from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { learningProposals as p, learningRuns as r } from './schema.js';

/** Analysis runs: one row each, its counts kept as proposals are stored. */
export class SqliteAnalysisRuns extends SqliteRepository implements AnalysisRunRepository {
    startSoon(run: NewAnalysisRun) {
        this.soon('start learning analysis', () => {
            this.db
                .insert(r)
                .values({
                    id: run.id,
                    containerId: run.containerId,
                    trigger: run.trigger,
                    startedAt: run.startedAt,
                    startedBy: run.startedBy,
                    status: 'running',
                    finishedAt: null,
                    threads: 0,
                    proposals: 0,
                    dropped: 0,
                    dropReasons: {},
                    skipped: 0,
                    error: null,
                })
                .run();
        });
    }

    failRunningNow(error: string, at: number) {
        const { changes } = this.db
            .update(r)
            .set({ status: 'failed', error, finishedAt: at })
            .where(eq(r.status, 'running'))
            .run();
        return Number(changes);
    }

    finishNow(run: AnalysisRun) {
        this.db
            .update(r)
            .set({
                status: run.status,
                finishedAt: run.finishedAt,
                threads: run.threads,
                proposals: run.proposals,
                dropped: run.dropped,
                dropReasons: run.dropReasons,
                skipped: run.skipped,
                inputTokens: run.inputTokens,
                outputTokens: run.outputTokens,
                costUsd: run.costUsd,
                error: run.error,
            })
            .where(eq(r.id, run.id))
            .run();
    }

    recordDropsNow(id: string, dropped: number, dropReasons: Partial<Record<LearningDropReason, number>>) {
        this.db.update(r).set({ dropped, dropReasons }).where(eq(r.id, id)).run();
    }

    recordProposalCountNow(id: string, proposals: number) {
        this.db.update(r).set({ proposals }).where(eq(r.id, id)).run();
    }
}

/** Skill proposals, pending until an admin reviews them. */
export class SqliteProposals extends SqliteRepository implements ProposalRepository {
    insertNow(proposal: NewProposal) {
        this.db
            .insert(p)
            .values({
                ...proposal,
                status: 'pending',
                reviewedBy: null,
                reviewedAt: null,
                revisionId: null,
            })
            .run();
    }

    reviewNow(id: string, review: ProposalReview) {
        this.db.update(p).set(review).where(eq(p.id, id)).run();
    }
}
