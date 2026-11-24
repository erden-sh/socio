import { eq, sql } from 'drizzle-orm';

import type { ContainerRevision, SkillRevision } from '../../contract.js';
import type { EvidenceEntry, EvidenceRepository, PublishedSkillRepository } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import {
    learningContainerPins,
    learningContainerRevisions,
    learningCursors,
    learningEvidence,
    learningSkillRevisions,
} from './schema.js';

/** Hard deletes name the table (tests/hard-deletes.test.ts). */
const pins = learningContainerPins;

/** Threads' latest runs and each container's analysis cursor. */
export class SqliteEvidence extends SqliteRepository implements EvidenceRepository {
    recordNow({ finished, at, ...thread }: EvidenceEntry) {
        this.db
            .insert(learningEvidence)
            .values({ ...thread, eligible: finished, finishedAt: at })
            .onConflictDoUpdate({
                target: learningEvidence.threadId,
                // A failed or stopped run keeps the last finish time.
                set: finished ? { eligible: true, finishedAt: at } : { eligible: false },
            })
            .run();
    }

    markAnalyzedNow(containerId: string, cutoff: number) {
        const c = learningCursors;
        this.db
            .insert(c)
            .values({ containerId, analyzedThrough: cutoff })
            .onConflictDoUpdate({
                target: c.containerId,
                set: {
                    analyzedThrough: sql`max(${c.analyzedThrough}, excluded.${sql.identifier('analyzedThrough')})`,
                },
            })
            .run();
    }
}

/** Skill revisions, container revisions and pins: never changed, only added. */
export class SqlitePublishedSkills extends SqliteRepository implements PublishedSkillRepository {
    insertRevisionNow(revision: SkillRevision) {
        this.db.insert(learningSkillRevisions).values(revision).run();
    }

    insertContainerRevisionNow(revision: ContainerRevision) {
        this.db.insert(learningContainerRevisions).values(revision).run();
    }

    pinNow(containerId: string, revision: number) {
        this.db
            .insert(pins)
            .values({ containerId, revision })
            .onConflictDoUpdate({ target: pins.containerId, set: { revision } })
            .run();
    }

    unpinNow(containerId: string) {
        this.db.delete(learningContainerPins).where(eq(pins.containerId, containerId)).run();
    }
}
