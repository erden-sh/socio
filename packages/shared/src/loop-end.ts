/**
 * How a Dot turn's agent loop ended (CB-126, CB-127): one AG-UI CUSTOM event
 * the server sends just before the turn's last event (RUN_FINISHED or
 * RUN_ERROR), for traces and logs. The runner passes it on to clients and
 * records it in the run's trace (CB-128).
 */
export const LOOP_END_EVENT = 'socio.loop-end';

/**
 * - `completed`: the model answered.
 * - `round_cap`: the turn used its model rounds; the last one, without
 *   tools, wrote what was done and what is left.
 * - `time_limit`: the turn time limit stopped it.
 * - `cycle_limit`: its message's work used its tokens, spend or handoffs
 *   (CB-211); the run's trace says which (`RunTrace.cycle.stop`).
 * - `output_limit`: the model's output limit cut it off (again).
 * - `error`: it failed.
 * - `model_unavailable`: no model could carry on (busy or unreachable,
 *   after its retries and any fallback, CB-140); the turn ended with a
 *   status of what was done and what is left, written without a model.
 * - `stopped`: its owner stopped it, the workspace was paused or the Dot's
 *   permissions changed.
 * - `interrupted`: it waits for the person (a review or an approval).
 */
export const LOOP_END_REASONS = [
    'completed',
    'round_cap',
    'time_limit',
    'cycle_limit',
    'output_limit',
    'error',
    'model_unavailable',
    'stopped',
    'interrupted',
] as const;
export type LoopEndReason = (typeof LOOP_END_REASONS)[number];

/** `LOOP_END_EVENT`'s value. */
export interface LoopEnd {
    reason: LoopEndReason;
    /** Model rounds run, the last one without tools included. */
    rounds: number;
    /** The round cap in force for the turn. */
    cap: number;
    /**
     * The person's own model was busy, so the rest of the turn ran on the
     * shared one (CB-140): their labels.
     */
    fallback?: { from: string; to: string };
}
