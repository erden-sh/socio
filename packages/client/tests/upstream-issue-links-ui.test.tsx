// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it } from 'vitest';

import { remarkIssueKeys } from '../src/lib/remark-issue-keys';
import { UpstreamIssueLink } from '../src/modules/whats-new/UpstreamIssueLink';

// CB-381: Socio's own issue keys open on its board (brain.ingenioventures.com),
// in a new tab, and stay local links on that instance itself.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const UPSTREAM = 'https://brain.ingenioventures.com';

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

function mount(node: ReactNode) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<MemoryRouter>{node}</MemoryRouter>));
    return host;
}

it('opens an upstream key on the upstream board from another instance', () => {
    const anchor = mount(<UpstreamIssueLink issue="CB-157" origin="https://lab.example.com" />).querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe(`${UPSTREAM}/issues/CB-157`);
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchor.textContent).toBe('CB-157');
});

it('keeps a local link on the upstream instance', () => {
    const anchor = mount(<UpstreamIssueLink issue="CB-157" origin={UPSTREAM} />).querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('/issues/CB-157');
    expect(anchor.getAttribute('target')).toBeNull();
});

it('shows anything but a key as text', () => {
    const shown = mount(<UpstreamIssueLink issue="not a key" origin="https://lab.example.com" />);
    expect(shown.querySelector('a')).toBeNull();
    expect(shown.textContent).toBe('not a key');
});

type Node = { type: string; value?: string; url?: string; children?: Node[] };
const paragraph = (value: string): Node => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
});
const urls = (tree: Node): string[] =>
    (tree.children ?? []).flatMap((child) => (child.type === 'link' ? [child.url!] : urls(child)));

it('links the release notes’ keys upstream, and local ones as before', () => {
    const elsewhere = paragraph('Fixed (CB-12), see CB-7.');
    remarkIssueKeys({ upstream: true, origin: 'https://lab.example.com' })(elsewhere as never);
    expect(urls(elsewhere)).toEqual([`${UPSTREAM}/issues/CB-12`, `${UPSTREAM}/issues/CB-7`]);

    const upstream = paragraph('Fixed (CB-12).');
    remarkIssueKeys({ upstream: true, origin: UPSTREAM })(upstream as never);
    expect(urls(upstream)).toEqual(['/issues/CB-12']);

    // An issue's own text keeps linking to this board.
    const local = paragraph('Blocked by CB-12 and #3.');
    remarkIssueKeys({ hash: true })(local as never);
    expect(urls(local)).toEqual(['/issues/CB-12', '/issues/CB-3']);
});
