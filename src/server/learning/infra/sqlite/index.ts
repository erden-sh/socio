import type { SqliteData } from '@socio/data/open';

import type { LearningRepositories } from '../../domain/repositories.js';

import { SqliteEvidence, SqlitePublishedSkills } from './evidence.js';
import { SqliteAnalysisRuns, SqliteProposals } from './runs.js';

/**
 * Learning's repositories on a migrated connection (CB-110): every write
 * the evidence ledger, the skill store and the analysis make.
 */
export function sqliteLearningRepositories(data: SqliteData): LearningRepositories {
    return {
        evidence: new SqliteEvidence(data),
        skills: new SqlitePublishedSkills(data),
        runs: new SqliteAnalysisRuns(data),
        proposals: new SqliteProposals(data),
    };
}
