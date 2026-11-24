/**
 * Text a socio or an app wrote, made inert for a consent card (CB-232):
 * shown as plain text, never Markdown, links or images (the card renders it
 * as a text node), with every character that
 * could hide or reorder what the person reads shown as a visible escape,
 * and a length cap. `untrusted-text.ts` is the GitHub-text helper and
 * does not do this.
 *
 * Escaped: C0 and C1 controls (but a newline, and a tab where kept),
 * bidirectional controls (embeddings, overrides, isolates, marks),
 * zero-width and invisible format characters, the byte order mark, line
 * and paragraph separators, variation selectors, Hangul fillers, the
 * Unicode tag block, and the format controls of Egyptian hieroglyphs,
 * shorthand and musical symbols. Each becomes `[U+XXXX]`, so
 * "evil\u202Etxt.exe" reads as `evil[U+202E]txt.exe`. A character carries
 * at most `MARKS_MAX` combining marks; the rest of a stack show as a
 * count, `[+12 marks]`, so they can't paint over the lines around it.
 */
/** Code point ranges `inertText` escapes (inclusive). */
const HIDDEN: ReadonlyArray<readonly [number, number]> = [
    [0x0000, 0x0008],
    [0x000b, 0x001f],
    [0x007f, 0x009f],
    [0x00ad, 0x00ad],
    [0x034f, 0x034f],
    [0x061c, 0x061c],
    [0x115f, 0x1160],
    [0x17b4, 0x17b5],
    [0x180b, 0x180f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2028, 0x2029],
    [0x2060, 0x206f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
    [0xffa0, 0xffa0],
    [0xfff9, 0xfffb],
    // Egyptian hieroglyph, shorthand and musical format controls.
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0000, 0xe007f],
    [0xe0100, 0xe01ef],
];

const hidden = (char: string) => {
    const code = char.codePointAt(0)!;
    return HIDDEN.some(([from, to]) => code >= from && code <= to);
};

/** The most combining marks one character shows. */
export const MARKS_MAX = 4;
const MARK = /\p{M}/u;

const escape = (char: string) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;

export interface InertOptions {
    /** The most characters kept (before escaping); the rest is cut with "…". */
    max: number;
    /** Keep newlines (else each becomes a space). Default true. */
    lines?: boolean;
    /** Keep tabs (else each is escaped). Default false. */
    tabs?: boolean;
}

/** `value` as inert card text (see above). */
export function inertText(value: string, options: InertOptions): string {
    const { max, lines = true, tabs = false } = options;
    const chars = [...value.replace(/\r\n?/g, '\n')];
    const cut = chars.length > max;
    let out = '';
    // The marks on the current character, and how many of them aren't shown.
    let marks = 0;
    let dropped = 0;
    const counted = () => {
        if (dropped) {
            out += `[+${dropped} marks]`;
        }
        marks = dropped = 0;
    };
    for (const char of cut ? chars.slice(0, max) : chars) {
        const mark = MARK.test(char);
        if (!mark) {
            counted();
        }
        if (char === '\n') {
            out += lines ? '\n' : ' ';
        } else if (char === '\t') {
            out += tabs ? '\t' : escape(char);
        } else if (hidden(char)) {
            out += escape(char);
        } else if (mark && ++marks > MARKS_MAX) {
            dropped++;
        } else {
            out += char;
        }
    }
    counted();
    return cut ? `${out}…` : out;
}

/** Whether `value` holds a character `inertText` escapes. */
export function hasHiddenCharacters(value: string) {
    return [...value].some((char) => char !== '\n' && (char === '\t' || hidden(char)));
}
