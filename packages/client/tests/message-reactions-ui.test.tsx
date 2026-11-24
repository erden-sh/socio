import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReactionsView } from '@socio/shared/chat/reactions';

import { CHANGES_CHANNEL, closeChangeChannel } from '../src/lib/change-channel';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { useReactions, withReaction } from '../src/modules/chat/use-reactions';

import { FakeBroadcastChannel } from './helpers/fake-broadcast-channel';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// CB-133: the reaction buttons in a Dot message's action row, and the
// state behind them: shown at once, kept by the server, in step with other
// tabs and devices.
let root: Root | undefined;
let host: HTMLElement | undefined;
let server: ReactionsView;
let calls: Array<{ method: string; path: string }>;
let failWrites = false;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    server = { shared: false, messages: {} };
    calls = [];
    failWrites = false;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ method, path: String(url) });
        if (method !== 'GET' && failWrites) {
            return Response.json({ error: 'No.' }, { status: 500 });
        }
        const kind = String(url).split('/').at(-1) as 'up';
        if (method === 'PUT') {
            server = withReaction(server, 'a1', kind, true);
        }
        if (method === 'DELETE') {
            server = withReaction(server, 'a1', kind, false);
        }
        return Response.json(server);
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    closeChangeChannel();
    vi.unstubAllGlobals();
});

const messages: Message[] = [
    { id: 'u1', role: 'user', content: 'Plan the offsite' },
    { id: 'a1', role: 'assistant', content: 'Talks, then lunch.' },
    { id: 'a2', role: 'assistant', content: 'Anything else?' },
];
function Harness({ enabled = true }: { enabled?: boolean }) {
    const reactions = useReactions('c1', enabled);
    return <ChatTranscript messages={messages} calls={[]} reactions={reactions} />;
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function render(enabled = true) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(<Harness enabled={enabled} />);
        await tick();
    });
    return host;
}
const message = (id: string) => host!.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const button = (id: string, kind: string) => message(id).querySelector<HTMLButtonElement>(`[data-reaction="${kind}"]`)!;

it('puts four labelled toggles in each Dot message’s row, and none under the person’s', async () => {
    server = {
        shared: false,
        messages: { a1: { counts: { down: 1 }, mine: ['down'] } },
    };
    await render();
    expect(message('u1').querySelector('[data-slot="message-reactions"]')).toBeNull();
    for (const id of ['a1', 'a2']) {
        expect([...message(id).querySelectorAll('[data-reaction]')].map((el) => el.getAttribute('aria-label'))).toEqual(
            ['Good reply', 'Bad reply', 'Try again', 'Needs work'],
        );
    }
    expect(message('a1').querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('React to this reply');
    // The reader's own is pressed (and highlighted); the others are not.
    expect(button('a1', 'down').getAttribute('aria-pressed')).toBe('true');
    expect(button('a1', 'up').getAttribute('aria-pressed')).toBe('false');
    expect(button('a2', 'down').getAttribute('aria-pressed')).toBe('false');
    // A message with a reaction keeps its row in view; the others show on hover.
    expect(message('a1').querySelector('[data-slot="message-actions"]')!.hasAttribute('data-pinned')).toBe(true);
    expect(message('a2').querySelector('[data-slot="message-actions"]')!.hasAttribute('data-pinned')).toBe(false);
});

it('shows counts only where others can see the chat, or from two', async () => {
    server = {
        shared: false,
        messages: {
            a1: { counts: { up: 1, retry: 2 }, mine: ['up'] },
        },
    };
    await render();
    expect(button('a1', 'up').textContent).toBe('');
    expect(button('a1', 'retry').textContent).toBe('2');
    expect(button('a1', 'retry').getAttribute('aria-label')).toBe('Try again, 2');
    // A team chat counts from one.
    act(() => root!.unmount());
    host!.remove();
    server = { shared: true, messages: { a1: { counts: { up: 1 }, mine: [] } } };
    await render();
    expect(button('a1', 'up').textContent).toBe('1');
    expect(button('a1', 'down').textContent).toBe('');
});

it('adds at once, saves on the server, and takes the reaction back on a second press', async () => {
    await render();
    await act(async () => {
        button('a1', 'needs-work').click();
    });
    // Pressed before the server answered.
    expect(button('a1', 'needs-work').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
        await tick();
    });
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([
        {
            method: 'PUT',
            path: '/api/conversations/c1/messages/a1/reactions/needs-work',
        },
    ]);
    expect(server.messages.a1.mine).toEqual(['needs-work']);
    expect(message('a1').querySelector('[data-slot="message-reactions"] [role="status"]')!.textContent).toBe(
        'Needs work added',
    );
    await act(async () => {
        button('a1', 'needs-work').click();
        await tick();
    });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(button('a1', 'needs-work').getAttribute('aria-pressed')).toBe('false');
    expect(server.messages.a1).toBeUndefined();
});

it('a thumbs up takes the thumbs down’s place', () => {
    const view: ReactionsView = {
        shared: true,
        messages: { a1: { counts: { down: 2 }, mine: ['down'] } },
    };
    expect(withReaction(view, 'a1', 'up', true).messages.a1).toEqual({
        counts: { down: 1, up: 1 },
        mine: ['up'],
    });
    expect(withReaction(view, 'a1', 'down', false).messages.a1).toEqual({
        counts: { down: 1 },
        mine: [],
    });
});

it('puts the button back and says so when the server refuses', async () => {
    await render();
    failWrites = true;
    await act(async () => {
        button('a1', 'up').click();
        await tick();
    });
    expect(button('a1', 'up').getAttribute('aria-pressed')).toBe('false');
    expect(message('a1').textContent).toContain('Could not save that');
    expect(message('a2').textContent).not.toContain('Could not save that');
});

it('follows another tab’s change at once, and another device’s on its next poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
        await render();
        expect(button('a1', 'up').getAttribute('aria-pressed')).toBe('false');
        // Another tab reacted: its note names the conversation, nothing more.
        server = {
            shared: false,
            messages: { a1: { counts: { up: 1 }, mine: ['up'] } },
        };
        const other = new FakeBroadcastChannel(CHANGES_CHANNEL);
        await act(async () => {
            other.postMessage([{ topic: 'conversation', id: 'c1' }]);
            await tick(200);
        });
        expect(button('a1', 'up').getAttribute('aria-pressed')).toBe('true');
        // Another device (no note reaches this browser): the next poll.
        server = {
            shared: false,
            messages: { a2: { counts: { retry: 1 }, mine: ['retry'] } },
        };
        await act(async () => {
            vi.advanceTimersByTime(5000);
            await tick();
        });
        expect(button('a2', 'retry').getAttribute('aria-pressed')).toBe('true');
        expect(button('a1', 'up').getAttribute('aria-pressed')).toBe('false');
    } finally {
        vi.useRealTimers();
    }
});

it('shows no buttons until the reactions have loaded, or when they are off', async () => {
    await render(false);
    expect(host!.querySelector('[data-slot="message-reactions"]')).toBeNull();
    expect(calls).toEqual([]);
});
