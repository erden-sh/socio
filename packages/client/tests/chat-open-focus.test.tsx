// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Conversation, Dot } from '@socio/shared/types';

import type { Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The live chat's CopilotKit agent, as far as the composer uses it.
const agent = vi.hoisted(() => ({
    messages: [] as unknown[],
    addMessage: vi.fn(),
    subscribe: () => ({ unsubscribe: () => {} }),
}));
const copilotkit = vi.hoisted(() => ({
    subscribe: () => ({ unsubscribe: () => {} }),
    connectAgent: vi.fn(async () => undefined),
    runAgent: vi.fn(async () => ({ newMessages: [{ role: 'assistant' }] })),
    stopAgent: vi.fn(),
}));
vi.mock('@copilotkit/react-core/v2', () => ({
    useAgent: () => ({ agent, isReady: true }),
    useCopilotKit: () => ({ copilotkit }),
    useRenderTool: () => {},
    useHumanInTheLoop: () => {},
    CopilotChatToolCallsView: () => null,
}));

const { Chat } = await import('../src/modules/chat/Chat');
const { DotChat } = await import('../src/views/ChatViews');
const { ShellContext } = await import('../src/shell/shell-context');

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Dot',
    instructions: 'Dot helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const thread: Conversation = {
    id: 'c1',
    dotId: 'd1',
    ownerId: 'alice',
    title: 'Chat',
    createdAt: 1,
};
const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** The browser the test runs in: a phone has a coarse pointer and no hover. */
function browser(kind: 'desktop' | 'touch desktop' | 'phone') {
    const coarse = kind !== 'desktop';
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: coarse && query === '(hover: none) and (pointer: coarse)',
    }));
    vi.stubGlobal('navigator', {
        userAgent: kind === 'phone' ? IPHONE : WINDOWS,
        maxTouchPoints: coarse ? 5 : 0,
    });
}

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
    agent.messages = [];
    agent.addMessage.mockClear();
    // jsdom has no layout.
    Element.prototype.scrollIntoView = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        Response.json(String(url).includes('/me/inference/options') ? { options: [], automatic: null } : null),
    );
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(node));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return host;
}

const newConversation = vi.fn(async () => true);
async function renderNewChat() {
    const shell = {
        state: { settings: { paused: false } },
        workspace: {
            dots: [dot],
            setup: { model: true, telegram: 'not_configured' },
        },
        admin: false,
        configured: true,
        busy: false,
        newConversation,
        openDialog: () => {},
        openTarget: () => {},
        pane: false,
        setPane: () => {},
    } as unknown as Shell;
    const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
        initialEntries: ['/dots/d1'],
    });
    return render(
        <ShellContext.Provider value={shell}>
            <RouterProvider router={router} />
        </ShellContext.Provider>,
    );
}

function renderChat(placement?: 'column' | 'page') {
    return render(
        <Chat
            thread={thread}
            dot={dot}
            placement={placement}
            onConsumed={() => {}}
            voiceReady={false}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />,
    );
}

/** A key press the way React sees it: keydown on the focused box. */
function press(box: HTMLTextAreaElement, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
    });
    act(() => {
        box.dispatchEvent(event);
    });
    return event;
}
function type(box: HTMLTextAreaElement, text: string) {
    return act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('focuses the message box of a new Dot chat on a desktop (CB-116)', async () => {
    browser('desktop');
    const view = await renderNewChat();
    expect(document.activeElement).toBe(view.querySelector('textarea'));
});

it('focuses the box of a new, empty chat, not of one with history or a side panel', async () => {
    browser('desktop');
    const view = await renderChat();
    expect(document.activeElement).toBe(view.querySelector('textarea'));
    act(() => root?.unmount());
    view.remove();

    agent.messages = [{ id: 'm1', role: 'user', content: 'Hello' }];
    const old = await renderChat();
    expect(document.activeElement).toBe(document.body);
    act(() => root?.unmount());
    old.remove();

    agent.messages = [];
    await renderChat('page');
    expect(document.activeElement).toBe(document.body);
});

it('does not raise the keyboard on a phone', async () => {
    browser('phone');
    await renderNewChat();
    expect(document.activeElement).toBe(document.body);
    act(() => root?.unmount());
    host?.remove();
    await renderChat();
    expect(document.activeElement).toBe(document.body);
});

it('does not steal focus from an open dialog or a field being typed in', async () => {
    browser('desktop');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    await renderNewChat();
    expect(document.activeElement).toBe(document.body);
    act(() => root?.unmount());
    host?.remove();
    dialog.remove();

    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    await renderNewChat();
    expect(document.activeElement).toBe(other);
});

it('sends from the new-chat box with Enter and Ctrl+Enter, not Shift+Enter, on a desktop (CB-115)', async () => {
    for (const kind of ['desktop', 'touch desktop'] as const) {
        browser(kind);
        newConversation.mockClear();
        const view = await renderNewChat();
        const box = view.querySelector('textarea')!;
        // Nothing to send yet: the key is taken, the box stays empty.
        expect(press(box).defaultPrevented).toBe(true);
        expect(newConversation).not.toHaveBeenCalled();
        await type(box, 'Hello');
        expect(press(box, { shiftKey: true }).defaultPrevented).toBe(false);
        expect(newConversation).not.toHaveBeenCalled();
        // An IME choosing a candidate does not send.
        expect(press(box, { isComposing: true }).defaultPrevented).toBe(false);
        expect(newConversation).not.toHaveBeenCalled();
        expect(press(box).defaultPrevented).toBe(true);
        expect(press(box, { ctrlKey: true }).defaultPrevented).toBe(true);
        expect(newConversation).toHaveBeenCalledTimes(2);
        expect(newConversation).toHaveBeenCalledWith(dot, 'Hello', null, []);
        act(() => root?.unmount());
        view.remove();
    }
});

it('sends from the chat box with Enter on a touch-screen desktop (CB-115)', async () => {
    browser('touch desktop');
    const view = await renderChat();
    const box = view.querySelector('textarea')!;
    await type(box, 'Hello');
    expect(press(box).defaultPrevented).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(agent.addMessage).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'Hello' }));
});

it('keeps Enter for a new line on a phone, where Ctrl+Enter still sends', async () => {
    browser('phone');
    newConversation.mockClear();
    const view = await renderNewChat();
    const box = view.querySelector('textarea')!;
    await type(box, 'Hello');
    expect(press(box).defaultPrevented).toBe(false);
    expect(newConversation).not.toHaveBeenCalled();
    expect(press(box, { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(newConversation).toHaveBeenCalledTimes(1);
});
