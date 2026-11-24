// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { APP_LOCALE, compareText, formatNumber, lowerText } from '@socio/shared/locale';
import type { PageSummary } from '@socio/shared/pages/page-library';
import type { Space } from '@socio/shared/types';

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
