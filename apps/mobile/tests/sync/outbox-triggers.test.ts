import { describe, expect, it, vi } from 'vitest';

import { bindOutboxTriggers, notesToPull } from '../../src/sync/outbox-triggers';

import { CELLULAR, fakeAppState, fakeNetwork, OFFLINE, WIFI } from './fakes';
import { turns } from './outbox-fakes';

// The outbox's drain triggers: a return to the
// foreground and the network back or changed poke it, through triggers.ts's
// AppState and NetInfo sources; the network going and a picker's 'inactive'
// don't; the unbind leaves no listener. And the pull after this device's own
// write (`notesForWrite`).

describe('the outbox drain triggers', () => {
    it('pokes on a return to the foreground, and the network back or changed', async () => {
        const appState = fakeAppState('active');
        const network = fakeNetwork(WIFI);
        const poke = vi.fn();
        const unbind = bindOutboxTriggers({ appState, network, poke });
        await turns(2);

        appState.set('inactive');
        expect(poke).not.toHaveBeenCalled();
        appState.set('background');
        appState.set('active');
        expect(poke).toHaveBeenCalledTimes(1);

        network.set(OFFLINE);
        expect(poke).toHaveBeenCalledTimes(1);
        network.set(WIFI);
        expect(poke).toHaveBeenCalledTimes(2);
        network.set(CELLULAR);
        expect(poke).toHaveBeenCalledTimes(3);
        network.set(CELLULAR);
        expect(poke).toHaveBeenCalledTimes(3);

        unbind();
        expect(appState.listeners).toBe(0);
        expect(network.listeners).toBe(0);
    });

    it('wakes, not pokes, for the network back or changed when given a wake', async () => {
        const appState = fakeAppState('active');
        const network = fakeNetwork(WIFI);
        const poke = vi.fn();
        const wake = vi.fn();
        bindOutboxTriggers({ appState, network, poke, wake });
        await turns(2);
        network.set(OFFLINE);
        network.set(WIFI);
        network.set(CELLULAR);
        expect(wake).toHaveBeenCalledTimes(2);
        appState.set('background');
        appState.set('active');
        expect(poke).toHaveBeenCalledTimes(1);
    });

    it('a write to a chat pulls that chat and the shell; a write nobody shows pulls nothing', () => {
        expect(notesToPull('/api/conversations/t-1/steering')).toEqual({
            conversations: ['t-1'],
            issues: [],
            shell: true,
        });
        expect(notesToPull('/api/conversations/t-1')).toEqual({ conversations: ['t-1'], issues: [], shell: true });
        expect(notesToPull('/api/copilotkit/agent/d-1/run')).toEqual({ conversations: [], issues: [], shell: false });
        // An issue's write names its detail: read again if held.
        expect(notesToPull('/api/issues/12/comments')).toEqual({ conversations: [], issues: ['12'], shell: true });
    });
});
