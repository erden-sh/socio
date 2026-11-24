// The variants the link domain names (src/apps.ts): the app's own bundle ids and path prefixes,
// and the placeholders the owner still has to fill in, pinned so that filling one is a reviewed
// change here too.

import { describe, expect, it } from 'vitest';

import { APP_VARIANTS, VARIANT_LINK_PATHS } from '@socio/shared/device-sign-in';

import { VARIANTS } from '../../mobile/variant';
import { APPLE_TEAM_ID, DEBUG_KEYSTORE_SHA256, LINK_APPS, PLACEHOLDER_SHA256 } from '../src/apps';

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

describe('the variants', () => {
    it("are the app's three builds, with its bundle ids and @socio/shared's path prefixes", () => {
        expect(LINK_APPS.map((app) => app.variant)).toEqual([...APP_VARIANTS]);
        for (const app of LINK_APPS) {
            expect(app.bundleId, app.variant).toBe(VARIANTS[app.variant].id);
            expect(app.scheme, app.variant).toBe(VARIANTS[app.variant].scheme);
            expect(app.prefix, app.variant).toBe(`/${VARIANT_LINK_PATHS[app.variant]}/`);
        }
        expect(new Set(LINK_APPS.map((app) => app.prefix)).size).toBe(3);
    });

    it('give Android fingerprints in the shape it reads', () => {
        for (const app of LINK_APPS) {
            expect(app.androidCertSha256.length, app.variant).toBeGreaterThan(0);
            for (const sha of app.androidCertSha256) {
                expect(sha, app.variant).toMatch(FINGERPRINT);
            }
        }
    });
});

describe('the placeholders, until the owner fills them', () => {
    const byVariant = Object.fromEntries(LINK_APPS.map((app) => [app.variant, app]));

    it('the Apple team id (Ingenio)', () => {
        expect(APPLE_TEAM_ID).toBe('6DDJ59773H');
    });

    it("the Play app signing key's and the preview keystore's SHA-256", () => {
        expect(PLACEHOLDER_SHA256).toBe(Array(32).fill('00').join(':'));
        expect(byVariant.production?.androidCertSha256).toEqual([PLACEHOLDER_SHA256]);
        expect(byVariant.preview?.androidCertSha256).toEqual([PLACEHOLDER_SHA256]);
    });

    it("development is signed with the React Native template's public debug key", () => {
        expect(byVariant.development?.androidCertSha256).toEqual([DEBUG_KEYSTORE_SHA256]);
        expect(DEBUG_KEYSTORE_SHA256).not.toBe(PLACEHOLDER_SHA256);
    });
});
