import { useState } from 'react';
import { Pressable, Switch, View } from 'react-native';

import type { FilterOp, OpValueShape } from '@socio/shared/dataset-query/operators';
import {
    DATE_BUCKETS,
    RELATIVE_UNITS,
    type FilterCondition,
    type QueryGroup,
    type QuerySort,
} from '@socio/shared/dataset-query/spec';
import type {
    DirectoryPerson,
    FieldDisplay,
    ViewFile,
    ViewSummary,
    ViewUser,
    WriteCell,
} from '@socio/shared/dataset-views/contract';
import type { ViewDefinition } from '@socio/shared/dataset-views/definition';

import type { PickSource } from '../chat/attachment-tray';
import {
    type BoardView,
    conditionText,
    editText,
    type FieldEditor,
    filterableFields,
    filterDraft,
    filterNode,
    groupableFields,
    layoutIcon,
    MORE_FIELDS,
    type OpenedView,
    operatorChoices,
    parseEdit,
    type RecordField,
    type RecordView,
    toggled,
    toggledOption,
    withColumnHidden,
    withFieldHidden,
    withFieldMoved,
    withOption,
    withPriority,
    withQuery,
} from '../shell/dataset-view';
import { type CellConflictView, withoutFile } from '../shell/dataset-writes';
import { AppSymbol, Button, Field, SegmentedControl, Text } from '../ui';
import { cx } from '../ui/cx';

import { DateField } from './dataset-date-field';
import { OptionChip } from './dataset-layouts';
import { FileCell, PersonPicker } from './dataset-pickers';

// A dataset view's sheets (CB-469, CB-451), each in a native
// sheet (`useRouteSheet`, CB-421): the views of the table; the view's options,
// Filter, Sort, Group and Fields, with every operator and option the web has,
// each change a personal draft of the whole definition (parts this client
// can't read kept, and shown read-only: "Filter set in a newer version"); and
// the record: every field, hidden ones under "More fields", each editable one
// edited in place by its kind (the system's date picker, the people directory,
// the attach picker for files) and saved as a compare-and-set on the value it
// replaces, a conflict showing theirs beside yours with Take theirs or Keep mine.

/** A list of choices, one checked (the sheets' radio rows). */
export function ChoiceRows(props: {
    title?: string;
    choices: readonly {
        id: string;
        label: string;
        icon?: 'table' | 'list' | 'kanban' | 'calendar' | 'layout-grid';
        note?: string;
    }[];
    chosen: string | null;
    onChoose: (id: string) => void;
    testID: string;
}) {
    return (
        <View
            className="gap-1"
            accessibilityRole="radiogroup"
            {...(props.title === undefined ? {} : { accessibilityLabel: props.title })}
        >
            {props.title === undefined ? null : (
                <Text variant="footnote" tone="muted" weight="medium">
                    {props.title}
                </Text>
            )}
            <View className="overflow-hidden rounded-xl border border-border">
                {props.choices.map((choice, index) => {
                    const on = choice.id === props.chosen;
                    return (
                        <Pressable
                            key={choice.id}
                            testID={`${props.testID}-${choice.id}`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                            onPress={() => props.onChoose(choice.id)}
                            className={cx(
                                'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                                index > 0 && 'border-t border-border',
                                on && 'bg-accent',
                            )}
                        >
                            {choice.icon === undefined ? null : (
                                <AppSymbol name={choice.icon} color="muted-foreground" />
                            )}
                            <View className="min-w-0 flex-1">
                                <Text numberOfLines={1}>{choice.label}</Text>
                                {choice.note === undefined ? null : (
                                    <Text variant="footnote" tone="muted" numberOfLines={1}>
                                        {choice.note}
                                    </Text>
                                )}
                            </View>
                            {on ? <AppSymbol name="check" color="primary" /> : null}
                        </Pressable>
                    );
                })}
            </View>
        </View>
    );
}

// ----- The views of the table -----

export function ViewsSheetBody(props: {
    views: readonly ViewSummary[];
    current: string;
    onPick: (id: string) => void;
}) {
    return (
        <ChoiceRows
            choices={props.views.map((view) => ({
                id: view.id,
                label: view.name,
                icon: layoutIcon(view.layout),
                note: [view.visibility === 'personal' ? 'Only you' : 'Shared', view.hasDraft ? 'Changed for you' : null]
                    .filter(Boolean)
                    .join(' · '),
            }))}
            chosen={props.current}
            onChoose={props.onPick}
            testID="dataset-views"
        />
    );
}

// ----- Filter, Sort, Group, Fields -----

export type OptionsTab = 'filter' | 'sort' | 'group' | 'fields';
const TABS: readonly { value: OptionsTab; label: string }[] = [
    { value: 'filter', label: 'Filter' },
    { value: 'sort', label: 'Sort' },
    { value: 'group', label: 'Group' },
    { value: 'fields', label: 'Fields' },
];

export function OptionsSheetBody(props: {
    opened: OpenedView;
    fields: readonly FieldDisplay[];
    board: BoardView | null;
    tab: OptionsTab;
    onTab: (tab: OptionsTab) => void;
    onDraft: (view: ViewDefinition) => void;
}) {
    const { opened, tab } = props;
    return (
        <View className="gap-4">
            <SegmentedControl
                options={TABS.map((t) => ({ ...t, testID: `dataset-options-${t.value}` }))}
                selected={tab}
                onSelect={props.onTab}
                accessibilityLabel="View options"
                testID="dataset-options-tabs"
            />
            {opened.notes.length === 0 ? null : (
                <Text variant="footnote" tone="muted" testID="dataset-options-note">
                    {opened.notes.join(' ')}
                </Text>
            )}
            {tab === 'filter' ? (
                <FilterTab {...props} />
            ) : tab === 'sort' ? (
                <SortTab {...props} />
            ) : tab === 'group' ? (
                <GroupTab {...props} />
            ) : (
                <FieldsTab {...props} />
            )}
            <Text variant="footnote" tone="muted">
                Changes here are yours until someone who may saves them for everyone.
            </Text>
        </View>
    );
}

function Row(props: { children: React.ReactNode; first?: boolean; testID?: string }) {
    return (
        <View
            testID={props.testID}
            className={cx('min-h-11 flex-row items-center gap-2 px-3 py-2', !props.first && 'border-t border-border')}
        >
            {props.children}
        </View>
    );
}

function Group({ children, testID }: { children: React.ReactNode; testID?: string }) {
    return (
        <View testID={testID} className="overflow-hidden rounded-xl border border-border">
            {children}
        </View>
    );
}

function FilterTab(props: {
    opened: OpenedView;
    fields: readonly FieldDisplay[];
    onDraft: (view: ViewDefinition) => void;
}) {
    const { opened } = props;
    const view = opened.reading.view;
    const readOnly = opened.reading.readOnly.filter;
    const draft = filterDraft(readOnly ? undefined : view.query.filter);
    const [adding, setAdding] = useState(false);
    const save = (conditions: readonly FilterCondition[], mode?: 'all' | 'any') =>
        props.onDraft(withQuery(view, { filter: filterNode({ mode: mode ?? draft.mode, conditions }) ?? null }));
    if (readOnly) {
        return (
            <Text variant="subheadline" tone="muted" testID="dataset-filter-readonly">
                {opened.reading.queryNote ?? 'Filter set in a newer version'}: it still applies, and stays as it is.
            </Text>
        );
    }
    return (
        <View className="gap-3">
            {draft.conditions.length > 1 ? (
                <SegmentedControl
                    options={[
                        { value: 'all', label: 'All of these', testID: 'dataset-filter-all' },
                        { value: 'any', label: 'Any of these', testID: 'dataset-filter-any' },
                    ]}
                    selected={draft.mode}
                    onSelect={(mode) => save(draft.conditions, mode)}
                    accessibilityLabel="Match"
                />
            ) : null}
            {draft.conditions.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    No filter: every row shows.
                </Text>
            ) : (
                <Group testID="dataset-filter-conditions">
                    {draft.conditions.map((condition, index) => (
                        <Row key={`${condition.field}-${index}`} first={index === 0}>
                            <Text className="min-w-0 flex-1">{conditionText(condition, opened.fields)}</Text>
                            <Button
                                label="Remove"
                                icon="x"
                                iconOnly
                                variant="ghost"
                                onPress={() => save(draft.conditions.filter((_, i) => i !== index))}
                                testID={`dataset-filter-remove-${index}`}
                            />
                        </Row>
                    ))}
                </Group>
            )}
            {draft.nested ? (
                <Text variant="footnote" tone="muted">
                    A group inside this filter was set on the web; it stays as it is.
                </Text>
            ) : null}
            {adding ? (
                <ConditionForm
                    fields={filterableFields(props.fields)}
                    onCancel={() => setAdding(false)}
                    onAdd={(condition) => {
                        setAdding(false);
                        save([...draft.conditions, condition]);
                    }}
                />
            ) : (
                <Button
                    label="Add filter"
                    icon="plus"
                    variant="tinted"
                    onPress={() => setAdding(true)}
                    testID="dataset-filter-add"
                />
            )}
        </View>
    );
}

/** A new condition: its field, its operator (every one the kind takes), then the value it wants. */
function ConditionForm(props: {
    fields: readonly FieldDisplay[];
    onCancel: () => void;
    onAdd: (condition: FilterCondition) => void;
}) {
    const [field, setField] = useState<FieldDisplay | null>(null);
    const [op, setOp] = useState<{ op: FilterOp; shape: OpValueShape } | null>(null);
    const [text, setText] = useState('');
    const [second, setSecond] = useState('');
    const [picked, setPicked] = useState<readonly string[]>([]);
    const [unit, setUnit] = useState<(typeof RELATIVE_UNITS)[number]>('day');
    if (field === null) {
        return (
            <ChoiceRows
                title="Filter by"
                choices={props.fields.map((f) => ({ id: f.field, label: f.label }))}
                chosen={null}
                onChoose={(id) => setField(props.fields.find((f) => f.field === id) ?? null)}
                testID="dataset-filter-field"
            />
        );
    }
    const ops = operatorChoices(field);
    if (op === null) {
        return (
            <ChoiceRows
                title={field.label}
                choices={ops.map((o) => ({ id: o.op, label: o.label }))}
                chosen={null}
                onChoose={(id) => setOp(ops.find((o) => o.op === id) ?? null)}
                testID="dataset-filter-op"
            />
        );
    }
    const options =
        field.kind === 'checkbox'
            ? [
                  { id: 'true', label: 'Checked' },
                  { id: 'false', label: 'Unchecked' },
              ]
            : field.settings.options;
    const number = ['number', 'currency', 'percent'].includes(field.kind);
    const typed = (value: string): string | number | boolean => (number ? Number(value) : value);
    const value = (): FilterCondition['value'] | undefined => {
        switch (op.shape) {
            case 'none':
                return undefined;
            case 'one':
                if (field.kind === 'checkbox') {
                    return picked[0] === 'true';
                }
                if (options !== undefined) {
                    return picked[0];
                }
                return typed(text);
            case 'list':
                return options !== undefined ? [...picked] : text.split(',').map((t) => typed(t.trim()));
            case 'pair':
                return [typed(text), typed(second)];
            case 'range':
                return { relative: 'next', count: Math.max(1, Number(text) || 1), unit };
        }
    };
    const ready =
        op.shape === 'none' ||
        (options !== undefined && op.shape !== 'pair' && op.shape !== 'range' ? picked.length > 0 : text.trim() !== '');
    return (
        <View className="gap-3" testID="dataset-filter-value">
            <Text variant="subheadline" weight="medium">
                {field.label} {ops.find((o) => o.op === op.op)?.label}
            </Text>
            {op.shape === 'none' ? null : op.shape === 'range' ? (
                <>
                    <Field
                        label="The next"
                        value={text}
                        onChangeText={setText}
                        keyboardType="number-pad"
                        testID="dataset-filter-count"
                    />
                    <SegmentedControl
                        options={RELATIVE_UNITS.slice(0, 4).map((u) => ({ value: u, label: `${u}s` }))}
                        selected={unit}
                        onSelect={setUnit}
                        accessibilityLabel="Unit"
                    />
                </>
            ) : options !== undefined && op.shape !== 'pair' ? (
                <Group>
                    {options.map((option, index) => {
                        const on = picked.includes(option.id);
                        return (
                            <Pressable
                                key={option.id}
                                onPress={() =>
                                    setPicked(
                                        op.shape === 'list'
                                            ? on
                                                ? picked.filter((p) => p !== option.id)
                                                : [...picked, option.id]
                                            : [option.id],
                                    )
                                }
                                accessibilityRole={op.shape === 'list' ? 'checkbox' : 'radio'}
                                accessibilityState={{ checked: on }}
                                className={cx(
                                    'min-h-11 flex-row items-center gap-3 px-3',
                                    index > 0 && 'border-t border-border',
                                )}
                                testID={`dataset-filter-option-${option.id}`}
                            >
                                <Text className="flex-1">{option.label}</Text>
                                {on ? <AppSymbol name="check" color="primary" /> : null}
                            </Pressable>
                        );
                    })}
                </Group>
            ) : (
                <>
                    <Field
                        label={
                            op.shape === 'pair' ? 'From' : op.shape === 'list' ? 'Values, separated by commas' : 'Value'
                        }
                        value={text}
                        onChangeText={setText}
                        {...(number ? { keyboardType: 'decimal-pad' as const } : {})}
                        {...(['date', 'datetime'].includes(field.kind) ? { placeholder: 'YYYY-MM-DD' } : {})}
                        testID="dataset-filter-text"
                    />
                    {op.shape === 'pair' ? (
                        <Field label="To" value={second} onChangeText={setSecond} testID="dataset-filter-second" />
                    ) : null}
                </>
            )}
            <View className="flex-row justify-end gap-3">
                <Button label="Cancel" variant="ghost" onPress={props.onCancel} />
                <Button
                    label="Add"
                    disabled={!ready}
                    onPress={() => {
                        const v = value();
                        props.onAdd({ field: field.field, op: op.op, ...(v === undefined ? {} : { value: v }) });
                    }}
                    testID="dataset-filter-save"
                />
            </View>
        </View>
    );
}

function SortTab(props: {
    opened: OpenedView;
    fields: readonly FieldDisplay[];
    onDraft: (view: ViewDefinition) => void;
}) {
    const view = props.opened.reading.view;
    const [adding, setAdding] = useState(false);
    if (props.opened.reading.readOnly.sort) {
        return (
            <Text variant="subheadline" tone="muted">
                This sort was set in a newer version; it still applies, and stays as it is.
            </Text>
        );
    }
    const sort = (view.query.sort ?? []) as QuerySort[];
    const save = (next: QuerySort[]) => props.onDraft(withQuery(view, { sort: next }));
    const label = (name: string) => props.opened.fields.get(name)?.label ?? name;
    return (
        <View className="gap-3">
            {sort.length === 0 ? (
                <Text variant="subheadline" tone="muted">
                    No sort: rows show in their stored order.
                </Text>
            ) : (
                <Group testID="dataset-sorts">
                    {sort.map((s, index) => (
                        <Row key={`${s.field}-${index}`} first={index === 0}>
                            <Text className="min-w-0 flex-1">{label(s.field)}</Text>
                            <SegmentedControl
                                options={[
                                    { value: 'asc', label: 'Ascending' },
                                    { value: 'desc', label: 'Descending' },
                                ]}
                                selected={s.dir ?? 'asc'}
                                onSelect={(dir) => save(sort.map((x, i) => (i === index ? { ...x, dir } : x)))}
                                accessibilityLabel={`${label(s.field)} order`}
                            />
                            <Button
                                label="Remove"
                                icon="x"
                                iconOnly
                                variant="ghost"
                                onPress={() => save(sort.filter((_, i) => i !== index))}
                            />
                        </Row>
                    ))}
                </Group>
            )}
            {adding ? (
                <ChoiceRows
                    title="Sort by"
                    choices={filterableFields(props.fields)
                        .filter((f) => !sort.some((s) => s.field === f.field))
                        .map((f) => ({ id: f.field, label: f.label }))}
                    chosen={null}
                    onChoose={(id) => {
                        setAdding(false);
                        save([...sort, { field: id, dir: 'asc' }]);
                    }}
                    testID="dataset-sort-field"
                />
            ) : (
                <Button
                    label="Add sort"
                    icon="arrow-up-down"
                    variant="tinted"
                    onPress={() => setAdding(true)}
                    testID="dataset-sort-add"
                />
            )}
        </View>
    );
}

function GroupTab(props: {
    opened: OpenedView;
    fields: readonly FieldDisplay[];
    board: BoardView | null;
    onDraft: (view: ViewDefinition) => void;
}) {
    const { opened } = props;
    const view = opened.reading.view;
    if (opened.layout === 'board') {
        // A board groups by its field, column by column: every column listed, hidden ones shown again here.
        const candidates = props.fields.filter((f) => ['select', 'person', 'checkbox'].includes(f.kind) && !f.missing);
        return (
            <View className="gap-3">
                <ChoiceRows
                    title="Columns by"
                    choices={candidates.map((f) => ({ id: f.field, label: f.label }))}
                    chosen={view.options.groupField ?? null}
                    onChoose={(id) =>
                        props.onDraft(withOption(withOption(view, 'columns', undefined), 'groupField', id))
                    }
                    testID="dataset-group-board"
                />
                {props.board === null ? null : (
                    <Group testID="dataset-board-columns-edit">
                        {props.board.columns.map((column, index) => (
                            <Row key={String(column.key)} first={index === 0}>
                                <Text className="min-w-0 flex-1">{column.label}</Text>
                                <Text variant="footnote" tone="muted">
                                    {column.hidden ? 'Hidden' : 'Shown'}
                                </Text>
                                <Switch
                                    value={!column.hidden}
                                    onValueChange={(show) => {
                                        if (props.board !== null) {
                                            props.onDraft(withColumnHidden(view, props.board, column.key, !show));
                                        }
                                    }}
                                    accessibilityLabel={`Show ${column.label}`}
                                    testID={`dataset-column-${String(column.key)}`}
                                />
                            </Row>
                        ))}
                    </Group>
                )}
            </View>
        );
    }
    if (opened.reading.readOnly.groupBy) {
        return (
            <Text variant="subheadline" tone="muted">
                This grouping was set in a newer version; it still applies, and stays as it is.
            </Text>
        );
    }
    const group = (view.query.groupBy?.[0] as Extract<QueryGroup, { field: string }> | undefined) ?? null;
    const field = group === null ? undefined : props.fields.find((f) => f.field === group.field);
    return (
        <View className="gap-3">
            <ChoiceRows
                title="Group by"
                choices={[
                    { id: '', label: 'None' },
                    ...groupableFields(props.fields).map((f) => ({ id: f.field, label: f.label })),
                ]}
                chosen={group?.field ?? ''}
                onChoose={(id) => props.onDraft(withQuery(view, { groupBy: id === '' ? null : [{ field: id }] }))}
                testID="dataset-group-field"
            />
            {field !== undefined && group !== null && ['date', 'datetime'].includes(field.kind) ? (
                <ChoiceRows
                    title="By"
                    choices={DATE_BUCKETS.map((b) => ({ id: b, label: b[0]!.toUpperCase() + b.slice(1) }))}
                    chosen={typeof group.bucket === 'string' ? group.bucket : 'day'}
                    onChoose={(bucket) =>
                        props.onDraft(
                            withQuery(view, {
                                groupBy: [{ field: group.field, bucket: bucket as (typeof DATE_BUCKETS)[number] }],
                            }),
                        )
                    }
                    testID="dataset-group-bucket"
                />
            ) : null}
        </View>
    );
}

function FieldsTab(props: {
    opened: OpenedView;
    fields: readonly FieldDisplay[];
    onDraft: (view: ViewDefinition) => void;
}) {
    const { opened } = props;
    const view = opened.reading.view;
    const listed = view.fields.map((f) => f.field);
    const names = [...listed, ...props.fields.map((f) => f.field).filter((name) => !listed.includes(name))];
    const calendar = opened.layout === 'calendar';
    const dates = props.fields.filter((f) => f.kind === 'date' || f.kind === 'datetime');
    return (
        <View className="gap-3">
            <Group testID="dataset-fields">
                {names.map((name, index) => {
                    const field = opened.fields.get(name);
                    if (field === undefined) {
                        return null;
                    }
                    const entry = view.fields.find((f) => f.field === name);
                    const shown = entry !== undefined && entry.hidden !== true;
                    const first = typeof entry?.priority === 'number';
                    return (
                        <Row key={name} first={index === 0} testID={`dataset-field-${name}`}>
                            <View className="min-w-0 flex-1">
                                <Text numberOfLines={1}>{field.label}</Text>
                                {first ? (
                                    <Text variant="footnote" tone="primary">
                                        Shows first on small screens
                                    </Text>
                                ) : null}
                            </View>
                            <Button
                                label={first ? 'Don’t show first' : 'Show first on small screens'}
                                icon="arrow-up"
                                iconOnly
                                variant={first ? 'tinted' : 'ghost'}
                                disabled={!shown}
                                onPress={() => props.onDraft(withPriority(view, name, !first))}
                                testID={`dataset-field-${name}-priority`}
                            />
                            <Button
                                label="Move down"
                                icon="arrow-down"
                                iconOnly
                                variant="ghost"
                                disabled={entry === undefined}
                                onPress={() => props.onDraft(withFieldMoved(view, name, 1))}
                            />
                            <Switch
                                value={shown}
                                onValueChange={(on) => props.onDraft(withFieldHidden(view, name, !on))}
                                accessibilityLabel={`Show ${field.label}`}
                                testID={`dataset-field-${name}-shown`}
                            />
                        </Row>
                    );
                })}
            </Group>
            {calendar ? (
                <>
                    <ChoiceRows
                        title="Calendar date"
                        choices={dates.map((f) => ({ id: f.field, label: f.label }))}
                        chosen={view.options.dateField ?? null}
                        onChoose={(id) => props.onDraft(withOption(view, 'dateField', id))}
                        testID="dataset-calendar-date"
                    />
                    <ChoiceRows
                        title="Ends"
                        choices={[
                            { id: '', label: 'No end' },
                            ...dates
                                .filter((f) => f.field !== view.options.dateField)
                                .map((f) => ({ id: f.field, label: f.label })),
                        ]}
                        chosen={view.options.endField ?? ''}
                        onChoose={(id) => props.onDraft(withOption(view, 'endField', id))}
                        testID="dataset-calendar-end"
                    />
                </>
            ) : null}
        </View>
    );
}

// ----- The record -----

/** What a cell edit came to, for the sheet to say. */
export type EditState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'saving'; readonly field: string }
    | { readonly kind: 'refused'; readonly field: string; readonly message: string };

/** What the record sheet's pickers need: the directory, the people a cell names, the files and uploads. */
export interface RecordPickers {
    readonly directory: readonly DirectoryPerson[] | null;
    readonly directoryError: string | null;
    /** Opening a person field asks for the directory. */
    readonly onNeedPeople: () => void;
    readonly known: Readonly<Record<string, ViewUser>>;
    readonly files: Readonly<Record<string, ViewFile>>;
    readonly uploading: boolean;
    readonly onAddFile: (field: RecordField, from: PickSource) => void;
    readonly timeZone: string;
}

export function RecordSheetBody(props: {
    record: RecordView;
    state: EditState;
    conflict: CellConflictView | null;
    pickers: RecordPickers;
    onEdit: (field: RecordField, to: WriteCell) => void;
    onKeepMine: () => void;
    onTakeTheirs: () => void;
}) {
    const [showMore, setShowMore] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const fieldRow = (field: RecordField, index: number) => (
        <RecordRow
            key={field.field}
            field={field}
            first={index === 0}
            pickers={props.pickers}
            editing={editing === field.field}
            onEditing={(on) => {
                setEditing(on ? field.field : null);
                if (on && field.editor.kind === 'person') {
                    props.pickers.onNeedPeople();
                }
            }}
            state={props.state}
            onEdit={(to, keepOpen) => {
                if (keepOpen !== true) {
                    setEditing(null);
                }
                props.onEdit(field, to);
            }}
        />
    );
    return (
        <View className="gap-4" testID="dataset-record">
            {props.conflict !== null ? (
                <CellConflictCard
                    conflict={props.conflict}
                    onKeepMine={props.onKeepMine}
                    onTakeTheirs={props.onTakeTheirs}
                />
            ) : props.state.kind === 'refused' ? (
                <Text variant="subheadline" tone="destructive" testID="dataset-record-refused">
                    {props.state.message}
                </Text>
            ) : null}
            <Group testID="dataset-record-fields">{props.record.fields.map(fieldRow)}</Group>
            {props.record.more.length === 0 ? null : (
                <>
                    <Pressable
                        onPress={() => setShowMore(!showMore)}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: showMore }}
                        className="min-h-11 flex-row items-center gap-2"
                        testID="dataset-record-more"
                    >
                        <AppSymbol name={showMore ? 'chevron-down' : 'chevron-right'} color="muted-foreground" />
                        <Text variant="section">{`${MORE_FIELDS} (${props.record.more.length})`}</Text>
                    </Pressable>
                    {showMore ? <Group>{props.record.more.map(fieldRow)}</Group> : null}
                </>
            )}
        </View>
    );
}

/** A cell's conflict (CB-451): theirs, now there, beside yours, and Take theirs or Keep mine. */
export function CellConflictCard(props: {
    conflict: CellConflictView;
    onKeepMine: () => void;
    onTakeTheirs: () => void;
}) {
    const { conflict } = props;
    const side = (label: string, value: string, testID: string) => (
        <View className="min-w-0 flex-1 gap-0.5 rounded-lg bg-card p-2.5" testID={testID}>
            <Text variant="footnote" tone="muted" weight="medium">
                {label}
            </Text>
            <Text selectable>{value === '' ? 'Empty' : value}</Text>
        </View>
    );
    return (
        <View
            className="gap-2.5 rounded-xl border border-paused-banner-border bg-paused-banner p-3"
            testID="dataset-record-conflict"
            accessibilityLiveRegion="polite"
        >
            <View className="flex-row items-center gap-2">
                <AppSymbol name="triangle-alert" size={16} color="foreground" />
                <Text weight="semibold" className="min-w-0 flex-1">{`${conflict.label} changed elsewhere`}</Text>
            </View>
            <Text variant="subheadline">Someone saved a new value while you were editing. Choose which to keep.</Text>
            <View className="flex-row gap-2">
                {side('Theirs, now', conflict.theirs, 'dataset-record-conflict-theirs')}
                {side('Yours', conflict.mine, 'dataset-record-conflict-mine')}
            </View>
            <View className="flex-row justify-end gap-3">
                <Button
                    label="Take theirs"
                    variant="ghost"
                    onPress={props.onTakeTheirs}
                    testID="dataset-record-theirs"
                />
                <Button label="Keep mine" onPress={props.onKeepMine} testID="dataset-record-mine" />
            </View>
        </View>
    );
}

function RecordRow(props: {
    field: RecordField;
    first: boolean;
    pickers: RecordPickers;
    editing: boolean;
    onEditing: (on: boolean) => void;
    state: EditState;
    /** `keepOpen`: a picker that stays while several are chosen (people). */
    onEdit: (to: WriteCell, keepOpen?: boolean) => void;
}) {
    const { field } = props;
    const editor: FieldEditor = field.editor;
    const saving = props.state.kind === 'saving' && props.state.field === field.field;
    const typed = editor.kind === 'text' || editor.kind === 'number';
    const [text, setText] = useState(editText(field.raw, editor));
    const [error, setError] = useState<string | undefined>(undefined);
    const canEdit = editor.kind !== 'readonly' && editor.kind !== 'file';
    const inline = editor.kind === 'date' || editor.kind === 'file';
    return (
        <View
            className={cx('gap-2 px-3 py-2.5', !props.first && 'border-t border-border')}
            testID={`dataset-record-${field.field}`}
        >
            {/* Editing a typed field, its Field says the label: the row's line and value would repeat it. */}
            {props.editing && typed ? null : (
                <View className="flex-row items-center gap-2">
                    <View className="min-w-0 flex-1 gap-0.5">
                        <Text variant="footnote" tone="muted">
                            {field.label}
                        </Text>
                        {editor.kind === 'checkbox' || inline ? null : field.colors !== undefined ? (
                            <View className="flex-row flex-wrap gap-1">
                                {field.text.split(', ').map((part, i) => (
                                    <OptionChip
                                        key={`${part}-${i}`}
                                        text={part}
                                        {...(field.colors?.[i] === undefined ? {} : { color: field.colors[i] })}
                                    />
                                ))}
                            </View>
                        ) : (
                            <Text selectable>{field.text === '' ? '—' : field.text}</Text>
                        )}
                    </View>
                    {editor.kind === 'checkbox' ? (
                        <Switch
                            value={field.text === 'Yes'}
                            disabled={saving}
                            onValueChange={() => props.onEdit(toggled(field.raw) as WriteCell)}
                            accessibilityLabel={field.label}
                            testID={`dataset-record-${field.field}-switch`}
                        />
                    ) : canEdit && !inline && !props.editing ? (
                        <Button
                            label={`Edit ${field.label}`}
                            icon="pencil"
                            iconOnly
                            variant="ghost"
                            busy={saving}
                            onPress={() => {
                                setText(editText(field.raw, editor));
                                setError(undefined);
                                props.onEditing(true);
                            }}
                            testID={`dataset-record-${field.field}-edit`}
                        />
                    ) : editor.kind === 'readonly' ? (
                        <AppSymbol name="lock" size={14} color="muted-foreground" />
                    ) : null}
                </View>
            )}
            {editor.kind === 'date' ? (
                <DateField
                    label={field.label}
                    text={field.text}
                    value={field.raw}
                    time={editor.time}
                    timeZone={props.pickers.timeZone}
                    busy={saving}
                    onChange={(to) => props.onEdit(to)}
                    testID={`dataset-record-${field.field}-date`}
                />
            ) : editor.kind === 'file' ? (
                <FileCell
                    label={field.label}
                    raw={field.raw}
                    files={props.pickers.files}
                    editable
                    busy={props.pickers.uploading || saving}
                    onAdd={(from) => props.pickers.onAddFile(field, from)}
                    onRemove={(id) => props.onEdit(withoutFile(field.raw, id))}
                    testID={`dataset-record-${field.field}-files`}
                />
            ) : !props.editing ? null : typed ? (
                <View className="gap-2">
                    <Field
                        label={field.label}
                        value={text}
                        onChangeText={setText}
                        autoFocus
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
                        {...(error === undefined ? {} : { error })}
                        testID={`dataset-record-${field.field}-input`}
                    />
                    <View className="flex-row justify-end gap-3">
                        <Button label="Cancel" variant="ghost" onPress={() => props.onEditing(false)} />
                        <Button
                            label="Save"
                            onPress={() => {
                                const parsed = parseEdit(text, editor);
                                if (parsed.ok) {
                                    props.onEdit(parsed.value as WriteCell);
                                } else {
                                    setError(parsed.message);
                                }
                            }}
                            testID={`dataset-record-${field.field}-save`}
                        />
                    </View>
                </View>
            ) : editor.kind === 'select' || editor.kind === 'multi' ? (
                <View className="gap-2">
                    <OptionPicker
                        field={field}
                        editor={editor}
                        onPick={(to) => props.onEdit(to, editor.kind === 'multi')}
                    />
                    <Button label="Done" variant="ghost" onPress={() => props.onEditing(false)} />
                </View>
            ) : editor.kind === 'person' ? (
                <PersonPicker
                    label={field.label}
                    raw={field.raw}
                    many={editor.many}
                    directory={props.pickers.directory}
                    directoryError={props.pickers.directoryError}
                    known={props.pickers.known}
                    onPick={(to) => props.onEdit(to, editor.many)}
                    onDone={() => props.onEditing(false)}
                    testID={`dataset-record-${field.field}-people`}
                />
            ) : null}
        </View>
    );
}

/** A select's or multi-select's options, one checked or several (the record and New row). */
export function OptionPicker(props: {
    field: Pick<RecordField, 'field' | 'raw' | 'text'>;
    editor: Extract<FieldEditor, { kind: 'select' | 'multi' }>;
    onPick: (to: WriteCell) => void;
}) {
    const { field, editor } = props;
    return (
        <Group>
            {[...(editor.kind === 'select' ? [{ id: '', label: 'None', color: 'gray' }] : []), ...editor.options].map(
                (option, index) => {
                    const on =
                        editor.kind === 'multi'
                            ? (Array.isArray(field.raw) ? field.raw.map(String) : []).includes(option.id)
                            : option.id === (field.raw ?? '');
                    return (
                        <Pressable
                            key={option.id || 'none'}
                            onPress={() =>
                                props.onPick(
                                    editor.kind === 'multi'
                                        ? (toggledOption(field.raw, option.id) as WriteCell)
                                        : option.id === ''
                                          ? null
                                          : option.id,
                                )
                            }
                            accessibilityRole={editor.kind === 'multi' ? 'checkbox' : 'radio'}
                            accessibilityState={{ checked: on }}
                            className={cx(
                                'min-h-11 flex-row items-center gap-3 px-3',
                                index > 0 && 'border-t border-border',
                            )}
                            testID={`dataset-record-${field.field}-option-${option.id || 'none'}`}
                        >
                            <View className="flex-1">
                                <OptionChip text={option.label} color={option.color} />
                            </View>
                            {on ? <AppSymbol name="check" color="primary" /> : null}
                        </Pressable>
                    );
                },
            )}
        </Group>
    );
}
