import type { AbstractAgent } from '@ag-ui/client';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { TIME_ZONE_MOVED_EVENT } from '@socio/shared/time-zone';

import { useTimeZoneMoved } from '../src/shell/use-time-zone-moved';

// CB-176: the chat shows the quiet note of a moved time zone when a turn
// of its own says so, never from history replayed on connect.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

type Listener = { onEvent: (params: { event: unknown }) => void };
const listeners = new Set<Listener>();
const agent = {
    subscribe: (listener: Listener) => {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
    },
} as unknown as AbstractAgent;
const emit = (event: unknown) =>
    act(() => {
        for (const listener of listeners) {
            listener.onEvent({ event });
        }
    });

function Probe({ running }: { running: boolean }) {
    const zone = useTimeZoneMoved(agent, running);
    return <p>{zone ?? 'none'}</p>;
}

it('takes the moved zone from a running turn only', () => {
    const moved = (zone: string) => ({
        type: 'CUSTOM',
        name: TIME_ZONE_MOVED_EVENT,
        value: { zone },
    });
    act(() => root.render(<Probe running={false} />));
    emit(moved('Asia/Tokyo'));
    expect(host.textContent).toBe('none');
    act(() => root.render(<Probe running />));
    emit({ type: 'CUSTOM', name: 'socio.run-model', value: { zone: 'x' } });
    emit({ type: 'CUSTOM', name: TIME_ZONE_MOVED_EVENT, value: {} });
    expect(host.textContent).toBe('none');
    emit(moved('Europe/Madrid'));
    expect(host.textContent).toBe('Europe/Madrid');
    // It stays once the turn is over, for as long as the chat is open.
    act(() => root.render(<Probe running={false} />));
    expect(host.textContent).toBe('Europe/Madrid');
});
