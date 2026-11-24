import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChatTranscript } from '../src/modules/chat/ChatTranscript';
import { COPIED_MS } from '../src/modules/chat/MessageActions';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
const writeText = vi.fn<(text: string) => Promise<void>>();
beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.useRealTimers();
});

function render(messages: Message[], streamingId?: string) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<ChatTranscript messages={messages} calls={[]} streamingId={streamingId} />));
    return host;
}

const reply = ['## Plan', '', '- **One** step', '- `two` steps', '', '```sql', 'SELECT 1;', '```'].join('\n');

it('puts a Copy row under each message, for both roles', () => {
    const view = render([
        { id: 'u', role: 'user', content: 'What is the plan?' },
        { id: 'a', role: 'assistant', content: reply },
    ]);
    const rows = view.querySelectorAll('[data-slot="message-actions"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
        expect(row.querySelector('button')!.getAttribute('aria-label')).toBe('Copy');
    }
    // Each row sits under its own message.
    const messages = view.querySelectorAll('[data-chat-message]');
    expect(messages[0].contains(rows[0])).toBe(true);
    expect(messages[1].contains(rows[1])).toBe(true);
});

it('copies the Markdown source, shows a check mark for 2 s and announces it', async () => {
    vi.useFakeTimers();
    const view = render([{ id: 'a', role: 'assistant', content: reply }]);
    const button = view.querySelector<HTMLButtonElement>('[data-slot="message-actions"] button')!;
    const status = view.querySelector('[data-slot="message-actions"] [role="status"]')!;
    expect(status.textContent).toBe('');
    expect(button.querySelector('svg')!.classList).toContain('lucide-copy');
    await act(async () => button.click());
    // The source, not the rendered text: the heading marks, bold and fence stay.
    expect(writeText).toHaveBeenCalledWith(reply);
    expect(button.querySelector('svg')!.classList).toContain('lucide-check');
    expect(status.textContent).toBe('Copied');
    act(() => vi.advanceTimersByTime(COPIED_MS - 100));
    expect(button.querySelector('svg')!.classList).toContain('lucide-check');
    act(() => vi.advanceTimersByTime(100));
    expect(button.querySelector('svg')!.classList).toContain('lucide-copy');
    expect(status.textContent).toBe('');
});

it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const view = render([{ id: 'u', role: 'user', content: 'Hello' }]);
    await act(async () => view.querySelector<HTMLButtonElement>('[data-slot="message-actions"] button')!.click());
    expect(view.querySelector('[data-slot="message-actions"] [role="status"]')!.textContent).toBe('Could not copy');
});

it('leaves the row off a reply the Dot is still writing, and off attachment-only messages', () => {
    const view = render(
        [
            {
                id: 'u',
                role: 'user',
                content: [
                    {
                        type: 'binary',
                        id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
                        mimeType: 'text/plain',
                        filename: 'a.txt',
                    },
                ],
            } as unknown as Message,
            { id: 'a', role: 'assistant', content: 'Half a sen' },
        ],
        'a',
    );
    expect(view.querySelectorAll('[data-chat-message]')).toHaveLength(2);
    expect(view.querySelectorAll('[data-slot="message-actions"]')).toHaveLength(0);
});

it('lays a Dot’s reply out as full-width text with a heading for screen readers, the reader’s message as a bubble', () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <ChatTranscript
                dotName="Ada"
                calls={[]}
                messages={[
                    { id: 'u', role: 'user', content: 'What is due?' },
                    { id: 'a', role: 'assistant', content: 'The **Q3** report.' },
                ]}
            />,
        ),
    );
    const [mine, reply] = host.querySelectorAll('[data-chat-message]');
    // No bubble and no avatar on the reply: text, with the Dot's name as an
    // sr-only heading.
    expect(reply.querySelector('[data-chat-body="user"]')).toBeNull();
    expect(reply.querySelector('[data-chat-body="assistant"]')!.textContent).toBe('The Q3 report.');
    const heading = reply.querySelector('h2')!;
    expect(heading.textContent).toBe('Ada');
    expect(heading.className).toBe('sr-only');
    expect(reply.querySelector('img, [data-local]')).toBeNull();
    // No data-slot around the Markdown: the legacy resets (list markers,
    // heading sizes) stop at data-slot elements (legacy-reset.css).
    expect(reply.querySelector('[data-chat-body="assistant"]')!.closest('[data-slot]')).toBeNull();
    expect(mine.querySelector('[data-chat-body]')!.closest('[data-slot]')).toBeNull();
    // The reader's own message keeps its bubble, on the right.
    expect(mine.getAttribute('data-chat-message')).toBe('user');
    expect(mine.classList).toContain('items-end');
    expect(mine.querySelector('[data-chat-body="user"]')!.textContent).toBe('What is due?');
    expect(mine.querySelector('h2, [data-chat-author]')).toBeNull();
});

it('shows other people’s messages in a team transcript as bubbles on the left with their name', () => {
    const view = render([
        {
            id: 'b',
            role: 'user',
            content: 'When are the Q3 numbers due?',
            author: { name: 'Bob', you: false },
        } as Message,
        { id: 'a', role: 'assistant', content: 'Friday.' },
        {
            id: 'me',
            role: 'user',
            content: 'Thanks, I will draft it.',
            author: { name: 'Alice', you: true },
        } as Message,
    ]);
    const [bob, reply, mine] = view.querySelectorAll('[data-chat-message]');
    expect(bob.getAttribute('data-chat-message')).toBe('other');
    expect(bob.classList).toContain('items-start');
    expect(bob.querySelector('[data-chat-author]')!.textContent).toBe('Bob');
    // The name sits above the bubble.
    expect(bob.firstElementChild!.hasAttribute('data-chat-author')).toBe(true);
    expect(bob.querySelector('[data-chat-body="other"]')!.textContent).toBe('When are the Q3 numbers due?');
    expect(reply.querySelector('[data-chat-body="user"]')).toBeNull();
    // The reader's own message in the team chat: theirs, on the right, unnamed.
    expect(mine.getAttribute('data-chat-message')).toBe('user');
    expect(mine.classList).toContain('items-end');
    expect(mine.querySelector('[data-chat-author]')).toBeNull();
});
