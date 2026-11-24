// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dot, User } from '@socio/shared/types';

import { CurrentUser } from '../src/shell/current-user';
import { ShellContext, type Shell } from '../src/shell/shell-context';
import { DotChat } from '../src/views/ChatViews';

// CB-266: the first-message composer carries the same actions as a running
// chat's — the source-page link and voice/dictation — and the link button's
// purpose is clear from a tooltip. Speech recognition is a fake; nothing
// listens and nothing leaves the test.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dot: Dot = {
    id: 'd1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Ada',
    instructions: 'Ada helps.',
    researchAllowed: false,
    memoryAllowed: false,
    createdAt: 1,
};
const bob: User = { id: 'bob', name: 'Bob', role: 'member' };

/** The browser's speech recognition, driven by the test. */
class FakeRecognition {
    static last: FakeRecognition | undefined;
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
        FakeRecognition.last = this;
    }
    start() {
        this.started = true;
    }
    stop() {
        this.onend?.();
    }
    abort() {
        this.onerror?.({ error: 'aborted' });
        this.onend?.();
    }
    hear(text: string, isFinal = true) {
        const result = Object.assign([{ transcript: text }], { isFinal });
        this.onresult?.({ results: [result] });
    }
}

let newConversation: ReturnType<typeof vi.fn>;
let root: Root | undefined;
let host: HTMLElement | undefined;

beforeEach(() => {
    FakeRecognition.last = undefined;
    newConversation = vi.fn(async () => false);
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    vi.stubGlobal(
        'fetch',
        async () =>
            new Response(JSON.stringify({ options: [], automatic: null }), {
                headers: { 'Content-Type': 'application/json' },
            }),
    );
});

afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function shellWith(over: Partial<Shell> = {}): Shell {
    return {
        state: { settings: { paused: false, dictationMethods: 'both' } },
        workspace: {
            user: bob,
            dots: [dot],
            setup: { model: true, telegram: 'not_configured', transcription: false },
            preferences: { dictation: null },
        },
        admin: false,
        configured: true,
        busy: false,
        newConversation,
        refresh: vi.fn(async () => {}),
        openDialog: () => {},
        openTarget: () => {},
        pane: false,
        setPane: () => {},
        ...over,
    } as unknown as Shell;
}

async function render(shell: Shell) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const router = createMemoryRouter([{ path: '/dots/:dotId', element: <DotChat /> }], {
        initialEntries: ['/dots/d1'],
    });
    await act(async () =>
        root!.render(
            <CurrentUser.Provider value={bob}>
                <ShellContext.Provider value={shell}>
                    <RouterProvider router={router} />
                </ShellContext.Provider>
            </CurrentUser.Provider>,
        ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    return host;
}

const $ = <T extends Element = HTMLElement>(selector: string) => host!.querySelector<T>(selector);
const textarea = () => $<HTMLTextAreaElement>('textarea')!;
const click = (element: Element | null) =>
    act(async () => {
        (element as HTMLElement).click();
        await new Promise((r) => setTimeout(r, 0));
    });
async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea(), text);
        textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('shows the source-page link button in the new-chat toolbar and prepends From <url> to the first message (CB-266)', async () => {
    await render(shellWith());
    const toolbar = $('[data-slot="composer-tools"]')!;
    // The link button is in the toolbar, with a tooltip that explains it.
    const link = $<HTMLButtonElement>('[aria-label="Add source page link"]')!;
    expect(toolbar.contains(link)).toBe(true);
    expect(link.getAttribute('title')).toMatch(/From <url>/);
    // It is the first action, before attach.
    expect(toolbar.querySelector('button')).toBe(link);
    // No source input yet.
    expect($('[data-slot="source-input"]')).toBeNull();
    await click(link);
    const input = $<HTMLInputElement>('[aria-label="Source page URL"]')!;
    expect(input).not.toBeNull();
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
            input,
            'https://example.com/page',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('read this');
    await click($('[aria-label="Start conversation"]'));
    expect(newConversation).toHaveBeenCalledWith(dot, 'From https://example.com/page:\n\nread this', null, []);
});

it('sends the prompt unchanged when no source link is set (CB-266)', async () => {
    await render(shellWith());
    await type('just a question');
    await click($('[aria-label="Start conversation"]')!);
    expect(newConversation).toHaveBeenCalledWith(dot, 'just a question', null, []);
});

it('offers dictation on the first message and writes it into the prompt, without sending (CB-266)', async () => {
    await render(shellWith());
    // Device dictation works in this browser, so the mic is offered.
    const mic = $<HTMLButtonElement>('[aria-label="Dictate"]')!;
    expect(mic.parentElement!.dataset.slot).toBe('composer-tools');
    await type('Note:');
    await click(mic);
    expect(FakeRecognition.last?.started).toBe(true);
    expect($('[data-slot="dictation-listening"]')?.textContent).toContain('Listening');
    await act(async () => FakeRecognition.last!.hear('buy milk'));
    await click($('[aria-label="Done dictating"]'));
    expect(textarea().value).toBe('Note: buy milk');
    // In the prompt to edit, never sent on its own.
    expect(newConversation).not.toHaveBeenCalled();
});

it('shows no mic when neither dictation way works (CB-266)', async () => {
    // No webkitSpeechRecognition here (it is set in beforeEach, so remove it).
    delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    await render(shellWith());
    expect($('[aria-label="Dictate"]')).toBeNull();
});
