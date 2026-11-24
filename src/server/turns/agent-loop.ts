import type { AgentLoopStrategy, ChatMiddleware } from '@tanstack/ai';

/**
 * A Dot turn's model rounds (CB-127). Each round is one model call; a round
 * that asks for tools is followed by their results and the next round. A turn
 * may run `cap` rounds: the last has no tools and a note asking the Dot to
 * say what it did, where it stopped and what is left, so a long task ends
 * with a status instead of the tool result of its last round and no reply.
 * The turn time limit (`TURN_TIME_LIMIT_SECONDS`) bounds the rounds as well.
 */

/** What the model is told in a turn's last round. */
export const lastRoundNote = (cap: number) =>
    `This is the last of the ${cap} model rounds this turn may use, so tools are off now: do not call any. Reply to the person with a short status: what you did, where you stopped and what is left to do, so they can ask you to carry on.`;

/**
 * The loop of one turn with `cap` rounds: the strategy and middleware for
 * `chat()`, and what it ran.
 */
export function agentLoop(cap: number) {
    let rounds = 0;
    let capped = false;
    let waiting = false;
    const strategy: AgentLoopStrategy = ({ iterationCount }) => iterationCount < cap;
    const middleware: ChatMiddleware = {
        name: 'socio-rounds',
        onIteration: () => {
            rounds += 1;
        },
        // Before the last round's model call: no tools (so none can run either),
        // and the note.
        onConfig: (ctx, config) => {
            if (ctx.phase !== 'beforeModel' || ctx.iteration < cap - 1) {
                return;
            }
            capped = true;
            return {
                tools: [],
                systemPrompts: [...config.systemPrompts, lastRoundNote(cap)],
            };
        },
        // Tool calls left without results: a client tool (the review) or an
        // approval waits for the person.
        onFinish: (_ctx, info) => {
            waiting = info.finishReason === 'tool_calls';
        },
    };
    return {
        cap,
        strategy,
        middleware,
        /** Model rounds started so far. */
        rounds: () => rounds,
        /** Whether the last, tool-less round ran. */
        capped: () => capped,
        /** Whether it ended waiting for the person. */
        waiting: () => waiting,
    };
}
