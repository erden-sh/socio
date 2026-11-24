// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dot, Role, State, WorkspaceState } from '@socio/shared/types';

import { WorkspaceDialog } from '../src/modules/settings/WorkspaceDialog';

vi.mock('../src/modules/chat/ModelSelect', () => ({
    ModelSelect: () => null,
    useModelOptions: () => undefined,
}));
vi.mock('../src/modules/settings/WebIdentityField', () => ({
    WebIdentityField: () => null,
    useWebIdentity: () => ({ save: async () => {} }),
}));
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});
async function render(role: Role, dot?: Dot) {
    const mutate = vi.fn(async (_path: string, _method: string, _body?: unknown) => true);
    await act(async () =>
        root.render(
            // In the app the dialog is inside the router: its Soul link needs it.
            <MemoryRouter>
                <WorkspaceDialog
                    dialog={{ type: 'dot', spaceId: 's1', dot }}
                    state={
                        {
                            settings: { researchAllowed: true, memoryAllowed: true },
                        } as State
                    }
                    workspace={
                        {
                            user: { id: 'me', name: 'Me', role },
                            spaces: [{ id: 's1', name: 'Shared', description: '', createdAt: 0 }],
                            dots: [],
                            conversations: [],
                        } as unknown as WorkspaceState
                    }
                    onClose={() => {}}
                    mutate={mutate}
                />
            </MemoryRouter>,
        ),
    );
    return mutate;
}
const share = () =>
    [...document.querySelectorAll('label[data-slot="permission-row"]')]
        .find((el) => el.textContent?.includes('Share with the workspace'))
        ?.querySelector<HTMLButtonElement>('[role="checkbox"]');
const submit = async () =>
    act(async () => {
        document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
it.each(['admin'] as const)('creates a private socio by default for %s and shares only after opt-in', async (role) => {
    const mutate = await render(role);
    expect(share()?.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-slot="dot-visibility"]')?.textContent).toContain('Personal socio');
    await submit();
    expect(mutate.mock.calls[0]).toMatchObject(['/dots', 'POST', { personal: true }]);
    await act(async () => share()!.click());
    expect(document.querySelector('[data-slot="dot-visibility"]')?.textContent).toContain('Workspace socio');
    expect(document.body.textContent).toContain('shared computer files');
    await submit();
    expect(mutate.mock.calls[1]).toMatchObject(['/dots', 'POST', { personal: false }]);
});
it('keeps member creation private without a sharing control', async () => {
    const mutate = await render('member');
    expect(share()).toBeUndefined();
    await submit();
    expect(mutate.mock.calls[0]).toMatchObject(['/dots', 'POST', { personal: true }]);
});
it.each([null, 'me'])('shows existing visibility without changing ownership (%s)', async (ownerId) => {
    const dot = {
        id: 'd1',
        spaceId: 's1',
        spaceIds: ['s1'],
        name: 'Existing',
        instructions: 'Keep it.',
        researchAllowed: false,
        memoryAllowed: false,
        createdAt: 0,
        ownerId,
    } as Dot;
    const mutate = await render('admin', dot);
    expect(share()).toBeUndefined();
    expect(document.querySelector('[data-slot="dot-visibility"]')?.textContent).toContain(
        ownerId ? 'Personal socio' : 'Workspace socio',
    );
    // Its instructions are its Soul's (CB-179): a link, never sent.
    expect(document.querySelector('[data-slot="dot-settings-soul"] a')?.getAttribute('href')).toBe('/dots/d1/soul');
    expect(document.querySelector('#entity-text')).toBeNull();
    await submit();
    expect(mutate.mock.calls[0]?.[2]).not.toHaveProperty('personal');
    expect(mutate.mock.calls[0]?.[2]).not.toHaveProperty('instructions');
});
