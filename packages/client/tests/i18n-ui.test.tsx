// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { WorkspaceState } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { I18nRoot } from '../src/i18n/I18nRoot';
import { LanguageSection } from '../src/modules/settings/language/LanguageSection';
import { ShellContext, type Shell } from '../src/shell/shell-context';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

// Settings › Language: hidden while en-US is the only locale over the
// coverage gate (today's build), shown and working once another passes.

const en = (ns: string) =>
    JSON.parse(readFileSync(join(import.meta.dirname, `../../i18n/locales/en-US/${ns}.json`), 'utf8'));

const page = (offered: string[]): PageI18n => ({
    locale: 'en-US',
    dir: 'ltr',
    manifest: { release: '1.0.0', locales: { 'en-US': { coverage: 1, ns: {} } } },
    resources: { 'en-US': { common: en('common'), 'settings.language': en('settings.language') } },
    offered,
});

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
    vi.unstubAllGlobals();
    document.documentElement.lang = '';
    document.cookie = 'socio_locale=; Max-Age=0; Path=/';
});

async function open(data: PageI18n, mutate = vi.fn(async () => true)) {
    const shell = { workspace: { preferences: { dictation: null } } as WorkspaceState, mutate } as unknown as Shell;
    const router = createMemoryRouter(
        [
            {
                id: 'root',
                path: '/',
                loader: () => ({ i18n: data }),
                Component: () => (
                    <I18nRoot>
                        <ShellContext.Provider value={shell}>
                            <LanguageSection />
                        </ShellContext.Provider>
                    </I18nRoot>
                ),
            },
        ],
        { hydrationData: { loaderData: { root: { i18n: data } } } },
    );
    root = createRoot(host);
    await act(async () => root!.render(<RouterProvider router={router} />));
    return mutate;
}

it('doesn’t render with en-US alone', async () => {
    await open(page(['en-US']));
    expect(host.querySelector('[data-slot="language-preference"]')).toBeNull();
    expect(host.textContent).toBe('');
});

it('offers each locale in its own language, and applies a choice without a reload', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            expect(url).toBe('/i18n/manifest.json?locales=es-419');
            return new Response(JSON.stringify({ release: '1.0.0', locales: { 'es-419': { coverage: 1, ns: {} } } }));
        }),
    );
    const mutate = await open(page(['en-US', 'es-419']));
    const section = host.querySelector('[data-slot="language-preference"]')!;
    expect(section.querySelector('legend')!.textContent).toBe('Language');
    expect(section.textContent).toContain('The language Socio shows you');
    const labels = [...section.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels[0]).toMatch(/^Match my device \(currently .+\)$/);
    expect(labels.slice(1)).toEqual(['American English', 'español latinoamericano']);
    expect(section.querySelector('[lang="es-419"]')).not.toBeNull();
    const radios = section.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[0]!.checked).toBe(true);
    await act(async () => radios[2]!.click());
    expect(mutate).toHaveBeenCalledWith('/preferences', 'PATCH', { locale: 'es-419' });
    expect(document.documentElement.lang).toBe('es-419');
    expect(document.cookie).toContain('socio_locale=es-419');
});
