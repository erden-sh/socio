import {
    FIELD_KINDS,
    NUMBER_KINDS,
    baseColumnType,
    inferFieldKind,
    kindFitsColumn,
    type FieldKind,
    type FieldSetting,
} from '../dataset-query/kinds.js';
/**
 * Field settings (CB-451): a column's kind, label and kind-specific
 * settings, checked against the column's stored type the same way
 * wherever they come from (a person's save, a plugin's manifest), and the
 * field display every client reads, built from the column and its
 * setting.
 *
 * Saving refuses, loading forgives: `checkFieldSetting` refuses a kind or
 * a setting the column's type doesn't take, naming the type, while
 * `fieldDisplayFor` shows a stored setting that no longer fits (the column
 * was retyped) by the kind its type gives.
 */
import { specPath } from '../dataset-query/spec.js';

import { fieldSettingsInput, type FieldDisplay, type FieldFallback, type FieldSettingEntry } from './contract.js';

/** A field's settings as stored and answered: only the keys of its kind. */
export type FieldSettingsValues = FieldDisplay['settings'];

/** The settings keys each kind keeps; a kind not listed keeps none. */
export const KIND_SETTING_KEYS: Partial<Record<FieldKind, ReadonlyArray<keyof FieldSettingsValues & string>>> = {
    select: ['options'],
    multi_select: ['options'],
    number: ['decimals', 'unit'],
    currency: ['currency', 'minorUnits', 'decimals'],
    percent: ['decimals'],
    date: ['dateFormat'],
    datetime: ['dateFormat'],
    person: ['allowSocios'],
    people: ['allowSocios'],
};

/**
 * The palette names an option's color is picked from in the editors. A
 * name, never a CSS value: each client maps it to its own colors, and an
 * unknown one (from a later release, or a plugin) shows as `gray`.
 */
export const OPTION_COLORS = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink'] as const;

/** The column a setting is checked against: its name, stored type and whether it is the key. */
export interface FieldColumn {
    name: string;
    type: string;
    primaryKey?: boolean;
    notNull?: boolean;
    defaultValue?: string | null;
}

export const isKnownFieldKind = (kind: unknown): kind is FieldKind =>
    typeof kind === 'string' && (FIELD_KINDS as readonly string[]).includes(kind);

/** Every kind a column's type takes (`kindFitsColumn`), in the order of `FIELD_KINDS`. */
export const kindsForColumn = (column: FieldColumn): FieldKind[] =>
    FIELD_KINDS.filter((kind) => kindFitsColumn(kind, column));

/** What a client that doesn't know a kind shows it as. */
export function fieldFallback(kind: FieldKind): FieldFallback {
    if (NUMBER_KINDS.includes(kind)) {
        return 'number';
    }
    if (kind === 'blob') {
        return 'hidden';
    }
    if (kind === 'json' || kind === 'multi_select' || kind === 'people' || kind === 'file') {
        return 'json';
    }
    return 'text';
}

/** Only the keys a kind keeps, without the ones left out. */
export function settingsForKind(kind: FieldKind, settings: FieldSettingsValues | undefined): FieldSettingsValues {
    const out: Record<string, unknown> = {};
    for (const key of KIND_SETTING_KEYS[kind] ?? []) {
        const value = settings?.[key];
        if (value !== undefined) {
            out[key] = value;
        }
    }
    return out as FieldSettingsValues;
}

/** A field setting to check: what a save or a manifest sends. */
export interface FieldSettingDraft {
    kind: unknown;
    label?: unknown;
    settings?: unknown;
}

export type FieldSettingProblem = { path: string; message: string } & { [key: string]: unknown };

export type FieldSettingCheck =
    | { ok: true; kind: FieldKind; label: string | null; settings: FieldSettingsValues }
    | { ok: false; problems: FieldSettingProblem[] };

/**
 * Checks a setting against its column: a kind the column's type
 * takes (`kindFitsColumn`; a refusal names the type and the kinds it
 * takes), settings of the right shape, and `minorUnits` only on integers.
 * Keys another kind keeps are dropped, not refused. `base` prefixes the
 * problems' paths (`$` for a save's body, `$.field` for a manifest's).
 */
export function checkFieldSetting(
    column: FieldColumn,
    draft: FieldSettingDraft,
    base: string[] = [],
): FieldSettingCheck {
    const problems: FieldSettingProblem[] = [];
    const at = (...parts: Array<string | number>) => specPath([...base, ...parts]);
    const type = column.type || 'untyped';
    if (!isKnownFieldKind(draft.kind)) {
        problems.push({
            path: at('kind'),
            message: `"${String(draft.kind).slice(0, 32)}" is not a field kind; use one of ${FIELD_KINDS.join(', ')}.`,
        });
        return { ok: false, problems };
    }
    const kind = draft.kind;
    if (!kindFitsColumn(kind, column)) {
        const fits = kindsForColumn(column);
        problems.push({
            path: at('kind'),
            message:
                kind === 'id'
                    ? `Column "${column.name}" is not the table's key, so it can't be an id field.`
                    : `Column "${column.name}" is stored as ${type}, which can't hold a ${kind} field; ${type} takes ${fits.join(', ') || 'no kind'}.`,
        });
    }
    let label: string | null = null;
    if (draft.label !== undefined && draft.label !== null) {
        if (typeof draft.label !== 'string' || !draft.label.trim() || draft.label.trim().length > 100) {
            problems.push({ path: at('label'), message: 'A label is 1 to 100 characters.' });
        } else {
            label = draft.label.trim();
        }
    }
    // Only the keys this kind keeps are read: another kind's, good or bad, are dropped.
    const raw = draft.settings ?? {};
    let settings: FieldSettingsValues = {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        problems.push({ path: at('settings'), message: 'Settings are an object.' });
    } else {
        const own = Object.fromEntries(
            (KIND_SETTING_KEYS[kind] ?? []).filter((key) => key in raw).map((key) => [key, (raw as never)[key]]),
        );
        const parsed = fieldSettingsInput.safeParse(own);
        if (parsed.success) {
            settings = settingsForKind(kind, parsed.data);
        } else {
            for (const issue of parsed.error.issues) {
                problems.push({
                    path: at('settings', ...(issue.path as Array<string | number>)),
                    message: issue.message,
                });
            }
        }
    }
    if (settings.minorUnits && baseColumnType(column.type) !== 'INTEGER') {
        problems.push({
            path: at('settings', 'minorUnits'),
            message: `Column "${column.name}" is stored as ${type}; minor units (cents) need an INTEGER column.`,
        });
    }
    if (problems.length) {
        return { ok: false, problems };
    }
    return { ok: true, kind, label, settings };
}

/** A stored setting, as the display reads it. */
export interface StoredFieldSetting {
    column: string;
    kind: string;
    label: string | null;
    settings: FieldSettingsValues;
    version: number;
    declaredBy: string | null;
}

/** The setting the query spec checks (`specFields`), from a stored one. */
export function specFieldSetting(stored: StoredFieldSetting): FieldSetting | undefined {
    if (!isKnownFieldKind(stored.kind)) {
        return undefined;
    }
    const { dateFormat, ...rest } = stored.settings;
    return {
        column: stored.column,
        kind: stored.kind,
        ...(stored.label ? { label: stored.label } : {}),
        settings: {
            ...(rest as FieldSetting['settings']),
            ...(typeof dateFormat === 'string' ? { format: dateFormat } : {}),
        },
    };
}

/**
 * A column's field display: its setting's kind when the kind
 * still fits the column's type, else the kind its type gives (loading
 * forgives); its setting's label, else the column's name. `write`: the
 * person may write the table in place (never a key, a `json` or a `blob`,
 * nor an analytical table's cells, which are appended, not edited).
 */
export function fieldDisplayFor(
    column: FieldColumn,
    stored: StoredFieldSetting | undefined,
    options: { write: boolean; analytical?: boolean },
): FieldDisplay {
    const fits = !!stored && isKnownFieldKind(stored.kind) && kindFitsColumn(stored.kind, column);
    const kind = fits ? (stored.kind as FieldKind) : inferFieldKind(column);
    const isKey = !!column.primaryKey;
    // A single INTEGER PRIMARY KEY is SQLite's rowid: it is assigned when left out.
    const assigned = isKey && baseColumnType(column.type) === 'INTEGER';
    return {
        field: column.name,
        label: stored?.label || column.name,
        kind,
        fallback: fieldFallback(kind),
        editable: options.write && !options.analytical && !isKey && kind !== 'id' && kind !== 'json' && kind !== 'blob',
        required: !!column.notNull && (column.defaultValue ?? null) === null && !assigned,
        isKey,
        settings: fits ? settingsForKind(kind, stored.settings) : {},
    };
}

/** A field's entry for the Fields panel and sheet: its display, its type, the kinds it takes, its version. */
export function fieldSettingEntry(
    column: FieldColumn,
    stored: StoredFieldSetting | undefined,
    options: { write: boolean; analytical?: boolean },
): FieldSettingEntry {
    return {
        ...fieldDisplayFor(column, stored, options),
        type: column.type,
        kinds: kindsForColumn(column),
        version: stored?.version ?? 0,
        ...(stored?.declaredBy ? { declaredBy: stored.declaredBy } : {}),
    };
}

/** A setting whose column is gone: shown to editors as missing, ignored by queries. */
export function missingFieldEntry(stored: StoredFieldSetting): FieldSettingEntry {
    const kind = isKnownFieldKind(stored.kind) ? stored.kind : 'text';
    return {
        field: stored.column,
        label: stored.label || stored.column,
        kind: stored.kind,
        fallback: fieldFallback(kind),
        editable: false,
        required: false,
        isKey: false,
        settings: isKnownFieldKind(stored.kind) ? settingsForKind(kind, stored.settings) : {},
        missing: true,
        type: '',
        kinds: [],
        version: stored.version,
        ...(stored.declaredBy ? { declaredBy: stored.declaredBy } : {}),
    };
}
