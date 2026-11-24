// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { embedCardMarkdown, type EmbedCard } from '@socio/shared/embed-card';

import RichEditor from '../src/modules/pages/editor/RichEditor';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    // ProseMirror measures; jsdom has no layout.
    Range.prototype.getClientRects = () =>
        ({
            length: 0,
            item: () => null,
            [Symbol.iterator]: [][Symbol.iterator],
        }) as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    document.elementFromPoint = () => null;
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.restoreAllMocks();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const card: EmbedCard = {
    url: 'https://x.com/rivera/status/2113278666507485349',
    kind: 'post',
    provider: 'X',
    author: 'Dana Rivera',
    handle: '@rivera',
    authorUrl: 'https://x.com/rivera',
    text: 'The good news: you can mid-train yourself to the frontier!',
    publishedAt: '2026-10-22T17:04:05.000Z',
    media: [
        { id: 'cbemb_0123456789abcdef', kind: 'image', alt: 'A loss curve' },
        { id: 'cbemb_fedcba9876543210', kind: 'video' },
    ],
    fetchedAt: '2026-10-27T12:00:00.000Z',
};

const editor = async (value: string) => {
    const onChange = vi.fn();
    root = createRoot(host);
    await act(async () => root!.render(<RichEditor value={value} onChange={onChange} onNotice={() => {}} />));
    await flush();
    await flush();
    return onChange;
};

it('shows a link card as a static snapshot: local images, links out in a new tab', async () => {
    // Nothing on the card is fetched from anywhere, not even this app's API.
    const fetch = vi.spyOn(globalThis, 'fetch');
    const onChange = await editor(`# Notes\n\n${embedCardMarkdown(card)}\n\nAfter the card.`);
    const figure = host.querySelector('figure.embed-card')!;
    expect(figure).not.toBeNull();
    expect(figure.getAttribute('contenteditable')).toBe('false');
    expect(figure.getAttribute('aria-label')).toBe('X card');
    expect(figure.textContent).toContain('Dana Rivera @rivera · X');
    expect(figure.textContent).toContain('The good news: you can mid-train');
    // Images only from this app, by the copies' ids.
    const images = [...figure.querySelectorAll('img')];
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
        '/api/media/embeds/cbemb_0123456789abcdef/content',
        '/api/media/embeds/cbemb_fedcba9876543210/content',
    ]);
    expect(images[0].getAttribute('alt')).toBe('A loss curve');
    expect(figure.querySelector('iframe, script, video')).toBeNull();
    // The video plays on its own site.
    const play = figure.querySelector('a.embed-card-play')!;
    expect(play.getAttribute('href')).toBe(card.url);
    expect(play.getAttribute('aria-label')).toBe('Play on X (opens in a new tab)');
    for (const link of figure.querySelectorAll('a')) {
        expect([link.getAttribute('target'), link.getAttribute('rel')]).toEqual([
            '_blank',
            'noopener noreferrer nofollow',
        ]);
    }
    expect(figure.querySelector('time')?.getAttribute('datetime')).toBe(card.publishedAt);
    expect(figure.textContent).toContain('Open on x.com');
    // An image that can't load (its copy was deleted) leaves a note.
    await act(async () => images[0].dispatchEvent(new Event('error')));
    expect(figure.querySelectorAll('img')).toHaveLength(1);
    expect(figure.textContent).toContain('Image not available here: A loss curve');
    expect(fetch).not.toHaveBeenCalled();
    // Opening it changes nothing in the page.
    expect(onChange).not.toHaveBeenCalled();
});

it('shows a fence that isn’t a card as code, unchanged', async () => {
    const onChange = await editor('```embed\n{ "url": "javascript:x" }\n```');
    expect(host.querySelector('figure.embed-card')).toBeNull();
    expect(host.querySelector('pre code')?.textContent).toBe('{ "url": "javascript:x" }');
    expect(onChange).not.toHaveBeenCalled();
});
