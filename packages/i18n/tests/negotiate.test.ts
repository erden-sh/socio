import { describe, expect, it } from 'vitest';

import { negotiateLocale, normalizeTag, parseAcceptLanguage, resolveRequestLocale } from '../src/negotiate.js';
import { fallbackLanguages, resolutionChain } from '../src/registry.js';

const SUPPORTED = ['en-US', 'es-419', 'es-US', 'pt-BR'];

describe('negotiateLocale', () => {
    it.each([
        [['es-US'], 'es-US'],
        [['es-us'], 'es-US'],
        [['es_MX'], 'es-419'],
        [['es-AR'], 'es-419'],
        [['es'], 'es-419'],
        [['es-ES'], 'es-419'],
        [['pt'], 'pt-BR'],
        [['pt-PT'], 'pt-BR'],
        [['en-GB'], 'en-US'],
        [['fr-FR', 'es-MX'], 'es-419'],
        [['fr-FR', 'de'], 'en-US'],
        [['en-GB', 'es-MX'], 'en-US'],
        [[], 'en-US'],
        [['not a tag', '*'], 'en-US'],
    ])('%j → %s', (requested, expected) => {
        expect(negotiateLocale(requested, SUPPORTED)).toBe(expected);
    });

    it('falls back through es-419 when es-US is all there is of Spanish, and to en-US without it', () => {
        expect(negotiateLocale(['es-MX'], ['en-US', 'es-US'])).toBe('es-US');
        expect(negotiateLocale(['es-MX'], ['en-US'])).toBe('en-US');
    });

    it('normalizes tags', () => {
        expect(normalizeTag('ZH_hant_tw')).toBe('zh-Hant-TW');
        expect(normalizeTag('es-419')).toBe('es-419');
        expect(normalizeTag('')).toBeNull();
        expect(normalizeTag('e')).toBeNull();
    });
});

describe('Accept-Language', () => {
    it('orders by weight, keeps ties in order, drops q=0 and *', () => {
        expect(parseAcceptLanguage('fr;q=0.5, es-MX, en;q=0.8, de;q=0, *;q=0.1')).toEqual(['es-MX', 'en', 'fr']);
        expect(parseAcceptLanguage(undefined)).toEqual([]);
    });
});

describe('resolveRequestLocale', () => {
    const available = ['en-US', 'es-419', 'es-US'];
    it('takes the preference, then the cookie, then Accept-Language, then en-US', () => {
        expect(resolveRequestLocale({ preference: 'es-US', cookie: 'es-419', acceptLanguage: 'en' }, available)).toBe(
            'es-US',
        );
        expect(resolveRequestLocale({ preference: null, cookie: 'es-419', acceptLanguage: 'en' }, available)).toBe(
            'es-419',
        );
        expect(resolveRequestLocale({ acceptLanguage: 'es-MX,en;q=0.5' }, available)).toBe('es-419');
        expect(resolveRequestLocale({}, available)).toBe('en-US');
    });

    it('ignores a preference or cookie outside the eligible set, or that is not registered', () => {
        expect(resolveRequestLocale({ preference: 'pt-BR', acceptLanguage: 'es' }, available)).toBe('es-419');
        expect(resolveRequestLocale({ cookie: 'xx-YY<script>' }, available)).toBe('en-US');
        // pt-BR under the gate: a Portuguese browser gets en-US.
        expect(resolveRequestLocale({ acceptLanguage: 'pt-BR,pt;q=0.9' }, available)).toBe('en-US');
    });

    it('takes the pseudo-locale only when named explicitly', () => {
        const explicit = [...available, 'en-XA'];
        expect(resolveRequestLocale({ cookie: 'en-XA' }, available, explicit)).toBe('en-XA');
        expect(resolveRequestLocale({ acceptLanguage: 'en-XA' }, available, explicit)).toBe('en-US');
    });
});

describe('the registry', () => {
    it('chains es-US through es-419 to en-US, skipping the unregistered es', () => {
        expect(resolutionChain('es-US')).toEqual(['es-US', 'es-419', 'en-US']);
        expect(resolutionChain('pt-BR')).toEqual(['pt-BR', 'en-US']);
        expect(resolutionChain('fr')).toEqual(['en-US']);
        expect(fallbackLanguages()).toMatchObject({ 'es-US': ['es-419', 'en-US'], default: ['en-US'] });
    });
});
