// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Dot, State, WorkspaceState } from '@socio/shared/types';
import type { WebStatus } from '@socio/shared/web/web-types';

// The dialog's Local picker shows all eight Locals, each a lazy chunk:
// loaded here with the file, they don't load (and render) mid-test or after it.
import '../src/locals/characters';
import { WorkspaceDialog } from '../src/modules/settings/WorkspaceDialog';

// Radix checkboxes measure themselves.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const dot = {
    id: 'dot-1',
    spaceId: 's1',
    spaceIds: ['s1'],
    name: 'Researcher',
    instructions: 'Read carefully.',
    researchAllowed: true,
    memoryAllowed: true,
    createdAt: 0,
} as Dot;
const status: WebStatus = {
    identity: 'agent',
    source: 'default',
    defaultIdentity: 'agent',
    userAgent: 'SocioAgent/1.0 (user-directed agent; +https://brain.example.com/agents)',
    limits: {
        perHostPerMinute: 30,
        globalPerMinute: 300,
        maxBytes: 2_000_000,
        timeoutMs: 15_000,
        cacheTtlSeconds: 60,
        cooldownSeconds: 900,
    },
    stoppedHosts: [],
};

it("sets a socio's web identity from its settings dialog", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
        calls.push({
            url,
            method: init.method ?? 'GET',
            body: init.body as string | undefined,
        });
        return Response.json(status);
    });
    const mutate = vi.fn(async () => true);
    const onClose = vi.fn();
    await act(async () =>
        root.render(
            // In the app the dialog is inside the router: its Soul link needs it.
            <MemoryRouter>
                <WorkspaceDialog
                    dialog={{ type: 'dot', dot, spaceId: 's1' }}
                    state={
                        {
                            settings: { researchAllowed: true, memoryAllowed: true },
                        } as State
                    }
                    workspace={
                        {
                            user: { id: 'alice', name: 'Alice', role: 'admin' },
                            spaces: [{ id: 's1', name: 'Everyday', description: '', createdAt: 0 }],
                            dots: [dot],
                            conversations: [],
                            setup: { missing: [] },
                            calls: [],
                        } as unknown as WorkspaceState
                    }
                    onClose={onClose}
                    mutate={mutate}
                />
            </MemoryRouter>,
        ),
    );
    // The dialog is portalled to the body.
    // A Dot's settings stay a wide dialog (CB-95), named by its title, with
    // the first field focused.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
        'Make this socio yours.',
    );
    expect(dialog.className).toContain('sm:max-w-[42rem]');
    expect(document.activeElement?.id).toBe('entity-name');
    expect(dialog.querySelector('[aria-label="Close dialog"]')).not.toBeNull();
    const select = document.querySelector<HTMLSelectElement>('#web-identity')!;
    expect(select.value).toBe('');
    expect(document.body.textContent).toContain('Workspace default (declared agent)');
    expect(document.body.textContent).toContain(status.userAgent);
    await act(async () => {
        select.value = 'browser';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
        select.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(mutate).toHaveBeenCalled();
    expect(calls.at(-1)).toEqual({
        url: '/api/dots/dot-1/web',
        method: 'PATCH',
        body: JSON.stringify({ identity: 'browser' }),
    });
    expect(onClose).toHaveBeenCalled();
});
