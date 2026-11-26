import type { Message } from '@ag-ui/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { attachmentPart, type AttachmentRef } from '@socio/shared/media/refs';

import { ChatTranscript, isInternalVoiceReceipt } from '../src/modules/chat/ChatTranscript';

it('keeps call receipts between the anchored message and later conversation turns', () => {
    const html = renderToStaticMarkup(
        <ChatTranscript
            messages={[
                { id: 'before', role: 'user', content: 'Before the call' },
                { id: 'after', role: 'assistant', content: 'Later message' },
            ]}
            calls={[
                {
                    id: 'call',
                    threadId: 'thread',
                    status: 'ended',
                    startedAt: 1000,
                    endedAt: 6000,
                    transcript: '',
                    error: null,
                    anchorMessageId: 'before',
                },
            ]}
        />,
    );
    expect(html.indexOf('Before the call')).toBeLessThan(html.indexOf('Call ended'));
    expect(html.indexOf('Call ended')).toBeLessThan(html.indexOf('Later message'));
});

it('folds tool-only rounds into the turn’s trace and shows card calls inline, without printing tool JSON (CB-72)', () => {
    const html = renderToStaticMarkup(
        <ChatTranscript
            messages={[
                { id: 'request', role: 'user', content: 'Open the website' },
                {
                    id: 'tool-call',
                    role: 'assistant',
                    toolCalls: [
                        {
                            id: 'navigate',
                            type: 'function',
                            function: {
                                name: 'computer_navigate',
                                arguments: '{"url":"https://example.com"}',
                            },
                        },
                        {
                            id: 'review',
                            type: 'function',
                            function: { name: 'review_space_page', arguments: '{}' },
                        },
                    ],
                },
                { id: 'reply', role: 'assistant', content: 'Here is the summary' },
            ]}
            calls={[]}
            isCard={(call) => call.function.name === 'review_space_page'}
            renderTools={(message) => (
                <section>Card for {message.toolCalls?.map((call) => call.id).join(', ')}</section>
            )}
        />,
    );
    const order = ['Open the website', 'Worked through 1 step', 'Card for review'];
    expect(order.map((text) => html.indexOf(text))).toEqual(
        order.map((text) => html.indexOf(text)).sort((a, b) => a - b),
    );
    expect(html.indexOf('Card for review')).toBeGreaterThan(-1);
    expect(html).toContain('Here is the summary');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('computer_navigate');
    expect(html).not.toContain('example.com');
});

it('hides only marked receipt prompts while retaining summaries and prior unmarked messages', () => {
    const messages: Message[] = [
        { id: 'legacy', role: 'user', content: 'Earlier unmarked receipt prompt' },
        {
            id: 'internal',
            role: 'user',
            content: 'Internal sync instructions',
            metadata: { socioSource: 'voice_receipt' },
        },
        {
            id: 'socio:voice_receipt:durable',
            role: 'user',
            content: 'Persisted internal instructions without metadata',
        },
        {
            id: 'summary',
            role: 'assistant',
            content: 'Confirmed call summary',
            metadata: { socioSource: 'voice_receipt' },
        },
        {
            id: 'user',
            role: 'user',
            content: 'My next question',
            metadata: { socioSource: 'voice_compute' },
        },
    ];
    const html = renderToStaticMarkup(
        <ChatTranscript messages={messages.filter((message) => !isInternalVoiceReceipt(message))} calls={[]} />,
    );
    expect(html).not.toContain('Internal sync instructions');
    expect(html).not.toContain('Persisted internal instructions without metadata');
    expect(html).toContain('Earlier unmarked receipt prompt');
    expect(html).toContain('Confirmed call summary');
    expect(html).toContain('My next question');
});

// The attachments of two messages, the second with files only: A, an image; B, a CSV; C, a zip.
const attachmentRefsFixture = {
    A: { id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA', mimeType: 'image/png', filename: 'chart.png' },
    B: { id: 'cbatt_BBBBBBBBBBBBBBBBBBBBBB', mimeType: 'text/csv', filename: 'data.csv' },
    C: { id: 'cbatt_CCCCCCCCCCCCCCCCCCCCCC', mimeType: 'application/zip', filename: 'logs.zip' },
};

function renderAttachments(part: (ref: AttachmentRef) => object) {
    const { A, B, C } = attachmentRefsFixture;
    const html = renderToStaticMarkup(
        <ChatTranscript
            calls={[]}
            messages={[
                {
                    id: 'files',
                    role: 'user',
                    content: [{ type: 'text', text: 'What about these?' }, part(A), part(B)],
                } as unknown as Message,
                // Only files: still a bubble.
                { id: 'only', role: 'user', content: [part(C)] } as unknown as Message,
            ]}
        />,
    );
    expect(html).toContain('What about these?');
    expect(html).toContain('src="/api/media/attachments/cbatt_AAAAAAAAAAAAAAAAAAAAAA/content"');
    expect(html).toContain('href="/api/media/attachments/cbatt_BBBBBBBBBBBBBBBBBBBBBB/content?download=1"');
    expect(html).toContain('logs.zip');
    expect(html.match(/data-chat-body="user"/g)).toHaveLength(2);
}

it('renders a message with attachments as its text, image thumbnails and file chips (CB-54)', () => {
    renderAttachments(attachmentPart);
});

it('renders attachments stored before AG-UI 1.0, as `binary` parts, the same way', () => {
    renderAttachments(({ id, mimeType, filename }) => ({ type: 'binary', id, mimeType, filename }));
});

it('names another person’s message from its metadata, else from the top level a server before AG-UI 1.0 sent', () => {
    const html = renderToStaticMarkup(
        <ChatTranscript
            calls={[]}
            messages={[
                {
                    id: 'meta',
                    role: 'user',
                    content: 'From metadata',
                    // A stale top-level copy loses to metadata.
                    author: { name: 'Stale', you: false },
                    metadata: { author: { name: 'Ada', you: false } },
                } as unknown as Message,
                { id: 'top', role: 'user', content: 'From the top', author: { name: 'Bo', you: false } },
                {
                    id: 'mine',
                    role: 'user',
                    content: 'Mine',
                    metadata: { author: { name: 'Me', you: true } },
                } as unknown as Message,
            ]}
        />,
    );
    const names = [...html.matchAll(/data-chat-author[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(names).toEqual(['Ada', 'Bo']);
    expect(html.match(/data-chat-body="other"/g)).toHaveLength(2);
    expect(html.match(/data-chat-body="user"/g)).toHaveLength(1);
});
