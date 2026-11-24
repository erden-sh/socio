import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';

import type { FieldDisplay, ViewFile, ViewListResponse, WriteCell } from '@socio/shared/dataset-views/contract';
import type { ViewDefinition } from '@socio/shared/dataset-views/definition';
import { formatCell, isChecked } from '@socio/shared/dataset-views/format';
import { MODULE_IDS } from '@socio/shared/modules';

import { useHasWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { randomId } from '../platform/crypto';
import { editText, fieldEditor, parseEdit } from '../shell/dataset-view';
import {
    createIdOf,
    missingRequired,
    newRowFields,
    newRowValues,
    problemsByField,
    REFUSAL_COPY,
    refusalCopy,
    withFile,
    withoutFile,
} from '../shell/dataset-writes';
import { moduleEntry } from '../shell/modules';
import type { TableRef } from '../sync/view-source';
import { AppSymbol, Banner, Button, Field, Screen, Text } from '../ui';
import { EmptyState } from '../ui/empty-state';

import { DateField } from './dataset-date-field';
import { FileCell, PersonPicker, useDatasetUpload, usePeople } from './dataset-pickers';
import { OptionPicker } from './dataset-sheets';
import { datasetFormat, useViewSource } from './dataset-source';
import { useRouteSheet } from './route-sheet';
import { StatusBanners } from './shell-parts';

// New row (CB-469, CB-451), a native form over the view's
// fields (`newRowFields`: the view's order, then the table's other writable
// fields; the key only when the server doesn't assign it), each edited by its
// kind as the record sheet edits it: text and numbers typed, a checkbox's
// switch, a select's options, people from the directory (a sheet), the
// system's date picker, files through the attach picker. Save in the bar is
// `POST …/rows` with the values set and a `createId` made once per form, so
// Save again after no answer (offline, a dropped connection) answers the row
// the first one made rather than adding a second. Online only, never queued:
// the outbox kind waits for the live server. A 400's problems show
// under their fields, `key_taken` under the key, anything else in words above.

const DATA = moduleEntry(MODULE_IDS.data);

type Params = { datasetId: string; table: string; viewId: string; preview?: boolean };

export function DatasetNewRowScreen({ route }: StaticScreenProps<Params>) {
    return useHasWorkspaceScope() ? <DatasetNewRow params={route.params} /> : null;
}

/** A record without one key (the React Compiler doesn't take a computed key in a pattern). */
function withoutKey(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
    const next = { ...record };
    delete next[key];
    return next;
}

interface Loaded {
    readonly list: ViewListResponse;
    readonly view: ViewDefinition;
    readonly types: Readonly<Record<string, string>>;
}

function DatasetNewRow({ params }: { params: Params }) {
    const navigation = useNavigation();
    const preview = params.preview === true;
    const source = useViewSource(preview);
    const { format } = datasetFormat(preview);
    const ref: TableRef = { datasetId: params.datasetId, table: params.table };
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [values, setValues] = useState<Record<string, WriteCell>>({});
    const [texts, setTexts] = useState<Record<string, string>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [banner, setBanner] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [files, setFiles] = useState<Record<string, ViewFile>>({});
    const [picking, setPicking] = useState<FieldDisplay | null>(null);
    const [createId] = useState(() => createIdOf(randomId()));
    const uploads = useDatasetUpload(source, params.datasetId);

    useEffect(() => {
        let live = true;
        const table = { datasetId: params.datasetId, table: params.table };
        (async () => {
            const [list, definition, fields] = await Promise.all([
                source.list(table),
                source.definition(table, params.viewId),
                source.fields(table).catch(() => null),
            ]);
            const types = Object.fromEntries((fields?.fields ?? []).map((f) => [f.field, f.type]));
            if (live) {
                setLoaded({ list, view: definition.draft?.definition ?? definition.view, types });
            }
        })().catch(() => live && setLoadError(REFUSAL_COPY.network));
        return () => {
            live = false;
        };
    }, [source, params.datasetId, params.table, params.viewId]);

    const form = loaded === null ? null : newRowFields(loaded.view, loaded.list.fields, loaded.types);
    const people = usePeople(
        source,
        form?.fields.some((f) => f.field.kind === 'person' || f.field.kind === 'people') === true,
    );
    const users = Object.fromEntries(
        (people.people ?? []).map((p) => [p.id, { name: p.name, avatar: p.avatar, active: true }]),
    );

    const set = (field: string, to: WriteCell) => {
        setValues((held) => ({ ...held, [field]: to }));
        setErrors((held) => withoutKey(held, field));
    };

    const save = async () => {
        if (form === null || loaded === null || saving) {
            return;
        }
        // Typed fields are read as they are saved, by their kind.
        const typed: Record<string, WriteCell> = { ...values };
        const found: Record<string, string> = {};
        for (const { field } of form.fields) {
            const editor = fieldEditor(field, { write: true });
            if (editor.kind === 'text' || editor.kind === 'number') {
                const parsed = parseEdit(texts[field.field] ?? '', editor);
                if (parsed.ok) {
                    typed[field.field] = parsed.value as WriteCell;
                } else {
                    found[field.field] = parsed.message;
                }
            }
        }
        const missing = { ...missingRequired(form.fields, typed), ...found };
        if (Object.keys(missing).length > 0) {
            setErrors(missing);
            setBanner('Fill in the fields marked below.');
            return;
        }
        setSaving(true);
        setBanner(null);
        const result = await source.createRow(ref, newRowValues(typed), createId);
        setSaving(false);
        if (result.outcome === 'created') {
            navigation.goBack();
            return;
        }
        if (result.outcome === 'invalid') {
            const { fields, other } = problemsByField(result.invalid);
            setErrors(fields);
            setBanner(other.length > 0 ? other.join(' ') : REFUSAL_COPY.invalid);
            return;
        }
        if (result.code === 'key_taken') {
            const key = loaded.list.fields.find((f) => f.isKey);
            if (key !== undefined) {
                setErrors({ [key.field]: REFUSAL_COPY.key_taken });
            }
        }
        setBanner(
            result.code === 'network'
                ? `${REFUSAL_COPY.network} Your row isn’t saved yet; Save sends it again, once.`
                : refusalCopy(result),
        );
    };

    useNativeBar({
        title: 'New row',
        tone: DATA.tone,
        right:
            form === null
                ? []
                : [
                      {
                          id: 'dataset-new-row-save',
                          label: saving ? 'Saving…' : 'Save',
                          prominent: true,
                          disabled: saving || uploads.busy,
                          onPress: () => void save(),
                      },
                  ],
    });

    useRouteSheet(
        picking === null
            ? null
            : {
                  testID: 'dataset-new-row-people-sheet',
                  title: picking.label,
                  tall: true,
                  body: (
                      <PersonPicker
                          label={picking.label}
                          raw={values[picking.field] ?? null}
                          many={picking.kind === 'people'}
                          directory={people.people}
                          directoryError={people.error}
                          known={users}
                          onPick={(to) => {
                              set(picking.field, to);
                              if (picking.kind !== 'people') {
                                  setPicking(null);
                              }
                          }}
                          onDone={() => setPicking(null)}
                          testID="dataset-new-row-people"
                      />
                  ),
              },
        () => setPicking(null),
    );

    const fieldRow = (field: FieldDisplay, required: boolean) => {
        const editor = fieldEditor(field, { write: true });
        const raw = values[field.field] ?? null;
        const problem = errors[field.field];
        const label = required ? `${field.label} (required)` : field.label;
        const caption = (
            <Text variant="subheadline" weight="medium">
                {label}
            </Text>
        );
        const problemLine =
            problem === undefined ? null : (
                <Text variant="footnote" tone="destructive" testID={`dataset-new-row-${field.field}-error`}>
                    {problem}
                </Text>
            );
        switch (editor.kind) {
            case 'text':
            case 'number':
                return (
                    <Field
                        label={label}
                        value={texts[field.field] ?? editText(null, editor)}
                        onChangeText={(text) => {
                            setTexts((held) => ({ ...held, [field.field]: text }));
                            setErrors((held) => withoutKey(held, field.field));
                        }}
                        multiline={editor.kind === 'text' && editor.multiline}
                        {...(editor.kind === 'number' ? { keyboardType: 'decimal-pad' as const } : {})}
                        {...(editor.kind === 'text' && editor.keyboard === 'url'
                            ? { keyboardType: 'url' as const, autoCapitalize: 'none' as const }
                            : {})}
                        {...(editor.kind === 'text' && editor.keyboard === 'email'
                            ? { keyboardType: 'email-address' as const, autoCapitalize: 'none' as const }
                            : {})}
                        {...(editor.kind === 'text' && editor.keyboard === 'phone'
                            ? { keyboardType: 'phone-pad' as const }
                            : {})}
                        {...(problem === undefined ? {} : { error: problem })}
                        testID={`dataset-new-row-${field.field}`}
                    />
                );
            case 'checkbox':
                return (
                    <View className="min-h-11 flex-row items-center gap-3">
                        <Text className="min-w-0 flex-1">{field.label}</Text>
                        <Switch
                            value={isChecked(raw)}
                            onValueChange={(on) => set(field.field, on)}
                            accessibilityLabel={field.label}
                            testID={`dataset-new-row-${field.field}`}
                        />
                    </View>
                );
            case 'select':
            case 'multi':
                return (
                    <View className="gap-1.5" testID={`dataset-new-row-${field.field}`}>
                        {caption}
                        <OptionPicker
                            field={{ field: field.field, raw, text: '' }}
                            editor={editor}
                            onPick={(to) => set(field.field, to)}
                        />
                        {problemLine}
                    </View>
                );
            case 'person': {
                const text = formatCell(raw, field, { ...format, users });
                return (
                    <View className="gap-1.5" testID={`dataset-new-row-${field.field}`}>
                        {caption}
                        <Button
                            label={text === '' ? `Choose ${editor.many ? 'people' : 'a person'}` : text}
                            icon="user-round"
                            variant="secondary"
                            onPress={() => setPicking(field)}
                            testID={`dataset-new-row-${field.field}-choose`}
                        />
                        {problemLine}
                    </View>
                );
            }
            case 'date':
                return (
                    <View className="gap-1.5">
                        {caption}
                        <DateField
                            label={field.label}
                            text={raw === null ? '' : formatCell(raw, field, format)}
                            value={raw}
                            time={editor.time}
                            timeZone={format.timeZone}
                            onChange={(to) => set(field.field, to)}
                            testID={`dataset-new-row-${field.field}`}
                        />
                        {problemLine}
                    </View>
                );
            case 'file':
                return (
                    <View className="gap-1.5">
                        {caption}
                        <FileCell
                            label={field.label}
                            raw={raw}
                            files={files}
                            editable
                            busy={uploads.busy}
                            onAdd={(from) =>
                                void uploads.upload(from).then((uploaded) => {
                                    if (uploaded === null) {
                                        return;
                                    }
                                    if (!uploaded.ok) {
                                        setErrors((held) => ({ ...held, [field.field]: uploaded.message }));
                                        return;
                                    }
                                    setFiles((held) => ({ ...held, [uploaded.id]: uploaded.file }));
                                    setValues((held) => ({
                                        ...held,
                                        [field.field]: withFile(held[field.field], uploaded.id),
                                    }));
                                })
                            }
                            onRemove={(id) => set(field.field, withoutFile(raw, id))}
                            testID={`dataset-new-row-${field.field}`}
                        />
                        {problemLine}
                    </View>
                );
            default:
                return null;
        }
    };

    return (
        <View testID="dataset-new-row-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} keyboardAware>
                <StatusBanners />
                {loadError !== null ? (
                    <EmptyState headline="New row didn’t open" line={loadError} testID="dataset-new-row-error" />
                ) : form === null || loaded === null ? (
                    <Text variant="subheadline" tone="muted" className="py-8 text-center">
                        Opening the form…
                    </Text>
                ) : (
                    <View className="gap-5">
                        <View className="flex-row items-center gap-2">
                            <AppSymbol name="table" size={16} color="muted-foreground" />
                            <Text variant="subheadline" tone="muted" className="min-w-0 flex-1">
                                {`In ${loaded.list.table.title}${form.keyAssigned ? '. Its ID is given when it’s saved.' : '.'}`}
                            </Text>
                        </View>
                        {banner === null ? null : (
                            <Banner tone="error" testID="dataset-new-row-refused">
                                {banner}
                            </Banner>
                        )}
                        {form.fields.map(({ field, required }) => (
                            <View key={field.field}>{fieldRow(field, required)}</View>
                        ))}
                    </View>
                )}
            </Screen>
        </View>
    );
}
