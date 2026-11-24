// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Page } from '@socio/shared/pages/page-library';
import type { WorkspaceState } from '@socio/shared/types';

import { PageConversation } from '../../packages/client/src/modules/pages/PageConversation';

vi.mock('../../packages/client/src/modules/chat/ClientChat', () => ({ ClientChat: () => null }));
vi.mock('../../packages/client/src/lib/api', () => ({ api: vi.fn() }));

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// What Radix Select needs from the DOM that jsdom leaves out.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

let root: Root, host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const dot = (id: string, name: string) => ({
    id,
    name,
    spaceIds: ['s1'],
    archivedAt: null,
});
const workspace = {
    dots: [dot('d1', 'Sebas'), dot('d2', 'Manny'), dot('d3', 'Elsewhere')].map((entry) =>
        entry.id === 'd3' ? { ...entry, spaceIds: ['s2'] } : entry,
    ),
    setup: { missing: [] },
} as unknown as WorkspaceState;
const page = { id: 'p1', spaceId: 's1', title: 'Notes' } as unknown as Page;

const key = (element: Element, key: string) =>
    act(() => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

it('picks the page chat’s socio from a shadcn Select, by keyboard (CB-257)', () => {
    act(() =>
        root.render(
            <PageConversation
                page={page}
                workspace={workspace}
                paused={false}
                beforeChat={async () => true}
                onRefresh={() => {}}
                onSchedule={() => {}}
                onSettings={() => {}}
                onCreateDot={() => {}}
                onOpenChange={() => {}}
            />,
        ),
    );
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Page specialist"]')!;
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.textContent).toBe('Sebas');
    // A touch target on narrow screens.
    expect(trigger.className).toContain('max-[700px]:min-h-10');
    expect(host.querySelector('select:not([aria-hidden])')).toBeNull();
    key(trigger, 'Enter');
    const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
    // Only the socios of this page's Space.
    expect(options.map((option) => option.textContent)).toEqual(['Sebas', 'Manny']);
    key(options[1]!, 'Enter');
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger.textContent).toBe('Manny');
});
