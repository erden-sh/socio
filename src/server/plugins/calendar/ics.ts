import type { EventRow } from './infra/repository.js';

/**
 * An iCalendar document (RFC 5545) of `rows`, for a calendar app's
 * subscription. Timed events are in UTC (no VTIMEZONE to keep in step);
 * all-day events are dates. Text is escaped and lines folded at 75 octets.
 */
export function icsCalendar(rows: readonly EventRow[], options: { name: string; host: string; now: number }) {
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Socio//Calendar plugin//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeText(options.name)}`,
        'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
        'X-PUBLISHED-TTL:PT1H',
    ];
    for (const row of rows) {
        lines.push(
            'BEGIN:VEVENT',
            `UID:${row.id}@${options.host}`,
            `DTSTAMP:${utcStamp(options.now)}`,
            ...(row.allDay
                ? [
                      `DTSTART;VALUE=DATE:${row.startLocal.replace(/-/g, '')}`,
                      `DTEND;VALUE=DATE:${nextDay(row.endLocal).replace(/-/g, '')}`,
                  ]
                : [`DTSTART:${utcStamp(row.startAt)}`, `DTEND:${utcStamp(row.endAt)}`]),
            `SUMMARY:${escapeText(row.title)}`,
            ...(row.location ? [`LOCATION:${escapeText(row.location)}`] : []),
            ...(row.description ? [`DESCRIPTION:${escapeText(row.description)}`] : []),
            `STATUS:${row.status.toUpperCase()}`,
            ...(row.visibility === 'private' ? ['CLASS:PRIVATE'] : []),
            `CREATED:${utcStamp(row.createdAt)}`,
            `LAST-MODIFIED:${utcStamp(row.updatedAt)}`,
            ...(row.sourceUrl ? [`URL:${row.sourceUrl}`] : []),
            'END:VEVENT',
        );
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

const pad = (value: number) => String(value).padStart(2, '0');

function utcStamp(at: number) {
    const date = new Date(at);
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function nextDay(key: string) {
    const [year, month, day] = key.split('-').map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day! + 1));
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped. */
export function escapeText(value: string) {
    return (
        value
            // oxlint-disable-next-line no-control-regex -- control characters are dropped
            .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
            .replace(/\\/g, '\\\\')
            .replace(/;/g, '\\;')
            .replace(/,/g, '\\,')
            .replace(/\r\n|\r|\n/g, '\\n')
    );
}

/** Folds a content line at 75 octets, never inside a UTF-8 sequence. */
export function fold(line: string) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) {
        return line;
    }
    const parts: string[] = [];
    let start = 0;
    let limit = 75;
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length);
        // Back off continuation bytes (10xxxxxx) so a character stays whole.
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
            end--;
        }
        parts.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
        limit = 74; // A folded line starts with one space.
    }
    return parts.join('\r\n ');
}
