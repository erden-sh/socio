import { describe, expect, it } from 'vitest';

import {
    createNetworkWatch,
    isForeground,
    LONG_BACKGROUND_MS,
    type NetworkState,
    returnsFromBackground,
} from '../../src/sync/triggers';

// What the scheduler reads from the app's state and the network,
// ported from T3 Code's wakeups: 'inactive'
// is the foreground, a picker's trip to the background isn't a return, and a
// change of network type while connected is a trigger.

const wifi: NetworkState = { connected: true, type: 'wifi' };
const cellular: NetworkState = { connected: true, type: 'cellular' };
const offline: NetworkState = { connected: false, type: 'none' };
const unknown: NetworkState = { connected: null, type: 'unknown' };

describe('the app’s state', () => {
    it('counts inactive, and a state not known yet, as the foreground', () => {
        expect(isForeground('active')).toBe(true);
        expect(isForeground('inactive')).toBe(true);
        expect(isForeground('unknown')).toBe(true);
        expect(isForeground('background')).toBe(false);
    });

    it('takes 10 s or more in the background as a return, less (a picker, a share sheet) as a brief leave', () => {
        expect(LONG_BACKGROUND_MS).toBe(10_000);
        expect(returnsFromBackground(1000, 1000 + LONG_BACKGROUND_MS)).toBe(true);
        expect(returnsFromBackground(1000, 1000 + LONG_BACKGROUND_MS - 1)).toBe(false);
        // Never in the background (inactive and back): no return.
        expect(returnsFromBackground(null, 50_000)).toBe(false);
    });
});

describe('the network watch', () => {
    it('takes the first known state as a seed, not a change', () => {
        const watch = createNetworkWatch();
        expect(watch.report(unknown)).toBeNull();
        expect(watch.report(offline)).toBeNull();
        expect(watch.report(wifi)).toBe('back');
    });

    it('reports the network coming back, going, and changing type while connected', () => {
        const watch = createNetworkWatch();
        watch.seed(wifi);
        expect(watch.report(wifi)).toBeNull();
        // Wi-Fi to cellular never shows as offline.
        expect(watch.report(cellular)).toBe('changed');
        expect(watch.report(offline)).toBe('lost');
        expect(watch.report(offline)).toBeNull();
        expect(watch.report(cellular)).toBe('back');
    });

    it('ignores a state NetInfo doesn’t know yet, and keeps the last known one', () => {
        const watch = createNetworkWatch();
        watch.seed(offline);
        expect(watch.report(unknown)).toBeNull();
        expect(watch.report(wifi)).toBe('back');
    });

    it('takes a seed only before the first report, since a report is newer', () => {
        const watch = createNetworkWatch();
        expect(watch.report(cellular)).toBeNull();
        watch.seed(wifi);
        expect(watch.report(cellular)).toBeNull();
        // An unknown seed is no seed.
        const fresh = createNetworkWatch();
        fresh.seed(unknown);
        fresh.seed(offline);
        expect(fresh.report(wifi)).toBe('back');
    });
});
