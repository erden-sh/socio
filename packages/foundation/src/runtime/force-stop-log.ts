import type { ForceStopResult } from '@socio/shared/operator';

/** The audit line for a force stop: who, when, and the counts. */
export function forceStopLogLine(by: string, result: ForceStopResult, at = new Date()) {
    return `Operator: force stop by user=${by.replace(/[^\w.:@-]/g, '_').slice(0, 80)} at=${at.toISOString()} turns=${result.turns} scheduled=${result.scheduledTasks} computer=${result.computerActions} jobs=${result.jobRuns} hold=${result.held}`;
}
