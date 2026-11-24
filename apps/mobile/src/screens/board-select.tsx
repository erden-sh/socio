import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BATCH_MENUS, type BatchChoice, type BatchMenu, batchGroups } from '../shell/board-select';
import { AppSymbol, Text } from '../ui';
import { cx } from '../ui/cx';

import type { RouteSheetContent } from './route-sheet';

// The Board's Select mode on a phone (O-4): iOS Mail's and Files' pattern
// with the web's BatchBar actions (src/shell/board-select.ts). The header
// says how many are picked with Select all and Done (board.tsx); each row
// shows a round check at its start; the bar at the bottom holds the web's
// three menus, Status, Priority and Labels, each a sheet of choices. A
// choice applies at once to every picked issue, through the outbox, and the
// bar says what it did.

/** A row's round check in Select: empty, or filled in the primary with a check mark. */
export function SelectMark({ selected }: { selected: boolean }) {
    return (
        <View
            className={cx(
                'size-6 items-center justify-center rounded-full border-2',
                selected ? 'border-primary bg-primary' : 'border-muted-foreground/50',
            )}
        >
            {selected ? <AppSymbol name="check" size={14} color="primary-foreground" /> : null}
        </View>
    );
}

/** The bar at the bottom in Select: the web's menus, and what the last choice did. */
export function BatchBar(props: {
    picked: number;
    busy: boolean;
    result: string | null;
    onMenu: (menu: BatchMenu) => void;
}) {
    const insets = useSafeAreaInsets();
    const off = props.picked === 0 || props.busy;
    return (
        <View
            testID="board-batch-bar"
            accessibilityRole="toolbar"
            accessibilityLabel="Batch actions"
            className="gap-2 border-t border-border bg-header px-4 pt-3"
            style={{ paddingBottom: 12 + insets.bottom }}
        >
            {props.result === null ? null : (
                <Text
                    variant="footnote"
                    tone="muted"
                    className="text-center"
                    accessibilityLiveRegion="polite"
                    testID="board-batch-result"
                >
                    {props.result}
                </Text>
            )}
            <View className="flex-row gap-2">
                {BATCH_MENUS.map(({ menu, label }) => (
                    <Pressable
                        key={menu}
                        testID={`board-batch-${menu}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Set ${label.toLowerCase()} of the selected issues`}
                        accessibilityState={{ disabled: off }}
                        disabled={off}
                        onPress={() => props.onMenu(menu)}
                        className="min-h-11 flex-1 flex-row items-center justify-center gap-1 rounded-md bg-secondary active:bg-secondary/80 disabled:opacity-50"
                    >
                        <Text weight="medium" tone="on-secondary">
                            {label}
                        </Text>
                        <AppSymbol name="chevron-down" size={14} color="muted-foreground" />
                    </Pressable>
                ))}
            </View>
        </View>
    );
}

/**
 * One menu's sheet (CB-421: a native sheet at the medium detent): its choices (Labels: Add label,
 * then Remove label); a tap applies and closes it.
 */
export function batchSheet(
    menu: BatchMenu,
    picked: number,
    onChoose: (choice: BatchChoice) => void,
): RouteSheetContent {
    return {
        testID: 'board-batch-sheet',
        title: BATCH_MENUS.find((item) => item.menu === menu)?.label ?? '',
        subtitle: `For ${picked} selected issue${picked === 1 ? '' : 's'}`,
        tall: menu === 'labels',
        body: batchGroups(menu).map((group) => (
            <View key={group.title ?? 'choices'} className="gap-2">
                {group.title === null ? null : (
                    <Text accessibilityRole="header" variant="footnote" weight="medium" tone="muted">
                        {group.title}
                    </Text>
                )}
                <View className="rounded-xl border border-border bg-card">
                    {group.choices.map((item, index) => (
                        <Pressable
                            key={item.testID}
                            testID={item.testID}
                            accessibilityRole="button"
                            accessibilityLabel={item.label}
                            onPress={() => onChoose(item.choice)}
                            className={cx(
                                'min-h-11 justify-center p-3 active:bg-accent',
                                index > 0 && 'border-t border-border',
                            )}
                        >
                            <Text>{item.label}</Text>
                        </Pressable>
                    ))}
                </View>
            </View>
        )),
    };
}
