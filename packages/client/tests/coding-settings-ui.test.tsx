// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'sonner';

import {
    CODING_LIMITS,
    CODING_LIMIT_KEYS,
    type CodingLimits,
    type CodingSettingsState,
} from '@socio/shared/coding/coding-gateway';

import { api } from '../src/lib/api';
import { CodingSettingsSection } from '../src/modules/coding/CodingSettingsSection';
import { allowed, findSection, type SettingsAccess } from '../src/modules/settings/sections';

// Settings → Coding (CB-239): admins list models, allow outside
// providers per repository, and set limits; the page is there only while
// the flag is on for them. Settings save as they change (CB-308); adding a
// model is an action, with its own button.

// React listens for focusout to run onBlur.
const leave = (element: Element) =>
    act(async () => {
        element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
const typeInto = (element: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')!.set!.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });

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
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
});

const limits = Object.fromEntries(CODING_LIMIT_KEYS.map((key) => [key, CODING_LIMITS[key].default])) as CodingLimits;

const state = (): CodingSettingsState => ({
    models: [
        {
            id: 'grok',
            label: 'Grok 5',
            backendId: 'b2',
            backendLabel: 'xAI',
            backendReady: true,
            backendHost: 'api.x.ai',
            upstreamModel: 'grok-5',
            maxOutputTokens: 8000,
            contextWindow: null,
            acceptsImages: false,
            outsideProviderSetting: null,
            outsideProvider: true,
            enabled: true,
            repositories: ['erden-sh/socio'],
            updatedAt: 1,
        },
        {
            id: 'orion',
            label: 'Homelab (qwen38)',
            backendId: 'b1',
            backendLabel: 'Homelab',
            backendReady: true,
            backendHost: '10.0.0.5',
            upstreamModel: 'qwen38',
            maxOutputTokens: 4000,
            contextWindow: null,
            acceptsImages: false,
            outsideProviderSetting: null,
            outsideProvider: false,
            enabled: true,
            repositories: [],
            updatedAt: 1,
        },
    ],
    backends: [
        {
            id: 'b1',
            label: 'Homelab',
            model: 'qwen38',
            host: '10.0.0.5',
            outsideByDefault: false,
            ready: true,
        },
    ],
    limits,
    limitDefaults: limits,
    usage: {
        persons: [
            {
                id: 'alice',
                label: 'Alice',
                requests: 3,
                promptTokens: 1200,
                completionTokens: 40,
            },
        ],
        socios: [],
        models: [],
    },
});

const render = () => act(async () => root.render(<CodingSettingsSection />));

it('lists the Coding page only for admins with the flag on', () => {
    const found = findSection('coding')!;
    expect(found.item.flag).toBe('coding-sessions');
    const base: SettingsAccess = {
        admin: true,
        operator: false,
        signIn: true,
        telegram: false,
        flags: [],
    };
    expect(allowed(found.item, base)).toBe(false);
    expect(allowed(found.item, { ...base, flags: ['coding-sessions'] })).toBe(true);
    expect(allowed(found.item, { ...base, admin: false, flags: ['coding-sessions'] })).toBe(false);
});

it('shows each model with where its code goes, and the outside one’s repositories', async () => {
    vi.mocked(api).mockResolvedValue(state());
    await render();
    expect(api).toHaveBeenCalledWith('/gateway/coding');
    const models = host.querySelectorAll('[data-slot="coding-model"]');
    expect(models).toHaveLength(2);
    expect(models[0]!.textContent).toContain('Outside provider');
    expect(models[1]!.textContent).toContain('Your servers');
    const repositories = models[0]!.querySelector('textarea')!;
    expect(repositories.value).toBe('erden-sh/socio');
    expect(models[1]!.querySelector('textarea')).toBeNull();
    expect(host.querySelector('[data-slot="coding-usage"]')!.textContent).toContain('Alice');
    // Every field has a label (keyboard and screen readers).
    for (const input of host.querySelectorAll('input, textarea, select')) {
        expect(host.querySelector(`label[for="${input.id}"]`), input.outerHTML).not.toBeNull();
    }
});

it('saves an outside model’s repositories, refusing what isn’t owner/name', async () => {
    vi.mocked(api).mockResolvedValue(state());
    await render();
    const model = host.querySelector('[data-slot="coding-model"]')!;
    const textarea = model.querySelector('textarea')!;
    const setValue = (value: string) =>
        act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });
    // No Save button: leaving the field saves it.
    expect([...model.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save repositories');
    await setValue('../etc');
    await leave(textarea);
    expect(model.textContent).toContain('is not owner/name');
    // Only the load (the repositories card, the sandboxes card and the
    // personal plans card load their own beside it).
    expect(
        vi
            .mocked(api)
            .mock.calls.filter(
                ([path]) =>
                    path !== '/gateway/repositories' &&
                    path !== '/gateway/sandbox' &&
                    path !== '/gateway/coding/options' &&
                    path !== '/gateway/harnesses',
            ),
    ).toHaveLength(1);
    await setValue('erden-sh/socio, erden-sh/other');
    await leave(textarea);
    expect(api).toHaveBeenLastCalledWith('/gateway/coding/models/grok/repositories', 'PUT', {
        repositories: ['erden-sh/socio', 'erden-sh/other'],
    });
    // One a line, as saved; the toast offers Undo.
    expect(textarea.value).toBe('erden-sh/socio\nerden-sh/other');
    expect(model.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
    expect(toast.success).toHaveBeenLastCalledWith(
        'Repositories saved',
        expect.objectContaining({
            action: expect.objectContaining({ label: 'Undo' }),
        }),
    );
});

it('sends limits left at the default as null, and refuses out-of-range ones', async () => {
    vi.mocked(api).mockResolvedValue(state());
    await render();
    const form = host.querySelector<HTMLFormElement>('[data-slot="coding-limits"]')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    const setValue = (value: string) =>
        act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    expect([...form.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Save limits');
    const loads = vi.mocked(api).mock.calls.length;
    await setValue('5');
    await leave(input);
    expect(form.querySelector('[role="alert"]')!.textContent).toContain('use a whole number');
    expect(vi.mocked(api).mock.calls).toHaveLength(loads);
    await setValue('3000000');
    await leave(input);
    expect(form.querySelector('[role="alert"]')).toBeNull();
    const call = vi.mocked(api).mock.calls.at(-1)!;
    expect(call[0]).toBe('/gateway/coding/limits');
    expect(call[2]).toMatchObject({
        sessionTokens: 3_000_000,
        personDailyTokens: null,
    });
});

it('turns personal plans on and back to the server default', async () => {
    vi.mocked(api).mockImplementation(async (path: string, method?: string) => {
        if (path === '/gateway/coding/options') {
            return method === 'PUT'
                ? {
                      personalPlans: true,
                      personalPlansDefault: false,
                      personalPlansSaved: true,
                  }
                : {
                      personalPlans: false,
                      personalPlansDefault: false,
                      personalPlansSaved: false,
                  };
        }
        if (path === '/gateway/coding') {
            return state();
        }
        return undefined;
    });
    await render();
    const card = host.querySelector('[data-slot="coding-plans"]')!;
    expect(card.textContent).toContain('Personal plans');
    expect(card.textContent).toContain('Server default: off');
    const box = card.querySelector<HTMLButtonElement>('#coding-personal-plans')!;
    expect(box.getAttribute('aria-checked')).toBe('false');
    await act(async () => box.click());
    expect(api).toHaveBeenCalledWith('/gateway/coding/options', 'PUT', {
        personalPlans: true,
    });
    expect(card.textContent).toContain('changed here');
    const reset = [...card.querySelectorAll('button')].find((b) => b.textContent?.includes('Use the server default'))!;
    await act(async () => reset.click());
    expect(api).toHaveBeenLastCalledWith('/gateway/coding/options', 'PUT', {
        personalPlans: null,
    });
});

it('lists the coding agents with their route, switch and terms record (CB-326)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
        if (path === '/gateway/harnesses') {
            return {
                harnesses: [
                    {
                        id: 'opencode',
                        label: 'OpenCode',
                        route: 'gateway',
                        default: true,
                        personalPlans: true,
                        disabled: false,
                        terms: {
                            plans: 'Models through Socio’s gateway',
                            checkedAt: null,
                            url: 'https://example.com/oc',
                        },
                    },
                    {
                        id: 'claude-code',
                        label: 'Claude Code',
                        route: 'gateway',
                        default: false,
                        personalPlans: false,
                        disabled: true,
                        terms: {
                            plans: 'The Messages API through the gateway',
                            checkedAt: '2026-11-01',
                            url: 'javascript:alert(1)',
                        },
                    },
                ],
            };
        }
        if (path === '/gateway/coding') {
            return state();
        }
        return undefined;
    });
    await render();
    const card = host.querySelector('[data-slot="coding-harnesses"]')!;
    expect(card.textContent).toContain('Coding agents');
    expect(card.textContent).toContain('CODING_HARNESSES_DISABLED');
    const [open, claude] = [...card.querySelectorAll('[data-slot="coding-harness"]')];
    expect(open!.textContent).toContain('Default');
    expect(open!.textContent).toContain('Available');
    expect(open!.textContent).toContain('may run on a person’s own plan');
    expect(open!.querySelector('[data-slot="coding-harness-checked"]')!.textContent).toBe('Not checked yet');
    expect(open!.querySelector('a')!.getAttribute('href')).toBe('https://example.com/oc');
    expect(claude!.textContent).toContain('Turned off');
    expect(claude!.textContent).toContain('The Messages API through the gateway');
    expect(claude!.querySelector('[data-slot="coding-harness-checked"]')!.textContent).toBe('2026-11-01');
    // Only an https link is a link.
    expect(claude!.querySelector('a')).toBeNull();
});
it('saves an edited model as it changes, and adds a new one with Add model', async () => {
    vi.mocked(api).mockResolvedValue(state());
    await render();
    const orion = host.querySelectorAll('[data-slot="coding-model"]')[1]!;
    await act(async () => [...orion.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!.click());
    const form = host.querySelector('[data-slot="coding-model-form"]')!;
    const buttons = () => [...form.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons()).not.toContain('Save model');
    expect(buttons()).toContain('Done');
    const label = form.querySelectorAll('input')[1]!;
    await typeInto(label, '');
    await leave(label);
    expect(form.querySelector('[role="alert"]')!.textContent).toBe('Give the model a label and an upstream model.');
    await typeInto(label, 'Homelab fast');
    await leave(label);
    expect(api).toHaveBeenLastCalledWith('/gateway/coding/models/orion', 'PUT', {
        label: 'Homelab fast',
        backendId: 'b1',
        upstreamModel: 'qwen38',
        maxOutputTokens: 4000,
        contextWindow: null,
        acceptsImages: false,
        outsideProvider: null,
        enabled: true,
    });
    expect(form.querySelector('[data-slot="save-status"]')!.textContent).toBe('Saved');
    // A checkbox saves at once.
    await act(async () => form.querySelector<HTMLElement>('[role="checkbox"]')!.click());
    expect(vi.mocked(api).mock.calls.at(-1)![2]).toMatchObject({
        acceptsImages: true,
    });
    await act(async () => [...form.querySelectorAll('button')].find((b) => b.textContent === 'Done')!.click());

    // Adding: an action, so it keeps its button, named for it.
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Add a model')!.click());
    const add = host.querySelector('[data-slot="coding-model-form"]')!;
    expect(add.querySelector('[data-slot="save-status"]')).toBeNull();
    const [name, newLabel] = add.querySelectorAll('input');
    await typeInto(name!, 'orion-2');
    await leave(name!);
    await typeInto(newLabel!, 'Homelab 2');
    await leave(newLabel!);
    // Nothing is saved until Add model.
    expect(vi.mocked(api).mock.calls.some(([path]) => String(path).includes('orion-2'))).toBe(false);
    await act(async () => [...add.querySelectorAll('button')].find((b) => b.textContent === 'Add model')!.click());
    expect(api).toHaveBeenLastCalledWith(
        '/gateway/coding/models/orion-2',
        'PUT',
        expect.objectContaining({ label: 'Homelab 2', backendId: 'b1' }),
    );
    expect(toast.success).toHaveBeenLastCalledWith('Model added');
});
