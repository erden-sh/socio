import { describe, expect, it } from 'vitest';

import { appVariant } from '../variant';

describe('the app variant', () => {
    it.each([
        ['development', 'Socio Dev', 'com.ingenioventures.socio.dev', 'socio-dev'],
        ['preview', 'Socio Preview', 'com.ingenioventures.socio.preview', 'socio-preview'],
        ['production', 'Socio', 'com.ingenioventures.socio', 'socio'],
    ])('names %s', (variant, name, id, scheme) => {
        expect(appVariant(variant)).toEqual({ variant, name, id, scheme });
    });

    it('is development when unset', () => {
        expect(appVariant(undefined).variant).toBe('development');
        expect(appVariant('').variant).toBe('development');
    });

    it('fails on anything else, so a typo fails the build', () => {
        for (const value of ['prod', 'Production', 'staging', ' preview', 'toString', '__proto__']) {
            expect(() => appVariant(value), value).toThrow(/Unknown APP_VARIANT/);
        }
    });

    it('gives each variant its own id and scheme, so all three install side by side', () => {
        const all = ['development', 'preview', 'production'].map((name) => appVariant(name));
        expect(new Set(all.map((variant) => variant.id)).size).toBe(3);
        expect(new Set(all.map((variant) => variant.scheme)).size).toBe(3);
        expect(new Set(all.map((variant) => variant.name)).size).toBe(3);
    });
});
