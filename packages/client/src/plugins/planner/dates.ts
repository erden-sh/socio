import type { CalendarTime } from '@socio/plugin-ui';
import { formatZonedLocal, parseZonedLocal, zonedParts, type PostStatus } from '@socio/shared/planner';

import type { PlannedPost } from './types';

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in America/New_York. */
export function dayKey(utc: number) {
    const wall = zonedParts(utc);
    return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}

function keyToUtcNoon(key: string) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(Date.UTC(year!, (month ?? 1) - 1, day, 12));
}

/** Move an instant by calendar days, keeping its New York time of day. */
export function addDays(utc: number, days: number) {
    const wall = zonedParts(utc);
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
    const local = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(wall.hour)}:${pad(wall.minute)}`;
    return parseZonedLocal(local) ?? utc;
}

export function onDay(utc: number, key: string) {
    const wall = zonedParts(utc);
    const local = `${key}T${pad(wall.hour)}:${pad(wall.minute)}`;
    return parseZonedLocal(local) ?? utc;
}

export function clock(utc: number) {
    const wall = zonedParts(utc);
    return { hour: wall.hour, minute: wall.minute };
}

/** `9:30 AM` in America/New_York. */
export function formatClock(utc: number) {
    const { hour, minute } = clock(utc);
    const hour12 = hour % 12 || 12;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return `${hour12}:${pad(minute)} ${suffix}`;
}

export function hourLabel(hour: number) {
    if (hour === 0) {
        return '12 AM';
    }
    if (hour === 12) {
        return '12 PM';
    }
    return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** A New York wall time on a `YYYY-MM-DD` key, as UTC milliseconds. */
export function placeOn(key: string, hour: number, minute: number) {
    return parseZonedLocal(`${key}T${pad(hour)}:${pad(minute)}`);
}

export function localStamp(key: string, hour: number, minute: number) {
    return `${key}T${pad(hour)}:${pad(minute)}`;
}

export function dayNumber(key: string) {
    return Number(key.slice(8, 10));
}

export function sameMonth(key: string, anchor: number) {
    const wall = zonedParts(anchor);
    return key.startsWith(`${wall.year}-${pad(wall.month)}`);
}

export function weekKeys(anchor: number) {
    const wall = zonedParts(anchor);
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
    const weekday = date.getUTCDay();
    const monday = weekday === 0 ? 6 : weekday - 1;
    date.setUTCDate(date.getUTCDate() - monday);
    return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(date);
        day.setUTCDate(date.getUTCDate() + index);
        return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    });
}

export function monthKeys(anchor: number) {
    const wall = zonedParts(anchor);
    const first = new Date(Date.UTC(wall.year, wall.month - 1, 1));
    const back = (first.getUTCDay() + 6) % 7;
    first.setUTCDate(1 - back);
    return Array.from({ length: 42 }, (_, index) => {
        const day = new Date(first);
        day.setUTCDate(first.getUTCDate() + index);
        return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
    });
}

export function shiftAnchor(anchor: number, view: 'week' | 'month', direction: -1 | 1) {
    if (view === 'week') {
        return addDays(anchor, 7 * direction);
    }
    const wall = zonedParts(anchor);
    const date = new Date(Date.UTC(wall.year, wall.month - 1 + direction, 1, wall.hour, wall.minute));
    const local = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(wall.hour)}:${pad(wall.minute)}`;
    return parseZonedLocal(local) ?? anchor;
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

export function formatDayKey(key: string) {
    return dayLabel.format(keyToUtcNoon(key));
}

export function formatWeekday(key: string) {
    return weekdayLabel.format(keyToUtcNoon(key));
}

export function rangeLabel(keys: string[]) {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (!first || !last) {
        return '';
    }
    if (first === last) {
        return formatDayKey(first);
    }
    return `${formatDayKey(first)} – ${formatDayKey(last)}`;
}

export function monthTitle(anchor: number) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'long',
        year: 'numeric',
    }).format(new Date(anchor));
}

export function defaultLocal(anchor: number) {
    const wall = zonedParts(anchor);
    return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T09:30`;
}

export const ACCOUNT_COLOR: Record<string, string> = {
    acme: 'var(--chart-1)',
    example_co: 'var(--chart-2)',
};

export function accountColor(account: string) {
    return ACCOUNT_COLOR[account] ?? 'var(--chart-5)';
}

export const STATUS_COLOR: Record<PostStatus, string> = {
    idea: 'var(--muted-foreground)',
    draft: 'var(--chart-5)',
    ready: 'var(--chart-1)',
    'scheduled-for-manual-posting': 'var(--chart-2)',
    posted: 'var(--chart-4)',
    skipped: 'var(--destructive)',
};

function formatSlot(hour: number, minute: number) {
    const hour12 = hour % 12 || 12;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return `${hour12}:${pad(minute)} ${suffix}`;
}

function dayInstant(key: string) {
    const [year, month, day] = key.split('-').map(Number);
    return Date.UTC(year!, (month ?? 1) - 1, day, 16);
}

/** New York calendar labels for `@socio/plugin-ui`. */
export const plannerTime: CalendarTime = {
    dayKey,
    weekKeys,
    monthKeys,
    shiftAnchor,
    clock,
    formatWeekday,
    formatDayKey,
    dayNumber,
    sameMonth,
    monthTitle,
    hourLabel,
    formatClock,
    formatSlot,
    dayInstant,
};

export function matchesPost(post: PlannedPost, filter: { account: string; status: string; topic: string }) {
    if (filter.account !== 'all' && post.account !== filter.account) {
        return false;
    }
    if (filter.status !== 'all' && post.status !== filter.status) {
        return false;
    }
    const topic = filter.topic.trim().toLowerCase();
    if (topic && !post.topic.toLowerCase().includes(topic)) {
        return false;
    }
    return true;
}

export { formatZonedLocal };
