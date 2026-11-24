import type { AgentRunSource } from './types.js';

/**
 * `APP_ENV`: `production` (the default) or `development`. Only development
 * enables an operator's force stop and `SHUTDOWN_FORCE`; everything else
 * behaves the same.
 */
export type AppEnvironment = 'development' | 'production';

/** What a turn or run stopped by a force stop says, in the app and channels. */
export const FORCE_STOP_MESSAGE = 'Stopped by an operator for a deploy.';
/** The RUN_ERROR `code` of a turn ended by a force stop. */
export const FORCE_STOP_CODE = 'operator_stopped';

/** Work in progress, as the Platform page and the force stop count it. */
export interface RunningWork {
    /** Agent turns: web, Telegram, scheduled and voice compute. */
    turns: number;
    /** Scheduled tasks in progress (each also runs a turn). */
    scheduledTasks: number;
    /** Computer actions waiting on a Dot's computer. */
    computerActions: number;
    /** Job runs in progress or waiting for a slot. */
    jobRuns: number;
}

/** `GET /api/operator/work` (operators). */
export interface OperatorWork {
    environment: AppEnvironment;
    /** Whether `POST /api/operator/force-stop` is available (development). */
    forceStop: boolean;
    /** Refusing new work until the restart (SIGTERM, or a held force stop). */
    draining: boolean;
    work: RunningWork;
}

/** `POST /api/operator/force-stop`: what was stopped. */
export interface ForceStopResult {
    /** Turns stopped, by where they came from. */
    turns: number;
    turnSources: Partial<Record<AgentRunSource, number>>;
    scheduledTasks: number;
    computerActions: number;
    /** Job runs stopped (their processes in the computers too). */
    jobRuns: number;
    /** New work is refused until the restart. */
    held: boolean;
}
