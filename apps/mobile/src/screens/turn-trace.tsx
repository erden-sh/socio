import type { StaticScreenProps } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { chatSource } from '../chat/chat-source';
import { loadRunTrace } from '../chat/run-trace';
import { prettyResult, resultEntries, type ValueEntry } from '../chat/trace-values';
import { chatTurns, type RunDetail, type RunSection, type StepView, traceSheet } from '../chat/turn-trace';
import { useHasWorkspaceScope, useWorkspaceScope } from '../live';
import { useAdvanced } from '../platform/device-settings';
import type { ChatHistory } from '../sync/history';
import { Button, AppSymbol, Text } from '../ui';

import { CardPicture } from './attachments';
import { ReplyMarkdown } from './chat-markdown';
import { TRACE_ICONS } from './trace-icons';

// A turn's trace: the sheet a transcript's
// trace line opens (CB-434: at its step, `step`, opened), over the chat, which keeps its history in memory. Its steps
// in the web's words, reasoning opening to its text, a failure saying what
// failed, a tool's picture (a screenshot) opening to it (CB-416, the web's
// ToolImageThumb). With Advanced mode on, each tool step opens to its time, raw codes,
// call id, inputs and result (a preview's whole result fetched as it opens),
// and the run's model, tokens, rounds and timings come from its trace.

/** Characters a code block shows before "Show all". */
const CODE_CHARS = 2_400;
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

export function TurnTraceScreen({ route }: StaticScreenProps<{ chat: string; turn: string; step?: string }>) {
    return useHasWorkspaceScope() ? (
        <TurnTrace chat={route.params.chat} turn={route.params.turn} step={route.params.step} />
    ) : null;
}

function TurnTrace({ chat, turn: turnId, step: opened }: { chat: string; turn: string; step: string | undefined }) {
    const scope = useWorkspaceScope();
    const insets = useSafeAreaInsets();
    const advanced = useAdvanced();
    const [source] = useState(() => chatSource(scope.histories.history(chat), scope.follows.follow(chat)));
    useEffect(() => source.history.use(), [source]);
    const snapshot = useSyncExternalStore(source.subscribe, source.get);
    const turn = chatTurns(snapshot.runs).find((found) => found.id === turnId);
    const [details, retry] = useRunDetails(turn?.runIds ?? [], advanced);
    if (turn === undefined) {
        return (
            <View testID="turn-trace" className="bg-sheet p-5">
                <Text variant="subheadline" tone="muted">
                    This turn isn’t in the chat any more.
                </Text>
            </View>
        );
    }
    const sheet = traceSheet(turn, advanced, details);
    return (
        <ScrollView
            testID="turn-trace"
            className="bg-sheet"
            contentContainerStyle={{ padding: 20, paddingBottom: 20 + insets.bottom, gap: 16 }}
        >
            <View className="flex-row items-center gap-2">
                <AppSymbol name={TRACE_ICONS[sheet.summary.icon]} color="muted-foreground" />
                <Text accessibilityRole="header" variant="headline" className="flex-1">
                    {sheet.summary.label}
                </Text>
                {sheet.summary.failed > 0 ? <Text tone="destructive">{sheet.summary.failed} failed</Text> : null}
            </View>
            <View className="gap-1">
                {sheet.steps.map((step) => (
                    <Step key={step.id} step={step} history={source.history} opened={step.id === opened} />
                ))}
            </View>
            {sheet.advanced ? (
                <View testID="turn-trace-advanced" className="gap-3">
                    <DetailLine name="Turn" value={sheet.advanced.turnId} copy />
                    {sheet.advanced.runs.map((run) => (
                        <Run key={run.runId} run={run} onRetry={retry} />
                    ))}
                </View>
            ) : null}
        </ScrollView>
    );
}

/** Each run's trace while Advanced mode is on, by `runIds`' order, with Try again for those that failed. */
function useRunDetails(runIds: readonly string[], advanced: boolean): [RunDetail[], () => void] {
    const scope = useWorkspaceScope();
    const key = runIds.join('\n');
    const [found, setFound] = useState<Readonly<Record<string, RunDetail>>>({});
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!advanced || key === '') {
            return;
        }
        const controller = new AbortController();
        for (const runId of key.split('\n')) {
            setFound((known) =>
                known[runId]?.state === 'loaded' ? known : { ...known, [runId]: { state: 'loading' } },
            );
            loadRunTrace(scope.fetch, runId, controller.signal).then(
                (view) => setFound((known) => ({ ...known, [runId]: { state: 'loaded', view } })),
                (error: unknown) => {
                    if (!controller.signal.aborted) {
                        console.warn('[trace] run trace not loaded', error);
                        setFound((known) => ({ ...known, [runId]: { state: 'failed' } }));
                    }
                },
            );
        }
        return () => controller.abort();
    }, [scope, key, advanced, attempt]);
    return [runIds.map((runId) => found[runId] ?? { state: 'loading' }), () => setAttempt((value) => value + 1)];
}

function Step({ step, history, opened }: { step: StepView; history: ChatHistory; opened: boolean }) {
    const opens = step.kind === 'reasoning' || step.advanced !== undefined || step.image !== undefined;
    // The transcript's line the sheet came from opens as the sheet does (CB-434).
    const [open, setOpen] = useState(opened && opens);
    const failed = step.state === 'failed';
    const label = [step.verb, step.detail, failed ? 'Failed' : step.state === 'stopped' ? 'Stopped' : undefined]
        .filter(Boolean)
        .join(', ');
    return (
        <View testID={`trace-step-${step.id}`}>
            <Pressable
                accessibilityRole={opens ? 'button' : undefined}
                accessibilityLabel={label}
                accessibilityState={opens ? { expanded: open } : undefined}
                disabled={!opens}
                onPress={() => setOpen(!open)}
                className="min-h-11 flex-row items-center gap-2 rounded-md px-2 py-2 active:bg-muted"
            >
                <AppSymbol name={TRACE_ICONS[step.icon]} color={failed ? 'destructive' : 'muted-foreground'} />
                <Text className="flex-1" numberOfLines={open ? undefined : 2}>
                    {step.verb}
                    {step.detail ? (
                        <Text variant="subheadline" tone="muted" style={step.code ? { fontFamily: MONO } : undefined}>
                            {` ${step.detail}`}
                        </Text>
                    ) : null}
                </Text>
                {failed ? (
                    <Text variant="footnote" weight="medium" tone="destructive">
                        Failed
                    </Text>
                ) : step.state === 'stopped' ? (
                    <Text variant="footnote" tone="muted">
                        Stopped
                    </Text>
                ) : null}
                {step.advanced?.duration ? (
                    <Text variant="footnote" tone="muted">
                        {step.advanced.duration}
                    </Text>
                ) : null}
                {opens ? <AppSymbol name="chevron-right" size={14} color="muted-foreground" /> : null}
            </Pressable>
            {step.message !== undefined ? (
                <View
                    className={
                        failed
                            ? 'ml-8 flex-row items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2'
                            : 'ml-8 flex-row items-start gap-2 rounded-md border border-border bg-muted p-2'
                    }
                >
                    <AppSymbol name="circle-alert" size={14} color={failed ? 'destructive' : 'muted-foreground'} />
                    <Text variant="footnote" tone={failed ? 'destructive' : 'muted'} className="flex-1">
                        {step.message}
                    </Text>
                </View>
            ) : null}
            {open && step.text !== undefined ? (
                <View className="ml-8 border-l-2 border-border pl-3">
                    <ReplyMarkdown text={step.text} testID={`trace-reasoning-${step.id}`} />
                </View>
            ) : null}
            {open && step.image !== undefined ? (
                // The web's ToolImageThumb (CB-157): the picture through the image cache, opening the viewer.
                <View className="ml-8 py-1">
                    <CardPicture image={step.image} testID={`trace-image-${step.id}`} />
                </View>
            ) : null}
            {open && step.advanced ? <ToolDetails step={step} history={history} /> : null}
        </View>
    );
}

function ToolDetails({ step, history }: { step: StepView; history: ChatHistory }) {
    const advanced = step.advanced!;
    const full = useFullResult(history, advanced.callId, advanced.lightSize !== undefined);
    const result = full.text ?? step.result;
    return (
        <View testID={`trace-details-${step.id}`} className="ml-8 gap-3 py-2">
            <DetailLine name="Tool" value={advanced.tool} />
            <DetailLine name="Call" value={advanced.callId} copy />
            {advanced.codes.length > 0 ? <DetailLine name="Codes" value={advanced.codes.join(' · ')} /> : null}
            {advanced.input ? (
                <Section label="Input" copy={advanced.input.raw}>
                    <Entries entries={advanced.input.entries} />
                </Section>
            ) : null}
            {step.state === 'running' ? (
                <Text variant="subheadline" tone="muted">
                    Waiting for the result…
                </Text>
            ) : null}
            {result === undefined ? null : (
                <Section label="Result" copy={prettyResult(result)}>
                    {full.loading ? (
                        <Text variant="footnote" tone="muted">
                            Loading the whole result ({Math.max(1, Math.round((advanced.lightSize ?? 0) / 1024))} KB)…
                        </Text>
                    ) : null}
                    {full.failed ? (
                        <View className="gap-1">
                            <Text variant="footnote" tone="muted">
                                Only part of this result is shown: the rest didn’t load.
                            </Text>
                            <Button label="Try again" variant="ghost" onPress={full.retry} />
                        </View>
                    ) : null}
                    <Entries entries={resultEntries(result)} />
                </Section>
            )}
        </View>
    );
}

/** A preview's whole result, fetched once the step opens (the history keeps it). */
function useFullResult(history: ChatHistory, callId: string, light: boolean) {
    const [text, setText] = useState<string>();
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        if (!light) {
            return;
        }
        let active = true;
        setFailed(false);
        history.fullResult(callId).then(
            (content) => {
                if (active) {
                    setText(content);
                }
            },
            (error: unknown) => {
                if (active) {
                    console.warn('[trace] whole result not loaded', error);
                    setFailed(true);
                }
            },
        );
        return () => {
            active = false;
        };
    }, [history, callId, light, attempt]);
    const cut = light && text === undefined;
    return { text, loading: cut && !failed, failed: cut && failed, retry: () => setAttempt((value) => value + 1) };
}

function Run({ run, onRetry }: { run: RunSection; onRetry: () => void }) {
    return (
        <View testID={`trace-run-${run.runId}`} className="gap-2 rounded-xl border border-border bg-card p-3">
            {run.rows.map((row) => (
                <DetailLine key={row.name} name={row.name} value={row.value} copy={row.copy} />
            ))}
            {run.state === 'loading' ? (
                <Text variant="subheadline" tone="muted">
                    Loading the run’s trace…
                </Text>
            ) : null}
            {run.state === 'missing' ? (
                <Text variant="subheadline" tone="muted">
                    This run’s trace isn’t available to you.
                </Text>
            ) : null}
            {run.state === 'failed' ? (
                <View className="gap-1">
                    <Text variant="subheadline" tone="muted">
                        The run’s trace didn’t load.
                    </Text>
                    <Button label="Try again" variant="ghost" onPress={onRetry} />
                </View>
            ) : null}
            {run.rounds.map((round) => (
                <Text key={round} variant="footnote" tone="muted" style={{ fontFamily: MONO }}>
                    {round}
                </Text>
            ))}
        </View>
    );
}

function copyText(text: string) {
    Clipboard.setStringAsync(text).catch((error: unknown) => console.warn('[trace] not copied', error));
}

function DetailLine({ name, value, copy }: { name: string; value: string; copy?: boolean }) {
    return (
        <View className="min-h-6 flex-row items-center gap-3">
            <Text variant="footnote" tone="muted" className="w-28">
                {name}
            </Text>
            <Text variant="footnote" selectable className="flex-1" style={copy ? { fontFamily: MONO } : undefined}>
                {value}
            </Text>
            {copy ? (
                <Button
                    label={`Copy ${name.toLowerCase()} id`}
                    icon="copy"
                    iconOnly
                    variant="ghost"
                    onPress={() => copyText(value)}
                />
            ) : null}
        </View>
    );
}

function Section({ label, copy, children }: { label: string; copy: string; children: ReactNode }) {
    return (
        <View className="gap-2">
            <View className="flex-row items-center justify-between">
                <Text variant="footnote" weight="semibold">
                    {label}
                </Text>
                <Button
                    label={`Copy ${label.toLowerCase()}`}
                    icon="copy"
                    iconOnly
                    variant="ghost"
                    onPress={() => copyText(copy)}
                />
            </View>
            {children}
        </View>
    );
}

function Entries({ entries }: { entries: readonly ValueEntry[] }) {
    return (
        <View className="gap-2">
            {entries.map((entry, index) => (
                <Entry key={index} entry={entry} />
            ))}
        </View>
    );
}

function Entry({ entry }: { entry: ValueEntry }) {
    if (entry.kind === 'row') {
        return <DetailLine name={entry.name} value={entry.value} />;
    }
    if (entry.kind === 'text') {
        return (
            <Text variant="footnote" selectable>
                {entry.text}
            </Text>
        );
    }
    if (entry.kind === 'code') {
        return <CodeBlock label={entry.label} text={entry.text} error={entry.tone === 'error'} />;
    }
    return (
        <View className="gap-1">
            <Text variant="footnote" tone="muted">
                {entry.label} · {entry.items.length + entry.more}
            </Text>
            {entry.items.map((item, index) => (
                <Text key={index} variant="footnote">
                    {item.title}
                    {item.meta ? <Text variant="subheadline" tone="muted">{` · ${item.meta}`}</Text> : null}
                    {item.excerpt ? <Text variant="subheadline" tone="muted">{`\n${item.excerpt}`}</Text> : null}
                </Text>
            ))}
            {entry.more > 0 ? (
                <Text variant="footnote" tone="muted">
                    and {entry.more} more (copy for all)
                </Text>
            ) : null}
        </View>
    );
}

function CodeBlock({ label, text, error }: { label: string; text: string; error: boolean }) {
    const [all, setAll] = useState(false);
    const cut = !all && text.length > CODE_CHARS;
    return (
        <View className="overflow-hidden rounded-md border border-border bg-muted">
            <Text variant="footnote" tone={error ? 'destructive' : 'muted'} className="border-b border-border p-2">
                {label}
            </Text>
            <Text variant="footnote" selectable className="p-3" style={{ fontFamily: MONO }}>
                {cut ? `${text.slice(0, CODE_CHARS)}…` : text}
            </Text>
            {cut ? (
                <Button label={`Show all ${text.length} characters`} variant="ghost" onPress={() => setAll(true)} />
            ) : null}
        </View>
    );
}
