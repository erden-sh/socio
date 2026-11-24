import { describe, expect, it } from 'vitest';

import { apnsEnvironment, apsEnvironment, defaultApsEnvironment } from '../aps-environment';
import { VARIANTS, type VariantName } from '../variant';

// The APNs environment: SOCIO_APS_ENVIRONMENT at prebuild, the variant's when unset, and the
// relay registration's apnsEnv from what the build embedded.

const variants = Object.keys(VARIANTS) as VariantName[];

describe('SOCIO_APS_ENVIRONMENT', () => {
    it("unset or empty, is the variant's: development for development, production for the others", () => {
        expect(apsEnvironment(undefined, 'development')).toBe('development');
        expect(apsEnvironment(undefined, 'preview')).toBe('production');
        expect(apsEnvironment(undefined, 'production')).toBe('production');
        expect(apsEnvironment('', 'preview')).toBe('production');
        for (const variant of variants) {
            expect(apsEnvironment(undefined, variant)).toBe(defaultApsEnvironment(variant));
        }
    });

    it.each(variants)('%s: takes development and production over its default', (variant) => {
        expect(apsEnvironment('development', variant)).toBe('development');
        expect(apsEnvironment('production', variant)).toBe('production');
    });

    it('fails on any other value', () => {
        for (const bad of ['sandbox', 'Development', 'prod', ' production', 'development ', 'true']) {
            expect(() => apsEnvironment(bad, 'preview'), bad).toThrow(/SOCIO_APS_ENVIRONMENT "/);
        }
    });
});

describe("the relay registration's apnsEnv", () => {
    it.each(variants)('%s: sandbox for an embedded development, production for production', (variant) => {
        expect(apnsEnvironment('development', variant)).toBe('sandbox');
        expect(apnsEnvironment('production', variant)).toBe('production');
    });

    it("falls back to the variant's when the extra is missing or unknown", () => {
        for (const embedded of [undefined, null, '', 'sandbox', 42, {}]) {
            expect(apnsEnvironment(embedded, 'development')).toBe('sandbox');
            expect(apnsEnvironment(embedded, 'preview')).toBe('production');
            expect(apnsEnvironment(embedded, 'production')).toBe('production');
        }
    });
});
