// The rules for packages/i18n/namespaces.json's entries, { "<ns>": { label, where } }: what
// the translation app's import accepts (docs/I18N.md). The app refuses the whole import when
// one entry breaks them, so scripts/i18n-build.mjs checks the file with these rules and
// scripts/i18n-sync.mjs won't build an import body that breaks them. Plain JavaScript with no
// imports, for both: i18n-sync runs on Node with nothing installed.

/** The longest a label and a where may be, in code points (the app's limits). */
export const NAMESPACE_LIMITS = { label: 80, where: 300 };

/** Control characters (line breaks among them) and the line and paragraph separators. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
/** Bidi overrides, embeddings and isolates, which could reorder what a translator reads. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
/** Something that reads as an HTML tag: `<b>`, `</a>`, `<!-- x -->`, `<?x?>`, `< img src=x>`. A lone `<` is prose. */
const TAG = /<\s*[/!?A-Za-z][^<]*>/u;
/** An HTML entity: `&amp;`, `&#38;`, `&#x26;`. A lone `&` is prose. */
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);/u;

/**
 * What's wrong with one field's text, or null. `field` is label or where; `required` says
 * whether an absent field is a problem (the build needs both; the app takes either).
 */
export function namespaceTextProblem(field, text, { required = true } = {}) {
    if (text === undefined && !required) {
        return null;
    }
    if (typeof text !== 'string' || !text.trim()) {
        return 'needs text (a non-empty string)';
    }
    const length = [...text].length;
    const max = NAMESPACE_LIMITS[field];
    if (length > max) {
        return `is ${length} characters, over the ${max} limit`;
    }
    if (CONTROL.test(text)) {
        return 'must be a single line, with no tabs or control characters';
    }
    if (BIDI.test(text)) {
        return 'has a bidi override or isolate character';
    }
    if (text.includes('{{')) {
        return "has a {{ placeholder; it's shown as plain text";
    }
    if (TAG.test(text)) {
        return "has an HTML-like tag; it's plain text";
    }
    if (ENTITY.test(text)) {
        return "has an HTML entity; it's plain text, so write the character itself";
    }
    if (text !== text.trim()) {
        return 'starts or ends with spaces';
    }
    return null;
}

/**
 * Every problem with namespaces.json's parsed content, as "<ns>.<field> …" lines. Namespaces
 * en-US lacks and missing entries are the build's to check, since it knows en-US.
 */
export function namespaceEntryProblems(entries, { required = true } = {}) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        return ['must be an object of namespace → { label, where }'];
    }
    const problems = [];
    for (const [ns, entry] of Object.entries(entries)) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            problems.push(`${ns} must be an object with a label and a where`);
            continue;
        }
        for (const field of Object.keys(entry)) {
            if (!Object.hasOwn(NAMESPACE_LIMITS, field)) {
                problems.push(`${ns} has an unknown field ${field} (only label and where)`);
            }
        }
        for (const field of Object.keys(NAMESPACE_LIMITS)) {
            const problem = namespaceTextProblem(field, entry[field], { required });
            if (problem) {
                problems.push(`${ns}.${field} ${problem}`);
            }
        }
    }
    return problems;
}
