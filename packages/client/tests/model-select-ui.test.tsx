// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { ModelChoice, ModelOption, ModelOptions } from '@socio/shared/inference';

import { INHERIT_MODEL, ModelPicker, ModelSelect, inheritedModelLabel } from '../src/modules/chat/ModelSelect';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const options: ModelOption[] = [
    {
        key: 'shared:b1',
        choice: { source: 'shared', backendId: 'b1' },
        label: 'qwen',
        group: 'Homelab',
        available: true,
    },
    {
        key: 'byo:byo-chatgpt:gpt-6-astra',
        choice: { source: 'byo', kind: 'byo-chatgpt', model: 'gpt-6-astra' },
        label: 'GPT-6-Astra',
        group: 'ChatGPT',
        available: false,
        detail: 'Connect ChatGPT in Account → Inference to use it.',
    },
];
const models: ModelOptions = { options, automatic: 'Homelab' };

// What Radix Select needs from the DOM that jsdom leaves out.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
} as unknown as typeof ResizeObserver;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
});

function render(value: ModelChoice | null, requireAvailable: boolean) {
    const onChange = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() =>
        root!.render(
            <>
                <label htmlFor="dot-model">Default model</label>
                <ModelSelect
                    id="dot-model"
                    className="h-10 rounded-[9px]"
                    aria-label="Model"
                    value={value}
                    onChange={onChange}
                    options={options}
                    inheritLabel="Socio default"
                    requireAvailable={requireAvailable}
                />
            </>,
        ),
    );
    return {
        trigger: host.querySelector<HTMLButtonElement>('[role="combobox"]')!,
        onChange,
    };
}

const key = (element: Element, key: string) =>
    act(() => {
        element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
const listbox = () => document.body.querySelector('[role="listbox"]');
const item = (text: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === text)!;

it('is a shadcn Select whose inherited choice has a value of its own (CB-257)', () => {
    const { trigger } = render(null, true);
    // A button, named, labeled by its <label>, sized by the caller.
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-label')).toBe('Model');
    expect(trigger.id).toBe('dot-model');
    expect(trigger.className).toContain('h-10');
    expect(trigger.className).toContain('rounded-[9px]');
    expect(trigger.textContent).toBe('Socio default');
    expect(INHERIT_MODEL).not.toBe('');
    expect(INHERIT_MODEL).not.toContain(':');
    expect(host!.querySelector('select:not([aria-hidden])')).toBeNull();
});

it('groups models by where they run and disables the ones a chat can’t use', () => {
    const { trigger, onChange } = render(null, true);
    // The keyboard opens it.
    key(trigger, 'ArrowDown');
    expect(listbox()).not.toBeNull();
    expect([...document.body.querySelectorAll('[data-slot="select-label"]')].map((label) => label.textContent)).toEqual(
        ['Homelab', 'ChatGPT'],
    );
    const astra = item('GPT-6-Astra (not connected)');
    expect(astra.getAttribute('aria-disabled')).toBe('true');
    expect(astra.title).toContain('Account → Inference');
    expect(item('Socio default').getAttribute('data-state')).toBe('checked');
    key(item('qwen'), 'Enter');
    expect(onChange).toHaveBeenCalledWith({ source: 'shared', backendId: 'b1' });
    expect(listbox()).toBeNull();
});

it('picks the inherited choice back as null', () => {
    const { trigger, onChange } = render({ source: 'shared', backendId: 'b1' }, true);
    expect(trigger.textContent).toBe('qwen');
    key(trigger, 'Enter');
    key(item('Socio default'), 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(null);
});

it('lets a socio’s default name any model, and shows a choice that is gone', () => {
    const { trigger } = render({ source: 'shared', backendId: 'gone' }, false);
    expect(trigger.textContent).toBe('No longer available');
    key(trigger, 'ArrowDown');
    expect(item('GPT-6-Astra').getAttribute('aria-disabled')).toBeNull();
    const gone = item('No longer available');
    expect(gone.getAttribute('aria-disabled')).toBe('true');
    expect(gone.getAttribute('data-state')).toBe('checked');
});

it('says what a chat without its own model runs on', () => {
    const astra: ModelChoice = {
        source: 'byo',
        kind: 'byo-chatgpt',
        model: 'gpt-6-astra',
    };
    expect(inheritedModelLabel(null, models)).toBe('Automatic: Homelab');
    expect(inheritedModelLabel({ source: 'shared', backendId: 'b1' }, models)).toBe('Socio default: Homelab · qwen');
    expect(inheritedModelLabel(astra, models)).toBe(
        'Socio default ChatGPT · GPT-6-Astra needs a connection; automatic: Homelab',
    );
    expect(
        inheritedModelLabel(astra, {
            options: [{ ...options[1], available: true }],
            automatic: 'ChatGPT',
        }),
    ).toBe('Socio default: ChatGPT · GPT-6-Astra');
    expect(inheritedModelLabel({ source: 'shared', backendId: 'gone' }, models)).toBe(
        'Socio default unavailable; automatic: Homelab',
    );
});

it('shows a chat’s model as a quiet label on the Select’s own trigger (CB-100, CB-257)', () => {
    const onChange = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const picker = (value: ModelChoice | null) => (
        <ModelPicker
            aria-label="Model for this chat"
            value={value}
            onChange={onChange}
            options={options}
            inheritLabel="Automatic: Homelab"
            requireAvailable
        />
    );
    act(() => root!.render(picker(null)));
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="model-picker"]')!;
    const label = () => host!.querySelector('[data-slot="model-picker-label"]')!.textContent;
    expect(label()).toBe('Automatic: Homelab');
    // Small text, no border, cut short when long; the full name on hover.
    expect(trigger.className).toContain('text-[12px]');
    expect(trigger.className).not.toMatch(/(^| )border( |$)/);
    expect(trigger.className).toContain('border-0');
    expect(trigger.getAttribute('title')).toBe('Automatic: Homelab');
    expect(host.querySelector('[data-slot="model-picker-label"]')!.className).toContain('truncate');
    // The trigger is the control: a named button the keyboard opens.
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-label')).toBe('Model for this chat');
    expect(host.querySelector('select')).toBeNull();
    key(trigger, ' ');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    key(item('qwen'), 'Enter');
    expect(onChange).toHaveBeenCalledWith({ source: 'shared', backendId: 'b1' });
    act(() => root!.render(picker({ source: 'shared', backendId: 'b1' })));
    expect(label()).toBe('qwen');
    act(() => root!.render(picker({ source: 'shared', backendId: 'gone' })));
    expect(label()).toBe('No longer available');
    act(() =>
        root!.render(
            <ModelPicker
                aria-label="Model for this chat"
                value={null}
                onChange={onChange}
                options={options}
                inheritLabel="Automatic: Homelab"
                disabled
            />,
        ),
    );
    expect(trigger.disabled).toBe(true);
});

it('resolves explicit model availability independently of the automatic default', async () => {
    const { modelAvailability } = await import('../src/modules/chat/ModelSelect');
    const choice = { source: 'shared' as const, backendId: 'selected' };
    const models = {
        automatic: null,
        options: [
            {
                key: 'shared:selected',
                choice,
                label: 'Selected',
                group: 'Shared',
                available: true,
            },
        ],
    };
    expect(modelAvailability(choice, models, false)).toBe(true);
    expect(modelAvailability(choice, undefined, false)).toBeUndefined();
    expect(modelAvailability({ source: 'shared', backendId: 'gone' }, models, true)).toBe(false);
    expect(modelAvailability(null, models, false)).toBe(false);
    expect(modelAvailability(null, models, true)).toBe(true);
});
