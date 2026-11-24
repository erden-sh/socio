// Dates in Set-Cookie's Expires attribute and in the Date header, read with
// RFC 6265's cookie-date algorithm (section 5.1.1), the one browsers use. It
// takes the IMF-fixdate servers send (`Thu, 05 Nov 2026 09:00:00 GMT`), RFC
// 850's `Thursday, 05-Nov-26 09:00:00 GMT` and asctime's
// `Thu Nov  5 09:00:00 2026`, and gives the same answer on every engine, which
// Date.parse doesn't promise for anything but ISO 8601.

/** The characters between a date's tokens (RFC 6265, 5.1.1: `delimiter`). */
// oxlint-disable-next-line no-control-regex -- the RFC's delimiters include the tab
const DELIMITERS = /[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/;
const TIME = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/;
const DAY_OF_MONTH = /^(\d{1,2})(?:\D|$)/;
const YEAR = /^(\d{2,4})(?:\D|$)/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The instant a cookie date or an HTTP date names, in milliseconds since the
 * epoch, or null when it names none (a missing field, a field out of range, or
 * a day the month doesn't have).
 */
export function parseCookieDate(text: string): number | null {
    let time: [number, number, number] | undefined;
    let day: number | undefined;
    let month: number | undefined;
    let year: number | undefined;
    for (const token of text.split(DELIMITERS)) {
        if (token === '') {
            continue;
        }
        if (time === undefined) {
            const match = TIME.exec(token);
            if (match) {
                time = [Number(match[1]), Number(match[2]), Number(match[3])];
                continue;
            }
        }
        if (day === undefined) {
            const match = DAY_OF_MONTH.exec(token);
            if (match) {
                day = Number(match[1]);
                continue;
            }
        }
        if (month === undefined) {
            const index = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
            if (index !== -1) {
                month = index;
                continue;
            }
        }
        if (year === undefined) {
            const match = YEAR.exec(token);
            if (match) {
                year = Number(match[1]);
            }
        }
    }
    if (time === undefined || day === undefined || month === undefined || year === undefined) {
        return null;
    }
    if (year >= 70 && year <= 99) {
        year += 1900;
    } else if (year <= 69) {
        year += 2000;
    }
    const [hour, minute, second] = time;
    if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) {
        return null;
    }
    const instant = Date.UTC(year, month, day, hour, minute, second);
    // Date.UTC rolls 31 February into March; the algorithm fails instead.
    return new Date(instant).getUTCDate() === day ? instant : null;
}
