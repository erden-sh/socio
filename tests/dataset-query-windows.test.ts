import { describe, expect, it } from 'vitest';

import {
    addMonths,
    bucketEnd,
    bucketsOf,
    bucketStart,
    offsetAt,
    periodRange,
    relativeRange,
    sourceRange,
    todayIn,
    windowRange,
    zoneStart,
} from '@socio/shared/dataset-query/dates';

describe('today in the spec’s zone', () => {
    it('is the date in that zone, not in UTC', () => {
        // 01:00 UTC on December 1 is still November 30 in Los Angeles.
        const at = Date.UTC(2026, 11, 1, 1, 0);
        expect(todayIn('UTC', at)).toBe('2026-12-01');
        expect(todayIn('America/Los_Angeles', at)).toBe('2026-11-30');
        expect(todayIn('Asia/Tokyo', Date.UTC(2026, 10, 30, 16, 0))).toBe('2026-12-01');
        // A date just after midnight UTC in a western zone is the day before.
        expect(todayIn('America/New_York', Date.UTC(2026, 0, 1, 0, 30))).toBe('2025-12-31');
        expect(todayIn('Pacific/Kiritimati', Date.UTC(2025, 11, 31, 10, 30))).toBe('2026-01-01');
    });

    it('moves a window with the zone: Los Angeles is still in November', () => {
        const at = Date.UTC(2026, 11, 1, 1, 0);
        expect(windowRange('this_month', todayIn('America/Los_Angeles', at))).toEqual({
            from: '2026-11-01',
            to: '2026-11-30',
        });
        expect(windowRange('this_month', todayIn('UTC', at))).toEqual({ from: '2026-12-01', to: '2026-12-01' });
        // At 01:00 UTC on January 1, Los Angeles is still in last year.
        const newYear = Date.UTC(2027, 0, 1, 1, 0);
        expect(windowRange('ytd', todayIn('America/Los_Angeles', newYear))).toEqual({
            from: '2026-01-01',
            to: '2026-12-31',
        });
        expect(windowRange('ytd', todayIn('UTC', newYear))).toEqual({ from: '2027-01-01', to: '2027-01-01' });
    });
});

describe('windows', () => {
    it('trailing 12 months on 2026-11-20: December 1 through today, twelve months, November partial', () => {
        const today = '2026-11-20';
        const range = windowRange('trailing_12_months', today);
        expect(range).toEqual({ from: '2025-12-01', to: '2026-11-20' });
        const months = bucketsOf(range, 'month', today);
        expect(months).toHaveLength(12);
        expect(months[0]).toEqual({ start: '2025-12-01', end: '2025-12-31', partial: false });
        expect(months.at(-1)).toEqual({ start: '2026-11-01', end: '2026-11-30', partial: true });
        expect(months.filter((m) => m.partial)).toHaveLength(1);
    });

    it('still has twelve buckets on the first of a month', () => {
        for (const today of ['2026-11-01', '2026-01-01', '2026-03-01', '2024-02-29']) {
            const range = windowRange('trailing_12_months', today);
            const months = bucketsOf(range, 'month', today);
            expect(months, today).toHaveLength(12);
            expect(months.at(-1)?.start, today).toBe(bucketStart(today, 'month'));
            expect(months.at(-1)?.partial, today).toBe(true);
        }
        expect(windowRange('trailing_12_months', '2026-01-01')).toEqual({ from: '2025-02-01', to: '2026-01-01' });
    });

    it('works out year to date and the previous year at year boundaries', () => {
        expect(windowRange('ytd', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
        expect(windowRange('ytd', '2026-12-31')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
        expect(windowRange('previous_year', '2026-01-01')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
        expect(windowRange('previous_year', '2026-12-31')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
        expect(windowRange('previous_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
        expect(windowRange('previous_month', '2024-03-31')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
        expect(windowRange('this_month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-10' });
        expect(windowRange({ last_n: { count: 30, unit: 'day' } }, '2026-11-20')).toEqual({
            from: '2026-10-22',
            to: '2026-11-20',
        });
        expect(windowRange({ last_n: { count: 1, unit: 'year' } }, '2026-11-20')).toEqual({
            from: '2025-11-21',
            to: '2026-11-20',
        });
        expect(windowRange({ between: ['2026-01-01', '2026-03-31'] }, '2026-11-20')).toEqual({
            from: '2026-01-01',
            to: '2026-03-31',
        });
    });

    it('resolves relative dates and periods, today included', () => {
        expect(relativeRange('past', 7, 'day', '2026-11-20')).toEqual({ from: '2026-11-14', to: '2026-11-20' });
        expect(relativeRange('next', 30, 'day', '2026-11-20')).toEqual({ from: '2026-11-20', to: '2026-12-19' });
        expect(relativeRange('past', 1, 'day', '2026-11-20')).toEqual({ from: '2026-11-20', to: '2026-11-20' });
        expect(relativeRange('next', 2, 'week', '2026-12-25')).toEqual({ from: '2026-12-25', to: '2027-01-07' });
        // Weeks start on Monday; 2026-11-22 is a Sunday.
        expect(periodRange('this_week', '2026-11-22')).toEqual({ from: '2026-11-16', to: '2026-11-22' });
        expect(periodRange('next_week', '2026-12-29')).toEqual({ from: '2027-01-04', to: '2027-01-10' });
        expect(periodRange('previous_quarter', '2026-01-15')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
        expect(periodRange('this_quarter', '2026-11-20')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
        expect(periodRange('next_year', '2026-11-20')).toEqual({ from: '2027-01-01', to: '2027-12-31' });
        expect(periodRange('previous_month', '2026-03-31')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
        expect(periodRange('this_month', '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    });

    it('keeps month arithmetic on the month’s last day', () => {
        expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
        expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
        expect(addMonths('2026-03-31', -13)).toBe('2025-02-28');
        expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    });
});

describe('buckets', () => {
    it('starts and ends each bucket on calendar days, weeks on Monday', () => {
        expect(bucketStart('2026-11-20', 'week')).toBe('2026-11-16');
        expect(bucketEnd('2026-11-20', 'week')).toBe('2026-11-22');
        expect(bucketStart('2027-01-01', 'week')).toBe('2026-12-28');
        expect(bucketStart('2026-11-20', 'quarter')).toBe('2026-10-01');
        expect(bucketEnd('2024-02-10', 'month')).toBe('2024-02-29');
        expect(bucketEnd('2026-05-05', 'year')).toBe('2026-12-31');
    });

    it('fills every bucket of a range, across a year end, and marks the one with today', () => {
        const weeks = bucketsOf({ from: '2026-12-20', to: '2027-01-06' }, 'week', '2027-01-02');
        expect(weeks.map((w) => w.start)).toEqual(['2026-12-14', '2026-12-21', '2026-12-28', '2027-01-04']);
        expect(weeks.map((w) => w.partial)).toEqual([false, false, true, false]);
        expect(() => bucketsOf({ from: '2000-01-01', to: '2026-01-01' }, 'day', '2026-01-01', 1_000)).toThrow(
            RangeError,
        );
    });
});

describe('the source range', () => {
    it('reads all history for a running value from "all", even with a January window', () => {
        // 100 in December and 10 in January: the January bucket must start from 100.
        const window = { between: ['2026-01-01', '2026-01-31'] as [string, string] };
        expect(sourceRange({ window, running: ['all'], today: '2026-11-20' })).toEqual({
            from: null,
            to: '2026-01-31',
        });
        expect(sourceRange({ window, running: [undefined], today: '2026-11-20' })).toEqual({
            from: null,
            to: '2026-01-31',
        });
        expect(sourceRange({ window, running: ['2025-06-01'], today: '2026-11-20' })).toEqual({
            from: '2025-06-01',
            to: '2026-01-31',
        });
        expect(sourceRange({ window, running: ['window'], today: '2026-11-20' })).toEqual({
            from: '2026-01-01',
            to: '2026-01-31',
        });
        // A date inside the window doesn't narrow it.
        expect(sourceRange({ window, running: ['2026-01-15'], today: '2026-11-20' })).toEqual({
            from: '2026-01-01',
            to: '2026-01-31',
        });
    });

    it('widens to every comparison window, and reads everything without a window', () => {
        expect(sourceRange({ windows: ['ytd', 'previous_year'], today: '2026-11-20' })).toEqual({
            from: '2025-01-01',
            to: '2026-11-20',
        });
        expect(sourceRange({ window: 'this_month', windows: ['previous_month'], today: '2026-11-20' })).toEqual({
            from: '2026-10-01',
            to: '2026-11-20',
        });
        expect(sourceRange({ today: '2026-11-20' })).toEqual({ from: null, to: null });
    });
});

describe('a date’s first instant in a zone', () => {
    it('is local midnight, with each side of a clock change', () => {
        expect(zoneStart('2026-11-20', 'UTC')).toBe(Date.UTC(2026, 10, 20));
        expect(zoneStart('2026-11-20', 'America/New_York')).toBe(Date.UTC(2026, 10, 20, 5));
        expect(zoneStart('2026-07-01', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 4));
        // The days clocks change in New York (02:00 local), and in Kolkata (no DST, +05:30).
        expect(zoneStart('2026-03-08', 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 5));
        expect(zoneStart('2026-11-01', 'America/New_York')).toBe(Date.UTC(2026, 10, 1, 4));
        expect(zoneStart('2026-11-20', 'Asia/Kolkata')).toBe(Date.UTC(2026, 10, 19, 18, 30));
        expect(offsetAt(Date.UTC(2026, 10, 20, 12), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
    });

    it('is the first instant of the date, even where a clock change skips midnight', () => {
        const cases: Array<[string, string]> = [
            // Havana and Santiago move their clocks forward at midnight.
            ['America/Havana', '2026-03-08'],
            ['America/Santiago', '2026-09-06'],
            ['America/Santiago', '2026-04-05'],
            ['Europe/London', '2026-03-29'],
            ['Australia/Lord_Howe', '2026-10-04'],
            ['Pacific/Apia', '2026-01-01'],
            ['America/Los_Angeles', '2026-12-31'],
        ];
        for (const [zone, date] of cases) {
            const start = zoneStart(date, zone);
            expect(todayIn(zone, start), `${zone} ${date}`).toBe(date);
            expect(todayIn(zone, start - 1) < date, `${zone} ${date}`).toBe(true);
        }
    });
});
