/**
 * Learning's privacy filters, shared with the classification seam
 * (CB-198, CB-200): `scrub()` before any text leaves the store, and
 * `leaksPrivateData()` on what a model wrote. Plain functions with no
 * imports, so the seam and Learning can both use them without a cycle.
 * Moved from `src/server/learning/scrub.ts`, which re-exports them.
 */

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Digit runs with separators; a phone-like number has at least 9 digits,
// which leaves dates and times alone.
const NUMBER = /\+?\d[\d\s().-]{7,}\d/g;
const phoneLike = (match: string) => match.replace(/\D/g, '').length >= 9;
// Provider-prefixed keys, and long unbroken tokens (UUIDs have hyphens).
const SECRET = /\b(?:sk|pk|rk|ghp|gho|xox[abpr])[-_][A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_]{32,}\b/g;
/** Removes contact details and secret-like strings before text leaves the store. */
export function scrub(text: string) {
    return text
        .replace(EMAIL, '<email>')
        .replace(SECRET, '<secret>')
        .replace(NUMBER, (match) => (phoneLike(match) ? '<number>' : match));
}

/** True when model output still carries contact details or secrets. */
export function leaksPrivateData(text: string) {
    return !!text.match(EMAIL) || !!text.match(SECRET) || (text.match(NUMBER) ?? []).some(phoneLike);
}
