import type { AbstractAgent } from '@ag-ui/client';
import { useEffect, useRef, useState } from 'react';

import { TIME_ZONE_MOVED_EVENT, type TimeZoneMoved } from '@socio/shared/time-zone';

/**
 * The zone the person's detected time zone moved to (CB-176), when a turn
 * of this chat said so: its quiet note stays for as long as the chat is
 * open. The server says it once, in the person's next chat; events
 * replayed outside a turn (history on connect) are ignored, as the run
 * phase ignores them.
 */
export function useTimeZoneMoved(agent: AbstractAgent, running: boolean) {
    const [zone, setZone] = useState<string>();
    const active = useRef(false);
    useEffect(() => {
        const events = agent.subscribe({
            onEvent: ({ event }) => {
                if (!active.current) {
                    return;
                }
                const custom = event as {
                    type: string;
                    name?: string;
                    value?: unknown;
                };
                if (custom.type !== 'CUSTOM' || custom.name !== TIME_ZONE_MOVED_EVENT) {
                    return;
                }
                const moved = custom.value as Partial<TimeZoneMoved> | undefined;
                if (typeof moved?.zone === 'string') {
                    setZone(moved.zone);
                }
            },
        });
        return () => events.unsubscribe();
    }, [agent]);
    useEffect(() => {
        active.current = running;
    }, [running]);
    return zone;
}
