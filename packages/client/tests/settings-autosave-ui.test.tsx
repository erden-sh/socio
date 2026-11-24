// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { State, WorkspaceState } from '@socio/shared/types';

import { WorkspaceSettings } from '../src/modules/settings/WorkspaceSettings';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    vi.stubGlobal('fetch', async () => Response.json({}));
    vi.mocked(toast.success).mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const page = (mutate: (...args: unknown[]) => Promise<boolean>) =>
    act(async () =>
        root.render(
            <WorkspaceSettings
                state={
                    {
                        settings: {
                            researchAllowed: true,
                            memoryAllowed: true,
                            dotDailyLimits: { perDot: 50, perUser: 50 },
                        },
                    } as State
                }
                workspace={
                    {
                        user: { id: 'alice', name: 'Alice', role: 'admin' },
                        setup: { missing: [], telegram: 'not_configured' },
                    } as unknown as WorkspaceState
                }
                mutate={mutate}
            />,
        ),
    );
const card = (slot: string) => host.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
const status = (slot: string) => card(slot).querySelector('[data-slot="save-status"]')!.textContent;
const type = (input: HTMLInputElement, value: string) =>
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
// React listens for focusout to run onBlur.
const leave = (input: HTMLInputElement) =>
    act(async () => {
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
/** The Undo of the toast shown last. */
const undo = () =>
    act(async () => {
        const options = vi.mocked(toast.success).mock.lastCall![1] as {
            action: { label: string; onClick: () => void };
        };
        expect(options.action.label).toBe('Undo');
        options.action.onClick();
    });

it('has no Save buttons on the cards it saves as they change (CB-308)', async () => {
    await page(vi.fn(async () => true));
    for (const slot of [
        'workspace-permissions',
        'dot-limits',
        'notification-limits',
        'auto-triage',
        'model-fallback',
        'rooms',
        'tracing',
    ]) {
        expect(
            [...card(slot).querySelectorAll('button')].map((b) => b.textContent),
            slot,
        ).not.toContain('Save');
    }
});

it('saves a toggle at once, says what its side effect did, and undoes it', async () => {
    let release = () => {};
    const mutate = vi.fn(
        () =>
            new Promise<boolean>((resolve) => {
                release = () => resolve(true);
            }),
    );
    await page(mutate);
    const memory = card('workspace-permissions').querySelectorAll<HTMLElement>('[role="checkbox"]')[1];
    await act(async () => memory.click());
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        researchAllowed: true,
        memoryAllowed: false,
    });
    expect(status('workspace-permissions')).toBe('Saving…');
    await act(async () => release());
    expect(status('workspace-permissions')).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith(
        'Saved memories turned off. Turns running now were stopped.',
        expect.anything(),
    );
    await undo();
    expect(memory.getAttribute('aria-checked')).toBe('true');
    await act(async () => release());
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        researchAllowed: true,
        memoryAllowed: true,
    });
    expect(toast.success).toHaveBeenLastCalledWith('Change undone', undefined);
});

it('saves a number when the field loses focus, refuses a bad one in the card, and undoes', async () => {
    const mutate = vi.fn(async () => true);
    await page(mutate);
    const perDot = host.querySelector<HTMLInputElement>('#dot-limit-per-dot')!;
    // Leaving it unchanged saves nothing.
    await leave(perDot);
    expect(mutate).not.toHaveBeenCalled();
    type(perDot, '1.5');
    await leave(perDot);
    expect(mutate).not.toHaveBeenCalled();
    expect(card('dot-limits').querySelector('[role="alert"]')!.textContent).toBe('Use whole numbers from 0 to 10000.');
    type(perDot, '40');
    await leave(perDot);
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', {
        dotDailyLimits: { perDot: 40, perUser: 50 },
    });
    expect(card('dot-limits').querySelector('[role="alert"]')).toBeNull();
    expect(status('dot-limits')).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith('Socio filing limits saved', expect.anything());
    await undo();
    expect(perDot.value).toBe('50');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        dotDailyLimits: { perDot: 50, perUser: 50 },
    });
});

it('shows what is saved when a save fails, and why', async () => {
    const mutate = vi.fn(async () => false);
    await page(mutate);
    const fallback = card('model-fallback').querySelector<HTMLElement>('[role="checkbox"]')!;
    await act(async () => fallback.click());
    expect(fallback.getAttribute('aria-checked')).toBe('true');
    expect(card('model-fallback').querySelector('[role="alert"]')!.textContent).toBe(
        'Could not save. Review the workspace error and retry.',
    );
    expect(status('model-fallback')).toBe('');
    expect(toast.success).not.toHaveBeenCalled();
});
