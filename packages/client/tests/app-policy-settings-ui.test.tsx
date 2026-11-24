// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AppPolicySetting } from '../src/modules/settings/AppPolicySetting';

// Settings → General → The Socio app on phones (CB-379): the manifest's policy, admins change it.

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
    // The checkbox measures itself (Radix).
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

type Mutate = (path: string, method: string, body?: unknown) => Promise<boolean>;
const render = (readOnly: boolean, mutate: Mutate = vi.fn(async () => true), policy?: Record<string, unknown>) =>
    act(async () => root.render(<AppPolicySetting policy={policy} readOnly={readOnly} mutate={mutate} />));
const field = (key: string) => host.querySelector<HTMLInputElement>(`#app-policy-${key}`)!;
const boxes = () => [...host.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
/** Types into a field as a person would, then leaves it. */
const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        input.focus();
        input.blur();
    });
};

/**
 * The server and the shell's `mutate` (AppShell): a save is applied, the
 * state refreshes into the card's props, then it resolves. With `hold`, each
 * answer waits for the test (`answers`).
 */
function workspace(initial: Record<string, unknown> = {}, { hold = false } = {}) {
    let policy: Record<string, unknown> = { ...initial };
    const answers: ((ok: boolean) => void)[] = [];
    const between: Record<string, unknown>[] = [];
    const mutate = vi.fn(async (_path: string, _method: string, body?: unknown) => {
        const ok = hold ? await new Promise<boolean>((resolve) => answers.push(resolve)) : true;
        if (ok) {
            policy = { ...policy, ...(body as { appPolicy: Record<string, unknown> }).appPolicy };
            // Another admin's save between this one and its refresh.
            policy = { ...policy, ...between.splice(0).reduce((all, change) => ({ ...all, ...change }), {}) };
            root.render(<AppPolicySetting policy={policy} readOnly={false} mutate={mutate} />);
        }
        return ok;
    });
    /** Another admin's save. */
    const other = async (change: Record<string, unknown>) => {
        policy = { ...policy, ...change };
        await render(false, mutate, policy);
    };
    return { mutate, answers, other, between };
}

it('shows members the policy in force, with no way to change it', async () => {
    await render(true, undefined, { leaseDays: 14 });
    expect(field('leaseDays').value).toBe('14');
    expect(field('wipeDays').value).toBe('30');
    expect(field('leaseDays').disabled).toBe(true);
    expect(boxes().map((box) => [box.getAttribute('aria-checked'), box.disabled])).toEqual([
        ['false', true],
        ['true', true],
    ]);
    expect(host.textContent).toContain('Only an admin can change these settings.');
});

it('saves an admin’s days and switches one at a time', async () => {
    const { mutate } = workspace();
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { leaseDays: 10 } });
    expect(field('leaseDays').value).toBe('10');
    await act(async () => boxes()[0].click());
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { appLock: true } });
    expect(boxes()[0].getAttribute('aria-checked')).toBe('true');
    await act(async () => boxes()[1].click());
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { notificationText: false } });
    expect(boxes()[1].getAttribute('aria-checked')).toBe('false');
});

it('refuses days the app can’t hold, in the card, and saves nothing', async () => {
    const mutate = vi.fn(async () => true);
    await render(false, mutate);
    await type(field('wipeDays'), '3');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Use a whole number of days from 7 to 365.');
    expect(mutate).not.toHaveBeenCalled();
});

it('follows another admin’s change while nothing is unsaved', async () => {
    await render(true, undefined, { leaseDays: 30 });
    expect(field('leaseDays').value).toBe('30');
    await render(true, undefined, { leaseDays: 7, appLock: true });
    expect(field('leaseDays').value).toBe('7');
    expect(boxes()[0].getAttribute('aria-checked')).toBe('true');
});

it('puts back only the switch whose save failed, never one that saved', async () => {
    const { mutate, answers } = workspace({}, { hold: true });
    await render(false, mutate);
    await act(async () => boxes()[0].click());
    await act(async () => boxes()[1].click());
    expect(mutate.mock.calls.map((call) => call[2])).toEqual([
        { appPolicy: { appLock: true } },
        { appPolicy: { notificationText: false } },
    ]);
    await act(async () => answers[0](false));
    await act(async () => answers[1](true));
    expect(boxes()[0].getAttribute('aria-checked')).toBe('false');
    expect(boxes()[1].getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it('shows what the server has after two failed saves, and saves again on retry', async () => {
    const { mutate, answers } = workspace({}, { hold: true });
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    await act(async () => boxes()[1].click());
    await act(async () => answers[0](false));
    await act(async () => answers[1](false));
    expect(field('leaseDays').value).toBe('30');
    expect(boxes()[1].getAttribute('aria-checked')).toBe('true');
    // Typing the value again sends it again.
    await type(field('leaseDays'), '10');
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { leaseDays: 10 } });
});

it('sends only the field this admin changed, never another admin’s change that came in meanwhile', async () => {
    const { mutate, other } = workspace();
    await render(false, mutate);
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(field('leaseDays'), '10');
        field('leaseDays').dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Another admin turns notification text off while this one is still typing.
    await other({ notificationText: false });
    await act(async () => {
        field('leaseDays').focus();
        field('leaseDays').blur();
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('/settings', 'PATCH', { appPolicy: { leaseDays: 10 } });
    expect(boxes()[1].getAttribute('aria-checked')).toBe('false');
});

it('sends each of three overlapping saves with its own field and value, and shows all three', async () => {
    const { mutate, answers } = workspace({}, { hold: true });
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    // While the lease's save is on its way, both switches change.
    await act(async () => boxes()[0].click());
    await act(async () => boxes()[1].click());
    // Each went at once with its own field; none waited on or carried another.
    expect(answers).toHaveLength(3);
    await act(async () => answers.forEach((answer) => answer(true)));
    expect(mutate.mock.calls.map((call) => call[2])).toEqual([
        { appPolicy: { leaseDays: 10 } },
        { appPolicy: { appLock: true } },
        { appPolicy: { notificationText: false } },
    ]);
    expect(field('leaseDays').value).toBe('10');
    expect(boxes().map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false']);
});

it('saves one field’s changes one after another, so the last one made is the one saved', async () => {
    const { mutate, answers } = workspace({}, { hold: true });
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    await type(field('leaseDays'), '20');
    // The second waits for the first.
    expect(mutate).toHaveBeenCalledTimes(1);
    await act(async () => answers[0](true));
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { leaseDays: 20 } });
    await act(async () => answers[1](true));
    expect(field('leaseDays').value).toBe('20');
});

it('follows another admin’s later change after a save the props showed before it ended', async () => {
    const { mutate, answers, other } = workspace({}, { hold: true });
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    await other({ leaseDays: 10 });
    await act(async () => answers[0](true));
    await other({ leaseDays: 7 });
    expect(field('leaseDays').value).toBe('7');
});

it('shows the policy in force when another admin saved over this one before its refresh', async () => {
    const { mutate, answers, between } = workspace({}, { hold: true });
    await render(false, mutate);
    await type(field('leaseDays'), '10');
    // Another admin saves 7 after this save lands and before its refresh.
    between.push({ leaseDays: 7 });
    await act(async () => answers[0](true));
    expect(field('leaseDays').value).toBe('7');
    // Typing 10 again saves it again.
    await type(field('leaseDays'), '10');
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', { appPolicy: { leaseDays: 10 } });
});
