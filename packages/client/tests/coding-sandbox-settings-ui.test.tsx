// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import type { CodingSandboxSettingsView } from '@socio/shared/coding/coding-sessions';

import { api } from '../src/lib/api';
import { CodingSandboxSection } from '../src/modules/coding/CodingSandboxSection';

// Settings → Coding → Sandboxes (CB-239): the registries and the
// workspace retention over their server defaults; nothing shows while the
// server answers 404 (the flag off for the admin).

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
    vi.mocked(api).mockReset();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const view = (change: Partial<CodingSandboxSettingsView> = {}): CodingSandboxSettingsView => ({
    registries: 'npm=registry.npmjs.org pypi=pypi.org',
    registriesDefault: 'npm=registry.npmjs.org pypi=pypi.org',
    registriesSaved: false,
    retentionDays: 14,
    retentionDaysDefault: 14,
    retentionDaysSaved: false,
    ...change,
});

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!;
    act(() => {
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

it('shows nothing when the server answers 404', async () => {
    vi.mocked(api).mockRejectedValue(new Error('This feature isn’t available.'));
    act(() => root.render(<CodingSandboxSection />));
    await flush();
    expect(host.textContent).toBe('');
});

const leave = (element: Element) =>
    act(async () => {
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

it('shows the values in force with their defaults, labelled, and saves each as it is left', async () => {
    vi.mocked(api).mockResolvedValueOnce(view());
    act(() => root.render(<CodingSandboxSection />));
    await flush();
    const registries = host.querySelector<HTMLTextAreaElement>('#coding-registries')!;
    const days = host.querySelector<HTMLInputElement>('#coding-retention')!;
    expect(registries.value).toBe('npm=registry.npmjs.org\npypi=pypi.org');
    expect(days.value).toBe('14');
    // Labeled and described for screen readers.
    expect(host.querySelector('label[for="coding-registries"]')).not.toBeNull();
    expect(host.querySelector('label[for="coding-retention"]')).not.toBeNull();
    expect(registries.getAttribute('aria-describedby')).toBe('coding-registries-help');
    expect(host.textContent).toContain('Server default 14 (in use)');
    // No reset while the defaults are in use.
    expect(host.textContent).not.toContain('Use the server default');
    // No Save button: each field saves when it is left.
    expect([...host.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save');
    await leave(registries);
    expect(vi.mocked(api)).toHaveBeenCalledOnce();
    type(registries, 'npm=registry.npmjs.org\n  crates=index.crates.io \n');
    vi.mocked(api).mockResolvedValueOnce(
        view({
            registries: 'npm=registry.npmjs.org crates=index.crates.io',
            registriesSaved: true,
        }),
    );
    await leave(registries);
    await flush();
    // The days stay the server's default: only the registries are set here.
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/gateway/sandbox', 'PUT', {
        registries: 'npm=registry.npmjs.org crates=index.crates.io',
        retentionDays: null,
    });
    expect(registries.value).toBe('npm=registry.npmjs.org\ncrates=index.crates.io');
    expect(host.textContent).toContain('Use the server default');
    type(days, '0');
    await leave(days);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Keep workspaces 1 to 365 days.');
    expect(vi.mocked(api)).toHaveBeenCalledTimes(2);
    type(days, '7');
    vi.mocked(api).mockResolvedValueOnce(
        view({
            registries: 'npm=registry.npmjs.org crates=index.crates.io',
            registriesSaved: true,
            retentionDays: 7,
            retentionDaysSaved: true,
        }),
    );
    await leave(days);
    await flush();
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/gateway/sandbox', 'PUT', {
        registries: 'npm=registry.npmjs.org crates=index.crates.io',
        retentionDays: 7,
    });
    expect(host.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
});

it('goes back to a default, and says why a save was refused', async () => {
    vi.mocked(api).mockResolvedValueOnce(view({ retentionDays: 3, retentionDaysSaved: true }));
    act(() => root.render(<CodingSandboxSection />));
    await flush();
    vi.mocked(api).mockResolvedValueOnce(view());
    const reset = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Use the server default',
    )!;
    await act(async () => reset.click());
    await flush();
    expect(vi.mocked(api)).toHaveBeenLastCalledWith('/gateway/sandbox', 'PUT', {
        registries: null,
        retentionDays: null,
    });
    const days = host.querySelector<HTMLInputElement>('#coding-retention')!;
    await (async () => {
        await flush();
        expect(days.value).toBe('14');
    })();
    vi.mocked(api).mockRejectedValueOnce(new Error('Workspaces can’t be kept that long on this server.'));
    type(days, '30');
    await leave(days);
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        'Workspaces can’t be kept that long on this server.',
    );
    // What is saved shows again.
    expect(days.value).toBe('14');
});
