import { describe, expect, it } from 'vitest';

import { buildStamp, DEFAULT_BUILD_NUMBER, MAX_BUILD_NUMBER } from '../build-stamp';

// SOCIO_BUILD_NUMBER, SOCIO_BUILD_COMMIT and SOCIO_BUILD_DATE as app.config.ts reads them at prebuild
// (build-stamp.ts): iOS's CFBundleVersion and Android's versionCode, and where the build came from.

describe('the build stamp', () => {
    it('is build 1 with no commit or date when unset, as a local development build is', () => {
        expect(buildStamp({})).toEqual({ buildNumber: DEFAULT_BUILD_NUMBER, commit: null, date: null });
        expect(buildStamp({ SOCIO_BUILD_NUMBER: '', SOCIO_BUILD_COMMIT: '', SOCIO_BUILD_DATE: '' })).toEqual({
            buildNumber: 1,
            commit: null,
            date: null,
        });
    });

    it('takes a positive whole number, the commit count of main, and the commit and date', () => {
        expect(
            buildStamp({ SOCIO_BUILD_NUMBER: '2829', SOCIO_BUILD_COMMIT: 'BE466EAB8', SOCIO_BUILD_DATE: '2026-11-09' }),
        ).toEqual({ buildNumber: 2829, commit: 'be466eab8', date: '2026-11-09' });
        expect(buildStamp({ SOCIO_BUILD_DATE: '2026-11-09T14:30:00Z' }).date).toBe('2026-11-09T14:30:00Z');
        expect(buildStamp({ SOCIO_BUILD_NUMBER: String(MAX_BUILD_NUMBER) }).buildNumber).toBe(2_100_000_000);
    });

    it('fails on anything that isn’t a positive whole number, so a typo fails the build', () => {
        for (const value of ['0', '-3', '12.5', '1e3', ' 12', '12 ', '0x10', '012', 'abc', '2829a']) {
            expect(() => buildStamp({ SOCIO_BUILD_NUMBER: value }), value).toThrow(
                /SOCIO_BUILD_NUMBER .* positive whole number/,
            );
        }
    });

    it('fails above Google Play’s highest versionCode', () => {
        expect(() => buildStamp({ SOCIO_BUILD_NUMBER: String(MAX_BUILD_NUMBER + 1) })).toThrow(/above 2100000000/);
        expect(() => buildStamp({ SOCIO_BUILD_NUMBER: '99999999999999999999' })).toThrow(/SOCIO_BUILD_NUMBER/);
    });

    it('fails on a commit or date it can’t read', () => {
        for (const value of ['abc', 'main', 'be466eab8!', 'g466eab8']) {
            expect(() => buildStamp({ SOCIO_BUILD_COMMIT: value }), value).toThrow(/SOCIO_BUILD_COMMIT/);
        }
        for (const value of ['yesterday', '2026-13-40', '11/09/2026', '2026-11-09 14:30']) {
            expect(() => buildStamp({ SOCIO_BUILD_DATE: value }), value).toThrow(/SOCIO_BUILD_DATE/);
        }
    });
});
