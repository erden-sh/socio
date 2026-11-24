import { View } from 'react-native';

import type { ConflictLine } from '../shell/dataset-writes';
import { Button, Field, SegmentedControl, Text } from '../ui';
import { cx } from '../ui/cx';

// A view's conflict and Save as new view (CB-469, CB-451), each the body of a
// native sheet (`useRouteSheet`):
// - the conflict: who saved the view, when, and each part that differs with
//   theirs (the view now) beside yours (the draft), the three choices first
//   the contract gives, nothing merged: Keep mine (saves again over theirs, recorded as
//   an overwrite), Take theirs (drops the draft) and Save mine as a new view;
// - Save as new view: its name and, for someone who may save shared views,
//   who sees it (a segmented control: Only me or Everyone).

export function ViewConflictBody(props: {
    savedLine: string;
    lines: readonly ConflictLine[];
    /** Keep mine needs the right to save over it; else only the other two. */
    canOverwrite: boolean;
    busy: boolean;
    error: string | null;
    onKeepMine: () => void;
    onTakeTheirs: () => void;
    onSaveAsNew: () => void;
}) {
    return (
        <View className="gap-4" testID="dataset-view-conflict">
            <Text variant="subheadline">
                {`${props.savedLine} after you started changing it. Nothing was merged: choose which to keep.`}
            </Text>
            {props.error === null ? null : (
                <Text variant="subheadline" tone="destructive" testID="dataset-view-conflict-error">
                    {props.error}
                </Text>
            )}
            <View className="gap-2">
                {props.canOverwrite ? (
                    <Button
                        label="Keep mine"
                        onPress={props.onKeepMine}
                        busy={props.busy}
                        accessibilityHint="Saves your changes over theirs for everyone"
                        testID="dataset-view-conflict-mine"
                    />
                ) : null}
                <Button
                    label="Save mine as a new view"
                    variant="secondary"
                    disabled={props.busy}
                    onPress={props.onSaveAsNew}
                    testID="dataset-view-conflict-new"
                />
                <Button
                    label="Take theirs"
                    variant="ghost"
                    disabled={props.busy}
                    onPress={props.onTakeTheirs}
                    accessibilityHint="Drops your changes"
                    testID="dataset-view-conflict-theirs"
                />
            </View>
            <View className="overflow-hidden rounded-xl border border-border" testID="dataset-view-conflict-lines">
                <View className="flex-row gap-2 bg-muted px-3 py-2">
                    <Text variant="footnote" weight="semibold" tone="muted" className="w-24">
                        Part
                    </Text>
                    <Text variant="footnote" weight="semibold" tone="muted" className="min-w-0 flex-1">
                        Theirs, now
                    </Text>
                    <Text variant="footnote" weight="semibold" tone="muted" className="min-w-0 flex-1">
                        Yours
                    </Text>
                </View>
                {props.lines.map((line) => (
                    <View
                        key={line.part}
                        className={cx('flex-row gap-2 border-t border-border px-3 py-2.5')}
                        accessible
                        accessibilityLabel={`${line.label}: theirs ${line.theirs}; yours ${line.mine}`}
                        testID={`dataset-view-conflict-${line.part}`}
                    >
                        <Text variant="subheadline" weight="medium" className="w-24">
                            {line.label}
                        </Text>
                        <Text variant="subheadline" className="min-w-0 flex-1">
                            {line.theirs}
                        </Text>
                        <Text variant="subheadline" className="min-w-0 flex-1">
                            {line.mine}
                        </Text>
                    </View>
                ))}
            </View>
        </View>
    );
}

export function SaveAsNewBody(props: {
    name: string;
    onName: (name: string) => void;
    shared: boolean;
    onShared: (shared: boolean) => void;
    canShare: boolean;
    busy: boolean;
    error: string | null;
    onSave: () => void;
}) {
    return (
        <View className="gap-4" testID="dataset-save-new">
            <Field
                label="Name"
                value={props.name}
                onChangeText={props.onName}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={props.onSave}
                {...(props.error === null ? {} : { error: props.error })}
                testID="dataset-save-new-name"
            />
            {props.canShare ? (
                <View className="gap-1.5">
                    <Text variant="subheadline" weight="medium">
                        Who sees it
                    </Text>
                    <SegmentedControl
                        options={[
                            { value: 'personal', label: 'Only me', testID: 'dataset-save-new-personal' },
                            { value: 'dataset', label: 'Everyone', testID: 'dataset-save-new-everyone' },
                        ]}
                        selected={props.shared ? 'dataset' : 'personal'}
                        onSelect={(value) => props.onShared(value === 'dataset')}
                        accessibilityLabel="Who sees it"
                        testID="dataset-save-new-who"
                    />
                </View>
            ) : null}
            <Button label="Save view" onPress={props.onSave} busy={props.busy} testID="dataset-save-new-save" />
        </View>
    );
}
