import { expect, it } from 'vitest';

import { dayStart } from '@socio/shared/calendar';

import { monthGridOf, rangeLabel, weekOf, zoneTime } from '../../packages/client/src/plugins/calendar/time';
import {
    MIN_BLOCK_MINUTES,
    BLOCK_MINUTES,
    eventsOnDay,
    groupTimed,
    timedOnDay,
    allDayOnDay,
} from '../../packages/plugin-ui/src/calendar-model';
import type { CalendarEvent } from '../../packages/plugin-ui/src/types';

const NY = 'America/New_York';

it('names days, weeks and clocks in the calendar’s zone (CB-254)', () => {
    const time = zoneTime(NY);
    // 2026-11-01 03:30 UTC is still Oct 31 in New York (EDT, UTC-4).
    const late = Date.UTC(2026, 10, 1, 3, 30);
    expect(time.dayKey(late)).toBe('2026-10-31');
    expect(time.clock(late)).toEqual({ hour: 23, minute: 30 });
    expect(time.formatClock(late)).toBe('11:30 PM');
    expect(zoneTime('Asia/Tokyo').dayKey(late)).toBe('2026-11-01');
    // Weeks start on Monday; a month grid is six of them.
    expect(weekOf('2026-11-01')).toEqual([
        '2026-10-26',
        '2026-10-27',
        '2026-10-28',
        '2026-10-29',
        '2026-10-30',
        '2026-10-31',
        '2026-11-01',
    ]);
    const grid = monthGridOf('2026-11-15');
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe('2026-10-26');
    expect(time.sameMonth('2026-11-30', Date.UTC(2026, 10, 15, 17))).toBe(true);
    expect(rangeLabel(weekOf('2026-11-01'))).toBe('Oct 26 – Nov 1');
});

it('moves a week across the clock change at the same wall time', () => {
    const time = zoneTime(NY);
    // Friday Oct 30, 09:00 EDT; a week later is Nov 6, 09:00 EST.
    const before = Date.UTC(2026, 9, 30, 13);
    const after = time.shiftAnchor(before, 'week', 1);
    expect(after - before).toBe(7 * 86_400_000 + 3_600_000);
    expect(time.clock(after)).toEqual({ hour: 9, minute: 0 });
    expect(time.dayKey(time.shiftAnchor(before, 'month', 1))).toBe('2026-11-01');
    expect(time.dayKey(time.dayInstant('2026-11-01'))).toBe('2026-11-01');
});

it('places events with an end, all-day and multi-day events (plugin-ui)', () => {
    const time = zoneTime(NY);
    const at = (day: string, hour: number, minute = 0) => dayStart(day, NY) + (hour * 60 + minute) * 60_000;
    const events: CalendarEvent[] = [
        // A point in time, as the planner's posts are.
        { id: 'post', title: 'Post', start: at('2026-11-02', 9), color: 'red' },
        {
            id: 'meeting',
            title: 'Meeting',
            start: at('2026-11-02', 9, 30),
            end: at('2026-11-02', 12),
            color: 'blue',
        },
        {
            id: 'short',
            title: 'Short',
            start: at('2026-11-02', 13),
            end: at('2026-11-02', 13, 5),
            color: 'blue',
        },
        {
            id: 'late',
            title: 'Late',
            start: at('2026-11-02', 23),
            end: at('2026-11-03', 2),
            color: 'blue',
        },
        {
            id: 'fair',
            title: 'Fair',
            start: dayStart('2026-11-03', NY),
            end: dayStart('2026-11-06', NY),
            allDay: true,
            color: 'green',
        },
    ];
    const monday = timedOnDay(events, '2026-11-02', time);
    const span = Object.fromEntries(monday.map((item) => [item.id, item.endMin - item.startMin]));
    expect(span).toEqual({
        post: BLOCK_MINUTES,
        meeting: 150,
        short: MIN_BLOCK_MINUTES,
        late: 60, // clipped at midnight
    });
    // The meeting overlaps the post's block; the short event fits after it.
    expect(groupTimed(monday).map((group) => group.map((item) => item.id))).toEqual([
        ['post', 'short', 'late'],
        ['meeting'],
    ]);
    // All-day: its own row, on each day it covers, never on the timed grid.
    expect(timedOnDay(events, '2026-11-04', time)).toEqual([]);
    for (const day of ['2026-11-03', '2026-11-04', '2026-11-05']) {
        expect(allDayOnDay(events, day, time).map((item) => item.id)).toEqual(['fair']);
    }
    expect(allDayOnDay(events, '2026-11-06', time)).toEqual([]);
    // Month and agenda list a spanning event on each day, all-day first.
    expect(eventsOnDay(events, '2026-11-03', time).map((item) => item.id)).toEqual(['fair', 'late']);
});
