// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

it('opens a page with an HTML blockquote as a quote block, without saving', async () => {
    const stored =
        '## Original post\n\n<blockquote>\nWe just launched **OpenUSD** support, see [Hub](https://huggingface.co)<br>second line\n</blockquote>';
    const onChange = vi.fn();
    root = createRoot(host);
    await act(async () => root!.render(<RichEditor value={stored} onChange={onChange} onNotice={() => {}} />));
    await flush();
    await flush();
    const quote = host.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toContain('We just launched');
    expect(quote!.querySelector('strong')?.textContent).toBe('OpenUSD');
    expect(quote!.querySelector('a')?.getAttribute('href')).toBe('https://huggingface.co');
    expect(quote!.querySelector('br')).not.toBeNull();
    expect(host.textContent).not.toContain('<blockquote>');
    // Loading never rewrites the stored page.
    expect(onChange).not.toHaveBeenCalled();
});
