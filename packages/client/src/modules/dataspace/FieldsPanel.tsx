import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
    viewRoutes,
    type FieldDisplayOption,
    type FieldSettingEntry,
    type FieldSettingsResponse,
    type OptionsInUse,
} from '@socio/shared/dataset-views/contract';
import {
    KIND_SETTING_KEYS,
    OPTION_COLORS,
    isKnownFieldKind,
    settingsForKind,
    type FieldSettingsValues,
} from '@socio/shared/dataset-views/field-settings';
import { DATASET_VIEWS_SCHEMA } from '@socio/shared/dataset-views/schema';

import { UNREADABLE_RESPONSE, api } from '../../lib/api';
import { postWrite } from '../../lib/change-channel';

import { fieldClass } from './format';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** How each kind reads in the kind menu. */
const KIND_LABELS: Record<string, string> = {
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
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

/** The view routes' paths as `api()` takes them: it adds `/api` itself. */
const local = (path: string) => path.replace(/^\/api/, '');

/** A save's answer as it came: the status, and the body a refusal carries. */
async function put(path: string, body: unknown) {
    const response = await fetch(`/api${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({ error: UNREADABLE_RESPONSE }))) as Record<string, unknown>;
    if (response.ok) {
        postWrite(path);
    }
    return { status: response.status, data };
}

/**
 * The Fields panel (CB-451): what each column of a
 * table means, for the people who may write the dataset. Each field's
 * kind (only those its column's type takes), label and kind-specific
 * settings, saved with the version it was opened at; a save someone beat
 * reloads the field as it is now, and removing options rows still use
 * asks first. Readers see nothing here: views show them the fields.
 */
export function FieldsPanel({ datasetId, table }: { datasetId: string; table: string }) {
    const path = local(viewRoutes(datasetId, table).fields);
    // The answer with the path it was read for: one that comes back after
    // the table changed is dropped, and never fills another table's editors.
    const [answer, setAnswer] = useState<{ path: string; fields: FieldSettingsResponse }>();
    const showing = useRef(path);
    showing.current = path;
    const load = useCallback(() => {
        const asked = path;
        return api<FieldSettingsResponse>(`${asked}?schema=${DATASET_VIEWS_SCHEMA}`)
            .then((fields) => showing.current === asked && setAnswer({ path: asked, fields }))
            .catch(() => showing.current === asked && setAnswer(undefined));
    }, [path]);
    useEffect(() => {
        setAnswer(undefined);
        void load();
    }, [load]);
    if (answer?.path !== path || !answer.fields.canEdit) {
        return null;
    }
    return (
        <Card data-slot="dataset-fields">
            <CardHeader>
                <CardTitle>Fields</CardTitle>
                <CardDescription>
                    What each column of {table} means: its kind, label and settings. Views format, filter and edit by
                    them.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
                {answer.fields.fields.map((entry) => (
                    <FieldEditor
                        key={`${path}:${entry.field}:${entry.version}:${entry.missing ? 'missing' : ''}`}
                        datasetId={datasetId}
                        table={table}
                        entry={entry}
                        reload={load}
                    />
                ))}
            </CardContent>
        </Card>
    );
}

let optionCount = 0;
/** A new option's id: stable once saved, never derived from its label. */
const newOptionId = () => `opt_${Date.now().toString(36)}${(optionCount++).toString(36)}`;

function FieldEditor({
    datasetId,
    table,
    entry,
    reload,
}: {
    datasetId: string;
    table: string;
    entry: FieldSettingEntry;
    reload: () => unknown;
}) {
    const [kind, setKind] = useState(entry.kind);
    const [label, setLabel] = useState(entry.label === entry.field ? '' : entry.label);
    const [settings, setSettings] = useState<FieldSettingsValues>(entry.settings);
    const [problems, setProblems] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [inUse, setInUse] = useState<OptionsInUse>();
    const name = `${table}.${entry.field}`;
    if (entry.missing) {
        return (
            <div data-slot="dataset-field" className="rounded-md border p-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{entry.label}</span>: missing column. Its setting (
                {kindLabel(entry.kind)}) is kept and ignored until a column named {entry.field} is back.
            </div>
        );
    }
    const keys = KIND_SETTING_KEYS[kind as keyof typeof KIND_SETTING_KEYS] ?? [];
    const set = (patch: Partial<FieldSettingsValues>) => setSettings((current) => ({ ...current, ...patch }));
    const options = settings.options ?? [];
    const setOption = (index: number, patch: Partial<FieldDisplayOption>) =>
        set({ options: options.map((option, i) => (i === index ? { ...option, ...patch } : option)) });
    const save = async (confirmRemovedOptions = false) => {
        setBusy(true);
        setProblems([]);
        try {
            const { status, data } = await put(local(viewRoutes(datasetId, table).field(entry.field)), {
                schema: DATASET_VIEWS_SCHEMA,
                kind,
                ...(label.trim() ? { label: label.trim() } : {}),
                // Only this kind's settings: a hidden one from another kind never blocks the save.
                settings: isKnownFieldKind(kind) ? settingsForKind(kind, settings) : settings,
                baseVersion: entry.version,
                ...(confirmRemovedOptions ? { confirmRemovedOptions: true } : {}),
            });
            if (status === 200) {
                setInUse(undefined);
                toast.success(`Saved ${label.trim() || entry.field}.`);
                await reload();
            } else if (status === 409 && data.code === 'options_in_use') {
                setInUse(data as unknown as OptionsInUse);
            } else if (status === 409) {
                toast.error(String(data.error ?? 'Someone changed this field.'));
                await reload();
            } else if (status === 400 && Array.isArray(data.problems)) {
                setProblems((data.problems as Array<{ message: string }>).map((problem) => problem.message));
            } else {
                toast.error(String(data.error ?? `Could not save (${status}).`));
            }
        } catch {
            toast.error('Could not save the field.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <div data-slot="dataset-field" className="grid gap-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium break-all">{entry.field}</span>
                <span className="text-xs text-muted-foreground">
                    {entry.type}
                    {entry.isKey ? ' · key' : ''}
                    {entry.declaredBy ? ` · set by ${entry.declaredBy}` : ''}
                </span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1">
                    Kind
                    <select
                        aria-label={`Kind of ${name}`}
                        className={`${fieldClass} w-44`}
                        value={kind}
                        onChange={(event) => setKind(event.target.value)}
                    >
                        {(entry.kinds.includes(kind) ? entry.kinds : [kind, ...entry.kinds]).map((option) => (
                            <option key={option} value={option}>
                                {kindLabel(option)}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="grid gap-1">
                    Label
                    <input
                        aria-label={`Label of ${name}`}
                        className={`${fieldClass} w-48`}
                        maxLength={100}
                        placeholder={entry.field}
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                    />
                </label>
                {keys.includes('currency') && (
                    <label className="grid gap-1">
                        Currency
                        <input
                            aria-label={`Currency of ${name}`}
                            className={`${fieldClass} w-24 uppercase`}
                            maxLength={3}
                            placeholder="USD"
                            value={settings.currency ?? ''}
                            onChange={(event) => set({ currency: event.target.value.toUpperCase() || undefined })}
                        />
                    </label>
                )}
                {keys.includes('decimals') && (
                    <label className="grid gap-1">
                        Decimals
                        <input
                            type="number"
                            min={0}
                            max={20}
                            aria-label={`Decimals of ${name}`}
                            className={`${fieldClass} w-20`}
                            value={settings.decimals ?? ''}
                            onChange={(event) =>
                                set({ decimals: event.target.value === '' ? undefined : Number(event.target.value) })
                            }
                        />
                    </label>
                )}
                {keys.includes('unit') && (
                    <label className="grid gap-1">
                        Unit
                        <input
                            aria-label={`Unit of ${name}`}
                            className={`${fieldClass} w-24`}
                            maxLength={32}
                            value={settings.unit ?? ''}
                            onChange={(event) => set({ unit: event.target.value || undefined })}
                        />
                    </label>
                )}
                {keys.includes('dateFormat') && (
                    <label className="grid gap-1">
                        Show as
                        <select
                            aria-label={`Date format of ${name}`}
                            className={`${fieldClass} w-36`}
                            value={settings.dateFormat ?? ''}
                            onChange={(event) =>
                                set({
                                    dateFormat: (event.target.value || undefined) as 'date' | 'datetime' | undefined,
                                })
                            }
                        >
                            <option value="">As stored</option>
                            <option value="date">Date</option>
                            <option value="datetime">Date and time</option>
                        </select>
                    </label>
                )}
                {keys.includes('minorUnits') && (
                    <label className="flex items-center gap-2 pb-2">
                        <input
                            type="checkbox"
                            checked={!!settings.minorUnits}
                            onChange={(event) => set({ minorUnits: event.target.checked || undefined })}
                        />
                        Stored in cents
                    </label>
                )}
                {keys.includes('allowSocios') && (
                    <label className="flex items-center gap-2 pb-2">
                        <input
                            type="checkbox"
                            checked={!!settings.allowSocios}
                            onChange={(event) => set({ allowSocios: event.target.checked || undefined })}
                        />
                        Socios too
                    </label>
                )}
                <Button size="sm" disabled={busy} onClick={() => void save()}>
                    Save
                </Button>
            </div>
            {keys.includes('options') && (
                <ul className="grid gap-1" aria-label={`Options of ${name}`}>
                    {options.map((option, index) => (
                        <li key={option.id} className="flex flex-wrap items-center gap-2">
                            <input
                                aria-label={`Option ${index + 1} of ${name}`}
                                className={`${fieldClass} w-48`}
                                maxLength={100}
                                value={option.label}
                                onChange={(event) => setOption(index, { label: event.target.value })}
                            />
                            <select
                                aria-label={`Color of option ${index + 1} of ${name}`}
                                className={`${fieldClass} w-28`}
                                value={option.color}
                                onChange={(event) => setOption(index, { color: event.target.value })}
                            >
                                {(OPTION_COLORS as readonly string[]).includes(option.color) ? null : (
                                    <option value={option.color}>{option.color}</option>
                                )}
                                {OPTION_COLORS.map((color) => (
                                    <option key={color} value={color}>
                                        {color}
                                    </option>
                                ))}
                            </select>
                            <Button
                                variant="outline"
                                size="sm"
                                aria-label={`Remove option ${option.label || index + 1} of ${name}`}
                                onClick={() => set({ options: options.filter((_, i) => i !== index) })}
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                    <li>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                set({
                                    options: [
                                        ...options,
                                        {
                                            id: newOptionId(),
                                            label: '',
                                            color: OPTION_COLORS[options.length % OPTION_COLORS.length]!,
                                        },
                                    ],
                                })
                            }
                        >
                            <Plus /> Add option
                        </Button>
                    </li>
                </ul>
            )}
            {!!problems.length && (
                <ul role="alert" className="grid gap-0.5 text-destructive">
                    {problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                    ))}
                </ul>
            )}
            <AlertDialog open={!!inUse} onOpenChange={(open) => !open && setInUse(undefined)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove options rows still use?</AlertDialogTitle>
                        <AlertDialogDescription>{inUse?.error}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <ul className="grid gap-0.5 text-sm">
                        {inUse?.inUse.map((option) => (
                            <li key={option.id}>
                                {option.label}: {option.rows} {option.rows === 1 ? 'row' : 'rows'}
                            </li>
                        ))}
                    </ul>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep them</AlertDialogCancel>
                        <Button variant="destructive" disabled={busy} onClick={() => void save(true)}>
                            Remove anyway
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
