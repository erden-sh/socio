import type { FilterNode, QuerySort } from '@socio/shared/dataset-query/spec';
import {
    type Cell,
    DATASET_FILE_TYPES,
    type DirectoryPerson,
    type FieldDisplay,
    type FieldDisplayOption,
    type FieldSettingEntry,
    type FieldSettingsRequest,
    type InvalidWrite,
    type NewViewDefinition,
    VIEW_WRITE_CODES,
    VIEW_WRITE_LIMITS,
    type ViewDiff,
    type ViewUser,
    type ViewWriteCode,
    type WriteCell,
} from '@socio/shared/dataset-views/contract';
import type { ViewDefinition, ViewField } from '@socio/shared/dataset-views/definition';
import { cellItems } from '@socio/shared/dataset-views/format';

import type { LOCAL_WRITE_CODES, Refused } from '../sync/view-source';

import { conditionText } from './dataset-view';

// A dataset view's writes on the phone (CB-469, CB-451), the
// words and view models the write screens draw from, with no React Native:
// - `refusalCopy`: every refusal's `code` (`VIEW_WRITE_CODES`, and the phone's
//   own `LOCAL_WRITE_CODES`) in plain words, never the server's text;
// - `conflictLines`: a `view_conflict`'s diff, part by part and field by field,
//   theirs beside yours;
// - field settings: the kinds' names, the settings each kind keeps, and a
//   form's draft and its request;
// - the person picker's rows: the directory's active people, those a cell
//   holds who are deactivated or unknown shown muted, kept but never offered;
// - the New row form: which fields it asks, its values, a 400's problems by
//   field, and the request.
// tests/shell/dataset-writes.test.ts runs it under Node.

// ----- Refusals -----

type LocalWriteCode = (typeof LOCAL_WRITE_CODES)[keyof typeof LOCAL_WRITE_CODES];

/** Every refusal's words, by code: the server's codes and the phone's own. */
export const REFUSAL_COPY: Readonly<Record<ViewWriteCode | LocalWriteCode, string>> = {
    invalid: 'Some of this can’t be saved. Check the fields marked below.',
    read_only: 'You can read this dataset but not change it.',
    row_gone: 'This row was deleted. Pull to refresh the view.',
    view_conflict: 'Someone saved this view after you started changing it.',
    cell_conflict: 'Someone changed this since you opened it.',
    key_taken: 'A row with this key already exists. Use another.',
    field_conflict: 'Someone changed this field’s settings since you opened them.',
    options_in_use: 'Some rows still use the options you removed.',
    too_many_rows: 'This view has too many rows to export. Narrow its filter, then export again.',
    file_too_large: 'This file is larger than this dataset takes.',
    unsupported_file: 'Datasets take images (PNG, JPEG, GIF, WebP) and PDFs.',
    network: 'Couldn’t reach the server. Check your connection and try again.',
    rate_limited: 'Too many at once. Wait a minute, then try again.',
    not_served: 'This server doesn’t take this change yet. Update Socio on the server to make it here.',
    unreadable: 'The server answered with something this app can’t read. Update Socio, then try again.',
    failed: 'That didn’t save. Try again.',
};

const count = (n: number) => n.toLocaleString('en-US');

/** A refusal in plain words: its code's, with the numbers its body carries. */
export function refusalCopy(refused: Pick<Refused, 'code' | 'body' | 'retryAfterSeconds'>): string {
    const body = (refused.body ?? {}) as Record<string, unknown>;
    if (
        refused.code === VIEW_WRITE_CODES.tooManyRows &&
        typeof body.rows === 'number' &&
        typeof body.limit === 'number'
    ) {
        return `This view has ${count(body.rows)} rows; an export takes at most ${count(body.limit)}. Narrow its filter, then export again.`;
    }
    if (refused.code === 'rate_limited' && refused.retryAfterSeconds !== undefined && refused.retryAfterSeconds > 0) {
        const seconds = Math.ceil(refused.retryAfterSeconds);
        return `Too many at once. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
    }
    return REFUSAL_COPY[refused.code as ViewWriteCode] ?? REFUSAL_COPY.failed;
}

/** `options_in_use`'s question: which options, and how many rows hold each. */
export function optionsInUseCopy(inUse: readonly { label: string; rows: number }[]): {
    title: string;
    message: string;
} {
    const rows = inUse.reduce((n, o) => n + o.rows, 0);
    const names = inUse.map((o) => `“${o.label}”`).join(', ');
    return {
        title: inUse.length === 1 ? `Remove ${names}?` : `Remove ${inUse.length} options?`,
        message: `${count(rows)} ${rows === 1 ? 'row uses' : 'rows use'} ${names}. ${rows === 1 ? 'It keeps its value' : 'They keep their values'}, shown as “Unknown option”.`,
    };
}

/** A 400's problems by field (`$.values.title` → `title`), the first message each, and the rest. */
export function problemsByField(invalid: Pick<InvalidWrite, 'problems'>): {
    fields: Record<string, string>;
    other: string[];
} {
    const fields: Record<string, string> = {};
    const other: string[] = [];
    for (const problem of invalid.problems) {
        const match = /^\$\.values\.([^.[\]]+)/.exec(problem.path);
        if (match?.[1] !== undefined) {
            fields[match[1]] ??= problem.message;
        } else {
            other.push(problem.message);
        }
    }
    return { fields, other };
}

// ----- A cell's conflict -----

/** A `cell_conflict` as the record sheet shows it: the field, theirs now and yours. */
export interface CellConflictView {
    readonly key: string;
    readonly field: string;
    readonly label: string;
    readonly theirs: string;
    readonly mine: string;
    /** What Keep mine sends: the same edit, from what is there now. */
    readonly retry: { readonly from: Cell; readonly to: WriteCell };
}

// ----- A view's conflict -----

/** One line of a view conflict's comparison: a part, theirs and yours. */
export interface ConflictLine {
    readonly part: string;
    readonly label: string;
    readonly theirs: string;
    readonly mine: string;
}

const PART_LABELS: Readonly<Record<string, string>> = {
    name: 'Name',
    layout: 'Layout',
    filter: 'Filter',
    sort: 'Sort',
    groupBy: 'Grouping',
    segments: 'Segments',
    fields: 'Fields',
    options: 'Layout options',
    totals: 'Totals',
    visibility: 'Who sees it',
};

export const LAYOUT_LABELS: Readonly<Record<string, string>> = {
    table: 'Table',
    list: 'List',
    board: 'Board',
    calendar: 'Calendar',
    gallery: 'Gallery',
};

function filterText(filter: unknown, fields: ReadonlyMap<string, FieldDisplay>): string {
    if (filter === null || filter === undefined) {
        return 'No filter';
    }
    const node = filter as FilterNode & { all?: FilterNode[]; any?: FilterNode[]; not?: FilterNode };
    if ('field' in node && typeof node.field === 'string') {
        return conditionText(node as Parameters<typeof conditionText>[0], fields);
    }
    const all = node.all;
    const any = node.any;
    if (Array.isArray(all) || Array.isArray(any)) {
        const parts = (all ?? any ?? []).map((n) => filterText(n, fields));
        return parts.length === 0 ? 'No filter' : parts.join(Array.isArray(all) ? ' and ' : ' or ');
    }
    return 'A filter from a newer version';
}

function sortText(sort: unknown, fields: ReadonlyMap<string, FieldDisplay>): string {
    if (!Array.isArray(sort) || sort.length === 0) {
        return 'No sort';
    }
    return (sort as QuerySort[])
        .map((s) => `${fields.get(s.field)?.label ?? s.field}, ${s.dir === 'desc' ? 'descending' : 'ascending'}`)
        .join('; ');
}

function fieldEntryText(entry: ViewField | null): string {
    if (entry === null) {
        return 'Not listed';
    }
    const parts = [entry.hidden === true ? 'hidden' : 'shown'];
    if (typeof entry.priority === 'number') {
        parts.push('first on small screens');
    }
    if (typeof entry.width === 'number') {
        parts.push(`${entry.width} wide`);
    }
    if (entry.wrap === true) {
        parts.push('wraps');
    }
    const text = parts.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function partText(part: string, value: unknown, fields: ReadonlyMap<string, FieldDisplay>): string {
    switch (part) {
        case 'name':
            return typeof value === 'string' ? `“${value}”` : '—';
        case 'layout':
            return LAYOUT_LABELS[String(value)] ?? String(value);
        case 'filter':
            return filterText(value, fields);
        case 'sort':
            return sortText(value, fields);
        case 'groupBy':
            return Array.isArray(value) && value.length > 0
                ? value.map((g: { field?: string }) => fields.get(g.field ?? '')?.label ?? g.field ?? '?').join(', ')
                : 'Not grouped';
        case 'visibility':
            return value === 'personal' ? 'Only the owner' : 'Everyone';
        case 'fields': {
            const list = Array.isArray(value) ? (value as ViewField[]) : [];
            const shown = list.filter((f) => f.hidden !== true).map((f) => fields.get(f.field)?.label ?? f.field);
            return shown.length === 0 ? 'No fields' : shown.join(', ');
        }
        default: {
            if (value === null || value === undefined) {
                return 'None';
            }
            const keys = typeof value === 'object' ? Object.keys(value as object) : [];
            return keys.length === 0 ? 'None' : keys.join(', ');
        }
    }
}

/**
 * A view conflict's comparison, theirs (the stored view) beside yours (the draft): each part
 * that differs, and under Fields each field entry added, removed, changed or moved.
 */
export function conflictLines(diff: ViewDiff, fields: readonly FieldDisplay[]): ConflictLine[] {
    const byName = new Map(fields.map((f) => [f.field, f]));
    const lines: ConflictLine[] = [];
    for (const part of diff.parts) {
        if (part.part === 'fields' && diff.fields.length > 0) {
            for (const field of diff.fields) {
                const label = byName.get(field.field)?.label ?? field.field;
                const moved = field.moved ? ' (moved)' : '';
                lines.push({
                    part: `field:${field.field}`,
                    label: `${PART_LABELS.fields}: ${label}`,
                    theirs: `${fieldEntryText(field.theirs)}${field.theirs !== null ? moved : ''}`,
                    mine: `${fieldEntryText(field.mine)}${field.mine !== null ? moved : ''}`,
                });
            }
            continue;
        }
        lines.push({
            part: part.part,
            label: PART_LABELS[part.part] ?? part.part,
            theirs: partText(part.part, part.theirs, byName),
            mine: partText(part.part, part.mine, byName),
        });
    }
    return lines;
}

/** Who saved the view now stored, for the conflict's title. */
export function savedByLine(savedBy: string | null, users: Readonly<Record<string, ViewUser>>): string {
    const name = savedBy === null ? undefined : users[savedBy]?.name;
    return name === undefined ? 'Someone saved this view' : `${name} saved this view`;
}

/** What the draft's Save offers: for everyone needs `saveShared` (a dataset view) and a stored view. */
export function saveChoices(
    view: Pick<ViewDefinition, 'id' | 'visibility'>,
    rights: { saveShared: boolean },
): { readonly save: 'everyone' | 'mine' | null; readonly asNew: boolean } {
    if (view.id === 'default') {
        return { save: null, asNew: true };
    }
    if (view.visibility === 'personal') {
        return { save: 'mine', asNew: true };
    }
    return { save: rights.saveShared ? 'everyone' : null, asNew: true };
}

/** "Save as new view"'s definition: the draft with no id or version, its name and who sees it. */
export function newViewDefinition(
    draft: ViewDefinition,
    name: string,
    visibility: 'personal' | 'dataset',
): NewViewDefinition {
    const { id: _id, version: _version, ...rest } = draft;
    return { ...rest, name: name.trim(), visibility };
}

/** The name "Save as new view" starts with. */
export const copyName = (name: string) => `${name} (copy)`.slice(0, VIEW_WRITE_LIMITS.label);

// ----- Field settings -----

/** The kinds' names, as the Fields screen says them. */
export const KIND_LABELS: Readonly<Record<string, string>> = {
    text: 'Text',
    long_text: 'Long text',
    number: 'Number',
    currency: 'Currency',
    percent: 'Percent',
    checkbox: 'Checkbox',
    date: 'Date',
    datetime: 'Date and time',
    select: 'Select',
    multi_select: 'Multi-select',
    person: 'Person',
    people: 'People',
    file: 'File',
    url: 'URL',
    email: 'Email',
    phone: 'Phone',
    json: 'JSON',
    id: 'ID',
    blob: 'Binary',
};

export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** The settings each kind keeps; a save keeps only these. */
export const KIND_SETTING_KEYS: Readonly<Record<string, readonly SettingKey[]>> = {
    select: ['options'],
    multi_select: ['options'],
    currency: ['currency', 'minorUnits', 'decimals'],
    number: ['decimals', 'unit'],
    percent: ['decimals'],
    date: ['dateFormat'],
    datetime: ['dateFormat'],
    person: ['allowSocios'],
    people: ['allowSocios'],
};

export type FieldSettingsInput = FieldSettingsRequest['settings'];
type SettingKey = keyof FieldSettingsInput;

/** The settings a kind keeps, from any settings: what a save of that kind sends. */
export function settingsForKind(kind: string, settings: Readonly<Record<string, unknown>>): FieldSettingsInput {
    const out: Record<string, unknown> = {};
    for (const key of KIND_SETTING_KEYS[kind] ?? []) {
        if (settings[key] !== undefined) {
            out[key] =
                key === 'options'
                    ? (settings.options as FieldDisplayOption[]).map(({ id, label, color }) => ({ id, label, color }))
                    : settings[key];
        }
    }
    return out as FieldSettingsInput;
}

/** The option colors the web's palette names (`paletteTone`), in the picker's order. */
export const OPTION_COLORS = [
    'gray',
    'blue',
    'green',
    'teal',
    'yellow',
    'orange',
    'red',
    'pink',
    'purple',
    'indigo',
] as const;

export const COLOR_LABELS: Readonly<Record<string, string>> = {
    gray: 'Gray',
    blue: 'Blue',
    green: 'Green',
    teal: 'Teal',
    yellow: 'Yellow',
    orange: 'Orange',
    red: 'Red',
    pink: 'Pink',
    purple: 'Purple',
    indigo: 'Indigo',
};

/** The field settings form's draft: what the person is changing. */
export interface FieldForm {
    readonly kind: string;
    readonly label: string;
    readonly options: readonly FieldDisplayOption[];
    readonly currency: string;
    readonly minorUnits: boolean;
    /** Typed: '' for none. */
    readonly decimals: string;
    readonly unit: string;
    readonly dateFormat: 'date' | 'datetime';
    readonly allowSocios: boolean;
}

export function fieldForm(entry: Pick<FieldSettingEntry, 'kind' | 'label' | 'settings'>): FieldForm {
    const s = entry.settings;
    return {
        kind: entry.kind,
        label: entry.label,
        options: (s.options ?? []).map(({ id, label, color }) => ({ id, label, color })),
        currency: s.currency ?? 'USD',
        minorUnits: s.minorUnits === true,
        decimals: s.decimals === undefined ? '' : String(s.decimals),
        unit: s.unit ?? '',
        dateFormat:
            s.dateFormat === 'datetime' || (s.dateFormat === undefined && entry.kind === 'datetime')
                ? 'datetime'
                : 'date',
        allowSocios: s.allowSocios === true,
    };
}

/** What the field form says is wrong before anything is sent, by its part; empty when it can save. */
export function fieldFormProblems(
    form: FieldForm,
): Partial<Record<'label' | 'options' | 'currency' | 'decimals' | 'unit', string>> {
    const problems: Partial<Record<'label' | 'options' | 'currency' | 'decimals' | 'unit', string>> = {};
    const keys = KIND_SETTING_KEYS[form.kind] ?? [];
    if (form.label.trim() === '') {
        problems.label = 'A field needs a name.';
    } else if (form.label.trim().length > VIEW_WRITE_LIMITS.label) {
        problems.label = `A name is at most ${VIEW_WRITE_LIMITS.label} characters.`;
    }
    if (keys.includes('options')) {
        if (form.options.some((o) => o.label.trim() === '')) {
            problems.options = 'Every option needs a name.';
        } else if (form.options.length > VIEW_WRITE_LIMITS.options) {
            problems.options = `A field has at most ${VIEW_WRITE_LIMITS.options} options.`;
        }
    }
    if (keys.includes('currency') && !/^[A-Z]{3}$/.test(form.currency.trim().toUpperCase())) {
        problems.currency = 'Use a three-letter currency code, like USD.';
    }
    if (keys.includes('decimals') && form.decimals.trim() !== '') {
        const n = Number(form.decimals);
        if (!Number.isInteger(n) || n < 0 || n > 20) {
            problems.decimals = 'Use a whole number from 0 to 20.';
        }
    }
    if (keys.includes('unit') && form.unit.length > VIEW_WRITE_LIMITS.unit) {
        problems.unit = `A unit is at most ${VIEW_WRITE_LIMITS.unit} characters.`;
    }
    return problems;
}

/** The form as `PUT …/fields/:field` takes it (without `schema`), the kind's settings only. */
export function fieldSave(
    form: FieldForm,
    baseVersion: number,
    confirmRemovedOptions = false,
): Omit<FieldSettingsRequest, 'schema'> {
    const settings: Record<string, unknown> = {
        options: form.options.map((o) => ({ id: o.id, label: o.label.trim(), color: o.color })),
        currency: form.currency.trim().toUpperCase(),
        minorUnits: form.minorUnits,
        unit: form.unit,
        dateFormat: form.dateFormat,
        allowSocios: form.allowSocios,
        ...(form.decimals.trim() === '' ? {} : { decimals: Number(form.decimals) }),
    };
    return {
        kind: form.kind,
        label: form.label.trim(),
        settings: settingsForKind(form.kind, settings),
        baseVersion,
        ...(confirmRemovedOptions ? { confirmRemovedOptions: true as const } : {}),
    };
}

/** A new option: a fresh id (`random` gives its tail), no name yet, the next palette color. */
export function newOption(existing: readonly FieldDisplayOption[], random: string): FieldDisplayOption {
    const ids = new Set(existing.map((o) => o.id));
    let id = `opt_${random.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'new'}`;
    for (let n = 2; ids.has(id); n += 1) {
        id = `${id}_${n}`;
    }
    return { id, label: '', color: OPTION_COLORS[existing.length % OPTION_COLORS.length]! };
}

/** The options a form moves one place up or down. */
export function movedOption(options: readonly FieldDisplayOption[], id: string, by: -1 | 1): FieldDisplayOption[] {
    const at = options.findIndex((o) => o.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= options.length) {
        return [...options];
    }
    const next = [...options];
    const [moved] = next.splice(at, 1);
    next.splice(to, 0, moved!);
    return next;
}

/** A field's line on the Fields screen: its kind, and why it can't be changed when it can't. */
export function fieldLine(
    entry: FieldSettingEntry,
    canEdit: boolean,
): { kind: string; note: string | null; editable: boolean } {
    const note = entry.missing
        ? 'Its column was removed from the table.'
        : entry.declaredBy !== undefined
          ? `Set by ${entry.declaredBy.replace(/^plugin:/, '')}`
          : entry.kinds.length <= 1 && (KIND_SETTING_KEYS[entry.kind]?.length ?? 0) === 0
            ? entry.isKey
                ? 'The table’s key'
                : null
            : null;
    return {
        kind: kindLabel(entry.kind),
        note,
        editable: canEdit && entry.missing !== true && !(entry.isKey && entry.kinds.length <= 1),
    };
}

// ----- People -----

/** One row of the person picker. */
export interface PersonRow {
    readonly id: string;
    readonly name: string;
    readonly chosen: boolean;
    /** Deactivated or unknown: kept when chosen, never offered. */
    readonly muted: boolean;
    readonly note?: string;
}

/**
 * The picker's rows: the cell's people first (a deactivated or unknown one muted, kept until
 * removed), then the directory's active people who match `query`, by name.
 */
export function personRows(
    directory: readonly DirectoryPerson[],
    held: readonly (string | number)[],
    known: Readonly<Record<string, ViewUser>>,
    query: string,
): PersonRow[] {
    const chosen = held.map(String);
    const q = query.trim().toLocaleLowerCase('en-US');
    const matches = (name: string) => q === '' || name.toLocaleLowerCase('en-US').includes(q);
    const listed = new Map(directory.map((p) => [p.id, p]));
    const rows: PersonRow[] = [];
    for (const id of chosen) {
        const person = listed.get(id);
        const user = known[id];
        const name = person?.name ?? user?.name ?? 'Unknown person';
        if (!matches(name)) {
            continue;
        }
        const inactive = person === undefined;
        rows.push({
            id,
            name,
            chosen: true,
            muted: inactive,
            ...(inactive ? { note: user === undefined ? 'Not in this workspace' : 'Deactivated' } : {}),
        });
    }
    for (const person of directory) {
        if (!chosen.includes(person.id) && matches(person.name)) {
            rows.push({ id: person.id, name: person.name, chosen: false, muted: false });
        }
    }
    return rows;
}

/** A person cell after a pick: one person replaces (or clears), people toggle. */
export function pickedPeople(raw: unknown, id: string, many: boolean): WriteCell {
    const held = cellItems(raw).map(String);
    if (!many) {
        return held.includes(id) ? null : id;
    }
    return held.includes(id) ? held.filter((h) => h !== id) : [...held, id];
}

/** The ids a page's cells name that its `users` map doesn't: what `lookupPeople` resolves. */
export function unresolvedPeople(values: readonly unknown[], users: Readonly<Record<string, ViewUser>>): string[] {
    const out = new Set<string>();
    for (const value of values) {
        for (const id of cellItems(value)) {
            if (users[String(id)] === undefined) {
                out.add(String(id));
            }
        }
    }
    return [...out];
}

// ----- Files -----

/**
 * Whether the phone offers Add file in a dataset's file cells (the record sheet, New row).
 * Off until the server has `POST /api/data/datasets/:id/files` (CB-532): every upload fails
 * without it. Removing a file is a cell write and stays. The upload code
 * (`useDatasetUpload`, `DATASET_FILES_PATH`) stays too, so turning it on is this line.
 */
export const DATASET_FILE_UPLOADS = false;

/** Whether a file cell shows Add file: editable, and uploads on (`DATASET_FILE_UPLOADS`). */
export const offersFileAdd = (editable: boolean, uploads: boolean = DATASET_FILE_UPLOADS) => editable && uploads;

/** Whether a dataset takes a picked file's type, before it is sent (the server checks the content). */
export const datasetTakes = (mime: string) => (DATASET_FILE_TYPES as readonly string[]).includes(mime);

/** A file cell after an upload or a removal. */
export const withFile = (raw: unknown, id: string): WriteCell => [...cellItems(raw).map(String), id];
export const withoutFile = (raw: unknown, id: string): WriteCell =>
    cellItems(raw)
        .map(String)
        .filter((f) => f !== id);

// ----- A new row -----

/** One field of the New row form. */
export interface NewRowField {
    readonly field: FieldDisplay;
    readonly required: boolean;
}

/**
 * The fields New row asks for, in the view's order then the rest: every field a person may
 * write, the key's too unless the server assigns it (a single INTEGER key), never a kind the
 * phone can't write. `types` are the columns' stored types (`GET …/fields`), when read.
 */
export function newRowFields(
    view: Pick<ViewDefinition, 'fields'>,
    fields: readonly FieldDisplay[],
    types: Readonly<Record<string, string>>,
): { fields: NewRowField[]; keyAssigned: boolean } {
    const keys = fields.filter((f) => f.isKey);
    const keyAssigned = keys.length === 1 && (types[keys[0]!.field] ?? '').toUpperCase() === 'INTEGER';
    const order = [...view.fields.map((f) => f.field), ...fields.map((f) => f.field)];
    const seen = new Set<string>();
    const out: NewRowField[] = [];
    for (const name of order) {
        if (seen.has(name)) {
            continue;
        }
        seen.add(name);
        const field = fields.find((f) => f.field === name);
        if (field === undefined || field.missing) {
            continue;
        }
        if (field.isKey) {
            if (!keyAssigned) {
                out.push({
                    field: { ...field, editable: true, kind: field.kind === 'id' ? 'text' : field.kind },
                    required: true,
                });
            }
            continue;
        }
        if (field.editable && WRITABLE_KINDS.has(field.kind)) {
            out.push({ field, required: field.required });
        }
    }
    return { fields: out, keyAssigned };
}

const WRITABLE_KINDS = new Set([
    'text',
    'long_text',
    'url',
    'email',
    'phone',
    'number',
    'currency',
    'percent',
    'checkbox',
    'select',
    'multi_select',
    'person',
    'people',
    'file',
    'date',
    'datetime',
]);

/** The values New row sends: only what the person set (left out, a field takes its default). */
export function newRowValues(values: Readonly<Record<string, WriteCell>>): Record<string, WriteCell> {
    return Object.fromEntries(
        Object.entries(values).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
    );
}

/** The required fields still empty, by name, before anything is sent. */
export function missingRequired(
    fields: readonly NewRowField[],
    values: Readonly<Record<string, WriteCell>>,
): Record<string, string> {
    const sent = newRowValues(values);
    return Object.fromEntries(
        fields
            .filter((f) => f.required && f.field.kind !== 'checkbox' && sent[f.field.field] === undefined)
            .map((f) => [f.field.field, `${f.field.label} is required.`]),
    );
}

/** A `createId` (8 to 64 of `A-Z a-z 0-9 - _`) from random bytes as hex, made once per form. */
export function createIdOf(hex: string): string {
    const clean = hex.replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    return `row-${clean.padEnd(8, '0')}`;
}

// ----- Dates -----

/**
 * The Date a picker opens on for a cell: a calendar date at noon UTC (the picker shows it in UTC,
 * so it is that day wherever the phone is), an instant as it is, today when the cell is empty.
 */
export function pickerDate(value: unknown, time: boolean, now: number = Date.now()): Date {
    if (!time) {
        const day = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
        if (day !== null) {
            return new Date(`${day}T12:00:00Z`);
        }
        const today = new Date(now);
        return new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 12));
    }
    const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return new Date(Number.isFinite(at) ? at : now);
}

/** What a picked Date writes: `YYYY-MM-DD` (its UTC day: the picker shows UTC) or an ISO instant. */
export function pickedValue(date: Date, time: boolean): string {
    return time ? date.toISOString() : date.toISOString().slice(0, 10);
}
