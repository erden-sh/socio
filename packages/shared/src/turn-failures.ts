import { NO_INFERENCE_MESSAGES } from './inference.js';

/**
 * The fixed words of a failed turn, keyed by its kind (the RUN_ERROR's
 * `code`): what its sender reads and what a room's other members read.
 * The server sends these texts; the clients word a problem from the code
 * with the same table, never from text a server or provider wrote.
 */

/** Why a turn failed; sent as the RUN_ERROR `code`. */
export type TurnFailure =
    | 'model_rejected'
    | 'model_unavailable'
    | 'model_config'
    | 'no_inference'
    | 'no_inference_operator'
    | 'no_inference_choice'
    | 'time_limit'
    | 'tool_call'
    | 'output_limit'
    | 'skill_context'
    | 'stopped'
    | 'failed'
    // A message's work cycle reached a bound (CB-211, `cycleExhausted`), or
    // was refused before it began.
    | 'cycle_tokens'
    | 'cycle_spend'
    | 'cycle_handoffs'
    | 'cycle_rate'
    | 'cycle_ended'
    // A room step whose sender may not send there.
    | 'room_access'
    // The person the turn acts for is deactivated (CB-528).
    | 'person_inactive';

const limitText = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} minute` : `${ms / 1000} second`);

/** What a user sees when a turn hits its time limit of `ms`. */
export const timeLimitMessage = (ms?: number) =>
    `This turn reached the ${ms === undefined ? '' : `${limitText(ms)} `}time limit and was stopped. Try a smaller request.`;

/** The only text a user sees for a failed turn, in the app and in channels. */
export const TURN_FAILURE_MESSAGES: Record<TurnFailure, string> = {
    model_rejected:
        'The model could not process this request. If you attached a photo or file, try again without it, or start a new conversation.',
    model_unavailable: 'Socio could not reach its model. Please try again shortly.',
    model_config: 'Socio’s model is not set up correctly. Ask an admin to check the model settings.',
    no_inference: NO_INFERENCE_MESSAGES.connect,
    no_inference_operator: NO_INFERENCE_MESSAGES.operator,
    no_inference_choice: NO_INFERENCE_MESSAGES.choice,
    time_limit: timeLimitMessage(),
    tool_call: 'The model twice sent a tool request Socio could not read, so this turn was stopped. Please try again.',
    output_limit:
        'The model’s replies kept hitting its length limit, so this turn was stopped. Ask for less at a time, for example one file or section per message.',
    skill_context:
        'These skill instructions are too large for this model. Choose a larger-context model or a shorter skill; no instructions were truncated.',
    stopped: 'This turn was stopped because Socio was paused or this socio’s settings changed.',
    failed: 'Socio could not complete this request. Please try again shortly.',
    cycle_tokens:
        'This message used the most model tokens one message may use, so the socio stopped. Send a new message to carry on, or ask for less at a time.',
    cycle_spend:
        'This message reached the most one message may spend on the model, so the socio stopped. Send a new message to carry on, or ask an admin about the limit.',
    cycle_handoffs:
        'This message was handed between socios as often as one message may be, so the work stopped. Send a new message to carry on.',
    cycle_rate: 'This chat got too many messages in the last minute. Wait a moment, then send yours again.',
    cycle_ended:
        'The work this belonged to has already ended, so the socio did not carry on. Send a new message to start again.',
    room_access: 'You can’t start work in this room now. Ask a room admin for access.',
    person_inactive: 'The person this socio acts for is deactivated, so it does nothing for them.',
};

/**
 * What a room's other members see for a failed turn (CB-205): the reason in
 * the third person, about `who` sent the message (a name, or "Its
 * sender"), since `TURN_FAILURE_MESSAGES` speak to that sender. It follows
 * "Nina’s message wasn’t answered:", so "it" is the message.
 */
export const ROOM_FAILURE_NOTES: Record<TurnFailure, (who: string) => string> = {
    model_rejected: () => 'The model couldn’t process it.',
    model_unavailable: () => 'Socio couldn’t reach its model.',
    model_config: () => 'Socio’s model isn’t set up correctly.',
    no_inference: (who) => `${who} has no model available right now.`,
    no_inference_operator: () => 'No model is set up for this workspace yet.',
    no_inference_choice: (who) => `This chat is set to a model ${who} can’t use right now.`,
    time_limit: () => 'The turn reached its time limit and was stopped.',
    tool_call: () => 'The model twice sent a tool request Socio couldn’t read, so the turn was stopped.',
    output_limit: () => 'The model’s replies kept hitting its length limit, so the turn was stopped.',
    skill_context: () => 'The socio’s skill instructions are too large for its model.',
    stopped: () => 'The turn was stopped because Socio was paused or the socio’s settings changed.',
    failed: () => 'Socio couldn’t complete it.',
    cycle_tokens: () => 'It used the most model tokens one message may use, so the socio stopped.',
    cycle_spend: () => 'It reached the most one message may spend on the model, so the socio stopped.',
    cycle_handoffs: () => 'It was handed between socios as often as one message may be, so the work stopped.',
    cycle_rate: () => 'The room got too many messages in a minute.',
    cycle_ended: () => 'The work it belonged to had already ended, so the socio didn’t carry on.',
    room_access: (who) => `${who} can’t start work in this room right now.`,
    person_inactive: (who) => `${who} is deactivated, so the socio does nothing for them.`,
};

/** What a turn that ended in an error of no known kind says to its sender. */
export const TURN_PROBLEM_FALLBACK = 'The socio couldn’t finish this turn. Send the message again to retry.';
/** What the room's other members see for it (CB-205). */
export const ROOM_PROBLEM_FALLBACK = 'The socio couldn’t finish this turn.';

/** Whether `code` (a RUN_ERROR's, from any server) is a kind this table words. */
export const isTurnFailure = (code: unknown): code is TurnFailure =>
    typeof code === 'string' && Object.prototype.hasOwnProperty.call(TURN_FAILURE_MESSAGES, code);

/** Which failure `message` is the fixed text of; undefined for any other. */
export function turnFailureKind(message: string): TurnFailure | undefined {
    if (/^This turn reached the .+ time limit and was stopped\. /.test(message)) {
        return 'time_limit';
    }
    return (Object.keys(TURN_FAILURE_MESSAGES) as TurnFailure[]).find(
        (kind) => TURN_FAILURE_MESSAGES[kind] === message,
    );
}

/**
 * The time limit a `time_limit` text names, in ms, when it is exactly the
 * fixed text with a limit (`timeLimitMessage(ms)`); else undefined.
 */
export function timeLimitOf(message: string | undefined): number | undefined {
    const named = message?.match(/^This turn reached the (\d{1,4}) (minute|second) time limit and was stopped\. /);
    if (!named) {
        return undefined;
    }
    const ms = Number(named[1]) * (named[2] === 'minute' ? 60_000 : 1000);
    return timeLimitMessage(ms) === message ? ms : undefined;
}
