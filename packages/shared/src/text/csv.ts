/**
 * CSV for every export Socio writes (RFC 4180: quoted fields, CRLF line
 * ends), with a guard against formula injection.
 *
 * A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` (and,
 * in some, a tab or a carriage return) as a formula, so a value someone
 * typed into a dataset, such as `=HYPERLINK("https://…")`, could run when
 * another person opens the export. Text that starts with one of those is
 * written with a leading `'`, which spreadsheets show as text. BLOBs are
 * written as base64 and guarded the same way, since base64 may start with
 * `+`: strip one leading `'` to decode them. Numbers and bigints are
 * written as they are: Socio produced them, and `-5` must stay a number.
 */

/** The characters that make a spreadsheet read a text cell as a formula. */
export const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/** A value as one CSV field: guarded, then quoted when it needs to be. */
export function csvField(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }
    let text = value instanceof Uint8Array ? base64(value) : String(value);
    // Bytes too: base64 can start with `+` (bytes 251, 95, 181 are `+1+1`),
    // which a spreadsheet adds up. A consumer that wants the bytes strips
    // one leading apostrophe before decoding (`'` is not a base64 character).
    if (CSV_FORMULA_START.test(text)) {
        text = `'${text}`;
    }
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Bytes as base64, in the browser and in Node alike (both have `btoa`). */
function base64(bytes: Uint8Array) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** One CSV line, without its line end. */
export function csvRow(values: readonly unknown[]): string {
    return values.map(csvField).join(',');
}

/** Whole CSV text: each row, with CRLF after every line, the last too. */
export function csvText(rows: Iterable<readonly unknown[]>): string {
    const lines: string[] = [];
    for (const row of rows) {
        lines.push(csvRow(row));
    }
    return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}
