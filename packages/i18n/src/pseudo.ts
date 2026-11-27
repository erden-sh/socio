import type { Dictionary } from './keys.js';

/**
 * The pseudo-locale (en-XA): every en-US string accented and about a third
 * longer, in brackets, with its variables, nesting and `<Trans>` tags kept.
 * Text that stays plain English under en-XA was never translated (a
 * hard-coded string); text cut off at the bracket doesn't fit a longer
 * language.
 */
const ACCENTS: Record<string, string> = {
    a: 'á',
    b: 'ƀ',
    c: 'ç',
    d: 'ð',
    e: 'é',
    f: 'ƒ',
    g: 'ĝ',
    h: 'ĥ',
    i: 'î',
    j: 'ĵ',
    k: 'ķ',
    l: 'ļ',
    m: 'ɱ',
    n: 'ñ',
    o: 'ö',
    p: 'þ',
    q: 'ǫ',
    r: 'ŕ',
    s: 'š',
    t: 'ţ',
    u: 'û',
    v: 'ṽ',
    w: 'ŵ',
    x: 'ẋ',
    y: 'ý',
    z: 'ž',
    A: 'Å',
    B: 'Ɓ',
    C: 'Ç',
    D: 'Ð',
    E: 'É',
    F: 'Ƒ',
    G: 'Ĝ',
    H: 'Ĥ',
    I: 'Î',
    J: 'Ĵ',
    K: 'Ķ',
    L: 'Ļ',
    M: 'Ṁ',
    N: 'Ñ',
    O: 'Ö',
    P: 'Þ',
    Q: 'Ǫ',
    R: 'Ŕ',
    S: 'Š',
    T: 'Ţ',
    U: 'Û',
    V: 'Ṽ',
    W: 'Ŵ',
    X: 'Ẋ',
    Y: 'Ý',
    Z: 'Ž',
};

/** What must reach i18next and React unchanged: `{{var}}`, `$t(...)` and `<0>`/`</strong>` tags. */
const KEPT = /(\{\{[^}]*\}\}|\$t\([^)]*\)|<\/?[a-zA-Z0-9]+\s*\/?>)/;

export function pseudoText(text: string): string {
    let letters = 0;
    const body = text
        .split(KEPT)
        .map((part, index) => {
            if (index % 2 === 1) {
                return part;
            }
            return [...part]
                .map((char) => {
                    const accented = ACCENTS[char];
                    if (accented) {
                        letters++;
                    }
                    return accented ?? char;
                })
                .join('');
        })
        .join('');
    return `[${body}${letters ? ` ${'~'.repeat(Math.ceil(letters / 3))}` : ''}]`;
}

/** A namespace's en-US dictionary as en-XA, with the same keys. */
export function pseudoDictionary(dictionary: Dictionary): Dictionary {
    return Object.fromEntries(
        Object.entries(dictionary).map(([key, value]) => [
            key,
            typeof value === 'string' ? pseudoText(value) : pseudoDictionary(value),
        ]),
    );
}
