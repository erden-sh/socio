import { formatNumber } from '@socio/shared/locale';

// What a tool took and gave, readable (Advanced mode): the web's
// StepDetails rules (CB-72) as entries a screen draws, never a wall of JSON.
// Short fields are name and value rows; code, long text and nested objects
// are blocks; lists of found things are one line each. No React Native here.

export type ValueEntry =
    | { readonly kind: 'row'; readonly name: string; readonly value: string }
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'code'; readonly label: string; readonly text: string; readonly tone?: 'error' }
    | {
          readonly kind: 'items';
          readonly label: string;
          readonly items: readonly { readonly title: string; readonly meta: string; readonly excerpt?: string }[];
          /** Items past the first `LIST_ITEMS`. */
          readonly more: number;
      };

/** Items a list shows before "and N more". */
export const LIST_ITEMS = 12;

/** Fields that hold code or output: always a code block. */
const CODE_FIELDS = new Set(['command', 'sql', 'code', 'script', 'source', 'contents', 'content', 'stdout', 'stderr']);
const FIELD_NAMES: Record<string, string> = {
    stdout: 'Output',
    stderr: 'Errors',
    sql: 'SQL',
    url: 'URL',
    id: 'ID',
    timeoutMs: 'Time limit (ms)',
};

/** A field's key in words: `exitCode` reads "Exit code". */
export function fieldName(key: string): string {
    const known = FIELD_NAMES[key];
    if (known) {
        return known;
    }
    const words = key
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

type Scalar = string | number | boolean;
const isScalar = (value: unknown): value is Scalar => ['string', 'number', 'boolean'].includes(typeof value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
/** Text that reads as a block, not a line: several lines, or long. */
const isBlock = (text: string) => text.includes('\n') || text.length > 160;
/** Base64 or similar: a screenshot, a file's bytes. */
const isBinary = (text: string) => text.length > 1_000 && /^[A-Za-z0-9+/=\s]+$/.test(text.slice(0, 2_000));
const kilobytes = (text: string) => `${formatNumber(Math.max(1, Math.round((text.length * 3) / 4 / 1024)))} KB`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** Search excerpts mark matches in Markdown bold. */
const plain = (text: string) => text.replace(/\*\*/g, '');

function items(label: string, list: readonly Record<string, unknown>[]): ValueEntry {
    return {
        kind: 'items',
        label,
        items: list.slice(0, LIST_ITEMS).map((item, index) => {
            const titleKey = ['title', 'name', 'url', 'path', 'id'].find(
                (key) => isScalar(item[key]) && String(item[key]).trim(),
            );
            const prefix = ['issue', 'key'].find((key) => isScalar(item[key]));
            const excerptKey = ['excerpt', 'snippet', 'description'].find((key) => typeof item[key] === 'string');
            const meta = Object.entries(item)
                .filter(
                    ([key, value]) =>
                        key !== titleKey &&
                        key !== prefix &&
                        key !== excerptKey &&
                        (typeof value === 'number' ||
                            typeof value === 'boolean' ||
                            (typeof value === 'string' && value !== '' && value.length <= 40)),
                )
                .slice(0, 2)
                .map(([key, value]) => `${fieldName(key)} ${String(value)}`)
                .join(' · ');
            const title = [prefix && item[prefix], titleKey && item[titleKey]]
                .filter((part) => part !== undefined && part !== '')
                .join(' ');
            return {
                title: clip(title || `Item ${index + 1}`, 120),
                meta,
                ...(excerptKey ? { excerpt: clip(plain(String(item[excerptKey])), 200) } : {}),
            };
        }),
        more: Math.max(0, list.length - LIST_ITEMS),
    };
}

function fields(record: Record<string, unknown>): ValueEntry[] {
    const rows: ValueEntry[] = [];
    const blocks: ValueEntry[] = [];
    for (const [key, value] of Object.entries(record)) {
        if (value === undefined || value === null || value === '') {
            continue;
        }
        const name = fieldName(key);
        if (typeof value === 'string') {
            if (isBinary(value)) {
                rows.push({ kind: 'row', name, value: `Binary data, ${kilobytes(value)}` });
            } else if (CODE_FIELDS.has(key) || isBlock(value)) {
                blocks.push({ kind: 'code', label: name, text: value, ...(key === 'stderr' ? { tone: 'error' } : {}) });
            } else {
                rows.push({ kind: 'row', name, value: clip(value, 400) });
            }
        } else if (isScalar(value)) {
            rows.push({ kind: 'row', name, value: String(value) });
        } else if (Array.isArray(value) && value.every(isScalar)) {
            rows.push({ kind: 'row', name, value: clip(value.join(', '), 300) });
        } else if (Array.isArray(value) && value.length && value.every(isRecord)) {
            blocks.push(items(name, value));
        } else if (isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')) {
            // Files by name (a job's files): one block each.
            for (const [file, contents] of Object.entries(value)) {
                blocks.push({ kind: 'code', label: file, text: contents as string });
            }
        } else {
            blocks.push({ kind: 'code', label: name, text: JSON.stringify(value, null, 2) });
        }
    }
    return [...rows, ...blocks];
}

/** Any value a tool took or gave, as entries; `label` names a block that stands alone. */
export function valueEntries(value: unknown, label: string): ValueEntry[] {
    if (typeof value === 'string') {
        return isBlock(value) ? [{ kind: 'code', label, text: value }] : [{ kind: 'text', text: value }];
    }
    if (Array.isArray(value) && value.length && value.every(isRecord)) {
        return [items(label, value)];
    }
    if (isRecord(value)) {
        return fields(value);
    }
    return [{ kind: 'text', text: Array.isArray(value) ? value.join(', ') : String(value) }];
}

/** A result's text as entries: parsed when it is JSON. */
export function resultEntries(text: string): ValueEntry[] {
    let value: unknown = text;
    try {
        value = JSON.parse(text);
    } catch {
        // Plain text.
    }
    return valueEntries(value, 'Result');
}

/** A result's text to copy: pretty JSON when it is JSON. */
export function prettyResult(text: string): string {
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        return text;
    }
}
