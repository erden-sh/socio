import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useRef, useState } from 'react';

import { nextPhase, startPhase, type RunPhase } from '@socio/shared/runs/run-phase';

/**
 * The running turn's phase, from the agent's events; undefined while
 * idle. It changes only when the phase does: the status line's clock
 * ticks on its own (`RunStatus`), without re-rendering the chat.
 */
export function useRunPhase(
    agent: AbstractAgent,
    running: boolean,
    /**
     * Set when the chat shows a turn it joined mid-way (a reload, CB-223):
     * its phase is the one the connection's replay of it reached.
     */
    joined?: { readonly current: boolean },
) {
    const [phase, setPhase] = useState<RunPhase>();
    const active = useRef(false);
    // The phase of the run the events last started, until it ends, also
    // while no turn shows (a run in progress replayed on connect).
    const replayed = useRef<RunPhase>(undefined);
    // Subscribed for the agent's lifetime: a run takes the subscribers it has
    // when it starts, which is before an effect of `running` would run.
    // Events outside a turn (history replay on connect) are ignored.
    useEffect(() => {
        const events = agent.subscribe({
            onEvent: ({ event }) => {
                const now = Date.now();
                replayed.current =
                    event.type === 'RUN_STARTED'
                        ? startPhase(now)
                        : event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR'
                          ? undefined
                          : replayed.current &&
                            nextPhase(replayed.current, event as Parameters<typeof nextPhase>[1], now);
                if (!active.current) {
                    return;
                }
                setPhase((current) =>
                    current ? nextPhase(current, event as Parameters<typeof nextPhase>[1], Date.now()) : current,
                );
            },
        });
        return () => events.unsubscribe();
    }, [agent]);
    useEffect(() => {
        active.current = running;
        setPhase(running ? ((joined?.current ? replayed.current : undefined) ?? startPhase(Date.now())) : undefined);
    }, [running, joined]);
    return phase;
}
