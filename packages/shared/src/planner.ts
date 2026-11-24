/** The social planner's own words. Stored times are UTC epoch milliseconds. */

export const POST_STATUSES = ['idea', 'draft', 'ready', 'scheduled-for-manual-posting', 'posted', 'skipped'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const REPLY_STATUSES = ['todo', 'replied', 'skip'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

/** Suggested accounts, stored without @. The field also accepts any other handle. */
export const SUGGESTED_ACCOUNTS = ['acme', 'example_co'] as const;

export const PLANNER_ZONE = 'America/New_York';

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
    idea: 'Idea',
    draft: 'Draft',
    ready: 'Ready',
    'scheduled-for-manual-posting': 'Scheduled for manual posting',
    posted: 'Posted',
    skipped: 'Skipped',
};

export const REPLY_STATUS_LABEL: Record<ReplyStatus, string> = {
    todo: 'To do',
    replied: 'Replied',
    skip: 'Skip',
};

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Wall-clock parts of an instant in the planner's zone. */
export function zonedParts(utcMs: number, zone = PLANNER_ZONE) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour'),
        minute: get('minute'),
    };
}

/** How far ahead of UTC the zone's wall clock is at this instant. */
function zoneOffset(utcMs: number, zone: string) {
    const wall = zonedParts(utcMs, zone);
    const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
    return asUtc - utcMs;
}

/**
 * A `datetime-local` value (`2026-10-27T09:30`) read as the planner's zone,
 * returned as UTC epoch milliseconds.
 */
export function parseZonedLocal(value: string, zone = PLANNER_ZONE) {
    const match = LOCAL.exec(value.trim());
    if (!match) {
        return undefined;
    }
    const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]));
    if (Number.isNaN(wall)) {
        return undefined;
    }
    let utc = wall - zoneOffset(wall, zone);
    utc = wall - zoneOffset(utc, zone);
    return utc;
}

/** `datetime-local` value for an instant in the planner's zone. */
export function formatZonedLocal(utcMs: number, zone = PLANNER_ZONE) {
    const wall = zonedParts(utcMs, zone);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

export function formatZonedLabel(utcMs: number, zone = PLANNER_ZONE) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(new Date(utcMs));
}

/** A handle stored without a leading @. */
export function accountHandle(value: string) {
    return value.trim().replace(/^@+/, '').toLowerCase();
}
