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
import { applyLocale, pageInstance } from '../src/i18n/page-instance';
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

it('matches the device over the offered locales only: a Portuguese browser with pt-BR under the gate gets en-US', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['pt-BR', 'pt']);
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(JSON.stringify({ release: '1.0.0', locales: { 'es-419': { coverage: 1, ns: {} } } })),
        ),
    );
    const mutate = await open(page(['en-US', 'es-419']));
    const section = host.querySelector('[data-slot="language-preference"]')!;
    expect(section.querySelector('label')!.textContent).toBe('Match my device (currently American English)');
    // Choosing it applies en-US, the same the server picks for this browser.
    const radios = section.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => radios[2]!.click());
    await act(async () => radios[0]!.click());
    expect(mutate).toHaveBeenLastCalledWith('/preferences', 'PATCH', { locale: null });
    expect(document.documentElement.lang).toBe('en-US');
});

it('doesn’t render with en-US alone', async () => {
    await open(page(['en-US']));
    expect(host.querySelector('[data-slot="language-preference"]')).toBeNull();
    expect(host.textContent).toBe('');
});

it('offers each locale in its own language, and applies a choice without a reload', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            requests.push(url);
            if (url === '/i18n/manifest.json?locales=es-419') {
                return new Response(
                    JSON.stringify({
                        release: '1.0.0',
                        locales: {
                            'es-419': {
                                coverage: 1,
                                ns: { 'settings.language': { hash: 'aaaaaaaaaaaa', sourceHash: 'bbbbbbbbbbbb' } },
                            },
                        },
                    }),
                );
            }
            if (url === '/i18n/es-419/settings.language.aaaaaaaaaaaa.json') {
                return new Response(JSON.stringify({ title: 'Idioma', savedDevice: 'Idioma: el del dispositivo' }));
            }
            return new Response('{}', { status: 404 });
        }),
    );
    const mutate = await open(page(['en-US', 'es-419']));
    const section = () => host.querySelector('[data-slot="language-preference"]')!;
    expect(section().querySelector('legend')!.textContent).toBe('Language');
    expect(section().textContent).toContain('The language Socio shows you');
    const labels = [...section().querySelectorAll('label')].map((label) => label.textContent);
    expect(labels[0]).toMatch(/^Match my device \(currently .+\)$/);
    expect(labels.slice(1)).toEqual(['American English', 'español latinoamericano']);
    expect(section().querySelector('[lang="es-419"]')).not.toBeNull();
    const radios = section().querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[0]!.checked).toBe(true);
    await act(async () => radios[2]!.click());
    expect(mutate).toHaveBeenCalledWith('/preferences', 'PATCH', { locale: 'es-419' });
    // The manifest for the new locale, then its file: no reload.
    expect(requests).toEqual([
        '/i18n/manifest.json?locales=es-419',
        '/i18n/es-419/settings.language.aaaaaaaaaaaa.json',
    ]);
    expect(section().querySelector('legend')!.textContent).toBe('Idioma');
    // What es-419 lacks falls back to en-US, key by key.
    expect(section().textContent).toContain('The language Socio shows you');
    expect(document.documentElement.lang).toBe('es-419');
    expect(document.cookie).toContain('socio_locale=es-419');
});

/** A fetch that answers when the test says so. */
function deferredFetch() {
    const waiting: { url: string; answer: (body: unknown) => void }[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(
            (input: string | URL | Request) =>
                new Promise<Response>((resolve) =>
                    waiting.push({
                        url: String(input instanceof Request ? input.url : input),
                        answer: (body) => resolve(new Response(JSON.stringify(body))),
                    }),
                ),
        ),
    );
    return waiting;
}

it('applies only the latest language change, however the earlier one ends', async () => {
    const waiting = deferredFetch();
    const instance = pageInstance(page(['en-US', 'es-419']));
    // Spanish waits for its manifest; English, already in it, goes at once.
    const spanish = applyLocale(instance, 'es-419', 'es-419');
    expect(await applyLocale(instance, 'en-US', 'en-US')).toBe(true);
    expect(waiting.map(({ url }) => url)).toEqual(['/i18n/manifest.json?locales=es-419']);
    waiting[0]!.answer({ release: '1.0.0', locales: { 'es-419': { coverage: 1, ns: {} } } });
    expect(await spanish).toBe(false);
    expect(instance.language).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');
    expect(document.cookie).toContain('socio_locale=en-US');
});

it('holds the list while a choice saves and applies', async () => {
    const waiting = deferredFetch();
    await open(page(['en-US', 'es-419']));
    const radios = () => [...host.querySelectorAll<HTMLInputElement>('[data-slot="language-preference"] input')];
    await act(async () => radios()[2]!.click());
    expect(radios().every((radio) => radio.disabled)).toBe(true);
    expect(host.querySelector('[data-slot="language-preference"]')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => waiting[0]!.answer({ release: '1.0.0', locales: { 'es-419': { coverage: 1, ns: {} } } }));
    expect(radios().some((radio) => radio.disabled)).toBe(false);
    expect(document.documentElement.lang).toBe('es-419');
});
