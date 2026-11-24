import type { Message } from '@ag-ui/client';
import { expect, it } from 'vitest';

import { messageText, modelReadableMessages } from '@socio/foundation/turns/media-parts';
import { displayContent } from '@socio/shared/media/refs';

const image = {
    type: 'image',
    source: { type: 'data', value: 'AAAA', mimeType: 'image/jpeg' },
};
const pdf = {
    type: 'document',
    source: { type: 'data', value: 'BBBB', mimeType: 'application/pdf' },
};
const history = [
    { id: 'a', role: 'user', content: 'plain' },
    { id: 'b', role: 'user', content: [{ type: 'text', text: 'look' }, image] },
    { id: 'c', role: 'user', content: [pdf] },
    { id: 'd', role: 'assistant', content: 'ok' },
] as unknown as Message[];

it('turns attachments into notes for a text-only model, leaving text alone', () => {
    const out = modelReadableMessages(history, 0);
    expect(out[0]).toBe(history[0]);
    expect(out[3]).toBe(history[3]);
    expect(JSON.stringify(out)).not.toMatch(/AAAA|BBBB/);
    expect(out[1].content).toEqual([
        { type: 'text', text: 'look' },
        { type: 'text', text: expect.stringContaining('(image/jpeg)') },
    ]);
    expect(out[2].content).toEqual([{ type: 'text', text: expect.stringContaining('(application/pdf)') }]);
});

it('keeps images for a vision model but still drops other media', () => {
    const out = modelReadableMessages(history, 4);
    expect(out[1]).toBe(history[1]);
    expect(JSON.stringify(out[2])).not.toContain('BBBB');
});

it('renders attachments as markers in display text', () => {
    expect(messageText(history[1].content)).toBe('look\n[image: image/jpeg]');
    expect(messageText(history[2].content)).toBe('[attachment: application/pdf]');
    expect(messageText('hi')).toBe('hi');
    expect(messageText(undefined)).toBe('');
    // CB-54: a reference shows its file name.
    expect(
        messageText([
            { type: 'text', text: 'see these' },
            {
                type: 'binary',
                id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
                mimeType: 'image/png',
                filename: 'shot.png',
            },
            { type: 'binary', id: 'cbatt_BBBBBBBBBBBBBBBBBBBBBB', mimeType: 'x/y' },
        ]),
    ).toBe('see these\n[attachment: shot.png]\n[attachment: x/y]');
});

it('keeps references, never inline bytes, in a read-only transcript', () => {
    const ref = {
        type: 'binary',
        id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
        mimeType: 'image/png',
        filename: 'shot.png',
    };
    const content = [{ type: 'text', text: 'see' }, image, ref];
    expect(displayContent(content, messageText(content))).toEqual([{ type: 'text', text: 'see' }, ref]);
    // Without references: the display text, as before.
    expect(displayContent(history[1].content, 'look')).toBe('look');
    expect(displayContent('plain', 'plain')).toBe('plain');
});

it('gives an empty user message a note instead of empty content', () => {
    const out = modelReadableMessages(
        [
            { id: 'e1', role: 'user', content: '' },
            { id: 'e2', role: 'user', content: [] },
            { id: 'e3', role: 'assistant', content: '' },
        ] as unknown as Message[],
        0,
    );
    expect(out[0].content).toContain('no text');
    expect(out[1].content).toContain('no text');
    expect(out[2].content).toBe('');
});

it('keeps only the most recent images, newest last', () => {
    const photo = (value: string) => ({
        type: 'image',
        source: { type: 'data', value, mimeType: 'image/jpeg' },
    });
    const out = modelReadableMessages(
        [
            { id: '1', role: 'user', content: [photo('P1'), photo('P2')] },
            { id: '2', role: 'assistant', content: 'ok' },
            {
                id: '3',
                role: 'user',
                content: [{ type: 'text', text: 'and' }, photo('P3')],
            },
        ] as unknown as Message[],
        2,
    );
    const sent = JSON.stringify(out);
    expect(sent).not.toContain('P1');
    expect(sent).toContain('P2');
    expect(sent).toContain('P3');
    expect(out[0].content).toEqual([{ type: 'text', text: expect.stringContaining('earlier') }, photo('P2')]);
});
