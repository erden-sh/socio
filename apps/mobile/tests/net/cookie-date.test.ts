import { describe, expect, it } from 'vitest';

import { parseCookieDate } from '../../src/net/cookie-date';

// RFC 6265's cookie-date algorithm (5.1.1), which reads Expires and the Date header.

const NOV_5 = Date.UTC(2026, 10, 5, 9, 30, 15);

describe('parseCookieDate', () => {
    it('reads the three HTTP date forms', () => {
        expect(parseCookieDate('Thu, 05 Nov 2026 09:30:15 GMT')).toBe(NOV_5);
        expect(parseCookieDate('Thursday, 05-Nov-26 09:30:15 GMT')).toBe(NOV_5);
        expect(parseCookieDate('Thu Nov  5 09:30:15 2026')).toBe(NOV_5);
    });

    it('reads what browsers accept besides: any case, dashes, extra tokens, one-digit fields', () => {
        expect(parseCookieDate('thu, 05-NOV-2026 09:30:15 gmt')).toBe(NOV_5);
        expect(parseCookieDate('Thu, 5 November 2026 9:30:15 GMT+0000')).toBe(NOV_5);
        expect(parseCookieDate('2026 Nov 05 09:30:15')).toBe(NOV_5);
    });

    it('maps two-digit years as the RFC does: 70 to 99 in the 1900s, 0 to 69 in the 2000s', () => {
        expect(parseCookieDate('Thu, 01-Jan-70 00:00:00 GMT')).toBe(0);
        expect(parseCookieDate('Sat, 01-Jan-69 00:00:00 GMT')).toBe(Date.UTC(2069, 0, 1));
    });

    it('names no instant for a missing or impossible field', () => {
        for (const text of [
            '',
            'tomorrow',
            'Thu, 05 Nov 2026 GMT',
            'Thu, 05 2026 09:30:15 GMT',
            'Thu, 31 Feb 2026 09:30:15 GMT',
            'Thu, 05 Nov 2026 24:00:00 GMT',
            'Thu, 05 Nov 2026 09:60:00 GMT',
            'Thu, 32 Nov 2026 09:30:15 GMT',
            'Thu, 05 Nov 1600 09:30:15 GMT',
        ]) {
            expect(parseCookieDate(text), text).toBeNull();
        }
    });
});
