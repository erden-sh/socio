import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
    AUTH_CHANNEL,
    closeAuthChannel,
    forgetOnSignOut,
    forgetSessionMemory,
    onAuthEvent,
    postAuthEvent,
    type AuthEvent,
} from '../src/shell/auth-channel';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});
afterEach(() => {
    closeAuthChannel();
    vi.unstubAllGlobals();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

it('posts the event name alone, on the one channel', () => {
    postAuthEvent('signed-out');
    postAuthEvent('signed-in');
    expect(FakeBroadcastChannel.posted).toEqual([
        { name: AUTH_CHANNEL, data: 'signed-out' },
        { name: AUTH_CHANNEL, data: 'signed-in' },
    ]);
    // One channel object for the tab, however often it posts.
    expect(FakeBroadcastChannel.open.size).toBe(1);
});

it('hears other tabs, not itself', async () => {
    const heard: AuthEvent[] = [];
    onAuthEvent((event) => heard.push(event));
    postAuthEvent('signed-in');
    // Another tab: its own channel object with the same name.
    const other = new FakeBroadcastChannel(AUTH_CHANNEL);
    const otherHeard: unknown[] = [];
    other.addEventListener('message', (event) => otherHeard.push((event as MessageEvent).data));
    other.postMessage('signed-out');
    await tick();
    expect(heard).toEqual(['signed-out']);
    postAuthEvent('signed-in');
    await tick();
    expect(otherHeard).toEqual(['signed-in']);
});

it('ignores anything that is not one of its two events', async () => {
    const heard: AuthEvent[] = [];
    onAuthEvent((event) => heard.push(event));
    const other = new FakeBroadcastChannel(AUTH_CHANNEL);
    for (const data of ['signed-in-as-alice', { event: 'signed-out', userId: 'alice' }, ['signed-out'], null, 42]) {
        other.postMessage(data);
    }
    // Another channel name is another conversation.
    new FakeBroadcastChannel('something-else').postMessage('signed-out');
    await tick();
    expect(heard).toEqual([]);
});

it('stops calling a listener once it unsubscribes', async () => {
    const heard: AuthEvent[] = [];
    const stop = onAuthEvent((event) => heard.push(event));
    const other = new FakeBroadcastChannel(AUTH_CHANNEL);
    other.postMessage('signed-out');
    await tick();
    stop();
    other.postMessage('signed-in');
    await tick();
    expect(heard).toEqual(['signed-out']);
});

it('drops what modules keep for the visit on sign-out', () => {
    const kept = new Map([['a1', 'bytes']]);
    forgetOnSignOut(() => kept.clear());
    forgetSessionMemory();
    expect(kept.size).toBe(0);
});
