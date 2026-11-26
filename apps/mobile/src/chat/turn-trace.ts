import type { Message } from '@ag-ui/core';

import type { HistoryRun } from '@socio/shared/chat/chat-history';
import { contentText } from '@socio/shared/chat/content-text';
import { formatNumber } from '@socio/shared/locale';
import { LOOP_END_LABELS, cachedPercent, type RunTraceView } from '@socio/shared/runs/run-trace';
import { toolLabel, type ToolIcon } from '@socio/shared/runs/tool-labels';
import { TraceTimes } from '@socio/shared/runs/trace-times';
import {
    fieldsOf,
    formatDuration,
    parseJson,
    spanMs,
    splitTurns,
    thoughtLabel,
    toolOutcome,
    turnSteps,
    workedMs,
    type ReasoningStep,
    type StepState,
    type TraceStep,
} from '@socio/shared/runs/turn-steps';
import { toolImageOf } from '@socio/shared/tool-images';

import { cardCalls } from './cards';
import { valueEntries, type ValueEntry } from './trace-values';

// A finished turn's trace in the chat, the web's
// TurnTrace on a phone. Each turn of the stored runs that did work shows one
// row before its first message from the socio: "Thought for 12s" when it only
// reasoned, else "Worked for 34s · 5 steps" with how many failed. The row opens
// a sheet of its steps, one line each in the web's words (shared's tool
// labels), reasoning opening to its text and a failure saying what failed.
// With Advanced mode on, each tool step also shows its time, call id, inputs
// and result (a preview's whole result fetched as it opens), and the sheet the
// run's model, tokens, rounds and raw codes from `/api/runs/:runId/trace`.
// Approvals, page reviews and coding sessions are cards (cards.ts), never
// steps. In the transcript the row is a disclosure (CB-434): folded until the
// person opens it, then the steps' lines (`stepLines`, the web's StepLine),
// each opening the sheet at its step. The running turn's steps come from its
// AG-UI events (live-steps.ts): "Working · 3 steps", or with none known yet
// the phase's "Thinking" or "Working".
// No React Native here: tests/chat runs it under Node.

/** The icons a trace draws: shared's tool icons, and reasoning's. */
export type TraceIcon = ToolIcon | 'brain' | 'loader-circle';

/** A turn of the stored runs that did work. */
export interface ChatTurn {
    /** Its first message's id: the sheet's param and the row's key. */
    readonly id: string;
    /** The message its row goes before: the turn's first one not from the person. */
    readonly anchor: string;
    readonly steps: readonly TraceStep[];
    /** When it began (its user message), when known. */
    readonly start?: number;
    /** The runs its messages came from, in order (an approval's continuation is another). */
    readonly runIds: readonly string[];
    /** Tool results stored as a preview: the call id, and the whole result's length. */
    readonly light: ReadonlyMap<string, number>;
}

/** A turn's row as the transcript draws it. */
export interface TraceSummary {
    readonly label: string;
    readonly icon: TraceIcon;
    /** Tool steps that failed. */
    readonly failed: number;
}

/** How many chats' turns {@link chatTurns} keeps: the chat shown, its trace sheet and a few switched between. */
const TURNS_KEPT = 4;

const kept: { readonly runs: readonly HistoryRun[]; readonly turns: readonly ChatTurn[] }[] = [];

const sameRuns = (a: readonly HistoryRun[], b: readonly HistoryRun[]) =>
    a.length === b.length && a.every((run, index) => run === b[index]);

/**
 * The turns of a chat's stored runs that did work, oldest first. Runs are
 * immutable (the history never rewrites a stored run, and chat-source.ts
 * compares them by identity), so the same runs give the same turns: the last
 * few answers are kept, and a render that leaves the runs as they were (each
 * streaming frame, a reaction, the trace sheet opening) parses no tool result
 * again. A new run, or a page
 * of older ones, builds the chat's turns once more.
 */
export function chatTurns(runs: readonly HistoryRun[]): readonly ChatTurn[] {
    const index = kept.findIndex((entry) => sameRuns(entry.runs, runs));
    if (index >= 0) {
        const [entry] = kept.splice(index, 1);
        kept.unshift(entry!);
        return entry!.turns;
    }
    const turns = turnsOf(runs);
    kept.unshift({ runs: [...runs], turns });
    kept.length = Math.min(kept.length, TURNS_KEPT);
    return turns;
}

function turnsOf(runs: readonly HistoryRun[]): readonly ChatTurn[] {
    const messages: Message[] = [];
    const runOf = new Map<string, string>();
    const times = new TraceTimes();
    const light = new Map<string, number>();
    for (const run of runs) {
        times.absorb(run.times);
        for (const [id, size] of Object.entries(run.light)) {
            light.set(id, size);
        }
        for (const message of run.messages) {
            if (!runOf.has(message.id)) {
                runOf.set(message.id, run.runId);
                messages.push(message);
            }
        }
    }
    const results = new Map<string, string>();
    for (const message of messages) {
        if (message.role === 'tool') {
            results.set(message.toolCallId, contentText(message.content));
        }
    }
    const isCard = cardCalls(messages);
    const turns: ChatTurn[] = [];
    for (const turn of splitTurns(messages)) {
        const steps = turnSteps(turn, { results, times, isCard });
        const anchor = turn.find((message) => message.role !== 'user');
        if (!steps.length || anchor === undefined) {
            continue;
        }
        const first = turn[0]!;
        const start = first.role === 'user' ? times.messages.get(first.id) : undefined;
        const runIds = [...new Set(turn.map((message) => runOf.get(message.id)!))];
        const ids = new Set(steps.flatMap((step) => (step.kind === 'tool' ? [step.id] : [])));
        turns.push({
            id: first.id,
            anchor: anchor.id,
            steps,
            ...(start === undefined ? {} : { start }),
            runIds,
            light: new Map([...light].filter(([id]) => ids.has(id))),
        });
    }
    return turns;
}

const reasoningSeconds = (step: ReasoningStep) => {
    const ms = spanMs(step.span);
    return ms === undefined ? undefined : Math.round(ms / 1000);
};

const count = (steps: number) => `${formatNumber(steps)} ${steps === 1 ? 'step' : 'steps'}`;

/** A finished turn's row: the web's summary line. */
export function traceSummary(turn: Pick<ChatTurn, 'steps' | 'start'>): TraceSummary {
    const { steps } = turn;
    const failed = steps.filter(
        (step) => step.kind === 'tool' && toolOutcome(step.result, false).state === 'failed',
    ).length;
    const only = steps.length === 1 && steps[0]!.kind === 'reasoning' ? steps[0] : undefined;
    if (only) {
        return { label: thoughtLabel(reasoningSeconds(only)), icon: 'brain', failed };
    }
    const worked = workedMs(steps, turn.start);
    return {
        label:
            worked === undefined
                ? `Worked through ${count(steps.length)}`
                : `Worked for ${formatDuration(worked)} · ${count(steps.length)}`,
        icon: 'list-checks',
        failed,
    };
}

/** One step's line in the transcript's disclosure: the web's StepLine. */
export interface StepLine {
    readonly id: string;
    readonly kind: TraceStep['kind'];
    readonly icon: TraceIcon;
    /** "Searched the board for", "Thinking", "Thought for 12s". */
    readonly verb: string;
    /** What it acted on, muted after the verb. */
    readonly detail?: string;
    /** The detail is code (a command, a query). */
    readonly code?: boolean;
    readonly state: StepState;
    /** How long it took, once it ended and when the times say. */
    readonly duration?: string;
}

/**
 * A step line's least height in the open disclosure (CB-502). A line that opens the trace sheet (a
 * stored turn's) keeps the platform's tap target, 44 pt on iOS and 48 dp on Android; a line that only
 * shows (the running turn's) has no tap to size for, so it sits about a quarter to a third closer, as
 * the owner asked, with the text at its size.
 */
export const TRACE_LINE_MIN_HEIGHT = {
    ios: { tappable: 44, quiet: 32 },
    android: { tappable: 48, quiet: 36 },
} as const;

/** The least height of a step line on `platform` (iOS's, else Android's), by whether it takes a tap. */
export function traceLineMinHeight(platform: string, tappable: boolean): number {
    const heights = platform === 'ios' ? TRACE_LINE_MIN_HEIGHT.ios : TRACE_LINE_MIN_HEIGHT.android;
    return tappable ? heights.tappable : heights.quiet;
}

/** A turn's steps as the disclosure's lines, in the web's words (TurnTrace's ReasoningLine and ToolLine). */
export function stepLines(steps: readonly TraceStep[], live: boolean): readonly StepLine[] {
    return steps.map((step): StepLine => {
        if (step.kind === 'reasoning') {
            return {
                id: step.id,
                kind: 'reasoning',
                icon: 'brain',
                verb: step.streaming ? 'Thinking' : thoughtLabel(reasoningSeconds(step)),
                state: step.streaming ? 'running' : 'done',
            };
        }
        const outcome = toolOutcome(step.result, live);
        const label = toolLabel(
            step.call.function.name,
            fieldsOf(parseJson(step.call.function.arguments)),
            fieldsOf(parseJson(step.result)),
            outcome.state !== 'running',
        );
        const ms = outcome.state === 'running' ? undefined : spanMs(step.span);
        return {
            id: step.id,
            kind: 'tool',
            icon: label.icon,
            verb: label.verb,
            ...(label.detail ? { detail: label.detail } : {}),
            ...(label.code ? { code: true } : {}),
            state: outcome.state,
            ...(ms === undefined ? {} : { duration: formatDuration(ms) }),
        };
    });
}

const linesKept = new WeakMap<ChatTurn, readonly StepLine[]>();

/** A stored turn's lines, worked out once per turn (chatTurns keeps the turns of unchanged runs). */
export function turnLines(turn: ChatTurn): readonly StepLine[] {
    const known = linesKept.get(turn);
    if (known !== undefined) {
        return known;
    }
    const lines = stepLines(turn.steps, false);
    linesKept.set(turn, lines);
    return lines;
}

/** Reasoning alone: its text, which the disclosure opens to instead of lines (the web's). */
export const onlyReasoning = (steps: readonly TraceStep[]): ReasoningStep | undefined =>
    steps.length === 1 && steps[0]!.kind === 'reasoning' ? steps[0] : undefined;

/**
 * The running turn's row once its steps are known (live-steps.ts): the web's live
 * summary, "Thinking" while reasoning alone streams, then "Thought for 3s", else
 * "Working · 3 steps" with how many failed. Without steps, the phase's word.
 */
export function liveTraceSummary(phase: string | undefined, steps: readonly TraceStep[]): TraceSummary | null {
    if (steps.length === 0) {
        return liveSummary(phase);
    }
    const failed = steps.filter(
        (step) => step.kind === 'tool' && toolOutcome(step.result, true).state === 'failed',
    ).length;
    const only = onlyReasoning(steps);
    if (only) {
        return {
            label: only.streaming ? 'Thinking' : thoughtLabel(reasoningSeconds(only)),
            icon: 'brain',
            failed,
        };
    }
    return { label: `Working · ${count(steps.length)}`, icon: 'loader-circle', failed };
}

/** The running turn's row, from the live turn's phase; none while it writes or between phases. */
export function liveSummary(phase: string | undefined): TraceSummary | null {
    if (phase === 'thinking') {
        return { label: 'Thinking', icon: 'brain', failed: 0 };
    }
    if (phase === 'working') {
        return { label: 'Working', icon: 'loader-circle', failed: 0 };
    }
    return null;
}

/** What `/api/runs/:runId/trace` told of a run, for Advanced mode. */
export type RunDetail =
    | { readonly state: 'loading' }
    | { readonly state: 'failed' }
    | { readonly state: 'loaded'; readonly view: RunTraceView | null };

/** A step's Advanced detail. */
export interface StepAdvanced {
    /** The tool call's id, to copy. */
    readonly callId: string;
    /** The tool's own name. */
    readonly tool: string;
    readonly duration?: string;
    /** The arguments as sent, and readable. */
    readonly input?: { readonly raw: string; readonly entries: readonly ValueEntry[] };
    /** The whole result's length when the stored one is a preview: the screen fetches it as the step opens. */
    readonly lightSize?: number;
    /** The server's codes for how it ended (`error · http_400`), from the run's trace. */
    readonly codes: readonly string[];
}

/** One line of the sheet. */
export interface StepView {
    readonly id: string;
    readonly kind: TraceStep['kind'];
    readonly icon: TraceIcon;
    readonly verb: string;
    /** What it acted on, muted after the verb. */
    readonly detail?: string;
    /** The detail is code (a command, a query). */
    readonly code?: boolean;
    readonly state: StepState;
    /** A failed or stopped step's line, in the tool's words; a failure without one gets the general line. */
    readonly message?: string;
    /** A reasoning step's text (Markdown). */
    readonly text?: string;
    /** The result as stored (a preview when `advanced.lightSize`): Advanced shows it. */
    readonly result?: string;
    /** The picture a tool returned (a screenshot, CB-157): its step opens to it, as on the web (CB-416). */
    readonly image?: { readonly id: string; readonly name: string };
    /** Only with Advanced mode on. */
    readonly advanced?: StepAdvanced;
}

/** A label and value of the run's Advanced detail; `copy` when it is an id to copy. */
export interface DetailRow {
    readonly name: string;
    readonly value: string;
    readonly copy?: boolean;
}

/** One run's Advanced detail. */
export interface RunSection {
    readonly runId: string;
    readonly state: 'loading' | 'failed' | 'missing' | 'loaded';
    readonly rows: readonly DetailRow[];
    /** One line per model round: its time, tokens and stop code. */
    readonly rounds: readonly string[];
}

export interface TraceSheet {
    readonly summary: TraceSummary;
    readonly steps: readonly StepView[];
    /** With Advanced mode on: the turn's message id, then each run's detail. */
    readonly advanced?: { readonly turnId: string; readonly runs: readonly RunSection[] };
}

/** A failed step's line when its result says nothing more. */
export const STEP_FAILED = 'This step failed.';
/** A stopped step's line when its result says nothing more. */
export const STEP_STOPPED = 'It stopped before it finished.';

const ms = (value: number) => formatDuration(Math.max(0, value));
const tokens = (value: number | undefined) => (value === undefined ? undefined : formatNumber(value));

function toolCodes(callId: string, details: readonly RunDetail[]): string[] {
    for (const detail of details) {
        if (detail.state !== 'loaded' || !detail.view?.trace) {
            continue;
        }
        const tool = (detail.view.trace.tools ?? []).find((entry) => entry.callId === callId);
        if (tool) {
            return [tool.outcome, ...(tool.error ? [tool.error] : [])];
        }
    }
    return [];
}

/** The picture a tool's result names (shared's `toolImageOf`), with its name, "Screenshot" by default (the web's). */
function stepImage(result: string | undefined): StepView['image'] {
    const ref = result === undefined ? undefined : toolImageOf(result);
    if (ref === undefined) {
        return undefined;
    }
    const name = fieldsOf(parseJson(result)).name;
    return { id: ref.id, name: typeof name === 'string' && name.trim() !== '' ? name : 'Screenshot' };
}

function stepView(step: TraceStep, turn: ChatTurn, advanced: boolean, details: readonly RunDetail[]): StepView {
    if (step.kind === 'reasoning') {
        return {
            id: step.id,
            kind: 'reasoning',
            icon: 'brain',
            verb: thoughtLabel(reasoningSeconds(step)),
            state: 'done',
            text: step.text,
        };
    }
    const outcome = toolOutcome(step.result, false);
    const name = step.call.function.name;
    const label = toolLabel(
        name,
        fieldsOf(parseJson(step.call.function.arguments)),
        fieldsOf(parseJson(step.result)),
        true,
    );
    const message =
        outcome.state === 'failed'
            ? (outcome.message ?? STEP_FAILED)
            : outcome.state === 'stopped'
              ? (outcome.message ?? STEP_STOPPED)
              : undefined;
    const image = stepImage(step.result);
    const view: StepView = {
        id: step.id,
        kind: 'tool',
        icon: label.icon,
        verb: label.verb,
        ...(label.detail ? { detail: label.detail } : {}),
        ...(label.code ? { code: true } : {}),
        state: outcome.state,
        ...(message === undefined ? {} : { message }),
        ...(image === undefined ? {} : { image }),
    };
    if (!advanced) {
        return view;
    }
    const raw = step.call.function.arguments;
    const args = parseJson(raw);
    const empty = raw.trim() === '' || (args !== null && typeof args === 'object' && !Object.keys(args).length);
    const duration = spanMs(step.span);
    const lightSize = turn.light.get(step.id);
    return {
        ...view,
        ...(step.result === undefined ? {} : { result: step.result }),
        advanced: {
            callId: step.id,
            tool: name,
            ...(duration === undefined ? {} : { duration: formatDuration(duration) }),
            ...(empty
                ? {}
                : {
                      input: {
                          raw: args === undefined ? raw : JSON.stringify(args, null, 2),
                          entries:
                              args === undefined
                                  ? [{ kind: 'code', label: 'Input', text: raw }]
                                  : valueEntries(args, 'Input'),
                      },
                  }),
            ...(lightSize === undefined ? {} : { lightSize }),
            codes: toolCodes(step.id, details),
        },
    };
}

/** A run's Advanced rows from its trace view: ids, model, tokens, timings and raw codes. */
export function runSection(runId: string, detail: RunDetail): RunSection {
    if (detail.state !== 'loaded') {
        return { runId, state: detail.state, rows: [{ name: 'Run', value: runId, copy: true }], rounds: [] };
    }
    const { view } = detail;
    if (view === null) {
        return { runId, state: 'missing', rows: [{ name: 'Run', value: runId, copy: true }], rounds: [] };
    }
    const trace = view.trace;
    const rows: DetailRow[] = [
        { name: 'Run', value: view.runId, copy: true },
        { name: 'Status', value: view.status },
    ];
    if (view.finishedAt !== null) {
        rows.push({ name: 'Took', value: ms(view.finishedAt - view.startedAt) });
    }
    if (trace?.receivedAt !== undefined) {
        rows.push({ name: 'Waited to start', value: ms(view.startedAt - trace.receivedAt) });
    }
    if (trace?.turn) {
        rows.push({
            name: 'Model',
            value: trace.turn.model === null ? trace.turn.label : `${trace.turn.label} · ${trace.turn.model}`,
        });
        rows.push({ name: 'Source', value: trace.turn.source });
    }
    const totals = trace?.totals;
    if (totals) {
        rows.push({ name: 'Rounds', value: formatNumber(totals.rounds) });
        const input = tokens(totals.inputTokens);
        if (input !== undefined) {
            const cached = cachedPercent(totals);
            rows.push({ name: 'Input tokens', value: cached === undefined ? input : `${input} (${cached}% cached)` });
        }
        const output = tokens(totals.outputTokens);
        if (output !== undefined) {
            rows.push({ name: 'Output tokens', value: output });
        }
        const reasoning = tokens(totals.reasoningTokens);
        if (reasoning !== undefined) {
            rows.push({ name: 'Reasoning tokens', value: reasoning });
        }
        if (totals.reasoningKind) {
            rows.push({ name: 'Reasoning', value: totals.reasoningKind });
        }
    }
    if (trace?.cycle?.tokens !== undefined) {
        rows.push({ name: 'Cycle tokens', value: formatNumber(trace.cycle.tokens) });
    }
    if (trace?.end) {
        rows.push({
            name: 'Ended',
            value: `${LOOP_END_LABELS[trace.end.reason] ?? trace.end.reason} (${trace.end.reason}${trace.end.inferred ? ', inferred' : ''})`,
        });
    }
    if (trace?.dropped) {
        rows.push({ name: 'Entries left out', value: formatNumber(trace.dropped) });
    }
    const rounds = (trace?.rounds ?? []).map((round) =>
        [
            round.summary
                ? `Notes for round ${round.round}`
                : round.retry
                  ? `Round ${round.round}, retry ${round.retry}`
                  : `Round ${round.round}`,
            ms(round.endedAt - round.startedAt),
            round.firstOutputMs === undefined ? undefined : `first output ${ms(round.firstOutputMs)}`,
            round.inputTokens === undefined ? undefined : `${tokens(round.inputTokens)} in`,
            round.outputTokens === undefined ? undefined : `${tokens(round.outputTokens)} out`,
            round.error ? `${round.stop} · ${round.error}` : round.stop,
        ]
            .filter((part) => part !== undefined)
            .join(' · '),
    );
    if (trace === null) {
        rows.push({ name: 'Trace', value: 'Not recorded for this turn' });
    }
    return { runId, state: 'loaded', rows, rounds };
}

/**
 * The sheet of one turn: its steps, and with Advanced mode on what each took
 * and gave and each run's detail (`details`, by the turn's `runIds` order).
 */
export function traceSheet(turn: ChatTurn, advanced: boolean, details: readonly RunDetail[] = []): TraceSheet {
    const steps = turn.steps.map((step) => stepView(step, turn, advanced, details));
    return {
        summary: traceSummary(turn),
        steps,
        ...(advanced
            ? {
                  advanced: {
                      turnId: turn.id,
                      runs: turn.runIds.map((runId, index) =>
                          runSection(runId, details[index] ?? { state: 'loading' }),
                      ),
                  },
              }
            : {}),
    };
}
