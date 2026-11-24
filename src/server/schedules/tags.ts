/**
 * Scheduling's services, whole, by tag: what its module and routes use
 * (other features use the contract's slices: `Jobs`, `LongRuns`,
 * `LongRunReporting`, `Schedules`, `Goals`). Moved from `layer.ts` so the
 * module can read them from the app's services: only entry files import a
 * `layer.ts`, and `contract.ts` can't name the classes. `layer.ts` builds
 * them.
 */
import { Context } from 'effect';

import type { GoalService } from './goals.js';
import type { JobService } from './jobs.js';
import type { LongRunReports } from './long-run-reports.js';
import type { LongRunService } from './long-runs.js';
import type { ScheduleService } from './service.js';
import type { ScheduleData } from './services.js';
import type { SchedulesStore } from './slices.js';

/** The Scheduling context's data on the workspace's connection. */
export class SchedulesData extends Context.Service<SchedulesData, ScheduleData>()('socio/schedules/ScheduleData') {}

/** Jobs, the whole class, as this folder and the composition (`LegacyJobs`) use it; other features see `Jobs`. */
export class FullJobs extends Context.Service<FullJobs, JobService>()('socio/schedules/JobService') {}

/** Long runs, the whole class; other features see `LongRuns`. */
export class FullLongRuns extends Context.Service<FullLongRuns, LongRunService>()('socio/schedules/LongRunService') {}

/** The reports of long runs' ends, the whole class; other features see `LongRunReporting`. */
export class FullLongRunReports extends Context.Service<FullLongRunReports, LongRunReports>()(
    'socio/schedules/LongRunReports',
) {}

/** Schedules, the whole class; other features see `Schedules`. */
export class FullSchedules extends Context.Service<FullSchedules, ScheduleService>()(
    'socio/schedules/ScheduleService',
) {}

/** Goals, the whole class; other features see `Goals`. */
export class FullGoals extends Context.Service<FullGoals, GoalService>()('socio/schedules/GoalService') {}

/**
 * The settings and this folder's `TaskService` (`SchedulesStore`), as the
 * module's routes read them: the same view of the core store the
 * schedules layers are handed (`SchedulesHost.store`).
 */
export class ScheduleStore extends Context.Service<ScheduleStore, SchedulesStore>()('socio/schedules/ScheduleStore') {}
