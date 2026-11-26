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

    it("the production app's Play app signing key SHA-256", () => {
        expect(PLACEHOLDER_SHA256).toBe(Array(32).fill('00').join(':'));
        expect(byVariant.production?.androidCertSha256).toEqual([PLACEHOLDER_SHA256]);
    });

    it('Socio Preview names its Play app signing keys, and neither the debug key nor a placeholder', () => {
        expect(byVariant.preview?.androidCertSha256).toEqual([
            'B8:9E:1A:3A:97:22:F9:23:CE:9C:17:B5:BF:8C:FE:2F:72:A9:D7:EA:C0:89:C0:81:95:DB:8A:15:6A:3F:92:83',
            'DD:05:AB:DF:E1:01:21:E2:94:70:CD:84:02:1D:E5:1C:E4:DF:F7:15:43:D2:F4:81:57:C7:ED:F3:FD:47:D5:E8',
            '44:5C:18:03:69:6D:A6:DC:AD:34:62:64:5A:99:78:4E:91:18:DB:15:84:9C:17:5D:CD:A0:FF:C5:5E:50:E3:C4',
        ]);
        expect(byVariant.preview?.androidCertSha256).not.toContain(DEBUG_KEYSTORE_SHA256);
        expect(byVariant.preview?.androidCertSha256).not.toContain(PLACEHOLDER_SHA256);
    });

    it("development is signed with the React Native template's public debug key", () => {
        expect(byVariant.development?.androidCertSha256).toEqual([DEBUG_KEYSTORE_SHA256]);
        expect(DEBUG_KEYSTORE_SHA256).not.toBe(PLACEHOLDER_SHA256);
    });
});
