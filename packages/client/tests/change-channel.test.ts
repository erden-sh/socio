// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ChangeNote } from '@socio/shared/live/change-notes';

import { AWAY_MS, watchReturns } from '../src/hooks/use-tab-refresh';
import { api } from '../src/lib/api';
import {
    CHANGES_CHANNEL,
    closeChangeChannel,
    postChanges,
    refreshShown,
    useLiveTopic,
} from '../src/lib/change-channel';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});
afterEach(() => {
    closeChangeChannel();
    vi.unstubAllGlobals();
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const posted = () =>
    FakeBroadcastChannel.posted.filter((message) => message.name === CHANGES_CHANNEL).map((message) => message.data);

it('a write through api() posts its note, and only after it worked', async () => {
    const replies = [200, 403];
    vi.stubGlobal('fetch', async () => {
        const status = replies.shift() ?? 200;
        return new Response(JSON.stringify(status === 200 ? {} : { error: 'No.' }), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    await api('/conversations/c1', 'PATCH', { title: 'Secret plan' });
    await expect(api('/conversations/c2', 'DELETE')).rejects.toThrow('No.');
    await api('/conversations/c1');
    expect(posted()).toEqual([[{ topic: 'conversation', id: 'c1' }]]);
    // Nothing of the body or the title goes on the channel.
    expect(JSON.stringify(posted())).not.toMatch(/Secret|title/);
});

it('never posts anything but topic and ids', () => {
    postChanges([
        { topic: 'memory', id: 'm1', text: 'my diary' } as unknown as ChangeNote,
        { topic: 'conversation', id: 'c1' },
    ]);
    expect(posted()).toEqual([[{ topic: 'conversation', id: 'c1' }]]);
});

/** Renders a hook-only component; returns the unmount. */
function mount(use: () => void) {
    const host = document.createElement('div');
    const root = createRoot(host);
    const Probe = () => {
        use();
        return null;
    };
    act(() => root.render(createElement(Probe)));
    return () => act(() => root.unmount());
}

it('another tab’s notes make the views of that topic refetch, coalesced', async () => {
    const heard: string[] = [];
    const unmount = mount(() => {
        useLiveTopic('issues', () => heard.push('issues'));
        useLiveTopic('space:s1', () => heard.push('space:s1'));
        useLiveTopic('space:s2', () => heard.push('space:s2'));
    });
    const other = new FakeBroadcastChannel(CHANGES_CHANNEL);
    other.postMessage([{ topic: 'issue', id: '3' }]);
    other.postMessage([{ topic: 'issue', id: '4' }]);
    other.postMessage([{ topic: 'page', id: 'p1', spaceId: 's1' }]);
    // Not a note: ignored.
    other.postMessage({ topic: 'issue' });
    other.postMessage([{ topic: 'issue', body: 'x' }]);
    await act(() => tick(150));
    expect(heard.sort()).toEqual(['issues', 'space:s1']);
    unmount();
    other.postMessage([{ topic: 'issue' }]);
    await act(() => tick(150));
    expect(heard).toHaveLength(2);
});

it('the shell re-reads first; the other topics run after it settled', async () => {
    const order: string[] = [];
    let finish: () => void = () => {};
    let canPoll: () => boolean = () => true;
    const unmount = mount(() => {
        useLiveTopic('shell', async () => {
            order.push('shell');
            await new Promise<void>((resolve) => (finish = resolve));
            order.push('shell done');
        });
        canPoll = useLiveTopic('conversation:c1', () => order.push('chat'));
    });
    new FakeBroadcastChannel(CHANGES_CHANNEL).postMessage([{ topic: 'conversation', id: 'c1' }]);
    await act(() => tick(150));
    expect(order).toEqual(['shell']);
    // While the shell re-reads, the chat's own poll waits.
    expect(canPoll()).toBe(false);
    await act(async () => finish());
    await act(() => tick());
    expect(order).toEqual(['shell', 'shell done', 'chat']);
    expect(canPoll()).toBe(true);
    unmount();
    expect(canPoll()).toBe(false);
});

it('a chat poll waits from the moment a note for the shell arrives, not only once the shell re-reads', async () => {
    let canPoll: () => boolean = () => true;
    const unmount = mount(() => {
        useLiveTopic('shell', () => undefined);
        canPoll = useLiveTopic('conversation:c1', () => undefined);
    });
    expect(canPoll()).toBe(true);
    // The other tab deleted c1: inside the coalescing window, no tick asks for it.
    new FakeBroadcastChannel(CHANGES_CHANNEL).postMessage([{ topic: 'conversation', id: 'c1' }]);
    await act(() => tick());
    expect(canPoll()).toBe(false);
    await act(() => tick(150));
    expect(canPoll()).toBe(true);
    // A note the shell doesn't hear leaves the poll alone.
    new FakeBroadcastChannel(CHANGES_CHANNEL).postMessage([{ topic: 'capture', id: 'c1' }]);
    await act(() => tick());
    expect(canPoll()).toBe(true);
    await act(() => tick(150));
    unmount();
});

it('refreshShown runs every topic shown, at once', async () => {
    const heard: string[] = [];
    const unmount = mount(() => {
        useLiveTopic('shell', () => heard.push('shell'));
        useLiveTopic('issue:9', () => heard.push('issue:9'));
    });
    await act(() => refreshShown());
    expect(heard).toEqual(['shell', 'issue:9']);
    // It speaks to no other tab.
    expect(posted()).toEqual([]);
    unmount();
});

it('a return after two seconds away counts once; a quick one not at all', () => {
    let now = 0;
    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
    });
    const returns: number[] = [];
    const stop = watchReturns(() => returns.push(now), { now: () => now });
    const hide = () => {
        hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
    };
    const show = () => {
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new FocusEvent('focus'));
    };
    // An alt-tab and back within a second: nothing.
    window.dispatchEvent(new FocusEvent('blur'));
    now += 900;
    window.dispatchEvent(new FocusEvent('focus'));
    expect(returns).toEqual([]);
    // Hidden for 5 s, then shown and focused together: once.
    hide();
    now += 5000;
    show();
    expect(returns).toEqual([now]);
    // Focus alone, with nothing hidden in between: nothing more.
    now += 5000;
    window.dispatchEvent(new FocusEvent('focus'));
    expect(returns).toHaveLength(1);
    // Another window for exactly the threshold: counts.
    window.dispatchEvent(new FocusEvent('blur'));
    now += AWAY_MS;
    window.dispatchEvent(new FocusEvent('focus'));
    expect(returns).toHaveLength(2);
    stop();
    hide();
    now += 5000;
    show();
    expect(returns).toHaveLength(2);
    Reflect.deleteProperty(document, 'visibilityState');
});
