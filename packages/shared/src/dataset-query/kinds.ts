/**
 * Field kinds (CB-451): what a dataset column means to a person. The
 * column type says how a value is stored; the kind decides its
 * operators, formatting, editing, grouping and the measures it allows.
 */

export const FIELD_KINDS = [
    'text',
    'long_text',
    'number',
    'currency',
    'percent',
    'checkbox',
    'date',
    'datetime',
    'select',
    'multi_select',
    'person',
    'people',
    'file',
    'url',
    'email',
    'phone',
    'json',
    'id',
    'blob',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/**
 * A column type reduced to the names the kind table uses: upper case,
 * `DECIMAL(p,s)` as `DECIMAL`, and any other declared type by SQLite's
 * affinity rules (`VARCHAR(20)` is `TEXT`, `BIGINT` is `INTEGER`), so a
 * table made with SQL still gets a kind.
 */
export function baseColumnType(type: string): string {
    const upper = type.trim().toUpperCase();
    if (/^DECIMAL\s*\(/.test(upper) || upper === 'DECIMAL') {
        return 'DECIMAL';
    }
    const known = ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATETIME', 'JSON', 'DATE', 'TIMESTAMP'];
    if (known.includes(upper)) {
        return upper;
    }
    // SQLite's affinity rules (datatype3.html, 3.1), in their order.
    if (upper.includes('INT')) {
        return 'INTEGER';
    }
    if (/CHAR|CLOB|TEXT/.test(upper)) {
        return 'TEXT';
    }
    if (upper === '' || upper.includes('BLOB')) {
        return 'BLOB';
    }
    if (/REAL|FLOA|DOUB/.test(upper)) {
        return 'REAL';
    }
    return 'NUMERIC';
}

/** The column types each kind may be stored as; `id` fits any primary key. */
export const KIND_COLUMN_TYPES: Record<FieldKind, readonly string[]> = {
    text: ['TEXT'],
    long_text: ['TEXT'],
    number: ['INTEGER', 'REAL', 'NUMERIC', 'DECIMAL'],
    currency: ['INTEGER', 'DECIMAL', 'REAL'],
    percent: ['REAL', 'NUMERIC', 'DECIMAL'],
    checkbox: ['BOOLEAN', 'INTEGER'],
    date: ['TEXT', 'DATE', 'DATETIME'],
    datetime: ['DATETIME', 'TIMESTAMP', 'INTEGER'],
    select: ['TEXT'],
    multi_select: ['JSON', 'TEXT'],
    person: ['TEXT'],
    people: ['JSON'],
    file: ['TEXT', 'JSON'],
    url: ['TEXT'],
    email: ['TEXT'],
    phone: ['TEXT'],
    json: ['JSON'],
    id: [],
    blob: ['BLOB'],
};

/** Whether a kind may be set on a column of this type (a primary key for `id`). */
export function kindFitsColumn(kind: FieldKind, column: { type: string; primaryKey?: boolean }) {
    if (kind === 'id') {
        return !!column.primaryKey;
    }
    return KIND_COLUMN_TYPES[kind].includes(baseColumnType(column.type));
}

/**
 * A column's kind without field settings: from its type, and `id` for a
 * primary key. Never `person` or `select`, which only a setting says.
 */
export function inferFieldKind(column: { type: string; primaryKey?: boolean }): FieldKind {
    if (column.primaryKey) {
        return 'id';
    }
    return typeKind(column.type);
}

/** The kind a type gives by itself, ignoring keys. */
export function typeKind(type: string): FieldKind {
    switch (baseColumnType(type)) {
        case 'INTEGER':
        case 'REAL':
        case 'NUMERIC':
        case 'DECIMAL':
            return 'number';
        case 'BOOLEAN':
            return 'checkbox';
        case 'DATETIME':
        case 'TIMESTAMP':
            return 'datetime';
        case 'DATE':
            return 'date';
        case 'JSON':
            return 'json';
        case 'BLOB':
            return 'blob';
        default:
            return 'text';
    }
}

/** Kinds that hold numbers: sums, averages, number filters. */
export const NUMBER_KINDS: readonly FieldKind[] = ['number', 'currency', 'percent'];
/** Kinds that hold a calendar day or an instant: windows, buckets, relative dates. */
export const DATE_KINDS: readonly FieldKind[] = ['date', 'datetime'];
/** Kinds matched as text. */
export const TEXT_KINDS: readonly FieldKind[] = ['text', 'long_text', 'url', 'email', 'phone'];
/** Kinds a query may group on. */
export const GROUPABLE_KINDS: readonly FieldKind[] = [
    'text',
    'url',
    'email',
    'phone',
    'number',
    'currency',
    'percent',
    'checkbox',
    'date',
    'datetime',
    'select',
    'person',
    'id',
];
/** Kinds a query may sort on. */
export const SORTABLE_KINDS: readonly FieldKind[] = [...GROUPABLE_KINDS, 'long_text'];

/** One option of a select or multi-select field: a stable id, its label and color. */
export interface FieldOption {
    id: string;
    label: string;
    color?: string;
}

/**
 * A column's field setting, as the query checks it. Stored per
 * table in `data_field_settings` (build step 4); kind-specific values
 * are in `settings`.
 */
export interface FieldSetting {
    column: string;
    kind: FieldKind;
    label?: string;
    settings?: {
        options?: FieldOption[];
        /** ISO 4217, for `currency`. */
        currency?: string;
        /** A `currency` stored as integer minor units (cents). */
        minorUnits?: boolean;
        decimals?: number;
        unit?: string;
        format?: string;
    };
}
