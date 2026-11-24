import type { AbstractAgent, BaseEvent, RunAgentInput } from '@ag-ui/client';
import { concatMap, type Observable } from 'rxjs';

/**
 * Runs a server-side turn without the AG-UI client's message bookkeeping
 * (CB-318).
 *
 * `runAgent` sends every event through `apply`, whose default rebuilds the
 * agent's message list as events arrive and deep-copies the whole list
 * (`structuredClone`) on each one. On a long thread that is the history
 * times every text delta: a profile of the live app showed about 80 s of
 * clones (and 26 s of garbage collection) in one scheduled turn, all on the
 * main thread, long enough to fail the healthcheck.
 *
 * The server doesn't read the agent's messages during or after a run: the
 * runner sets them before it (from the stored events) and keeps its own
 * events, which are what replays and what `runner.messages` returns. So for
 * these runs `apply` only hands each event, in order, to the subscribers'
 * `onEvent` (the runner's), and changes no messages or state.
 */
type Subscriber = {
    onEvent?: (parameters: {
        event: BaseEvent;
        agent: AbstractAgent;
        input: RunAgentInput;
        messages: AbstractAgent['messages'];
        state: AbstractAgent['state'];
    }) => unknown;
};

type Apply = (
    input: RunAgentInput,
    events: Observable<BaseEvent>,
    subscribers: Subscriber[],
) => Observable<Record<string, never>>;

export function leanApply(agent: AbstractAgent): Apply {
    return (input, events, subscribers) =>
        events.pipe(
            concatMap(async (event) => {
                for (const subscriber of subscribers) {
                    await subscriber.onEvent?.({
                        event,
                        agent,
                        input,
                        messages: agent.messages,
                        state: agent.state,
                    });
                }
                return {};
            }),
        );
}

/** `agent.runAgent(parameters, subscriber)` with `leanApply` for this run. */
export async function runAgentLean(
    agent: AbstractAgent,
    parameters: Parameters<AbstractAgent['runAgent']>[0],
    subscriber: Subscriber,
) {
    const target = agent as unknown as { apply: Apply };
    const own = Object.prototype.hasOwnProperty.call(target, 'apply');
    const previous = target.apply;
    target.apply = leanApply(agent);
    try {
        return await agent.runAgent(parameters, subscriber as Parameters<AbstractAgent['runAgent']>[1]);
    } finally {
        if (own) {
            target.apply = previous;
        } else {
            delete (target as { apply?: Apply }).apply;
        }
    }
}
