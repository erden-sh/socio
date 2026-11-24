// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { UserPreferences } from '@socio/shared/voice/dictation';

import { nativeSelect } from '../src/components/form-fields';
import { DictationLanguageSetting } from '../src/modules/voice/DictationSettings';
import { ShellContext, type Shell } from '../src/shell/shell-context';

// Settings → Account → Dictation language (CB-221): a labeled native
// select, Auto first, then the languages by name; saved at once to the
// person's own preferences. The server is a fake `mutate`.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
});

async function render(preferences: Partial<UserPreferences>, mutate = vi.fn(async () => true)) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const shell = {
        workspace: { preferences: { dictation: null, ...preferences } },
        mutate,
    } as unknown as Shell;
    await act(async () =>
        root!.render(
            <ShellContext.Provider value={shell}>
                <DictationLanguageSetting />
            </ShellContext.Provider>,
        ),
    );
    return {
        mutate,
        select: host.querySelector<HTMLSelectElement>('#dictation-language')!,
    };
}
const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

it('shows a labelled select with Auto first, then languages by name', async () => {
    const { select } = await render({});
    const label = host!.querySelector('label[for="dictation-language"]');
    expect(label?.textContent).toBe('Dictation language');
    expect(select.getAttribute('aria-describedby')).toBe('dictation-language-help');
    expect(host!.querySelector('#dictation-language-help')?.textContent).toMatch(
        /Auto detects the language as you speak/,
    );
    // The shared native select (CB-258).
    expect(select.dataset.slot).toBe('native-select');
    expect(select.className).toContain(nativeSelect);
    expect(select.value).toBe('auto');
    const options = [...select.options];
    expect(options).toHaveLength(99);
    expect(options[0]).toMatchObject({ value: 'auto', text: 'Auto' });
    expect(options[1]).toMatchObject({ value: 'af', text: 'Afrikaans' });
    expect(options.map((option) => option.value)).not.toContain('jw');
    expect(options.map((option) => option.value)).not.toContain('nn');
    expect(options.find((option) => option.value === 'yue')?.text).toBe('Cantonese');
});

it('shows the saved language, and Auto for one no longer offered', async () => {
    expect((await render({ dictationLanguage: 'fr' })).select.value).toBe('fr');
    act(() => root?.unmount());
    host?.remove();
    expect((await render({ dictationLanguage: 'jw' as never })).select.value).toBe('auto');
});

it('saves a language, and Auto as null, and goes back when saving fails', async () => {
    const { select, mutate } = await render({});
    await choose(select, 'zh');
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', {
        dictationLanguage: 'zh',
    });
    await choose(select, 'auto');
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', {
        dictationLanguage: null,
    });
    mutate.mockResolvedValueOnce(false);
    await choose(select, 'de');
    expect(select.value).toBe('auto');
});
