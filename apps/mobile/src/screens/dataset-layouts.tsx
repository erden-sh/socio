import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, type ScrollViewInstance, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';

import type { CalendarMode } from '@socio/shared/dataset-views/definition';

import { ACTIVE_OFFSET, FAIL_OFFSET, pageShift } from '../shell/board-swipe';
import {
    addDays,
    type BoardView,
    CALENDAR_LABELS,
    type CalendarEntry,
    calendarRange,
    calendarTitle,
    columnPicker,
    daysOf,
    emptyColumn,
    entriesOn,
    type FieldValue,
    HIDDEN_COLUMNS,
    paletteTone,
    PHONE_CALENDAR_MODES,
    type RowCard,
    type TableView,
    weekStart,
} from '../shell/dataset-view';
import { LONG_PRESS_TO_MENU } from '../shell/native-menu';
import { useScheme } from '../theme/scheme';
import { theme } from '../theme/theme';
import { AppSymbol, Button, SegmentedControl, Text } from '../ui';
import { cx } from '../ui/cx';

import { type BoardSwipe, boardSwipeCallbacks } from './board-swipe-gesture';

// The layouts of a dataset view on the phone (CB-469, CB-451), drawn from
// src/shell/dataset-view.ts's models. Only the presentation adapts; every field,
// column and range stays reachable:
// - table: a sticky first column beside a sideways scroll of every other
//   visible column (the priority fields first), the totals as its last row;
// - list and gallery: each row's title and priority fields, a chevron that
//   expands it in place to every visible field; gallery cards lead with their
//   cover's file;
// - board: one column in focus, full width, the column chips above it (hidden
//   columns under "Hidden columns") and the Issues Board's sideways swipe
//   (CB-468's pan, board-swipe-gesture.ts) between the visible ones;
// - calendar: Day (with its week strip), Week, Month and Agenda in the
//   platform's segmented control, Previous, Today and Next; Day and Week draw
//   timed entries on a time grid and multi-day ones across the top; a month
//   day opens its Day.
// A row opens the record sheet (every field, with editing) through `onOpen`.

/** An option's chip in its palette color (a name, never a CSS value: `paletteTone`). */
export function OptionChip({ text, color }: { text: string; color?: string }) {
    const tone = theme[useScheme()].tones[paletteTone(color)];
    return (
        <View className="self-start rounded-full px-2 py-0.5" style={{ backgroundColor: tone.tint }}>
            <Text variant="footnote" weight="medium" numberOfLines={1} style={{ color: tone.foreground }}>
                {text}
            </Text>
        </View>
    );
}

function Value({ value }: { value: FieldValue }) {
    if (value.colors !== undefined && value.colors.length > 0) {
        const parts = value.text.split(', ');
        return (
            <View className="flex-row flex-wrap gap-1">
                {parts.map((part, index) => (
                    <OptionChip
                        key={`${part}-${index}`}
                        text={part}
                        {...(value.colors?.[index] === undefined ? {} : { color: value.colors[index] })}
                    />
                ))}
            </View>
        );
    }
    return (
        <Text variant="subheadline" numberOfLines={2} className="min-w-0 shrink">
            {value.text === '' ? '—' : value.text}
        </Text>
    );
}

/** A label and its value, on a card or an expanded line. */
function FieldLine({ value }: { value: FieldValue }) {
    return (
        <View className="flex-row items-start gap-3">
            <Text variant="footnote" tone="muted" numberOfLines={1} className="w-24 pt-0.5">
                {value.label}
            </Text>
            <View className="min-w-0 flex-1">
                <Value value={value} />
            </View>
        </View>
    );
}

/** A row's card: its title, the priority fields, and its other fields once expanded. */
export function RowCardView(props: {
    card: RowCard;
    expanded: boolean;
    onToggle: () => void;
    onOpen: () => void;
    cover?: ReactNode;
    /** A long-press opens the row's menu (a board card's Move to). */
    menu?: boolean;
    testID: string;
}) {
    const { card, expanded } = props;
    const more = card.more.length;
    return (
        <View className="overflow-hidden rounded-xl border border-border bg-card" testID={props.testID}>
            {props.cover ?? null}
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={card.accessibilityLabel}
                accessibilityHint="Opens the record"
                accessibilityState={more > 0 ? { expanded } : undefined}
                accessibilityActions={
                    more > 0 ? [{ name: 'expand', label: expanded ? 'Show fewer fields' : 'Show every field' }] : []
                }
                onAccessibilityAction={() => props.onToggle()}
                onPress={props.onOpen}
                {...(props.menu === true ? { onLongPress: LONG_PRESS_TO_MENU } : {})}
                className="gap-2 p-3 active:bg-accent"
            >
                <View className="flex-row items-center gap-2">
                    <Text variant="headline" numberOfLines={2} className="min-w-0 flex-1">
                        {card.title}
                    </Text>
                    {more > 0 ? (
                        <Pressable
                            hitSlop={12}
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            onPress={props.onToggle}
                            testID={`${props.testID}-expand`}
                            className="size-8 items-center justify-center rounded-full active:bg-accent"
                        >
                            <AppSymbol
                                name={expanded ? 'chevron-up' : 'chevron-down'}
                                color="muted-foreground"
                                size={16}
                            />
                        </Pressable>
                    ) : null}
                </View>
                {card.lead.map((value) => (
                    <FieldLine key={value.field} value={value} />
                ))}
                {expanded ? card.more.map((value) => <FieldLine key={value.field} value={value} />) : null}
            </Pressable>
        </View>
    );
}

// ----- List and gallery -----

export function CardList(props: {
    cards: readonly RowCard[];
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpen: (key: string) => void;
    cover?: (key: string) => ReactNode;
    /** Wraps each card (a board card in its Move to menu). */
    wrap?: (key: string, card: ReactElement) => ReactNode;
    empty: string;
    testID: string;
}) {
    if (props.cards.length === 0) {
        return (
            <Text variant="subheadline" tone="muted" className="py-8 text-center" testID={`${props.testID}-empty`}>
                {props.empty}
            </Text>
        );
    }
    return (
        <View className="gap-3" testID={props.testID}>
            {props.cards.map((card) => {
                const view = (
                    <RowCardView
                        key={card.key}
                        card={card}
                        expanded={props.expanded.has(card.key)}
                        onToggle={() => props.onToggle(card.key)}
                        onOpen={() => props.onOpen(card.key)}
                        cover={props.cover?.(card.key)}
                        menu={props.wrap !== undefined}
                        testID={`${props.testID}-row-${card.key}`}
                    />
                );
                return props.wrap === undefined ? view : props.wrap(card.key, view);
            })}
        </View>
    );
}

/** A gallery card's cover: the file's name and type in the Data tone, from the dataset's own attachments only. */
export function CoverTile({ name, image }: { name: string | null; image: boolean }) {
    const tone = theme[useScheme()].tones.emerald;
    return (
        <View className="h-28 items-center justify-center gap-1" style={{ backgroundColor: tone.tint }}>
            <AppSymbol
                name={name === null ? 'image-off' : image ? 'image' : 'file'}
                size={28}
                color={{ value: tone.foreground }}
            />
            <Text variant="footnote" numberOfLines={1} style={{ color: tone.foreground }}>
                {name ?? 'No cover'}
            </Text>
        </View>
    );
}

// ----- Table -----

/** A table row at the default text size: the sticky column and the scrolled cells must match. */
const ROW = 44;

export function TableLayout({ table, onOpen }: { table: TableView; onOpen: (key: string) => void }) {
    const stickyWidth = table.sticky?.width ?? 0;
    // Both halves share one row height so they line up; it grows with the person's text size,
    // and every cell holds one line.
    const { fontScale } = useWindowDimensions();
    const rowHeight = Math.round(ROW * Math.max(1, fontScale));
    const header = (label: string, width: number, numeric: boolean, key: string) => (
        <View key={key} style={{ width, height: rowHeight }} className="justify-center border-b border-border px-2">
            <Text
                variant="footnote"
                weight="medium"
                tone="muted"
                numberOfLines={1}
                className={numeric ? 'text-right' : undefined}
            >
                {label}
            </Text>
        </View>
    );
    const cell = (text: string, width: number, numeric: boolean, key: string, strong = false) => (
        <View key={key} style={{ width, height: rowHeight }} className="justify-center border-b border-border px-2">
            <Text
                variant="subheadline"
                numberOfLines={1}
                weight={strong ? 'medium' : undefined}
                className={numeric ? 'text-right' : undefined}
            >
                {text}
            </Text>
        </View>
    );
    return (
        <View className="flex-row overflow-hidden rounded-xl border border-border bg-card" testID="dataset-table">
            {table.sticky === null ? null : (
                // The sticky first column: it stays while the rest scrolls sideways.
                <View
                    style={{ width: stickyWidth }}
                    className="border-r border-border bg-card"
                    testID="dataset-table-sticky"
                >
                    {header(table.sticky.label, stickyWidth, false, 'h')}
                    {table.rows.map((row) => (
                        <Pressable
                            key={row.key}
                            onPress={() => onOpen(row.key)}
                            accessibilityRole="button"
                            accessibilityLabel={row.first}
                            accessibilityHint="Opens the record"
                            className="active:bg-accent"
                        >
                            {cell(row.first, stickyWidth, false, 'c', true)}
                        </Pressable>
                    ))}
                    {table.totals === null ? null : cell(table.totals.first, stickyWidth, false, 't', true)}
                </View>
            )}
            <ScrollView horizontal showsHorizontalScrollIndicator testID="dataset-table-scroll" className="flex-1">
                <View>
                    <View className="flex-row">
                        {table.columns.map((column) =>
                            header(column.label, column.width, column.numeric, column.field),
                        )}
                    </View>
                    {table.rows.map((row) => (
                        <Pressable
                            key={row.key}
                            onPress={() => onOpen(row.key)}
                            className="flex-row active:bg-accent"
                            importantForAccessibility="no-hide-descendants"
                        >
                            {table.columns.map((column, index) =>
                                cell(row.cells[index] ?? '', column.width, column.numeric, column.field),
                            )}
                        </Pressable>
                    ))}
                    {table.totals === null ? null : (
                        <View className="flex-row" testID="dataset-table-totals">
                            {table.columns.map((column, index) =>
                                cell(
                                    table.totals?.cells[index] ?? '',
                                    column.width,
                                    column.numeric,
                                    column.field,
                                    true,
                                ),
                            )}
                        </View>
                    )}
                </View>
            </ScrollView>
        </View>
    );
}

// ----- Board -----

/** The column chips: every visible column with its count, then the hidden ones after a divider. */
function ColumnChips({ board, onFocus }: { board: BoardView; onFocus: (key: string | null) => void }) {
    const { shown, hidden } = columnPicker(board);
    const focused = board.swipeable[board.focus]?.key;
    const reduceMotion = useReducedMotion();
    const scroller = useRef<ScrollViewInstance>(null);
    const spots = useRef(new Map<string, { x: number; width: number }>());
    const [viewport, setViewport] = useState(0);
    useEffect(() => {
        const spot = spots.current.get(String(focused));
        if (spot !== undefined && viewport > 0) {
            scroller.current?.scrollTo({
                x: Math.max(0, spot.x + spot.width / 2 - viewport / 2),
                animated: !reduceMotion,
            });
        }
    }, [focused, viewport, reduceMotion]);
    const chip = (column: BoardView['columns'][number]) => {
        const on = column.key === focused;
        return (
            <Pressable
                key={String(column.key)}
                onLayout={(event) => spots.current.set(String(column.key), event.nativeEvent.layout)}
                accessibilityRole="tab"
                accessibilityLabel={`${column.label}, ${column.count}${column.hidden ? ', hidden' : ''}`}
                accessibilityState={{ selected: on }}
                onPress={() => onFocus(column.key)}
                testID={`dataset-board-chip-${String(column.key)}`}
                className={cx(
                    'min-h-11 flex-row items-center gap-2 rounded-full border px-4',
                    on ? 'border-transparent bg-accent' : 'border-border active:bg-accent/50',
                    column.hidden && !on && 'border-dashed',
                )}
            >
                {column.hidden ? <AppSymbol name="eye-off" size={14} color="muted-foreground" /> : null}
                <Text variant="subheadline" weight="medium" tone={on ? 'default' : 'muted'}>
                    {column.label}
                </Text>
                <Text variant="meta">{column.count}</Text>
            </Pressable>
        );
    };
    return (
        <ScrollView
            ref={scroller}
            onLayout={(event) => setViewport(event.nativeEvent.layout.width)}
            horizontal
            showsHorizontalScrollIndicator={false}
            className="-mx-4 grow-0"
            contentContainerClassName="items-center gap-2 px-4"
            accessibilityRole="tablist"
            testID="dataset-board-columns"
        >
            {shown.map(chip)}
            {hidden.length === 0 ? null : (
                <Text variant="footnote" tone="muted" className="px-1" testID="dataset-board-hidden">
                    {HIDDEN_COLUMNS}
                </Text>
            )}
            {hidden.map(chip)}
        </ScrollView>
    );
}

/** The cards of the column in focus, moved sideways with the swipe (CB-468's pan). */
function SwipeCards({ swipe, index, children }: { swipe: BoardSwipe; index: number; children: ReactNode }) {
    const style = useAnimatedStyle(() => ({
        transform: [
            { translateX: swipe.moving.get() === 0 ? 0 : pageShift(index, swipe.position.get(), swipe.width.get()) },
        ],
    }));
    return <Animated.View style={style}>{children}</Animated.View>;
}

export function BoardLayout(props: {
    board: BoardView;
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpen: (key: string) => void;
    onFocus: (key: string | null) => void;
    wrap?: (key: string, card: ReactElement) => ReactNode;
    empty: string;
}) {
    const { board } = props;
    const width = useWindowDimensions().width;
    const reduceMotion = useReducedMotion();
    const swipe: BoardSwipe = {
        position: useSharedValue(0),
        moving: useSharedValue(0),
        start: useSharedValue(0),
        current: useSharedValue(board.focus),
        count: useSharedValue(board.swipeable.length),
        width: useSharedValue(width),
        offsetY: useSharedValue(0),
        // The pan sits on the cards alone, so it may start anywhere in them.
        rowsStart: useSharedValue(0),
    };
    useEffect(() => {
        swipe.count.set(board.swipeable.length);
        swipe.width.set(width);
    }, [board.swipeable.length, width, swipe.count, swipe.width]);
    useEffect(() => {
        swipe.current.set(board.focus);
        swipe.moving.set(0);
    }, [board.focus, swipe.current, swipe.moving]);
    const land = (index: number) => {
        const column = board.swipeable[index];
        if (column === undefined || index === board.focus) {
            swipe.moving.set(0);
            return;
        }
        props.onFocus(column.key);
    };
    const callbacks = boardSwipeCallbacks({ swipe, os: Platform.OS, reduceMotion, onLand: land });
    const pan = usePanGesture({
        enabled: board.swipeable.length > 1,
        activeOffsetX: [-ACTIVE_OFFSET, ACTIVE_OFFSET],
        failOffsetY: [-FAIL_OFFSET, FAIL_OFFSET],
        onBegin: callbacks.onBegin,
        onActivate: callbacks.onActivate,
        onUpdate: callbacks.onUpdate,
        onDeactivate: callbacks.onDeactivate,
    });
    const column = board.swipeable[board.focus];
    return (
        <View className="gap-3">
            <ColumnChips board={board} onFocus={props.onFocus} />
            {column?.total === null || column === undefined ? null : (
                <Text variant="footnote" tone="muted" testID="dataset-board-total">
                    {column.total}
                </Text>
            )}
            <GestureDetector gesture={pan}>
                <View collapsable={false} testID="dataset-board">
                    <SwipeCards swipe={swipe} index={board.focus}>
                        <CardList
                            cards={board.cards}
                            expanded={props.expanded}
                            onToggle={props.onToggle}
                            onOpen={props.onOpen}
                            empty={column === undefined ? props.empty : emptyColumn(column.label)}
                            {...(props.wrap === undefined ? {} : { wrap: props.wrap })}
                            testID="dataset-board-cards"
                        />
                    </SwipeCards>
                </View>
            </GestureDetector>
        </View>
    );
}

// ----- Calendar -----

const HOUR = 48;
const weekday = (day: string, style: 'narrow' | 'short') =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: style }).format(new Date(`${day}T00:00:00Z`));
const dateNumber = (day: string) => String(Number(day.slice(8, 10)));

export function CalendarHead(props: {
    mode: CalendarMode;
    day: string;
    today: string;
    onMode: (mode: CalendarMode) => void;
    onStep: (by: 1 | -1) => void;
    onToday: () => void;
    onDay: (day: string) => void;
}) {
    const { mode, day } = props;
    return (
        <View className="gap-3">
            <SegmentedControl
                options={PHONE_CALENDAR_MODES.map((m) => ({
                    value: m,
                    label: CALENDAR_LABELS[m],
                    testID: `dataset-calendar-${m}`,
                }))}
                selected={mode}
                onSelect={props.onMode}
                accessibilityLabel="Calendar range"
                testID="dataset-calendar-mode"
            />
            <View className="flex-row items-center gap-2">
                <Button
                    label="Previous"
                    icon="chevron-left"
                    iconOnly
                    variant="ghost"
                    onPress={() => props.onStep(-1)}
                    testID="dataset-calendar-prev"
                />
                <Text
                    variant="headline"
                    className="min-w-0 flex-1 text-center"
                    numberOfLines={1}
                    testID="dataset-calendar-title"
                >
                    {calendarTitle(mode, day)}
                </Text>
                <Button
                    label="Next"
                    icon="chevron-right"
                    iconOnly
                    variant="ghost"
                    onPress={() => props.onStep(1)}
                    testID="dataset-calendar-next"
                />
                <Button
                    label="Today"
                    variant="tinted"
                    onPress={props.onToday}
                    disabled={day === props.today}
                    testID="dataset-calendar-today"
                />
            </View>
            {mode === 'day' ? (
                // The week strip: a tap changes the day.
                <View className="flex-row justify-between" accessibilityRole="tablist" testID="dataset-calendar-strip">
                    {daysOf({ from: weekStart(day), to: addDays(weekStart(day), 6) }).map((d) => {
                        const on = d === day;
                        return (
                            <Pressable
                                key={d}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: on }}
                                accessibilityLabel={calendarTitle('day', d)}
                                onPress={() => props.onDay(d)}
                                className="min-h-11 w-11 items-center justify-center gap-0.5 rounded-xl"
                            >
                                <Text variant="footnote" tone="muted">
                                    {weekday(d, 'narrow')}
                                </Text>
                                <View
                                    className={cx(
                                        'size-8 items-center justify-center rounded-full',
                                        on && 'bg-primary',
                                    )}
                                >
                                    <Text
                                        variant="subheadline"
                                        weight="medium"
                                        tone={on ? 'on-primary' : d === props.today ? 'primary' : 'default'}
                                    >
                                        {dateNumber(d)}
                                    </Text>
                                </View>
                            </Pressable>
                        );
                    })}
                </View>
            ) : null}
        </View>
    );
}

function EntryBlock({ entry, onOpen, compact }: { entry: CalendarEntry; onOpen: () => void; compact: boolean }) {
    const tone = theme[useScheme()].tones.emerald;
    return (
        <Pressable
            onPress={onOpen}
            accessibilityRole="button"
            accessibilityLabel={[entry.card.title, entry.time].filter(Boolean).join(', ')}
            accessibilityHint="Opens the record"
            className="flex-1 overflow-hidden rounded-md px-1.5 py-1"
            style={{ backgroundColor: tone.tint, borderLeftWidth: 3, borderLeftColor: tone.foreground }}
        >
            <Text variant="footnote" weight="medium" numberOfLines={compact ? 1 : 2} style={{ color: tone.foreground }}>
                {entry.card.title}
            </Text>
            {compact || entry.time === null ? null : (
                <Text variant="footnote" tone="muted" numberOfLines={1}>
                    {entry.time}
                </Text>
            )}
        </Pressable>
    );
}

/** Day and Week: all-day and multi-day entries across the top, timed ones on the hours. */
export function TimeGrid(props: {
    days: readonly string[];
    entries: readonly CalendarEntry[];
    today: string;
    onOpen: (key: string) => void;
}) {
    const { days } = props;
    const timed = props.entries.filter((e) => e.startMinute !== null && !e.multiDay);
    const across = props.entries.filter((e) => e.startMinute === null || e.multiDay);
    const minutes = timed.flatMap((e) => [e.startMinute ?? 0, e.endMinute ?? 0]);
    const first = minutes.length === 0 ? 8 : Math.max(0, Math.floor(Math.min(...minutes) / 60) - 1);
    const last = minutes.length === 0 ? 18 : Math.min(24, Math.ceil(Math.max(...minutes) / 60) + 1);
    const hours = Array.from({ length: Math.max(1, last - first) }, (_, i) => first + i);
    const compact = days.length > 1;
    const hourLabel = (h: number) =>
        new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 1, h));
    return (
        <View
            className="overflow-hidden rounded-xl border border-border bg-card"
            testID={days.length === 1 ? 'dataset-calendar-day' : 'dataset-calendar-week'}
        >
            {compact ? (
                <View className="flex-row border-b border-border" style={{ paddingLeft: 44 }}>
                    {days.map((d) => (
                        <View key={d} className="flex-1 items-center py-1">
                            <Text variant="footnote" tone="muted">
                                {weekday(d, 'narrow')}
                            </Text>
                            <Text
                                variant="subheadline"
                                weight="medium"
                                tone={d === props.today ? 'primary' : 'default'}
                            >
                                {dateNumber(d)}
                            </Text>
                        </View>
                    ))}
                </View>
            ) : null}
            {across.length === 0 ? null : (
                <View
                    className="gap-1 border-b border-border p-1"
                    style={{ paddingLeft: 44 }}
                    testID="dataset-calendar-allday"
                >
                    {across.map((entry) => {
                        const start = Math.max(0, days.indexOf(entry.startDay < days[0]! ? days[0]! : entry.startDay));
                        const endDay = entry.endDay > days[days.length - 1]! ? days[days.length - 1]! : entry.endDay;
                        const end = Math.max(start, days.indexOf(endDay));
                        const span = ((end - start + 1) / days.length) * 100;
                        return (
                            <View
                                key={entry.card.key}
                                className="flex-row"
                                style={{ marginLeft: `${(start / days.length) * 100}%`, width: `${span}%` }}
                            >
                                <EntryBlock entry={entry} compact onOpen={() => props.onOpen(entry.card.key)} />
                            </View>
                        );
                    })}
                </View>
            )}
            <View className="flex-row">
                <View style={{ width: 44 }}>
                    {hours.map((h) => (
                        <View key={h} style={{ height: HOUR }} className="items-end pr-1">
                            <Text variant="footnote" tone="muted">
                                {hourLabel(h)}
                            </Text>
                        </View>
                    ))}
                </View>
                {days.map((d) => (
                    <View key={d} className="flex-1 border-l border-border" style={{ height: hours.length * HOUR }}>
                        {hours.map((h) => (
                            <View key={h} style={{ height: HOUR }} className="border-t border-border" />
                        ))}
                        {timed
                            .filter((entry) => entry.startDay === d)
                            .map((entry) => (
                                <View
                                    key={entry.card.key}
                                    className="absolute flex-row px-0.5"
                                    style={{
                                        left: 0,
                                        right: 0,
                                        top: (((entry.startMinute ?? 0) - first * 60) / 60) * HOUR,
                                        height: Math.max(
                                            22,
                                            (((entry.endMinute ?? 0) - (entry.startMinute ?? 0)) / 60) * HOUR,
                                        ),
                                    }}
                                >
                                    <EntryBlock
                                        entry={entry}
                                        compact={compact}
                                        onOpen={() => props.onOpen(entry.card.key)}
                                    />
                                </View>
                            ))}
                    </View>
                ))}
            </View>
        </View>
    );
}

/** Month: the six-week grid, each day's entries as short lines; a day opens its Day. */
export function MonthGrid(props: {
    day: string;
    entries: readonly CalendarEntry[];
    today: string;
    onDay: (day: string) => void;
}) {
    const days = daysOf(calendarRange('month', props.day));
    const month = props.day.slice(0, 7);
    const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));
    const tone = theme[useScheme()].tones.emerald;
    return (
        <View className="overflow-hidden rounded-xl border border-border bg-card" testID="dataset-calendar-month">
            <View className="flex-row border-b border-border">
                {weeks[0]!.map((d) => (
                    <Text key={d} variant="footnote" tone="muted" className="flex-1 py-1 text-center">
                        {weekday(d, 'narrow')}
                    </Text>
                ))}
            </View>
            {weeks.map((week) => (
                <View key={week[0]} className="flex-row">
                    {week.map((d) => {
                        const on = entriesOn(props.entries, d);
                        return (
                            <Pressable
                                key={d}
                                onPress={() => props.onDay(d)}
                                accessibilityRole="button"
                                accessibilityLabel={`${calendarTitle('day', d)}, ${on.length} ${on.length === 1 ? 'entry' : 'entries'}`}
                                className="min-h-16 flex-1 gap-0.5 border-t border-l border-border p-0.5 active:bg-accent"
                                testID={`dataset-calendar-month-${d}`}
                            >
                                <Text
                                    variant="footnote"
                                    weight={d === props.today ? 'medium' : undefined}
                                    tone={d.slice(0, 7) !== month ? 'muted' : d === props.today ? 'primary' : 'default'}
                                    className="text-center"
                                >
                                    {dateNumber(d)}
                                </Text>
                                {on.slice(0, 2).map((entry) => (
                                    <View
                                        key={entry.card.key}
                                        className="rounded-sm px-0.5"
                                        style={{ backgroundColor: tone.tint }}
                                    >
                                        <Text
                                            variant="footnote"
                                            numberOfLines={1}
                                            style={{ color: tone.foreground, fontSize: 10, lineHeight: 13 }}
                                        >
                                            {entry.card.title}
                                        </Text>
                                    </View>
                                ))}
                                {on.length > 2 ? (
                                    <Text variant="footnote" tone="muted" style={{ fontSize: 10, lineHeight: 13 }}>
                                        +{on.length - 2}
                                    </Text>
                                ) : null}
                            </Pressable>
                        );
                    })}
                </View>
            ))}
        </View>
    );
}

/** Agenda: the range's days with entries, in order, each entry a card. */
export function AgendaList(props: {
    day: string;
    entries: readonly CalendarEntry[];
    expanded: ReadonlySet<string>;
    onToggle: (key: string) => void;
    onOpen: (key: string) => void;
}) {
    const days = daysOf(calendarRange('agenda', props.day)).filter((d) => entriesOn(props.entries, d).length > 0);
    if (days.length === 0) {
        return (
            <Text
                variant="subheadline"
                tone="muted"
                className="py-8 text-center"
                testID="dataset-calendar-agenda-empty"
            >
                Nothing in the next 30 days.
            </Text>
        );
    }
    return (
        <View className="gap-4" testID="dataset-calendar-agenda">
            {days.map((d) => (
                <View key={d} className="gap-2">
                    <Text variant="section">{calendarTitle('day', d)}</Text>
                    <CardList
                        cards={entriesOn(props.entries, d).map((entry) => entry.card)}
                        expanded={props.expanded}
                        onToggle={props.onToggle}
                        onOpen={props.onOpen}
                        empty=""
                        testID={`dataset-calendar-agenda-${d}`}
                    />
                </View>
            ))}
        </View>
    );
}
