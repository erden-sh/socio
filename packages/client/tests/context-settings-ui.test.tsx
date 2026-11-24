// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ContextSetting } from '../src/modules/settings/ContextSetting';

// Settings → General → Long chats (CB-137, CB-134).

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
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const render = (readOnly: boolean, mutate = vi.fn(async () => true)) =>
    act(async () =>
        root.render(
            <ContextSetting
                settings={{ summaryModel: 'shared', selection: 'age' }}
                readOnly={readOnly}
                mutate={mutate}
            />,
        ),
    );
const select = (id: string) => host.querySelector<HTMLSelectElement>(`#${id}`)!;
const choose = (field: HTMLSelectElement, value: string) =>
    act(async () => {
        field.value = value;
        field.dispatchEvent(new Event('change', { bubbles: true }));
    });

it('shows members the choices in force, and no way to change them', async () => {
    await render(true);
    expect(select('context-summary-model').value).toBe('shared');
    expect(select('context-selection').value).toBe('age');
    expect(select('context-summary-model').disabled).toBe(true);
    expect(select('context-selection').disabled).toBe(true);
    expect(host.textContent).toContain('Only an admin can change these settings.');
});

it('saves each choice as it is made, and goes back when saving fails', async () => {
    const mutate = vi.fn(async () => true);
    await render(false, mutate);
    expect([...select('context-selection').options].map((option) => option.text)).toEqual([
        'The newest facts',
        'The facts that match each request',
        'A short core, the rest on search',
    ]);
    await choose(select('context-selection'), 'relevance');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        context: { selection: 'relevance' },
    });
    expect(select('context-selection').value).toBe('relevance');
    mutate.mockResolvedValueOnce(false);
    await choose(select('context-summary-model'), 'chat');
    expect(mutate).toHaveBeenLastCalledWith('/settings', 'PATCH', {
        context: { summaryModel: 'chat' },
    });
    expect(select('context-summary-model').value).toBe('shared');
});
