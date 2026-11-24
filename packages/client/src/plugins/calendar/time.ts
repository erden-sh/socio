import type { CalendarTime } from '@socio/plugin-ui';
import { addDaysToKey, dayKeyIn, dayStart, wallClock, zonedInstant } from '@socio/shared/calendar';

const pad = (value: number) => String(value).padStart(2, '0');

/** Noon UTC on a day key: a safe instant to name that date in UTC. */
function keyNoon(key: string) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year!, (month ?? 1) - 1, day, 12));
}

const dayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
});
const weekdayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
});
const longDayLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
});

function clockLabel(hour: number, minute: number) {
    const hour12 = hour % 12 || 12;
    return `${hour12}:${pad(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** The Monday-first week of seven day keys that holds `key`. */
export function weekOf(key: string) {
    const weekday = (keyNoon(key).getUTCDay() + 6) % 7;
    const monday = addDaysToKey(key, -weekday);
    return Array.from({ length: 7 }, (_, index) => addDaysToKey(monday, index));
}

/** Six Monday-first weeks that cover the month of `key`. */
export function monthGridOf(key: string) {
    const first = `${key.slice(0, 7)}-01`;
    const back = (keyNoon(first).getUTCDay() + 6) % 7;
    const start = addDaysToKey(first, -back);
    return Array.from({ length: 42 }, (_, index) => addDaysToKey(start, index));
}

/** `Nov 1 – Nov 7`, or one day. */
export function rangeLabel(keys: readonly string[]) {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || !last) {
        return '';
    }
    const label = (key: string) => dayLabel.format(keyNoon(key));
    return first === last ? label(first) : `${label(first)} – ${label(last)}`;
}

/** `Saturday, November 1, 2026`. */
export function longDay(key: string) {
    return longDayLabel.format(keyNoon(key));
}

/**
 * Labels and day math for `@socio/plugin-ui` in one IANA zone: the
 * calendar's, so everyone reads an event at the hour it is in that place.
 */
export function zoneTime(timeZone: string): CalendarTime {
    const dayKey = (utc: number) => dayKeyIn(utc, timeZone);
    const clock = (utc: number) => {
        const wall = wallClock(utc, timeZone);
        return { hour: wall.hour, minute: wall.minute };
    };
    const shiftAnchor = (anchor: number, unit: 'week' | 'month', delta: -1 | 1) => {
        const wall = wallClock(anchor, timeZone);
        if (unit === 'week') {
            return zonedInstant(wall.year, wall.month, wall.day + 7 * delta, wall.hour, wall.minute, timeZone);
        }
        return zonedInstant(wall.year, wall.month + delta, 1, wall.hour, wall.minute, timeZone);
    };
    return {
        dayKey,
        weekKeys: (anchor) => weekOf(dayKey(anchor)),
        monthKeys: (anchor) => monthGridOf(dayKey(anchor)),
        shiftAnchor,
        clock,
        formatWeekday: (key) => weekdayLabel.format(keyNoon(key)),
        formatDayKey: (key) => dayLabel.format(keyNoon(key)),
        dayNumber: (key) => Number(key.slice(8, 10)),
        sameMonth: (key, anchor) => key.slice(0, 7) === dayKey(anchor).slice(0, 7),
        monthTitle: (anchor) =>
            new Intl.DateTimeFormat('en-US', {
                timeZone,
                month: 'long',
                year: 'numeric',
            }).format(new Date(anchor)),
        hourLabel: (hour) =>
            hour === 0 ? '12 AM' : hour === 12 ? '12 PM' : hour < 12 ? `${hour} AM` : `${hour - 12} PM`,
        formatClock: (utc) => {
            const { hour, minute } = clock(utc);
            return clockLabel(hour, minute);
        },
        formatSlot: clockLabel,
        // Noon in the zone: the anchor the mini month moves to stays on that day.
        dayInstant: (key) => dayStart(key, timeZone) + 12 * 3_600_000,
    };
}

/** `YYYY-MM-DDTHH:mm` for a day key and a wall-clock time. */
export function localStamp(key: string, hour: number, minute: number) {
    return `${key}T${pad(hour)}:${pad(minute)}`;
}
