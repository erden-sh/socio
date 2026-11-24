import { expect, it } from 'vitest';

import {
    CadenceError,
    cadenceInWords,
    instantOf,
    nextRun,
    parseCadence,
    shortestGap,
    validTimeZone,
    wallClock,
} from '../src/server/schedules/cadence.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
/** The next `n` runs after `from`, for a schedule created at `from`. */
function runs(text: string, zone: string, from: number, n = 3) {
    const cadence = parseCadence(text);
    const out: Array<string | null> = [];
    let t = from;
    for (let i = 0; i < n; i++) {
        const next = nextRun(cadence, zone, t, from);
        out.push(iso(next));
        if (next === null) {
            break;
        }
        t = next;
    }
    return out;
}

it('parses phrases and cron, and normalises them', () => {
    expect(parseCadence('Every Day at 9am').text).toBe('every day at 09:00');
    expect(parseCadence('daily at 9:30 pm').text).toBe('every day at 21:30');
    expect(parseCadence('hourly').text).toBe('every hour');
    expect(parseCadence('every 2 hours at :30').text).toBe('every 2 hours at :30');
    expect(parseCadence('every monday at 8:30').text).toBe('every week on monday at 08:30');
    expect(parseCadence('every 2 weeks on fri at 17:00').text).toBe('every 2 weeks on friday at 17:00');
    expect(parseCadence('every 15 minutes')).toMatchObject({
        kind: 'interval',
        everyMs: 15 * MINUTE,
    });
    expect(parseCadence('0 9 * * mon-fri')).toMatchObject({ kind: 'cron' });
    expect(parseCadence('@weekly')).toMatchObject({ kind: 'cron' });
    for (const bad of [
        '',
        'sometimes',
        'every 0 days',
        'every day at 25:00',
        'every 5 minutes at 09:00',
        'every day on monday',
        '61 * * * *',
        '* * * *',
        '*/0 * * * *',
    ]) {
        expect(() => parseCadence(bad), bad).toThrow(CadenceError);
    }
    expect(validTimeZone('Europe/Paris')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
});

it('computes runs from the anchor: durations for minutes and hours, the wall clock for days', () => {
    const created = Date.UTC(2026, 5, 1, 10, 7, 30); // Mon 1 June 2026, 10:07:30 UTC
    expect(runs('every 6 hours', 'UTC', created)).toEqual([
        '2026-06-01T16:07:30.000Z',
        '2026-06-01T22:07:30.000Z',
        '2026-06-02T04:07:30.000Z',
    ]);
    expect(runs('every 2 hours at :30', 'UTC', created)).toEqual([
        '2026-06-01T10:30:00.000Z',
        '2026-06-01T12:30:00.000Z',
        '2026-06-01T14:30:00.000Z',
    ]);
    expect(runs('every day at 09:00', 'Europe/Paris', created)).toEqual([
        '2026-06-02T07:00:00.000Z',
        '2026-06-03T07:00:00.000Z',
        '2026-06-04T07:00:00.000Z',
    ]);
    expect(runs('every 3 days at 7pm', 'UTC', created)).toEqual([
        '2026-06-01T19:00:00.000Z',
        '2026-06-04T19:00:00.000Z',
        '2026-06-07T19:00:00.000Z',
    ]);
    expect(runs('every friday at 17:00', 'America/New_York', created, 2)).toEqual([
        '2026-06-05T21:00:00.000Z',
        '2026-06-12T21:00:00.000Z',
    ]);
    expect(runs('*/20 9-10 * * 1-5', 'UTC', created, 4)).toEqual([
        '2026-06-01T10:20:00.000Z',
        '2026-06-01T10:40:00.000Z',
        '2026-06-02T09:00:00.000Z',
        '2026-06-02T09:20:00.000Z',
    ]);
    // Both day fields restricted: either matches (the 15th, or a Sunday).
    expect(runs('0 0 15 * 0', 'UTC', created, 3)).toEqual([
        '2026-06-07T00:00:00.000Z',
        '2026-06-14T00:00:00.000Z',
        '2026-06-15T00:00:00.000Z',
    ]);
    // A day that never comes.
    expect(runs('0 0 30 2 *', 'UTC', created, 1)).toEqual([null]);
    // Later runs never depend on when they are computed, only on the anchor.
    const cadence = parseCadence('every 6 hours');
    expect(nextRun(cadence, 'UTC', Date.UTC(2026, 5, 3, 1), created)).toBe(Date.UTC(2026, 5, 3, 4, 7, 30));
});

it('keeps wall-clock times across DST: skipped times shift forward, repeated ones run once', () => {
    const zone = 'America/New_York';
    // Spring forward on 8 March 2026: 02:00–03:00 doesn't exist.
    const spring = Date.UTC(2026, 2, 7, 12); // 07:00 EST
    expect(runs('every day at 02:30', zone, spring)).toEqual([
        '2026-03-08T07:30:00.000Z', // 03:30 EDT, after the gap
        '2026-03-09T06:30:00.000Z', // 02:30 EDT
        '2026-03-10T06:30:00.000Z',
    ]);
    expect(runs('30 2 * * *', zone, spring)).toEqual(runs('every day at 02:30', zone, spring));
    expect(runs('every day at 09:00', zone, spring)).toEqual([
        '2026-03-07T14:00:00.000Z', // 09:00 EST
        '2026-03-08T13:00:00.000Z', // 09:00 EDT
        '2026-03-09T13:00:00.000Z',
    ]);
    // Fall back on 1 November 2026: 01:00–02:00 happens twice.
    const fall = Date.UTC(2026, 10, 1, 4); // 00:00 EDT
    expect(runs('30 1 * * *', zone, fall, 2)).toEqual([
        '2026-11-01T05:30:00.000Z', // the first 01:30 (EDT)
        '2026-11-02T06:30:00.000Z', // the next day, EST
    ]);
    expect(runs('0 * * * *', zone, fall, 3)).toEqual([
        '2026-11-01T05:00:00.000Z', // 01:00 EDT
        '2026-11-01T07:00:00.000Z', // 02:00 EST (01:00 EST is not repeated)
        '2026-11-01T08:00:00.000Z',
    ]);
    // Durations are durations: "every 6 hours" ignores the clock change.
    const sixes = runs('every 6 hours', zone, spring, 4).map((t) => Date.parse(t!));
    expect(sixes[1] - sixes[0]).toBe(6 * HOUR);
    expect(sixes[2] - sixes[1]).toBe(6 * HOUR);
    // Instants round-trip through the zone's wall clock.
    const at = instantOf(zone, {
        year: 2026,
        month: 7,
        day: 4,
        hour: 12,
        minute: 0,
    });
    expect(iso(at)).toBe('2026-07-04T16:00:00.000Z');
    expect(wallClock(zone, at)).toMatchObject({ hour: 12, minute: 0 });
});

it('measures the shortest gap between runs', () => {
    const from = Date.UTC(2026, 5, 1);
    expect(shortestGap(parseCadence('every 15 minutes'), 'UTC', from)).toBe(15 * MINUTE);
    expect(shortestGap(parseCadence('*/5 * * * *'), 'UTC', from)).toBe(5 * MINUTE);
    expect(shortestGap(parseCadence('0,10 9 * * *'), 'UTC', from)).toBe(10 * MINUTE);
    expect(shortestGap(parseCadence('every day at 09:00'), 'Europe/Paris', from)).toBeGreaterThanOrEqual(23 * HOUR);
});

it('says a cadence in words, crons included where they are common (CB-88)', () => {
    const words = (text: string) => cadenceInWords(text);
    expect(words('every day at 09:00')).toBe('Every day at 09:00');
    expect(words('every 2 weeks on friday at 17:00')).toBe('Every 2 weeks on Friday at 17:00');
    expect(words('0 9 * * 1-5')).toBe('Every weekday at 09:00');
    expect(words('0 9 * * mon,thu')).toBe('Every Monday and Thursday at 09:00');
    expect(words('0 8,17 * * *')).toBe('Every day at 08:00 and 17:00');
    expect(words('*/15 * * * *')).toBe('Every 15 minutes');
    expect(words('*/30 * * * 1-5')).toBe('Every 30 minutes on weekdays');
    expect(words('30 * * * *')).toBe('Every hour at :30');
    expect(words('@monthly')).toBe('On day 1 of the month at 00:00');
    expect(words('0 9 * 1,7 *')).toBe('Every day at 09:00 in January and July');
    // Anything else stays as written.
    expect(words('*/15 9-17 * * 1-5')).toBe('Cron: */15 9-17 * * 1-5');
});
