// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { PageTitleField, singleLine } from '../src/modules/pages/PageTitleField';

// CB-202: the page title wraps on a phone instead of being cut off at the
// right edge, so it is a textarea that still acts as a one-line title.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLDivElement;
let root: Root;
let seen: string[];

function Harness() {
    const [title, setTitle] = useState('');
    return (
        <article>
            <PageTitleField
                value={title}
                onChange={(next) => {
                    seen.push(next);
                    setTitle(next);
                }}
            />
            <div aria-label="Page content" data-page-body tabIndex={0} />
        </article>
    );
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    seen = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const field = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Page title"]')!;

function type(value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
        set.call(field(), value);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('is a one-row textarea, so a long title wraps', () => {
    expect(field().tagName).toBe('TEXTAREA');
    expect(field().rows).toBe(1);
    expect(field().maxLength).toBe(160);
});

it('strips pasted line breaks', () => {
    type('Hugging Face\r\nHub\n\nOpenUSD');
    expect(field().value).toBe('Hugging Face Hub OpenUSD');
    expect(seen.at(-1)).toBe('Hugging Face Hub OpenUSD');
    expect(singleLine('a\u2028b')).toBe('a b');
    expect(singleLine('plain title')).toBe('plain title');
});

it('moves to the body on Enter, without adding a line', () => {
    type('A title');
    const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
    });
    act(() => {
        field().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Page content"]'));
    expect(field().value).toBe('A title');
});
