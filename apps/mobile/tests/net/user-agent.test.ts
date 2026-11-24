import { describe, expect, it } from 'vitest';

import { userAgent } from '../../src/net/user-agent';

// The app's User-Agent: which app and platform, nothing about the person or the phone.

const SHAPE = /^Socio\/\d{1,4}(?:\.\d{1,4}){0,3} \((?:iPhone|iPad|Android); (?:iOS|Android)(?: \d{1,3})?\)$/;

describe('userAgent', () => {
    it('names the app’s version, the platform and the OS’s major version', () => {
        expect(userAgent({ appVersion: '0.1.0', platform: 'ios', osVersion: '26.1' })).toBe(
            'Socio/0.1.0 (iPhone; iOS 26)',
        );
        expect(userAgent({ appVersion: '0.1.0', platform: 'ios', osVersion: '17.6.1', tablet: true })).toBe(
            'Socio/0.1.0 (iPad; iOS 17)',
        );
        expect(userAgent({ appVersion: '1.2.3', platform: 'android', osVersion: 16 })).toBe(
            'Socio/1.2.3 (Android; Android 16)',
        );
    });

    it('drops anything that isn’t a plain version number, so nothing personal can reach the header', () => {
        for (const info of [
            { appVersion: 'ada@example.test', platform: 'ios', osVersion: 'Ada’s iPhone' },
            { appVersion: '0.1.0 (Ada Lovelace)', platform: 'android', osVersion: 'u-123; Pixel 4' },
            { appVersion: '', platform: 'ios', osVersion: '' },
            { appVersion: '0.1.0\r\nCookie: x', platform: 'android', osVersion: '16\r\nX: y' },
        ] as const) {
            const header = userAgent(info);
            expect(header, JSON.stringify(info)).toMatch(SHAPE);
            expect(header).not.toMatch(/ada|lovelace|example|pixel|u-123|cookie|\r|\n/i);
        }
        expect(userAgent({ appVersion: 'ada@example.test', platform: 'ios', osVersion: 'n/a' })).toBe(
            'Socio/0.0.0 (iPhone; iOS)',
        );
    });
});
