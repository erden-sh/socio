import { type ReactNode, useState } from 'react';
import { Pressable, View } from 'react-native';

import { issuePath } from '@socio/shared/issues/issue-board';
import type { IssueLabel } from '@socio/shared/issues/issue-types';

import { useIssueAssignees, useWorkspaceScope } from '../live';
import { randomId } from '../platform/crypto';
import type { ComponentLabels } from '../shell/issue-components';
import {
    ADMIN_ON_WEB,
    type AdminField,
    type AdminFieldName,
    type AdminView,
    assigneePicker,
    type FieldChoice,
    fieldChoices,
    labelChoices,
    OPENS_IN_BROWSER,
    resolutionValue,
} from '../shell/issue-detail';
import { editIssue, IssueEditError, type IssueEditValues } from '../sync/issue-edit';
import { Button, Field, GroupedCard, AppSymbol, ROW_INSET, RowSeparator, Text } from '../ui';

import { ComponentChipList, componentSheet } from './issue-components';
import { useOpenLink } from './open-link';
import { type RouteSheetContent, useRouteSheet } from './route-sheet';

// An admin's fields on an issue:
// the web's AdminFields on a phone. Each row opens a sheet: one choice for
// status, priority, kind and area, the labels on and off, the assignee (the
// last list kept offline, with its age), the components (CB-442: the same
// picker as File an issue, each tap one folded edit); the resolution is edited in place,
// under the rows, so the screen lifts it over the keyboard. Every change goes
// through `editIssue`, so it works offline and folds into a queued edit;
// the server decides (a 403 shows in place as "Couldn't save"). Proposals,
// links and delete open the web for now.

export function AdminFields(props: {
    admin: AdminView;
    issueKey: string;
    /** The issue's number, or null while it is a `CB-?` filing (the web can't open it yet). */
    number: number | null;
    users: Readonly<Record<string, string>>;
    /** The detail's component labels (CB-442). */
    labels?: ComponentLabels;
}) {
    const { admin, issueKey: key, number, users } = props;
    const { outbox } = useWorkspaceScope();
    const openLink = useOpenLink();
    const [open, setOpen] = useState<Exclude<AdminFieldName, 'resolution'> | null>(null);
    // The picker's set while it shows: each tap edits from it, never from a screen drawn before the last.
    const [components, setComponents] = useState<string[] | null>(null);
    const [resolution, setResolution] = useState<string | null>(null);
    const edit = (changes: IssueEditValues, label?: IssueLabel) =>
        editIssue(outbox, {
            issue: key,
            changes,
            base: admin.base,
            newId: randomId,
            ...(label === undefined ? {} : { toggleLabel: label }),
        });
    const close = () => {
        setOpen(null);
        setComponents(null);
    };
    // A field's choices in a native sheet (CB-421).
    useRouteSheet(
        open === null
            ? null
            : open === 'components'
              ? componentSheet({
                    value: components ?? admin.values.components,
                    labels: props.labels,
                    onChange: (refs) => {
                        setComponents(refs);
                        edit({ components: refs }).catch(warn);
                    },
                    onClose: close,
                })
              : fieldSheet({ field: open, admin, users, edit, onClose: close }),
        close,
    );
    return (
        <View className="gap-2" testID="issue-admin-fields">
            <Text accessibilityRole="header" variant="section">
                Details
            </Text>
            <GroupedCard>
                {admin.fields.map((field, index) => (
                    <FieldRow
                        key={field.field}
                        field={field}
                        first={index === 0}
                        onPress={() =>
                            field.field === 'resolution'
                                ? setResolution(admin.values.resolution ?? '')
                                : setOpen(field.field)
                        }
                    />
                ))}
            </GroupedCard>
            {resolution === null ? null : (
                <Resolution text={resolution} onText={setResolution} edit={edit} onClose={() => setResolution(null)} />
            )}
            {number === null ? null : (
                <GroupedCard>
                    <Pressable
                        testID="issue-admin-web"
                        accessibilityRole="link"
                        accessibilityLabel={ADMIN_ON_WEB}
                        accessibilityHint={OPENS_IN_BROWSER}
                        onPress={() => openLink(issuePath(number), { web: true })}
                        className="min-h-11 flex-row items-center gap-3 p-3 active:bg-accent"
                    >
                        <View className="min-w-0 flex-1">
                            <Text>{ADMIN_ON_WEB}</Text>
                            <Text variant="footnote" tone="muted">
                                {OPENS_IN_BROWSER}
                            </Text>
                        </View>
                        <AppSymbol name="external-link" size={16} color="muted-foreground" />
                    </Pressable>
                </GroupedCard>
            )}
        </View>
    );
}

function FieldRow({ field, first, onPress }: { field: AdminField; first: boolean; onPress: () => void }) {
    return (
        <Pressable
            testID={`issue-admin-${field.field}`}
            accessibilityRole="button"
            accessibilityLabel={field.accessibilityLabel}
            accessibilityHint={`Changes the ${field.label.toLowerCase()}`}
            onPress={onPress}
            className="min-h-11 flex-row items-center gap-3 p-3 active:bg-accent"
        >
            {first ? null : <RowSeparator inset={ROW_INSET} />}
            <Text variant="subheadline" tone="muted" className="w-24">
                {field.label}
            </Text>
            {field.chips === undefined ? (
                <Text className="min-w-0 flex-1">{field.value}</Text>
            ) : (
                <ComponentChipList chips={field.chips} testID="issue-admin-components-chips" />
            )}
            {field.pending ? <AppSymbol name="clock" size={12} color="muted-foreground" /> : null}
            <AppSymbol name="chevron-right" size={16} color="muted-foreground" />
        </Pressable>
    );
}

const warn = (error: unknown) => console.warn('[issue] the field was not saved', error);

/**
 * One field's sheet (CB-421: a native sheet): its choices, Done in its title row. Status, priority
 * and kind stay at the medium detent; the area, the labels and the people can be long.
 */
function fieldSheet(props: {
    field: Exclude<AdminFieldName, 'resolution' | 'components'>;
    admin: AdminView;
    users: Readonly<Record<string, string>>;
    edit: (changes: IssueEditValues, label?: IssueLabel) => Promise<unknown>;
    onClose: () => void;
}): RouteSheetContent {
    const { field, admin, edit, onClose } = props;
    const label = admin.fields.find((item) => item.field === field)?.label ?? '';
    const choose = (changes: IssueEditValues) => {
        edit(changes).catch(warn);
        onClose();
    };
    let body: ReactNode;
    switch (field) {
        case 'labels':
            body = (
                <Choices
                    field={field}
                    multiple
                    choices={labelChoices(admin.values)}
                    onChoose={(value) => edit({}, value as IssueLabel).catch(warn)}
                />
            );
            break;
        case 'assigneeId':
            body = (
                <Assignees
                    current={admin.values.assigneeId}
                    users={props.users}
                    onChoose={(assigneeId) => choose({ assigneeId })}
                />
            );
            break;
        default:
            body = (
                <Choices
                    field={field}
                    choices={fieldChoices(field, admin.values)}
                    onChoose={(value) => choose({ [field]: value } as IssueEditValues)}
                />
            );
    }
    return {
        testID: 'issue-admin-sheet',
        title: label,
        tall: field === 'area' || field === 'labels' || field === 'assigneeId',
        actions: <Button label="Done" onPress={onClose} testID="issue-admin-done" />,
        body,
    };
}

function Choices(props: {
    field: string;
    choices: readonly FieldChoice[];
    multiple?: boolean;
    onChoose: (value: string | null) => void;
}) {
    return (
        // iOS's pushed picker list: an inset group, the chosen ones checked.
        <GroupedCard>
            <View accessibilityRole={props.multiple ? undefined : 'radiogroup'}>
                {props.choices.map((choice, index) => (
                    <Pressable
                        key={choice.value ?? 'none'}
                        testID={`issue-admin-choice-${props.field}-${choice.value ?? 'none'}`}
                        accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
                        accessibilityLabel={choice.label}
                        accessibilityState={
                            props.multiple ? { checked: choice.selected } : { selected: choice.selected }
                        }
                        onPress={() => props.onChoose(choice.value)}
                        className="min-h-11 flex-row items-center gap-3 p-3 active:bg-accent"
                    >
                        {index > 0 ? <RowSeparator inset={ROW_INSET} /> : null}
                        <Text weight={choice.selected ? 'medium' : 'normal'} className="min-w-0 flex-1">
                            {choice.label}
                        </Text>
                        {choice.selected ? <AppSymbol name="check" size={16} color="primary" /> : null}
                    </Pressable>
                ))}
            </View>
        </GroupedCard>
    );
}

/** The people an admin can assign: read when the sheet opens, the last list (with its age) offline. */
function Assignees(props: {
    current: string | null;
    users: Readonly<Record<string, string>>;
    onChoose: (assigneeId: string | null) => void;
}) {
    const list = useIssueAssignees();
    const view = assigneePicker({ list, current: props.current, users: props.users });
    return (
        <>
            {view.line === null && view.age === null ? null : (
                <Text variant="footnote" tone="muted" testID="issue-admin-assignees-line">
                    {[view.line, view.age].filter(Boolean).join(' · ')}
                </Text>
            )}
            <Choices field="assigneeId" choices={view.choices} onChoose={props.onChoose} />
        </>
    );
}

/** The resolution, edited in place: blank is none. */
function Resolution(props: {
    text: string;
    onText: (text: string) => void;
    edit: (changes: IssueEditValues, label?: IssueLabel) => Promise<unknown>;
    onClose: () => void;
}) {
    const [error, setError] = useState<string | undefined>();
    const save = () => {
        props
            .edit({ resolution: resolutionValue(props.text) })
            .then(props.onClose)
            .catch((caught: unknown) => {
                if (caught instanceof IssueEditError) {
                    setError(caught.message);
                } else {
                    warn(caught);
                }
            });
    };
    return (
        <View className="gap-2">
            <Field
                label="Resolution"
                value={props.text}
                placeholder="e.g. Fixed in 380fb4c"
                onChangeText={(next) => {
                    props.onText(next);
                    setError(undefined);
                }}
                maxLength={500}
                autoFocus
                error={error}
                testID="issue-admin-resolution-field"
            />
            <View className="flex-row justify-end gap-2">
                <Button variant="ghost" label="Cancel" onPress={props.onClose} testID="issue-admin-resolution-cancel" />
                <Button label="Save" onPress={save} testID="issue-admin-resolution-save" />
            </View>
        </View>
    );
}
