import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Pressable, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { runNoteText, type RunNoteRow, type TraceRow } from '../chat/transcript';
import { type StepLine, traceLineMinHeight } from '../chat/turn-trace';
import { useColors } from '../theme/scheme';
import { Button, AppSymbol, Text } from '../ui';
import { systemSpring } from '../ui/motion';

import { ReplyMarkdown } from './chat-markdown';
import { TRACE_ICONS } from './trace-icons';

// A turn's work in the transcript (CB-434; the web's TurnTrace): one quiet
// row, "Worked for 34s · 5 steps", folded until the person opens it, then
// the steps' lines in the web's words, each opening the trace sheet at its
// step (a stored turn's; the running turn's lines only show). Reasoning alone
// opens to its text. Each platform's own disclosure: iOS's chevron.forward
// turning a quarter as the row opens (a DisclosureGroup's), Android's
// Material expand chevron turning half over, with the ripple; each with the
// platform's fast spring (ui/motion.ts), at once under Reduce Motion. A run's notes beyond its stream (run-lifecycle.ts) are
// `RunNote`'s quiet lines.

const ios = Platform.OS === 'ios';
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });
/** The chevron's turn: iOS's quarter, Material's half. */
const TURN = ios ? '90deg' : '180deg';
/** The web's 120 ms is a pointer's; a tap gets the system's own spring. */
const TURN_SPRING = systemSpring(Platform.OS, 'fast');

/** The chevron, turning as the row opens. */
function DisclosureChevron({ open }: { open: boolean }) {
    const reduceMotion = useReducedMotion();
    const [turn] = useState(() => new Animated.Value(open ? 1 : 0));
    useEffect(() => {
        if (reduceMotion) {
            turn.setValue(open ? 1 : 0);
            return;
        }
        const animation = Animated.spring(turn, { toValue: open ? 1 : 0, ...TURN_SPRING, useNativeDriver: true });
        animation.start();
        return () => animation.stop();
    }, [open, reduceMotion, turn]);
    const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', TURN] });
    return (
        <Animated.View style={{ transform: [{ rotate }] }}>
            <AppSymbol
                name={ios ? 'chevron-right' : 'chevron-down'}
                size={13}
                weight="semibold"
                color="muted-foreground"
            />
        </Animated.View>
    );
}

/** What a screen reader says for the row. */
const rowLabel = (row: TraceRow) => (row.failed > 0 ? `${row.label}, ${row.failed} failed` : row.label);

export function TraceDisclosure({
    row,
    open,
    onToggle,
    onStep,
}: {
    row: TraceRow;
    open: boolean;
    onToggle: () => void;
    /** A stored turn's line: the sheet at that step. */
    onStep: (step: string) => void;
}) {
    const colors = useColors();
    const opens = row.lines.length > 0 || row.reasoning !== undefined;
    const testID = `chat-${row.id.replace(':', '-')}`;
    const spin = row.turn === null && row.icon === 'loader-circle';
    return (
        <View testID={testID} className="self-stretch">
            <Pressable
                testID={`${testID}-toggle`}
                accessibilityRole={opens ? 'button' : undefined}
                accessibilityLabel={rowLabel(row)}
                accessibilityState={opens ? { expanded: open } : undefined}
                accessibilityHint={opens ? (open ? 'Hides the steps' : 'Shows the steps') : undefined}
                disabled={!opens}
                onPress={onToggle}
                android_ripple={ios ? undefined : { color: colors.muted }}
                className={
                    ios
                        ? 'min-h-11 flex-row items-center gap-1.5 self-start rounded-md px-2 py-2 active:opacity-50'
                        : 'min-h-12 flex-row items-center gap-1.5 self-start rounded-md px-2 py-2'
                }
            >
                {spin ? (
                    <ActivityIndicator
                        size="small"
                        color={colors['muted-foreground']}
                        style={{ transform: [{ scale: 0.6 }] }}
                    />
                ) : (
                    <AppSymbol name={TRACE_ICONS[row.icon]} size={13} color="muted-foreground" />
                )}
                <Text variant="footnote" tone="muted">
                    {row.label}
                </Text>
                {row.failed > 0 ? (
                    <Text variant="footnote" tone="destructive">
                        · {row.failed} failed
                    </Text>
                ) : null}
                {opens ? <DisclosureChevron open={open} /> : null}
            </Pressable>
            {open && row.reasoning !== undefined ? (
                <View className="mt-0.5 mb-1.5 ml-2 border-l-2 border-border pl-3">
                    <ReplyMarkdown text={row.reasoning} testID={`${testID}-reasoning`} />
                </View>
            ) : null}
            {open && row.lines.length > 0 ? (
                <View testID={`${testID}-steps`} className="mb-1.5 ml-[13px] border-l-2 border-border pl-2">
                    {row.lines.map((line) => (
                        <Line
                            key={line.id}
                            line={line}
                            onPress={row.turn === null ? undefined : () => onStep(line.id)}
                        />
                    ))}
                </View>
            ) : null}
        </View>
    );
}

/** One step's line: the web's StepLine, a stored one opening the sheet at it. */
function Line({ line, onPress }: { line: StepLine; onPress: (() => void) | undefined }) {
    const colors = useColors();
    const failed = line.state === 'failed';
    const label = [
        line.verb,
        line.detail,
        failed ? 'Failed' : line.state === 'stopped' ? 'Stopped' : line.state === 'running' ? 'Running' : undefined,
        line.duration,
    ]
        .filter(Boolean)
        .join(', ');
    return (
        <Pressable
            testID={`trace-line-${line.id}`}
            accessibilityRole={onPress === undefined ? 'text' : 'button'}
            accessibilityLabel={label}
            accessibilityHint={onPress === undefined ? undefined : 'Shows what it took and gave'}
            disabled={onPress === undefined}
            onPress={onPress}
            android_ripple={ios || onPress === undefined ? undefined : { color: colors.muted }}
            className={
                ios
                    ? 'flex-row items-center gap-2 rounded-md px-1.5 py-1 active:bg-muted'
                    : 'flex-row items-center gap-2 rounded-md px-1.5 py-1'
            }
            // CB-502: a line that only shows sits closer; one that opens the sheet keeps the tap target.
            style={{ minHeight: traceLineMinHeight(Platform.OS, onPress !== undefined) }}
        >
            <AppSymbol name={TRACE_ICONS[line.icon]} size={14} color={failed ? 'destructive' : 'muted-foreground'} />
            <Text variant="footnote" tone="muted" numberOfLines={1} className="min-w-0 flex-1">
                <Text variant="footnote">{line.verb}</Text>
                {line.detail ? (
                    <Text variant="footnote" tone="muted" style={line.code ? { fontFamily: MONO } : undefined}>
                        {` ${line.detail}`}
                    </Text>
                ) : null}
            </Text>
            {failed ? (
                <View className="flex-row items-center gap-1">
                    <AppSymbol name="circle-alert" size={13} color="destructive" />
                    <Text variant="footnote" weight="medium" tone="destructive">
                        Failed
                    </Text>
                </View>
            ) : line.state === 'stopped' ? (
                <Text variant="footnote" tone="muted">
                    Stopped
                </Text>
            ) : line.state === 'running' && line.kind === 'tool' ? (
                <ActivityIndicator
                    size="small"
                    color={colors['muted-foreground']}
                    style={{ transform: [{ scale: 0.6 }] }}
                />
            ) : null}
            {line.duration === undefined ? null : (
                <Text variant="footnote" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
                    {line.duration}
                </Text>
            )}
            {onPress === undefined ? null : (
                <AppSymbol name="chevron-right" size={12} weight="semibold" color="muted-foreground" />
            )}
        </Pressable>
    );
}

/** A run's note beyond its stream (CB-434): it works in the background, or it reported back. */
export function RunNote({
    row,
    socio,
    onOpen,
}: {
    row: RunNoteRow;
    socio: string | null;
    onOpen: (link: string) => void;
}) {
    const text = runNoteText(row, socio);
    const link = row.note === 'report' ? (row.link ?? null) : null;
    return (
        <View
            testID={`chat-${row.id.replace(':', '-')}`}
            className="flex-row items-center gap-2 self-stretch rounded-md border border-dashed border-border px-3 py-2"
        >
            <AppSymbol
                name={row.note === 'background' ? 'hourglass' : 'circle-check'}
                size={14}
                color="muted-foreground"
            />
            <Text variant="footnote" tone="muted" className="min-w-0 flex-1" accessibilityRole="text">
                {text}
            </Text>
            {link === null ? null : <Button label="Open" variant="ghost" onPress={() => onOpen(link)} />}
        </View>
    );
}
