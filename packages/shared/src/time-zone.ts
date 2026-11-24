/**
 * A person's time zone (CB-159): an IANA name, such as `America/New_York`.
 * Their profile's, else their browser's, which the web app sends with every
 * chat request in `TIME_ZONE_HEADER` (never in a message's text) and the
 * server saves to a profile that has none, or one whose zone it detected
 * before (CB-176); else UTC.
 */

/** The request header the web app sends the browser's time zone in. */
export const TIME_ZONE_HEADER = 'X-Time-Zone';

/** The zone a turn uses when its person's isn't known. */
export const DEFAULT_TIME_ZONE = 'UTC';

// An IANA name: `UTC`, `EST`, `Europe/Madrid`, `America/Argentina/Salta`,
// `Etc/GMT+5`. Not an offset such as `+05:30`, which Intl also takes.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * `value` as an IANA time zone name, spelled as the time zone database
 * spells it: a name that differs only in case gets the database's case
 * (`america/new_york`, `America/New_York`); one in lower case that the
 * database lists only as a link gets the zone it links to (`us/eastern`,
 * `America/New_York`). Undefined when it isn't one.
 */
export function ianaTimeZone(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const name = value.trim();
    if (!name || name.length > 64 || !IANA_NAME.test(name)) {
        return undefined;
    }
    let resolved: string;
    try {
        resolved = new Intl.DateTimeFormat('en-US', {
            timeZone: name,
        }).resolvedOptions().timeZone;
    } catch {
        return undefined;
    }
    const lower = name.toLowerCase();
    if (resolved.toLowerCase() === lower) {
        return resolved;
    }
    // Hermes, which runs the native app, has no Intl.supportedValuesOf: there,
    // the list isn't checked.
    const listed =
        typeof Intl.supportedValuesOf === 'function'
            ? // oxlint-disable-next-line socio/hermes -- guarded by the typeof check above
              Intl.supportedValuesOf('timeZone').find((zone) => zone.toLowerCase() === lower)
            : undefined;
    if (listed) {
        return listed;
    }
    // A link spelled as the database spells it (`US/Eastern`, `Asia/Kolkata`)
    // is kept: each part starts with a capital.
    return name.split('/').every((part) => /^[A-Z]/.test(part)) ? name : resolved;
}

/** The browser's own time zone, when it names a valid one. */
export function browserTimeZone(): string | undefined {
    try {
        return ianaTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
        return undefined;
    }
}

/**
 * The quiet note when a detected time zone followed the browser (CB-176),
 * shown once in the person's next chat and once on the Memories page.
 */
export const movedTimeZoneText = (zone: string) => `Your time zone is now ${zone} (detected from your browser).`;

/**
 * The run event that carries that note to the chat (CB-176), with
 * `TimeZoneMoved`: sent in the first web turn of the person's own after
 * the move, never in a chat with other people in it.
 */
export const TIME_ZONE_MOVED_EVENT = 'socio.time-zone-moved';
export interface TimeZoneMoved {
    zone: string;
}
