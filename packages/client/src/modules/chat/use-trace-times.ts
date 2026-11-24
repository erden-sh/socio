import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useState } from 'react';

import { TraceTimes } from '@socio/shared/runs/trace-times';

/**
 * When things happened in the chat (CB-72), from the times on the agent's
 * events: the history a connection replays and the turns it streams. Kept
 * for the chat's lifetime, so a reconnect's replay keeps them. Call it
 * before the chat connects: a connection takes the subscribers it has when
 * it starts. The times change as events arrive, before the messages they
 * belong to re-render the chat.
 */
export function useTraceTimes(agent: AbstractAgent) {
    const [times, setTimes] = useState(() => new TraceTimes());
    const [owner, setOwner] = useState(agent);
    if (owner !== agent) {
        setOwner(agent);
        setTimes(new TraceTimes());
    }
    useEffect(() => {
        const events = agent.subscribe({
            onEvent: ({ event }) => times.add(event),
        });
        return () => events.unsubscribe();
    }, [agent, times]);
    return times;
}
