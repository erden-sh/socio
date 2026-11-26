// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AttachmentRef, UploadResult } from '@socio/shared/media-types';
import { attachmentPart } from '@socio/shared/media/refs';
import type { Conversation, Dot } from '@socio/shared/types';

import type { Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Uploads are driven by the test: each one waits until it is resolved.
const uploads: Array<{
    file: File;
    threadId?: string;
    resolve: (result: UploadResult) => void;
}> = [];
const upload = vi.hoisted(() => ({
    uploadAttachment: vi.fn(),
    removeAttachment: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/modules/chat/attachments/upload', () => ({
    uploadAttachment: upload.uploadAttachment,
    removeAttachment: upload.removeAttachment,
    DEFAULT_MEDIA_LIMITS: {
        fileMaxBytes: 1000,
        perMessage: 3,
        imageModelMaxBytes: 1000,
    },
    mediaLimits: async () => ({
        fileMaxBytes: 1000,
        perMessage: 3,
        imageModelMaxBytes: 1000,
    }),
    // A file deleted since: the bubble says so.
    attachmentView: async (id: string) => (id.includes('GONE') ? null : { size: 2048 }),
}));

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
const { ChatTranscript } = await import('../src/modules/chat/ChatTranscript');

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

let root: Root | undefined;
let host: HTMLElement | undefined;
beforeEach(() => {
    uploads.splice(0);
    // jsdom has no layout.
    Element.prototype.scrollIntoView = () => {};
    agent.addMessage.mockClear();
    upload.removeAttachment.mockClear();
    upload.uploadAttachment.mockImplementation(
        (file: File, options: { threadId?: string }) =>
            new Promise((resolve) => uploads.push({ file, threadId: options.threadId, resolve })),
    );
    // Page context, model options: nothing to show.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
        Response.json(String(url).includes('/me/inference/options') ? { options: [], automatic: null } : null),
    );
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(node));
    return host;
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const ref = (id: string, name: string, kind: AttachmentRef['kind']) => ({
    id,
    name,
    mediaType: kind === 'image' ? 'image/png' : 'text/markdown',
    size: 5,
    kind,
});
/** Finishes the n-th upload as the server would answer it. */
async function finish(index: number, attachment: AttachmentRef) {
    await act(async () =>
        uploads[index].resolve({
            item: {} as UploadResult['item'],
            attachment,
        }),
    );
}

function paste(target: Element, files: File[]) {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
        },
    });
    target.dispatchEvent(event);
    return event;
}
function drop(target: Element, files: File[]) {
    for (const type of ['dragover', 'drop']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: { files, types: ['Files'] },
        });
        target.dispatchEvent(event);
    }
}
function pick(host: HTMLElement, files: File[]) {
    const input = host.querySelector<HTMLInputElement>('[data-slot="attachment-input"]')!;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
}
const png = (name = 'shot.png') => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
const md = () => new File(['# hi'], 'notes.md', { type: 'text/markdown' });

it('attaches by paste, drop and picker in the chat, removes before sending, and sends references', async () => {
    const view = await render(
        <Chat
            thread={thread}
            dot={dot}
            onConsumed={() => {}}
            voiceReady={false}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />,
    );
    await flush();
    const textarea = view.querySelector('textarea')!;
    const form = view.querySelector('form[data-slot="chat-composer"]')!;
    const send = () => view.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send().disabled).toBe(true);
    // The composer (CB-97): the tray above the row; the row holds the tools,
    // the text box (one line to start) and send, each in its place.
    const row = form.querySelector('[data-slot="composer-row"]')!;
    expect(row.querySelector('[data-slot="composer-text"] textarea')).toBe(textarea);
    expect(textarea.rows).toBe(1);
    const tools = row.querySelector('[data-slot="composer-tools"]')!;
    expect(tools.querySelector('[aria-label="Add source page link"]')).not.toBeNull();
    expect(tools.querySelector('[aria-label="Attach files"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="composer-send"] [aria-label="Send message"]')).toBe(send());
    expect(form.closest('[class*="@container/chat"]')).not.toBeNull();

    // A pasted screenshot uploads into this conversation.
    await act(async () => {
        expect(paste(textarea, [png()]).defaultPrevented).toBe(true);
    });
    expect(uploads.map((entry) => [entry.file.name, entry.threadId])).toEqual([['shot.png', 'c1']]);
    expect(view.querySelector('[role="progressbar"]')).not.toBeNull();
    // Plain text pastes as before.
    await act(async () => {
        expect(paste(textarea, []).defaultPrevented).toBe(false);
    });
    // Dropped and picked files join it.
    await act(async () => drop(form, [md()]));
    await act(async () => pick(view, [png('other.png')]));
    expect(uploads.map((entry) => entry.file.name)).toEqual(['shot.png', 'notes.md', 'other.png']);
    // Sending waits for the uploads.
    await act(async () => {
        // Through the native setter, so React sees the change.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Look');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await finish(0, ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'shot.png', 'image'));
    await finish(1, ref('cbatt_BBBBBBBBBBBBBBBBBBBBBB', 'notes.md', 'text'));
    expect(send().disabled).toBe(true);
    await finish(2, ref('cbatt_CCCCCCCCCCCCCCCCCCCCCC', 'other.png', 'image'));
    expect(send().disabled).toBe(false);
    // The thumbnail is the uploaded original, from the server.
    expect(
        [...view.querySelectorAll<HTMLImageElement>('[data-slot="tray-thumb"]')].map((image) =>
            image.getAttribute('src'),
        ),
    ).toEqual([
        '/api/media/attachments/cbatt_AAAAAAAAAAAAAAAAAAAAAA/content',
        '/api/media/attachments/cbatt_CCCCCCCCCCCCCCCCCCCCCC/content',
    ]);
    // Over the per-message limit: a clear message, no upload.
    await act(async () => pick(view, [png('fourth.png')]));
    expect(view.querySelector('[data-slot="attachment-notice"]')?.textContent).toContain('at most 3 attachments');
    expect(uploads).toHaveLength(3);

    await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Remove other.png"]')!.click());
    expect(upload.removeAttachment).toHaveBeenCalledWith('cbatt_CCCCCCCCCCCCCCCCCCCCCC');
    await act(async () => send().click());
    expect(agent.addMessage).toHaveBeenCalledWith({
        id: expect.any(String),
        role: 'user',
        content: [
            { type: 'text', text: 'Look' },
            // AG-UI 1.0 media parts, never the pre-1.0 `binary` reference.
            {
                type: 'image',
                source: {
                    type: 'file',
                    value: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
                    provider: 'socio',
                    mimeType: 'image/png',
                },
                metadata: { filename: 'shot.png' },
            },
            {
                type: 'document',
                source: {
                    type: 'file',
                    value: 'cbatt_BBBBBBBBBBBBBBBBBBBBBB',
                    provider: 'socio',
                    mimeType: 'text/markdown',
                },
                metadata: { filename: 'notes.md' },
            },
        ],
    });
    // The tray empties; nothing sent is deleted.
    expect(view.querySelectorAll('[data-slot="tray-item"]')).toHaveLength(0);
    expect(upload.removeAttachment).toHaveBeenCalledTimes(1);
});

it('refuses files over the size limit with a clear message', async () => {
    const view = await render(
        <Chat
            thread={thread}
            dot={dot}
            onConsumed={() => {}}
            voiceReady={false}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />,
    );
    await flush();
    await act(async () => pick(view, [new File([new Uint8Array(1001)], 'big.zip')]));
    expect(uploads).toHaveLength(0);
    expect(view.querySelector('[data-slot="attachment-notice"]')?.textContent).toBe(
        'big.zip is 1001 B; files can be at most 1000 B.',
    );
});

it('sends the new-chat composer’s attachments with the first message', async () => {
    const attachments = [ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'shot.png', 'image')];
    const onConsumed = vi.fn();
    await render(
        <Chat
            thread={thread}
            dot={dot}
            initialPrompt=""
            initialAttachments={attachments}
            onConsumed={onConsumed}
            voiceReady={false}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />,
    );
    await flush();
    expect(onConsumed).toHaveBeenCalled();
    expect(agent.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
            content: [
                attachmentPart({ id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA', mimeType: 'image/png', filename: 'shot.png' }),
            ],
        }),
    );
});

it('uploads pending attachments in the new-chat composer and starts the chat with them', async () => {
    const newConversation = vi.fn(async () => true);
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
    const view = await render(
        <ShellContext.Provider value={shell}>
            <RouterProvider router={router} />
        </ShellContext.Provider>,
    );
    await flush();
    const textarea = view.querySelector('textarea')!;
    const start = () => view.querySelector<HTMLButtonElement>('[aria-label="Start conversation"]')!;
    // The text first, one line to start; a toolbar under it: attach at its
    // start, the model and send at its end (CB-97).
    expect(textarea.rows).toBe(1);
    const toolbar = view.querySelector('[data-slot="composer-toolbar"]')!;
    expect(textarea.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
        // Radix Select's hidden form copy of the model picker is not a control.
        [...toolbar.querySelectorAll('button, select:not([aria-hidden])')].map((item) =>
            item.getAttribute('aria-label'),
        ),
    ).toEqual(['Add source page link', 'Attach files', 'Model for this chat', 'Start conversation']);
    await act(async () => {
        paste(textarea, [png()]);
    });
    // Pending: no conversation yet.
    expect(uploads[0].threadId).toBeUndefined();
    expect(start().disabled).toBe(true);
    await finish(0, ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'shot.png', 'image'));
    // Files alone can start a chat.
    expect(start().disabled).toBe(false);
    await act(async () => drop(view.querySelector('form[data-slot="new-chat-composer"]')!, [md()]));
    await finish(1, ref('cbatt_BBBBBBBBBBBBBBBBBBBBBB', 'notes.md', 'text'));
    await act(async () => start().click());
    expect(newConversation).toHaveBeenCalledWith(dot, '', null, [
        ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'shot.png', 'image'),
        ref('cbatt_BBBBBBBBBBBBBBBBBBBBBB', 'notes.md', 'text'),
    ]);
    await flush();
    expect(view.querySelectorAll('[data-slot="tray-item"]')).toHaveLength(0);
    expect(upload.removeAttachment).not.toHaveBeenCalled();
});

it('shows a bubble’s images and files (stored before AG-UI 1.0, as `binary`), and a removed one as removed', async () => {
    const view = await render(
        <ChatTranscript
            calls={[]}
            messages={[
                {
                    id: 'm',
                    role: 'user',
                    content: [
                        { type: 'text', text: 'See **these**' },
                        {
                            type: 'binary',
                            id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
                            mimeType: 'image/png',
                            filename: 'shot.png',
                        },
                        {
                            type: 'binary',
                            id: 'cbatt_BBBBBBBBBBBBBBBBBBBBBB',
                            mimeType: 'application/pdf',
                            filename: 'spec.pdf',
                        },
                        {
                            type: 'binary',
                            id: 'cbatt_GONEGONEGONEGONEGONEGO',
                            mimeType: 'text/plain',
                            filename: 'old.txt',
                        },
                    ],
                } as never,
            ]}
        />,
    );
    await flush();
    const bubble = view.querySelector('[data-chat-body="user"]')!;
    expect(bubble.querySelector('strong')?.textContent).toBe('these');
    const file = bubble.querySelector<HTMLAnchorElement>('a[data-attachment="file"]')!;
    expect(file.getAttribute('href')).toBe('/api/media/attachments/cbatt_BBBBBBBBBBBBBBBBBBBBBB/content?download=1');
    expect(file.textContent).toBe('spec.pdf2 KB');
    expect(bubble.querySelector('[data-slot="attachment-removed"]')?.textContent).toBe('old.txtRemoved');
    // An image that no longer loads is removed too.
    const image = bubble.querySelector<HTMLImageElement>('[data-attachment="image"] img')!;
    expect(image.getAttribute('src')).toBe('/api/media/attachments/cbatt_AAAAAAAAAAAAAAAAAAAAAA/content');
    // It opens in the same viewer as the composer's; one image, no stepping.
    await act(async () => bubble.querySelector<HTMLButtonElement>('[aria-label="View shot.png"]')!.click());
    const viewer = document.querySelector('[data-slot="attachment-viewer"]')!;
    expect(viewer.querySelector('img')!.getAttribute('src')).toBe(
        '/api/media/attachments/cbatt_AAAAAAAAAAAAAAAAAAAAAA/content',
    );
    expect(viewer.querySelector('[aria-label="Next attachment"]')).toBeNull();
    await act(async () => viewer.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(bubble.querySelectorAll('[data-slot="attachment-removed"]')).toHaveLength(2);
});

it('previews the composer’s attachments full size before sending, one after another', async () => {
    vi.mocked(fetch).mockImplementation(async (url) =>
        String(url).includes('cbatt_BBBBBBBBBBBBBBBBBBBBBB/content')
            ? new Response('# Notes\nWater the tomatoes.')
            : Response.json(String(url).includes('/me/inference/options') ? { options: [], automatic: null } : null),
    );
    const view = await render(
        <Chat
            thread={thread}
            dot={dot}
            onConsumed={() => {}}
            voiceReady={false}
            calls={[]}
            paused={false}
            onSaved={() => {}}
            onSchedule={() => {}}
        />,
    );
    await flush();
    await act(async () => pick(view, [png(), md(), png('other.png')]));
    // Still uploading: nothing to open yet.
    expect(view.querySelector('[aria-label="View shot.png"]')).toBeNull();
    await finish(0, ref('cbatt_AAAAAAAAAAAAAAAAAAAAAA', 'shot.png', 'image'));
    await finish(1, ref('cbatt_BBBBBBBBBBBBBBBBBBBBBB', 'notes.md', 'text'));
    await finish(2, ref('cbatt_CCCCCCCCCCCCCCCCCCCCCC', 'other.png', 'image'));
    const viewer = () => document.querySelector<HTMLElement>('[data-slot="attachment-viewer"]');
    const key = (name: string) =>
        act(async () => {
            (document.activeElement ?? document.body).dispatchEvent(
                new KeyboardEvent('keydown', { key: name, bubbles: true }),
            );
        });

    // The image thumbnail opens the uploaded original at full size.
    await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="View shot.png"]')!.click());
    expect(viewer()!.querySelector('h2')?.textContent).toBe('shot.png');
    expect(viewer()!.querySelector('img')!.getAttribute('src')).toBe(
        '/api/media/attachments/cbatt_AAAAAAAAAAAAAAAAAAAAAA/content',
    );
    expect(viewer()!.textContent).toContain('PNG · 5 B · 1 of 3');
    // The arrow keys step through them: the text file shows its text.
    await key('ArrowRight');
    await flush();
    expect(viewer()!.querySelector('h2')?.textContent).toBe('notes.md');
    expect(viewer()!.querySelector('[data-slot="media-text-preview"]')?.textContent).toBe(
        '# Notes\nWater the tomatoes.',
    );
    // Previous from the first wraps to the last.
    await key('ArrowLeft');
    await act(async () => viewer()!.querySelector<HTMLButtonElement>('[aria-label="Previous attachment"]')!.click());
    expect(viewer()!.querySelector('img')!.getAttribute('src')).toBe(
        '/api/media/attachments/cbatt_CCCCCCCCCCCCCCCCCCCCCC/content',
    );
    // Escape closes it; the tray is as it was.
    await key('Escape');
    expect(viewer()).toBeNull();
    expect(view.querySelectorAll('[data-slot="tray-item"]')).toHaveLength(3);
    expect(upload.removeAttachment).not.toHaveBeenCalled();

    // A text file's chip opens it too.
    await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="View notes.md"]')!.click());
    await flush();
    expect(viewer()!.querySelector('[data-slot="media-text-preview"]')?.textContent).toBe(
        '# Notes\nWater the tomatoes.',
    );
});
