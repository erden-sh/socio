import { type StaticScreenProps, useNavigation } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { Alert, Switch, View } from 'react-native';

import type { FieldSettingEntry, FieldSettingsResponse } from '@socio/shared/dataset-views/contract';
import { MODULE_IDS } from '@socio/shared/modules';

import { useHasWorkspaceScope } from '../live';
import { useNativeBar } from '../navigation/native-bar';
import { datasetFieldAction } from '../navigation/tabs';
import { randomId } from '../platform/crypto';
import {
    COLOR_LABELS,
    type FieldForm,
    fieldForm,
    fieldFormProblems,
    fieldLine,
    fieldSave,
    KIND_SETTING_KEYS,
    kindLabel,
    movedOption,
    newOption,
    OPTION_COLORS,
    optionsInUseCopy,
    REFUSAL_COPY,
    refusalCopy,
} from '../shell/dataset-writes';
import { moduleEntry } from '../shell/modules';
import type { TableRef } from '../sync/view-source';
import { AppSymbol, Banner, Button, Field, Screen, SegmentedControl, Text } from '../ui';
import { EmptyState } from '../ui/empty-state';

import { ActionMenu } from './action-menu';
import { OptionChip } from './dataset-layouts';
import { useViewSource } from './dataset-source';
import { ListRow, PageIntro, Section, StatusBanners } from './shell-parts';

// A table's field settings (CB-469, CB-451):
// - `DatasetFields`: every field from `GET …/fields`, its kind and why it
//   can't change when it can't (a removed column, the key); a person who may
//   write the dataset (`canEdit`) opens one.
// - `DatasetField`: its name, its kind (the kinds the column's type takes, in
//   the system's menu) and the kind's settings: a select's options (name,
//   color, order, add, remove), a currency's code, cents and decimals, a
//   number's decimals and unit, a date's format, a person field's socios.
//   Save in the bar is `PUT …/fields/:field` at the version read: a
//   `field_conflict` asks Take theirs or Keep mine (saved again at theirs'
//   version), `options_in_use` asks before the options rows hold go (their
//   values stay, "Unknown option"), every other refusal in plain words.

const DATA = moduleEntry(MODULE_IDS.data);

type ListParams = { datasetId: string; table: string; preview?: boolean };
type FieldParams = ListParams & { field: string };

export function DatasetFieldsScreen({ route }: StaticScreenProps<ListParams>) {
    return useHasWorkspaceScope() ? <DatasetFields params={route.params} /> : null;
}

export function DatasetFieldScreen({ route }: StaticScreenProps<FieldParams>) {
    return useHasWorkspaceScope() ? <DatasetField params={route.params} /> : null;
}

/** Reads the fields, again when the screen comes back into view. */
function useFields(params: ListParams) {
    const navigation = useNavigation();
    const source = useViewSource(params.preview === true);
    const [answer, setAnswer] = useState<FieldSettingsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [reload, setReload] = useState(0);
    const seen = useRef(false);
    useEffect(
        () =>
            navigation.addListener('focus', () => {
                if (seen.current) {
                    setReload((n) => n + 1);
                }
                seen.current = true;
            }),
        [navigation],
    );
    useEffect(() => {
        let live = true;
        source
            .fields({ datasetId: params.datasetId, table: params.table })
            .then((fields) => {
                if (live) {
                    setAnswer(fields);
                    setError(null);
                }
            })
            .catch(() => live && setError(REFUSAL_COPY.network));
        return () => {
            live = false;
        };
    }, [source, params.datasetId, params.table, reload]);
    return { source, answer, error, reload: () => setReload((n) => n + 1) };
}

function DatasetFields({ params }: { params: ListParams }) {
    const navigation = useNavigation();
    const { answer, error } = useFields(params);
    useNativeBar({ title: 'Field settings', tone: DATA.tone });
    return (
        <View testID="dataset-fields-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped>
                <StatusBanners />
                <PageIntro
                    subtitle="Each field’s type and settings, for every view of this table."
                    subtitleLines={2}
                    tile={{ tone: DATA.tone, icon: 'settings-2' }}
                />
                {error !== null ? (
                    <EmptyState headline="The fields didn’t load" line={error} testID="dataset-fields-error" />
                ) : answer === null ? (
                    <Text variant="subheadline" tone="muted" className="py-8 text-center">
                        Loading the fields…
                    </Text>
                ) : (
                    <>
                        {answer.canEdit ? null : (
                            <Banner tone="info" testID="dataset-fields-read-only">
                                Only people who can change this dataset change its fields.
                            </Banner>
                        )}
                        <Section title="Fields" testID="dataset-fields-list">
                            {answer.fields.map((entry, index) => {
                                const line = fieldLine(entry, answer.canEdit);
                                const subtitle = line.note === null ? line.kind : `${line.kind} · ${line.note}`;
                                return (
                                    <ListRow
                                        key={entry.field}
                                        first={index === 0}
                                        title={entry.label}
                                        subtitle={subtitle}
                                        accessibilityLabel={`${entry.label}, ${subtitle}`}
                                        {...(line.editable
                                            ? {
                                                  onPress: () =>
                                                      navigation.dispatch(
                                                          datasetFieldAction({ ...params, field: entry.field }),
                                                      ),
                                                  trailing: <AppSymbol name="chevron-right" color="muted-foreground" />,
                                              }
                                            : {
                                                  trailing: (
                                                      <AppSymbol name="lock" size={14} color="muted-foreground" />
                                                  ),
                                              })}
                                        testID={`dataset-fields-${entry.field}`}
                                    />
                                );
                            })}
                        </Section>
                    </>
                )}
            </Screen>
        </View>
    );
}

function DatasetField({ params }: { params: FieldParams }) {
    const navigation = useNavigation();
    const { source, answer, error } = useFields(params);
    const ref: TableRef = { datasetId: params.datasetId, table: params.table };
    const [entry, setEntry] = useState<FieldSettingEntry | null>(null);
    const [form, setForm] = useState<FieldForm | null>(null);
    const [saving, setSaving] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [tried, setTried] = useState(false);
    const read = answer?.fields.find((f) => f.field === params.field) ?? null;
    if (read !== null && entry === null) {
        setEntry(read);
        setForm(fieldForm(read));
    }
    const canEdit = answer?.canEdit === true && entry !== null && entry.missing !== true;
    const problems = form === null ? {} : fieldFormProblems(form);
    const changed = entry !== null && form !== null && JSON.stringify(fieldForm(entry)) !== JSON.stringify(form);

    const save = async (at: FieldSettingEntry, confirm = false) => {
        if (form === null) {
            return;
        }
        setTried(true);
        if (Object.keys(fieldFormProblems(form)).length > 0) {
            return;
        }
        setSaving(true);
        setRefusal(null);
        const result = await source.saveField(ref, params.field, fieldSave(form, at.version, confirm));
        setSaving(false);
        if (result.outcome === 'saved') {
            setEntry(result.saved.field);
            setForm(fieldForm(result.saved.field));
            navigation.goBack();
        } else if (result.outcome === 'conflict') {
            const current = result.conflict.current;
            Alert.alert('Changed by someone else', REFUSAL_COPY.field_conflict, [
                {
                    text: 'Take theirs',
                    style: 'cancel',
                    onPress: () => {
                        setEntry(current);
                        setForm(fieldForm(current));
                    },
                },
                {
                    text: 'Keep mine',
                    onPress: () => {
                        setEntry(current);
                        void save(current, confirm);
                    },
                },
            ]);
        } else if (result.outcome === 'in-use') {
            const ask = optionsInUseCopy(result.inUse.inUse);
            Alert.alert(ask.title, ask.message, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => void save(at, true) },
            ]);
        } else {
            setRefusal(refusalCopy(result));
        }
    };

    useNativeBar({
        title: entry?.label ?? 'Field',
        tone: DATA.tone,
        right: canEdit
            ? [
                  {
                      id: 'dataset-field-save',
                      label: saving ? 'Saving…' : 'Save',
                      prominent: true,
                      disabled: saving || !changed,
                      onPress: () => entry !== null && void save(entry),
                  },
              ]
            : [],
    });

    const set = (patch: Partial<FieldForm>) => form !== null && setForm({ ...form, ...patch });
    const keys = form === null ? [] : (KIND_SETTING_KEYS[form.kind] ?? []);
    const shownProblem = (key: keyof typeof problems) => (tried ? problems[key] : undefined);

    return (
        <View testID="dataset-field-screen" className="flex-1 bg-screen" collapsable={false}>
            <Screen edges={['right', 'bottom', 'left']} grouped>
                <StatusBanners />
                {error !== null ? (
                    <EmptyState headline="This field didn’t load" line={error} testID="dataset-field-error" />
                ) : entry === null || form === null ? (
                    <Text variant="subheadline" tone="muted" className="py-8 text-center">
                        {answer === null ? 'Loading the field…' : 'This field isn’t in the table any more.'}
                    </Text>
                ) : (
                    <View className="gap-5">
                        {refusal === null ? null : (
                            <Banner tone="error" testID="dataset-field-refused">
                                {refusal}
                            </Banner>
                        )}
                        {entry.declaredBy === undefined ? null : (
                            <Banner tone="info" testID="dataset-field-declared">
                                {`Set by ${entry.declaredBy.replace(/^plugin:/, '')}. Your changes are kept when it updates.`}
                            </Banner>
                        )}
                        <Field
                            label="Name"
                            value={form.label}
                            onChangeText={(label) => set({ label })}
                            editable={canEdit}
                            {...(shownProblem('label') === undefined ? {} : { error: shownProblem('label') })}
                            testID="dataset-field-label"
                        />
                        <View className="gap-1.5">
                            <Text variant="subheadline" weight="medium">
                                Type
                            </Text>
                            <ActionMenu
                                trigger="press"
                                label={`Type, ${kindLabel(form.kind)}`}
                                testID="dataset-field-kind"
                                disabled={!canEdit || entry.kinds.length <= 1}
                                request={{
                                    title: `Types a ${entry.type || 'column'} column takes`,
                                    actions: entry.kinds.map((kind) => ({
                                        name: kind,
                                        label: kindLabel(kind),
                                        checked: kind === form.kind,
                                    })),
                                    onAction: (kind) => set({ kind }),
                                }}
                            >
                                <View className="min-h-11 flex-row items-center gap-2 rounded-md border border-input px-3">
                                    <Text className="min-w-0 flex-1">{kindLabel(form.kind)}</Text>
                                    {canEdit && entry.kinds.length > 1 ? (
                                        <AppSymbol name="chevron-down" size={16} color="muted-foreground" />
                                    ) : null}
                                </View>
                            </ActionMenu>
                        </View>
                        {keys.includes('options') ? (
                            <OptionsEditor
                                form={form}
                                editable={canEdit}
                                problem={shownProblem('options')}
                                onChange={(options) => set({ options })}
                            />
                        ) : null}
                        {keys.includes('currency') ? (
                            <Field
                                label="Currency"
                                hint="Its ISO 4217 code, like USD or EUR."
                                value={form.currency}
                                autoCapitalize="characters"
                                maxLength={3}
                                onChangeText={(currency) => set({ currency: currency.toUpperCase() })}
                                editable={canEdit}
                                {...(shownProblem('currency') === undefined ? {} : { error: shownProblem('currency') })}
                                testID="dataset-field-currency"
                            />
                        ) : null}
                        {keys.includes('minorUnits') ? (
                            <SwitchRow
                                label="Stored in cents"
                                hint="The column holds whole minor units: 1999 shows as 19.99."
                                value={form.minorUnits}
                                disabled={!canEdit}
                                onChange={(minorUnits) => set({ minorUnits })}
                                testID="dataset-field-minor-units"
                            />
                        ) : null}
                        {keys.includes('decimals') ? (
                            <Field
                                label="Decimal places"
                                hint="Leave empty for as many as the value has."
                                value={form.decimals}
                                keyboardType="number-pad"
                                onChangeText={(decimals) => set({ decimals })}
                                editable={canEdit}
                                {...(shownProblem('decimals') === undefined ? {} : { error: shownProblem('decimals') })}
                                testID="dataset-field-decimals"
                            />
                        ) : null}
                        {keys.includes('unit') ? (
                            <Field
                                label="Unit"
                                hint="Shown after each value, like “kg” or “people”."
                                value={form.unit}
                                onChangeText={(unit) => set({ unit })}
                                editable={canEdit}
                                {...(shownProblem('unit') === undefined ? {} : { error: shownProblem('unit') })}
                                testID="dataset-field-unit"
                            />
                        ) : null}
                        {keys.includes('dateFormat') ? (
                            <View className="gap-1.5">
                                <Text variant="subheadline" weight="medium">
                                    Shows
                                </Text>
                                <SegmentedControl
                                    options={[
                                        { value: 'date', label: 'Date', testID: 'dataset-field-format-date' },
                                        {
                                            value: 'datetime',
                                            label: 'Date and time',
                                            testID: 'dataset-field-format-datetime',
                                        },
                                    ]}
                                    selected={form.dateFormat}
                                    onSelect={(dateFormat) => canEdit && set({ dateFormat })}
                                    accessibilityLabel="Shows"
                                    testID="dataset-field-format"
                                />
                            </View>
                        ) : null}
                        {keys.includes('allowSocios') ? (
                            <SwitchRow
                                label="Socios can be chosen"
                                hint="Besides people, the workspace’s socios."
                                value={form.allowSocios}
                                disabled={!canEdit}
                                onChange={(allowSocios) => set({ allowSocios })}
                                testID="dataset-field-socios"
                            />
                        ) : null}
                        <Text variant="footnote" tone="muted">
                            {`Column ${entry.field}${entry.type === '' ? '' : `, ${entry.type}`}. Changing the type changes how values show and are edited, never the values themselves.`}
                        </Text>
                    </View>
                )}
            </Screen>
        </View>
    );
}

function SwitchRow(props: {
    label: string;
    hint: string;
    value: boolean;
    disabled: boolean;
    onChange: (on: boolean) => void;
    testID: string;
}) {
    return (
        <View className="min-h-11 flex-row items-center gap-3">
            <View className="min-w-0 flex-1">
                <Text>{props.label}</Text>
                <Text variant="footnote" tone="muted">
                    {props.hint}
                </Text>
            </View>
            <Switch
                value={props.value}
                disabled={props.disabled}
                onValueChange={props.onChange}
                accessibilityLabel={props.label}
                testID={props.testID}
            />
        </View>
    );
}

function OptionsEditor(props: {
    form: FieldForm;
    editable: boolean;
    problem: string | undefined;
    onChange: (options: FieldForm['options']) => void;
}) {
    const { options } = props.form;
    const change = (id: string, patch: { label?: string; color?: string }) =>
        props.onChange(options.map((o) => (o.id === id ? { ...o, ...patch } : o)));
    return (
        <View className="gap-2" testID="dataset-field-options">
            <Text variant="subheadline" weight="medium">
                Options
            </Text>
            {options.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    No options yet.
                </Text>
            ) : null}
            {options.map((option, index) => (
                <View key={option.id} className="flex-row items-end gap-1" testID={`dataset-field-option-${option.id}`}>
                    <ActionMenu
                        trigger="press"
                        label={`Color of ${option.label || `option ${index + 1}`}, ${COLOR_LABELS[option.color] ?? option.color}`}
                        testID={`dataset-field-option-${option.id}-color`}
                        disabled={!props.editable}
                        request={{
                            title: 'Color',
                            actions: OPTION_COLORS.map((color) => ({
                                name: color,
                                label: COLOR_LABELS[color] ?? color,
                                checked: color === option.color,
                            })),
                            onAction: (color) => change(option.id, { color }),
                        }}
                    >
                        <View className="min-h-11 justify-center px-1">
                            <OptionChip text=" " color={option.color} />
                        </View>
                    </ActionMenu>
                    <View className="min-w-0 flex-1">
                        <Field
                            label={`Option ${index + 1}`}
                            value={option.label}
                            onChangeText={(label) => change(option.id, { label })}
                            editable={props.editable}
                            testID={`dataset-field-option-${option.id}-label`}
                        />
                    </View>
                    {props.editable ? (
                        <>
                            <Button
                                label={`Move ${option.label || `option ${index + 1}`} up`}
                                icon="arrow-up"
                                iconOnly
                                variant="ghost"
                                disabled={index === 0}
                                onPress={() => props.onChange(movedOption(options, option.id, -1))}
                            />
                            <Button
                                label={`Remove ${option.label || `option ${index + 1}`}`}
                                icon="trash-2"
                                iconOnly
                                variant="ghost"
                                onPress={() => props.onChange(options.filter((o) => o.id !== option.id))}
                                testID={`dataset-field-option-${option.id}-remove`}
                            />
                        </>
                    ) : null}
                </View>
            ))}
            {props.problem === undefined ? null : (
                <Text variant="footnote" tone="destructive">
                    {props.problem}
                </Text>
            )}
            {props.editable ? (
                <View className="flex-row">
                    <Button
                        label="Add option"
                        icon="plus"
                        variant="ghost"
                        onPress={() => props.onChange([...options, newOption(options, randomId())])}
                        testID="dataset-field-option-add"
                    />
                </View>
            ) : null}
        </View>
    );
}
