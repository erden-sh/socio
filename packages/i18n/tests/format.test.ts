import { afterEach, describe, expect, it } from 'vitest';

import {
    APP_LOCALE,
    activeLocale,
    compareText,
    formatNumber,
    numberFormat,
    scopeActiveLocale,
    setActiveLocale,
} from '@socio/shared/locale';

import { createI18n } from '../src/create.js';
import { formatBytes, formatDuration } from '../src/format.js';
import { createReactI18n } from '../src/react.js';

afterEach(() => {
    setActiveLocale(APP_LOCALE);
    scopeActiveLocale(undefined);
});

const nbsp = (text: string) => text.replace(/[  ]/g, ' ');

describe('the formatters', () => {
    const i18n = (locale: string, strings: Record<string, string>) =>
        createI18n({ locale, resources: { [locale]: { common: strings } } });

    it('format numbers, currency, dates, relative times and lists in the string’s locale', () => {
        const strings = {
            n: '{{n, number}}',
            price: '{{p, currency(currency: EUR)}}',
            when: '{{d, datetime(dateStyle: medium; timeZone: UTC)}}',
            ago: '{{days, relativetime(range: day)}}',
            who: '{{names, list}}',
            size: '{{bytes, bytes}}',
            took: '{{ms, duration}}',
        };
        const en = i18n('en-US', strings);
        const day = new Date(Date.UTC(2026, 9, 15, 12));
        expect(en.t('n', { n: 12345.5 })).toBe('12,345.5');
        expect(en.t('price', { p: 3.5 })).toBe('€3.50');
        expect(en.t('when', { d: day })).toBe('Oct 15, 2026');
        expect(en.t('ago', { days: -1 })).toBe('yesterday');
        expect(en.t('who', { names: ['Ada', 'Alice', 'Bob'] })).toBe('Ada, Alice, and Bob');
        expect(nbsp(en.t('size', { bytes: 1_234_567 }))).toBe('1.2 MB');
        expect(nbsp(en.t('took', { ms: 3_905_000 }))).toBe('1 hr, 5 min, 5 sec');
        const es = i18n('es-419', strings);
        expect(nbsp(es.t('n', { n: 12345.5 }))).toBe('12,345.5');
        expect(es.t('ago', { days: -1 })).toBe('ayer');
        expect(es.t('who', { names: ['Ada', 'Alice', 'Bob'] })).toBe('Ada, Alice y Bob');
        const de = i18n('de-DE', strings);
        expect(de.t('n', { n: 12345.5 })).toBe('12.345,5');
    });

    it('formats bytes and durations', () => {
        expect(nbsp(formatBytes(512, 'en-US'))).toBe('512 byte');
        expect(nbsp(formatBytes(1500, 'en-US'))).toBe('1.5 kB');
        expect(nbsp(formatDuration(0, 'en-US'))).toBe('0 sec');
        expect(nbsp(formatDuration(61_000, 'en-US'))).toBe('1 min, 1 sec');
    });
});

describe('plurals', () => {
    /** Each count's form, for a key with every CLDR category written out. */
    const forms = (locale: string, counts: number[]) => {
        const i18n = createI18n({
            locale,
            resources: {
                [locale]: {
                    common: Object.fromEntries(
                        ['zero', 'one', 'two', 'few', 'many', 'other'].map((category) => [
                            `file_${category}`,
                            `${category} {{count}}`,
                        ]),
                    ),
                },
            },
        });
        return counts.map((count) => i18n.t('file', { count }));
    };

    it.each([
        // i18next takes `_zero` for 0 when there is one, whatever CLDR says.
        ['en-US', [0, 1, 2, 5], ['zero 0', 'one 1', 'other 2', 'other 5']],
        ['es-419', [1, 2, 1_000_000], ['one 1', 'other 2', 'many 1000000']],
        ['ar', [0, 1, 2, 3, 11, 100], ['zero 0', 'one 1', 'two 2', 'few 3', 'many 11', 'other 100']],
        ['ru', [1, 2, 5, 21], ['one 1', 'few 2', 'many 5', 'one 21']],
        ['pl', [1, 2, 5, 22], ['one 1', 'few 2', 'many 5', 'few 22']],
    ])('%s', (locale, counts, expected) => {
        expect(forms(locale, counts)).toEqual(expected);
    });

    it('falls back to en-US through the locale’s chain, never to an empty string', () => {
        const i18n = createI18n({
            locale: 'es-US',
            resources: {
                'en-US': { common: { hello: 'Hello', bye: 'Bye', left: 'Left' } },
                'es-419': { common: { hello: 'Hola', left: '' } },
                'es-US': { common: { bye: 'Chau' } },
            },
        });
        expect([i18n.t('hello'), i18n.t('bye'), i18n.t('left')]).toEqual(['Hola', 'Chau', 'Left']);
    });

    it('escapes interpolated values unless it renders for React', () => {
        const i18n = createI18n({ locale: 'en-US', resources: { 'en-US': { common: { hi: 'Hi {{name}}' } } } });
        expect(i18n.t('hi', { name: '<b>Ada</b>' })).toBe('Hi &lt;b&gt;Ada&lt;/b&gt;');
        const react = createReactI18n({ locale: 'en-US', resources: { 'en-US': { common: { hi: 'Hi {{name}}' } } } });
        expect(react.t('hi', { name: '<b>Ada</b>' })).toBe('Hi <b>Ada</b>');
    });

    it('counts ordinals', () => {
        const i18n = createI18n({
            locale: 'en-US',
            resources: {
                'en-US': {
                    common: {
                        place_ordinal_one: '{{count}}st',
                        place_ordinal_two: '{{count}}nd',
                        place_ordinal_few: '{{count}}rd',
                        place_ordinal_other: '{{count}}th',
                    },
                },
            },
        });
        expect([1, 2, 3, 4, 11, 22].map((count) => i18n.t('place', { count, ordinal: true }))).toEqual([
            '1st',
            '2nd',
            '3rd',
            '4th',
            '11th',
            '22nd',
        ]);
    });

    it('reads context and nesting', () => {
        const i18n = createI18n({
            locale: 'en-US',
            resources: {
                'en-US': {
                    common: {
                        product: 'Socio',
                        edited: 'Edited',
                        edited_socio: 'Edited by a socio',
                        about: 'About $t(common:product)',
                    },
                },
            },
        });
        expect([i18n.t('edited'), i18n.t('edited', { context: 'socio' }), i18n.t('about')]).toEqual([
            'Edited',
            'Edited by a socio',
            'About Socio',
        ]);
    });
});

describe('@socio/shared/locale follows the UI', () => {
    it('stays en-US, byte for byte, until a locale is set', () => {
        expect(activeLocale()).toBe('en-US');
        expect(formatNumber(1234567.5)).toBe('1,234,567.5');
        expect(numberFormat({ style: 'percent' }).format(0.5)).toBe('50%');
        expect(['Örn', 'Zebra', 'Äpple'].sort(compareText)).toEqual(['Äpple', 'Örn', 'Zebra']);
    });

    it('follows an instance that drives it, and a scope over it', () => {
        const i18n = createI18n({ locale: 'de-DE', drivesActiveLocale: true });
        expect(activeLocale()).toBe('de-DE');
        expect(formatNumber(1234.5)).toBe('1.234,5');
        void i18n.changeLanguage('sv-SE');
        expect(activeLocale()).toBe('sv-SE');
        expect(['Zebra', 'Äpple'].sort(compareText)).toEqual(['Zebra', 'Äpple']);
        scopeActiveLocale(() => 'en-US');
        expect(formatNumber(1234.5)).toBe('1,234.5');
        scopeActiveLocale(() => undefined);
        expect(activeLocale()).toBe('sv-SE');
    });
});
