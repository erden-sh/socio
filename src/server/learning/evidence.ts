import type { DatabaseSync } from 'node:sqlite';

import { sqliteData } from '@socio/data/open';

import type { RunStatus } from '../turns/contract.js';

import type { EvidenceShape } from './contract.js';
import type { EvidenceRepository } from './domain/repositories.js';
import { SqliteEvidence } from './infra/sqlite/evidence.js';

/** Evidence of a deleted conversation is skipped (CB-64). */
const LIVE_THREAD = 'threadId NOT IN (SELECT id FROM thread_bindings WHERE deletedAt IS NOT NULL)';

export interface EvidenceThread {
    threadId: string;
    dotId: string;
    ownerId: string;
    finishedAt: number;
}

/**
 * Learning evidence: threads assigned to a learning container (frozen at
 * creation in `thread_bindings.learningContainerId`) whose latest run
 * finished. Each thread is one row, so a thread with several runs counts once
 * per analysis; a later failed or stopped run makes it ineligible until a run
 * finishes again. An analysis consumes evidence up to its cutoff.
 */
export class EvidenceLedger implements EvidenceShape {
    /** Its writes (CB-110); the reads stay here. */
    private repository: EvidenceRepository;
    constructor(
        private db: DatabaseSync,
        private container: (threadId: string) => { containerId: string; dotId: string; ownerId: string } | undefined,
    ) {
        this.repository = new SqliteEvidence(sqliteData(db));
    }
    /** Runner hook: called after every stored run. */
    /** Returns the thread's container when the run was recorded. */
    record(threadId: string, status: RunStatus, at = Date.now()): string | undefined {
        const binding = this.container(threadId);
        if (!binding) {
            return undefined;
        }
        this.repository.recordNow({
            threadId,
            ...binding,
            finished: status === 'finished',
            at,
        });
        return binding.containerId;
    }
    /** Eligible threads finished since the container's last analysis, oldest first. */
    pending(containerId: string): EvidenceThread[] {
        return this.db
            .prepare(
                `SELECT threadId, dotId, ownerId, finishedAt FROM learning_evidence
         WHERE containerId=? AND eligible=1 AND finishedAt>? AND ${LIVE_THREAD}
         ORDER BY finishedAt, threadId`,
            )
            .all(containerId, this.analyzedThrough(containerId)) as unknown as EvidenceThread[];
    }
    count(containerId: string) {
        const row = this.db
            .prepare(
                `SELECT COUNT(*) AS n FROM learning_evidence WHERE containerId=? AND eligible=1 AND finishedAt>? AND ${LIVE_THREAD}`,
            )
            .get(containerId, this.analyzedThrough(containerId)) as { n: number };
        return Number(row.n);
    }
    /** The container a thread's evidence is in, if it is evidence (CB-200). */
    containerOf(threadId: string): string | undefined {
        const row = this.db
            .prepare(`SELECT containerId FROM learning_evidence WHERE threadId=? AND ${LIVE_THREAD}`)
            .get(threadId) as { containerId: string } | undefined;
        return row?.containerId;
    }
    /** Containers with any recorded evidence. */
    containers(): string[] {
        return (
            this.db.prepare('SELECT DISTINCT containerId FROM learning_evidence ORDER BY 1').all() as Array<{
                containerId: string;
            }>
        ).map((row) => row.containerId);
    }
    analyzedThrough(containerId: string): number {
        const row = this.db
            .prepare('SELECT analyzedThrough FROM learning_cursors WHERE containerId=?')
            .get(containerId) as { analyzedThrough: number } | undefined;
        return row?.analyzedThrough ?? 0;
    }
    /** Marks evidence through `cutoff` (a finishedAt) as analyzed. */
    markAnalyzed(containerId: string, cutoff: number) {
        this.repository.markAnalyzedNow(containerId, cutoff);
    }
}
