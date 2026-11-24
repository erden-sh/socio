import { ACTIVITY_STEPS } from '../etl/activity-steps.js';
import { costStep } from '../etl/cost-step.js';
import { cyclesStep } from '../etl/cycles-step.js';
import { dimensionsStep } from '../etl/dimensions-step.js';
import { GROUNDING_STEPS } from '../etl/grounding-steps.js';
import { jobRunsStep, schedulesStep, taskRunsStep } from '../etl/health-steps.js';
import { issuesStep } from '../etl/issues-step.js';
import { KNOWLEDGE_STEPS } from '../etl/knowledge-steps.js';
import { labelsStep } from '../etl/labels-step.js';
import { retentionStep } from '../etl/retention-step.js';
import { runsStep } from '../etl/runs-step.js';
import { taxonomyStep } from '../etl/taxonomy-step.js';
import type { EtlStep } from '../infra/duckdb/etl.js';
import '../etl/sources.js';
import { sessionLabelsStep } from '../themes/etl.js';

/**
 * The ETL's sources, in order (CB-187): turns with their messages and
 * tool calls (and the rollups they touch), the failure taxonomy over
 * their codes (CB-189), the failure labels in force over it (CB-198),
 * their cost (CB-195, CB-196), the work cycles they were steps of
 * (CB-218), then the dimensions (which see the turns' source
 * keys), the board's issues, job and scheduled runs and the schedules,
 * goals and long runs as they are (Health, CB-192), then retention; then
 * Activity's approvals, Space writes, reactions and memories (CB-190),
 * and Space pages, datasets, storage and capability requests (CB-191);
 * then what grounded each turn and the turns items were filed from
 * (CB-194); then sessions' intent and themes (CB-199). Bump
 * `ETL_VERSION` with any change to them or their tables: the store
 * is then rebuilt from SQLite.
 */
export const ETL_STEPS: readonly EtlStep[] = [
    runsStep,
    taxonomyStep,
    labelsStep,
    costStep,
    cyclesStep,
    dimensionsStep,
    issuesStep,
    jobRunsStep,
    taskRunsStep,
    schedulesStep,
    retentionStep,
    ...ACTIVITY_STEPS,
    ...KNOWLEDGE_STEPS,
    ...GROUNDING_STEPS,
    sessionLabelsStep,
];
export const ETL_VERSION = 9;
