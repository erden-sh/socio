import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useIssueComponentOptions } from '../live';
import {
    type ComponentChipsView,
    type ComponentChipView,
    type ComponentChoice,
    type ComponentLabels,
    componentPicker,
    COMPONENTS_PICKER_TITLE,
    ISSUE_COMPONENTS_MAX,
    NO_COMPONENTS,
    SEARCH_COMPONENTS,
} from '../shell/issue-components';
import { Button, AppSymbol, SearchField, Text } from '../ui';
import { cx } from '../ui/cx';

import type { RouteSheetContent } from './route-sheet';

// Issue components on screen (CB-442): the web's chip (IssueComponents.tsx's
// ComponentChip: the plugin's puzzle or the app's window, the name, a muted
// struck-through name and its state for one that is gone), and the picker:
// a native sheet (CB-421, `useRouteSheet`, medium then large) of grouped
// sections, All, Plugins and Apps, each choice a row with its check, as iOS's
// and Material's own multi-select lists draw them, at most ten. The rules are
// src/shell/issue-components.ts's.

/** One component: the web's small chip, in the board tags' look. */
export function ComponentChip({ chip, testID }: { chip: ComponentChipView; testID?: string }) {
    return (
        <View
            accessible
            accessibilityLabel={chip.accessibilityLabel}
            testID={testID ?? `component-chip-${chip.ref}`}
            className={cx(
                'max-w-48 flex-row items-center gap-1 rounded-sm px-1.5',
                chip.gone ? 'bg-muted/50' : 'bg-muted',
            )}
            style={chip.gone ? GONE : undefined}
        >
            <AppSymbol name={chip.plugin ? 'puzzle' : 'app-window'} size={12} color="muted-foreground" />
            <Text
                variant="footnote"
                tone="muted"
                numberOfLines={1}
                className="min-w-0 shrink"
                style={chip.gone ? STRUCK : undefined}
            >
                {chip.label}
            </Text>
            {chip.note === null ? null : (
                <Text variant="footnote" tone="muted">
                    {chip.note}
                </Text>
            )}
        </View>
    );
}

/** The web's `text-muted-foreground/70` for a component that is gone. */
const GONE = { opacity: 0.7 } as const;
const STRUCK = { textDecorationLine: 'line-through' } as const;

/** A card's or a row's components: two chips, then "+n". */
export function ComponentChips({ view, testID }: { view: ComponentChipsView; testID?: string }) {
    if (view.chips.length === 0) {
        return null;
    }
    return (
        <>
            {view.chips.map((chip) => (
                <ComponentChip key={chip.ref} chip={chip} testID={testID ? `${testID}-${chip.ref}` : undefined} />
            ))}
            {view.more === null ? null : (
                <View
                    accessible
                    accessibilityLabel={view.more.accessibilityLabel}
                    className="rounded-sm bg-muted px-1.5"
                    testID={testID ? `${testID}-more` : undefined}
                >
                    <Text variant="footnote" tone="muted">
                        {view.more.label}
                    </Text>
                </View>
            )}
        </>
    );
}

/** Chips that wrap, or "None": a field's value. */
export function ComponentChipList({ chips, testID }: { chips: readonly ComponentChipView[]; testID?: string }) {
    return chips.length === 0 ? (
        <Text className="min-w-0 flex-1" testID={testID}>
            {NO_COMPONENTS}
        </Text>
    ) : (
        <View className="min-w-0 flex-1 flex-row flex-wrap gap-1" testID={testID}>
            {chips.map((chip) => (
                <ComponentChip key={chip.ref} chip={chip} />
            ))}
        </View>
    );
}

/**
 * File an issue's "Plugins and apps" row: the label, the chosen chips (or
 * "None"), a chevron; it opens the picker. The admin's Components row is
 * issue-admin.tsx's FieldRow with the same chips.
 */
export function ComponentField(props: { chips: readonly ComponentChipView[]; disabled: boolean; onPress: () => void }) {
    return (
        <Pressable
            testID="file-issue-components"
            accessibilityRole="button"
            accessibilityLabel={[
                COMPONENTS_PICKER_TITLE,
                props.chips.length ? props.chips.map((chip) => chip.label).join(', ') : NO_COMPONENTS,
            ].join(', ')}
            accessibilityHint="Chooses the plugins and apps it is about"
            accessibilityState={{ disabled: props.disabled }}
            disabled={props.disabled}
            onPress={props.onPress}
            className={cx(
                'min-h-11 flex-row items-center gap-3 rounded-xl border border-border bg-card p-3 active:bg-accent',
                props.disabled && 'opacity-50',
            )}
        >
            <Text weight="medium">{COMPONENTS_PICKER_TITLE}</Text>
            <View className="min-w-0 flex-1 flex-row flex-wrap justify-end gap-1">
                {props.chips.length === 0 ? (
                    <Text tone="muted">{NO_COMPONENTS}</Text>
                ) : (
                    props.chips.map((chip) => <ComponentChip key={chip.ref} chip={chip} />)
                )}
            </View>
            <AppSymbol name="chevron-right" size={16} color="muted-foreground" />
        </Pressable>
    );
}

/**
 * The picker in a native sheet: tall (medium, then large), "Plugins and apps"
 * with Done in its title row. `value` is the screen's; each tap gives back the
 * whole new set (`onChange`).
 */
export function componentSheet(props: {
    value: readonly string[];
    labels?: ComponentLabels;
    onChange: (refs: string[]) => void;
    onClose: () => void;
    /** Waits to send (an admin's edit): the title row says so. */
    pending?: boolean;
}): RouteSheetContent {
    return {
        testID: 'component-sheet',
        title: COMPONENTS_PICKER_TITLE,
        subtitle: `${props.value.length} of ${ISSUE_COMPONENTS_MAX} chosen`,
        tall: true,
        actions: <Button label="Done" onPress={props.onClose} testID="component-sheet-done" />,
        body: <ComponentPicker value={props.value} labels={props.labels} onChange={props.onChange} />,
    };
}

/** The sheet's body: the reader's options read as it shows, the last list (with its age) offline. */
function ComponentPicker(props: {
    value: readonly string[];
    labels?: ComponentLabels;
    onChange: (refs: string[]) => void;
}) {
    const list = useIssueComponentOptions();
    const [query, setQuery] = useState('');
    const view = componentPicker({ list, value: props.value, labels: props.labels, query });
    const toggle = (ref: string) => {
        const chosen = props.value.includes(ref);
        if (!chosen && props.value.length >= ISSUE_COMPONENTS_MAX) {
            return;
        }
        props.onChange(chosen ? props.value.filter((item) => item !== ref) : [...props.value, ref]);
    };
    return (
        <>
            {view.line === null && view.age === null ? null : (
                <Text variant="footnote" tone="muted" testID="component-sheet-line">
                    {[view.line, view.age].filter(Boolean).join(' · ')}
                </Text>
            )}
            {view.searchable ? (
                <SearchField
                    label={SEARCH_COMPONENTS}
                    placeholder={SEARCH_COMPONENTS}
                    value={query}
                    onChangeText={setQuery}
                    testID="component-sheet-search"
                />
            ) : null}
            {view.others.length === 0 ? null : <Section title="Chosen" choices={view.others} onToggle={toggle} />}
            {view.groups.map((group) => (
                <Section key={group.title} title={group.title} choices={group.choices} onToggle={toggle} />
            ))}
            {view.empty === null ? null : (
                <Text variant="subheadline" tone="muted">
                    {view.empty}
                </Text>
            )}
            {view.full === null ? null : (
                <Text variant="footnote" tone="muted" testID="component-sheet-full">
                    {view.full}
                </Text>
            )}
        </>
    );
}

/** A grouped section: its header (iOS's grouped list header, Material's subheader), then its rows. */
function Section(props: { title: string; choices: readonly ComponentChoice[]; onToggle: (ref: string) => void }) {
    return (
        <View className="gap-1.5" accessibilityRole="list" accessibilityLabel={props.title}>
            <Text accessibilityRole="header" variant="section" className="px-1">
                {props.title}
            </Text>
            <View className="rounded-xl border border-border bg-card">
                {props.choices.map((choice, index) => (
                    <Pressable
                        key={choice.ref}
                        testID={choice.testID}
                        accessibilityRole="checkbox"
                        accessibilityLabel={choice.accessibilityLabel}
                        accessibilityState={{ checked: choice.selected, disabled: choice.disabled }}
                        disabled={choice.disabled}
                        onPress={() => props.onToggle(choice.ref)}
                        className={cx(
                            'min-h-11 flex-row items-center gap-3 p-3 active:bg-accent',
                            index > 0 && 'border-t border-border',
                            choice.disabled && 'opacity-50',
                        )}
                    >
                        <AppSymbol name={choice.plugin ? 'puzzle' : 'app-window'} size={16} color="muted-foreground" />
                        <Text
                            weight={choice.selected ? 'medium' : 'normal'}
                            numberOfLines={1}
                            className="min-w-0 flex-1"
                        >
                            {choice.label}
                        </Text>
                        {choice.detail === null ? null : (
                            <Text variant="footnote" tone="muted" numberOfLines={1} className="max-w-32">
                                {choice.detail}
                            </Text>
                        )}
                        {choice.selected ? <AppSymbol name="check" size={16} color="primary" /> : null}
                    </Pressable>
                ))}
            </View>
        </View>
    );
}
