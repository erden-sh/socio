// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { useTranslation } from '@socio/i18n/react';
import {
    APP_LOCALE,
    compareText,
    formatNumber,
    lowerText,
    scopeActiveLocale,
    setActiveLocale,
} from '@socio/shared/locale';
import type { PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';
import type { PageI18n } from '@socio/shared/web/web';

import { I18nRoot } from '../src/i18n/I18nRoot';
import { FolderTree } from '../src/modules/media/FolderTree';
import { SpaceLibrary } from '../src/modules/spaces/SpaceLibrary';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/*
 * The server renders in its own default locale (Node follows LANG) and the
 * browser hydrates in the reader's. Here both are stubbed: whatever reads
 * the default locale (`localeCompare()`, `toLocaleString()`, `new
 * Intl.Collator()`, ...) gets `defaultLocale`, en-US while the "server"
 * renders and another language while the "browser" hydrates. Sorting or
 * formatting by the default locale then mismatches, as it did in a
 * Swedish or Danish browser.
 */
let defaultLocale = 'en-US';
const pick = (locales?: Intl.LocalesArgument) => locales ?? defaultLocale;
const original = {
    localeCompare: String.prototype.localeCompare,
    toLocaleLowerCase: String.prototype.toLocaleLowerCase,
    toLocaleUpperCase: String.prototype.toLocaleUpperCase,
    numberToLocaleString: Number.prototype.toLocaleString,
    Collator: Intl.Collator,
    NumberFormat: Intl.NumberFormat,
};
const defaulting = <T extends object>(Ctor: T) =>
    new Proxy(Ctor, {
        construct: (target, [locales, options]) => Reflect.construct(target as never, [pick(locales), options]),
        apply: (target, self, [locales, options]) => Reflect.apply(target as never, self, [pick(locales), options]),
    });
beforeAll(() => {
    String.prototype.localeCompare = function (
        this: string,
        that: string,
        locales?: Intl.LocalesArgument,
        o?: Intl.CollatorOptions,
    ) {
        return original.localeCompare.call(this, that, pick(locales), o);
    };
    String.prototype.toLocaleLowerCase = function (this: string, locales) {
        return original.toLocaleLowerCase.call(this, pick(locales));
    };
    String.prototype.toLocaleUpperCase = function (this: string, locales) {
        return original.toLocaleUpperCase.call(this, pick(locales));
    };
    Number.prototype.toLocaleString = function (this: number, locales, o) {
        return original.numberToLocaleString.call(this, pick(locales), o);
    };
    Intl.Collator = defaulting(original.Collator);
    Intl.NumberFormat = defaulting(original.NumberFormat);
});
afterAll(() => {
    String.prototype.localeCompare = original.localeCompare;
    String.prototype.toLocaleLowerCase = original.toLocaleLowerCase;
    String.prototype.toLocaleUpperCase = original.toLocaleUpperCase;
    Number.prototype.toLocaleString = original.numberToLocaleString;
    Intl.Collator = original.Collator;
    Intl.NumberFormat = original.NumberFormat;
});

let host: HTMLDivElement;
let root: Root | undefined;
let mismatches: unknown[];
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    defaultLocale = 'en-US';
    mismatches = [];
    host = document.createElement('div');
    document.body.append(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host.remove();
});

/**
 * Renders `ui` on an en-US server, then hydrates it in a browser whose
 * default locale is `browser`. Returns the server's HTML.
 */
async function serverThenHydrate(ui: ReactNode, browser: string) {
    defaultLocale = 'en-US';
    const html = renderToString(ui);
    host.innerHTML = html;
    defaultLocale = browser;
    await act(async () => {
        root = hydrateRoot(host, ui, {
            onRecoverableError: (error) => mismatches.push(error),
        });
    });
    return html;
}

it('stubs the default locale as a browser in another language has it', () => {
    defaultLocale = 'sv-SE';
    expect(['Äpple', 'Zebra'].sort((a, b) => a.localeCompare(b))).toEqual(['Zebra', 'Äpple']);
    expect(new Intl.NumberFormat().format(12345)).toMatch(/^12\s345$/);
    defaultLocale = 'da-DK';
    expect(['Zebra', 'Aalborg'].sort(new Intl.Collator().compare)).toEqual(['Zebra', 'Aalborg']);
});

it('sorts and formats in en-US whatever the default locale', () => {
    expect(APP_LOCALE).toBe('en-US');
    for (const locale of ['sv-SE', 'da-DK', 'tr-TR']) {
        defaultLocale = locale;
        expect(['Zebra', 'Örn', 'Äpple', 'Aalborg', 'Banan'].sort(compareText)).toEqual([
            'Aalborg',
            'Äpple',
            'Banan',
            'Örn',
            'Zebra',
        ]);
        expect(formatNumber(12345.5)).toBe('12,345.5');
        expect(lowerText('ISTANBUL')).toBe('istanbul');
    }
});

it('hydrates the Media folder tree in a Danish browser', async () => {
    // Danish sorts "Aa" as "Å", after Z; folder names are ASCII.
    const html = await serverThenHydrate(
        <FolderTree
            tree={['Zebra/', 'Aalborg/', 'Banan/', 'attachments/']}
            folder=""
            dotName={() => undefined}
            onOpen={() => {}}
        />,
        'da-DK',
    );
    expect(mismatches).toEqual([]);
    const order = [...host.querySelectorAll('[data-folder]')].map((node) => node.getAttribute('data-folder'));
    expect(order).toEqual(['', 'attachments/', 'Aalborg/', 'Banan/', 'Zebra/']);
    expect(html).toContain('data-folder="Aalborg/"');
});

it('hydrates the Space library in a Swedish browser', async () => {
    // Pages edited at the same moment are ordered by title; Swedish puts Ä
    // and Ö after Z.
    const at = Date.UTC(2026, 9, 9, 15, 4);
    const page = (id: string, title: string) =>
        ({
            id,
            spaceId: 'space',
            parentId: null,
            title,
            excerpt: `About ${title}.`,
            revision: 1,
            createdAt: at,
            updatedAt: at,
        }) as unknown as PageSummary;
    const space = { id: 'space', name: 'Team' } as Space;
    await serverThenHydrate(
        <SpaceLibrary
            space={space}
            pages={[page('z', 'Zebra'), page('o', 'Örn'), page('a', 'Äpple'), page('b', 'Banan')]}
            onPage={() => {}}
            onNew={() => {}}
            onDeleted={() => {}}
        />,
        'sv-SE',
    );
    expect(mismatches).toEqual([]);
    expect([...host.querySelectorAll('[data-slot="library-page-card"] h3')].map((node) => node.textContent)).toEqual([
        'Äpple',
        'Banan',
        'Örn',
        'Zebra',
    ]);
});

/**
 * A page in a locale the server inlined (`I18nRoot` over the root loader's
 * data): the server renders its words and numbers in that locale, and the
 * browser, whatever its own language, hydrates with the same, so nothing
 * flashes in English and nothing mismatches.
 */
it('renders and hydrates a page in its inlined locale', async () => {
    const data: PageI18n = {
        locale: 'es-419',
        dir: 'ltr',
        manifest: { release: '1.0.0', locales: {} },
        resources: {
            'es-419': { 'settings.language': { title: 'Idioma', saved: 'Idioma: {{language}}' } },
            'en-US': { 'settings.language': { title: 'Language', saved: 'Language: {{language}}' } },
        },
        offered: ['en-US'],
    };
    function Probe() {
        const { t } = useTranslation(['settings.language']);
        return (
            <p data-slot="probe">
                {t('settings.language:title')} · {formatNumber(1234.5)} ·{' '}
                {t('settings.language:saved', { language: 'español' })}
            </p>
        );
    }
    const page = () => (
        <RouterProvider
            router={createMemoryRouter(
                [
                    {
                        id: 'root',
                        path: '/',
                        loader: () => ({ i18n: data }),
                        Component: () => (
                            <I18nRoot>
                                <Probe />
                            </I18nRoot>
                        ),
                    },
                ],
                { hydrationData: { loaderData: { root: { i18n: data } } } },
            )}
        />
    );
    try {
        defaultLocale = 'en-US';
        const html = renderToString(page());
        expect(html.replaceAll('<!-- -->', '')).toContain('Idioma · 1,234.5 · Idioma: español');
        expect(html).not.toContain('Language');
        host.innerHTML = html;
        defaultLocale = 'sv-SE';
        await act(async () => {
            root = hydrateRoot(host, page(), { onRecoverableError: (error) => mismatches.push(error) });
        });
        expect(mismatches).toEqual([]);
        expect(host.querySelector('[data-slot="probe"]')!.textContent).toBe('Idioma · 1,234.5 · Idioma: español');
    } finally {
        setActiveLocale(APP_LOCALE);
    }
});

/**
 * Successive and interleaved page renders in two locales, as the server's
 * renderer scopes them (entry.server.tsx): every formatter, made at module
 * load (`formatNumber`) or kept in a cache (`bucketLabel`'s, by zone and
 * shape), writes in the render's own locale, never the one before it.
 */
it('formats each render in its own locale, whatever rendered before', async () => {
    const { AsyncLocalStorage } = await import('node:async_hooks');
    const { bucketLabel } = await import('../src/modules/operations/format');
    const store = new AsyncLocalStorage<string>();
    scopeActiveLocale(() => store.getStore());
    const at = Date.UTC(2026, 9, 22, 12);
    function Report() {
        return (
            <p>
                {bucketLabel(at, 'day', 'UTC')} | {formatNumber(1234.5)} | {['Zebra', 'Äpple'].sort(compareText)[0]}
            </p>
        );
    }
    const render = (locale: string) =>
        store.run(locale, async () => {
            const first = renderToString(<Report />).replaceAll('<!-- -->', '');
            // Another request renders while this one waits.
            await new Promise((resolve) => setTimeout(resolve, 5));
            const second = renderToString(<Report />).replaceAll('<!-- -->', '');
            return [first, second];
        });
    try {
        const [ptBr, enUs, sv] = await Promise.all([render('pt-BR'), render('en-US'), render('sv-SE')]);
        expect(ptBr).toEqual(['<p>22 de out. | 1.234,5 | Äpple</p>', '<p>22 de out. | 1.234,5 | Äpple</p>']);
        expect(enUs).toEqual(['<p>Oct 22 | 1,234.5 | Äpple</p>', '<p>Oct 22 | 1,234.5 | Äpple</p>']);
        expect(sv![0]).toMatch(/^<p>22 okt\. \| 1\s234,5 \| Zebra<\/p>$/);
        // Then en-US alone, after the others filled every cache.
        expect(await render('en-US')).toEqual(enUs);
    } finally {
        scopeActiveLocale(undefined);
    }
});
