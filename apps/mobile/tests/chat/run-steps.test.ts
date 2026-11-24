import { readFileSync } from 'node:fs';

import type { BaseEvent, Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';

import type { HistoryPage } from '@socio/shared/chat/chat-history';
import { applyRoomEvent, type LiveTurn, NO_LIVE_TURN, stillLive } from '@socio/shared/rooms/live-turn';

import { applyRunEvent, keepLiveSteps, liveSteps } from '../../src/chat/live-steps';
import {
    applyLifecycle,
    createRunLifecycle,
    LIFECYCLE_EVENTS,
    lifecycleSignal,
    NO_LIFECYCLE,
} from '../../src/chat/run-lifecycle';
import { runNoteText, transcriptRows, type TraceRow } from '../../src/chat/transcript';
import {
    chatTurns,
    liveTraceSummary,
    stepLines,
    TRACE_LINE_MIN_HEIGHT,
    traceLineMinHeight,
} from '../../src/chat/turn-trace';

// CB-434: the step disclosure on today's AG-UI events (the web's TurnTrace), and
// the lifecycle adapter for the background runs the server will tell later.

const page = JSON.parse(
    readFileSync(new URL('../fixtures/smoke-trace-history.json', import.meta.url), 'utf8'),
) as HistoryPage;
const runs = page.runs;

const ev = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields }) as unknown as BaseEvent;

/** A "smoke trace"-like run: reasoning, a lookup, a query that fails, then the reply starts. */
const EVENTS: BaseEvent[] = [
    ev('RUN_STARTED', {
        runId: 'run-1',
        threadId: 't',
        timestamp: 1_000,
        input: { messages: [{ id: 'u1', role: 'user', content: 'Please smoke trace for me' }] },
    }),
    ev('REASONING_START', { messageId: 'r1', timestamp: 1_000 }),
    ev('REASONING_MESSAGE_START', { messageId: 'r1', timestamp: 1_000 }),
    ev('REASONING_MESSAGE_CONTENT', { messageId: 'r1', delta: 'Let me look.' }),
    ev('REASONING_MESSAGE_END', { messageId: 'r1', timestamp: 3_000 }),
    ev('REASONING_END', { messageId: 'r1', timestamp: 3_000 }),
    ev('TOOL_CALL_START', { toolCallId: 'c1', toolCallName: 'search_space_pages', timestamp: 3_100 }),
    ev('TOOL_CALL_ARGS', { toolCallId: 'c1', delta: '{"query":' }),
    ev('TOOL_CALL_ARGS', { toolCallId: 'c1', delta: '"export"}' }),
    ev('TOOL_CALL_END', { toolCallId: 'c1' }),
    ev('TOOL_CALL_RESULT', { toolCallId: 'c1', messageId: 'tr1', content: '{"results":[]}', timestamp: 3_500 }),
    ev('TOOL_CALL_START', { toolCallId: 'c2', toolCallName: 'data_query', timestamp: 3_600 }),
    ev('TOOL_CALL_ARGS', { toolCallId: 'c2', delta: '{"sql":"select 1"}' }),
    ev('TOOL_CALL_END', { toolCallId: 'c2' }),
];

const run = (events: readonly BaseEvent[], turn: LiveTurn = NO_LIVE_TURN) =>
    events.reduce((current, event) => applyRunEvent(current, event, 'me'), turn);

describe('the running turn steps (live-steps.ts)', () => {
    it('keeps the live turn the plain value shared reduces: the run client and follow tests compare it', () => {
        const plain = EVENTS.reduce((turn, event) => applyRoomEvent(turn, event, 'me'), NO_LIVE_TURN);
        expect(run(EVENTS)).toEqual(plain);
    });

    it('finds the steps in the order they happened, with their times and states', () => {
        const steps = liveSteps(run(EVENTS));
        expect(steps.map((step) => (step.kind === 'tool' ? step.call.function.name : step.kind))).toEqual([
            'reasoning',
            'search_space_pages',
            'data_query',
        ]);
        expect(steps[1]).toMatchObject({ result: '{"results":[]}', span: { start: 3_100, end: 3_500 } });
        expect(
            stepLines(steps, true).map(({ verb, detail, state, duration }) => ({ verb, detail, state, duration })),
        ).toEqual([
            { verb: 'Thought for 2s', detail: undefined, state: 'done', duration: undefined },
            { verb: 'Searched pages', detail: 'for “export”', state: 'done', duration: '0.4s' },
            { verb: 'Querying', detail: 'a dataset', state: 'running', duration: undefined },
        ]);
    });

    it('says "Working · 3 steps" with how many failed, as the web does while a turn runs', () => {
        const failed = run([
            ...EVENTS,
            ev('TOOL_CALL_RESULT', { toolCallId: 'c2', content: '{"error":"no such table"}', timestamp: 4_000 }),
        ]);
        expect(liveTraceSummary(failed.phase, liveSteps(failed))).toEqual({
            label: 'Working · 3 steps',
            icon: 'loader-circle',
            failed: 1,
        });
        // Reasoning alone: "Thinking" while it streams, as the web's folded line.
        const thinking = run(EVENTS.slice(0, 4));
        expect(liveTraceSummary(thinking.phase, liveSteps(thinking))).toMatchObject({
            label: 'Thinking',
            icon: 'brain',
        });
        // Nothing known yet: the phase's word.
        expect(liveTraceSummary('working', [])).toMatchObject({ label: 'Working' });
    });

    it('hands back a new turn when only the steps changed, except for an argument delta', () => {
        const before = run(EVENTS.slice(0, 7));
        const args = applyRunEvent(before, EVENTS[7]!, 'me');
        expect(args).toBe(before);
        const result = run(EVENTS.slice(7, 11), before);
        expect(result).not.toBe(before);
        expect(result).toEqual(before);
        expect(liveSteps(result)[1]).toMatchObject({ result: '{"results":[]}' });
    });

    it('starts each run with no steps, and keeps them as the history takes messages over', () => {
        const done = run(EVENTS);
        const next = applyRunEvent(done, ev('RUN_STARTED', { runId: 'run-2', input: { messages: [] } }), 'me');
        expect(liveSteps(next)).toEqual([]);
        const settled = keepLiveSteps(done, stillLive(done, [{ id: 'u1', role: 'user', content: '' } as Message]));
        expect(settled).not.toBe(done);
        expect(liveSteps(settled)).toBe(liveSteps(done));
    });

    it('leaves page reviews out: a card, never a step', () => {
        const turn = run([EVENTS[0]!, ev('TOOL_CALL_START', { toolCallId: 'rv', toolCallName: 'review_space_page' })]);
        expect(liveSteps(turn)).toEqual([]);
    });

    it('opens the live row to its lines, folded by the screen until the person opens it', () => {
        const rows = transcriptRows([], run(EVENTS));
        const live = rows.find((row): row is TraceRow => row.kind === 'trace')!;
        expect(live).toMatchObject({ id: 'trace:live', turn: null, label: 'Working · 3 steps' });
        expect(live.lines.map((line) => line.verb)).toEqual(['Thought for 2s', 'Searched pages', 'Querying']);
    });
});

describe("a stored turn's disclosure", () => {
    it('carries the lines the web shows under "Worked for …", each one the sheet opens at', () => {
        const row = transcriptRows(runs, NO_LIVE_TURN).find((found): found is TraceRow => found.kind === 'trace')!;
        expect(row.label).toBe('Worked for 8.3s · 5 steps');
        expect(row.lines.map((line) => line.id)).toEqual(chatTurns(runs)[0]!.steps.map((step) => step.id));
        expect(row.lines.find((line) => line.state === 'failed')).toMatchObject({ kind: 'tool' });
        expect(row.reasoning).toBeUndefined();
        // Worked out once per stored turn: a streaming frame redraws without parsing a result again.
        const again = transcriptRows(runs, NO_LIVE_TURN).find((found): found is TraceRow => found.kind === 'trace')!;
        expect(again.lines).toBe(row.lines);
    });

    it('opens a turn that only reasoned to its text, as the web does', () => {
        const run = runs[0]!;
        const thought = {
            ...run,
            messages: [
                run.messages[0]!,
                run.messages[1]!,
                { id: 'a1', role: 'assistant', content: 'Done.' } as Message,
            ],
        };
        const row = transcriptRows([thought], NO_LIVE_TURN).find((found): found is TraceRow => found.kind === 'trace')!;
        expect(row.lines).toEqual([]);
        expect(row.reasoning).toEqual(expect.any(String));
    });
});

describe('the lifecycle adapter (run-lifecycle.ts)', () => {
    it('maps no server event yet: their names are still to come', () => {
        expect(Object.keys(LIFECYCLE_EVENTS)).toEqual([]);
        for (const event of EVENTS) {
            expect(lifecycleSignal(event)).toBeNull();
        }
        expect(lifecycleSignal(ev('CUSTOM', { name: 'run_backgrounded' }))).toBeNull();
        const lifecycle = createRunLifecycle();
        for (const event of EVENTS) {
            lifecycle.observe('t', event);
        }
        expect(lifecycle.state('t')).toBe(NO_LIFECYCLE);
    });

    it('moves a run to the background once, and its report takes it out', () => {
        const lifecycle = createRunLifecycle();
        let told = 0;
        const stop = lifecycle.subscribe('t', () => (told += 1));
        lifecycle.backgrounded('t', { runId: 'run-1', at: 5 });
        lifecycle.backgrounded('t', { runId: 'run-1', at: 6 });
        expect(lifecycle.state('t')).toEqual({ background: [{ runId: 'run-1', at: 5 }], reports: [] });
        lifecycle.finished('t', { runId: 'run-1', summary: 'Found 3 exports.', link: '/chats/t' });
        expect(lifecycle.state('t')).toEqual({
            background: [],
            reports: [{ runId: 'run-1', summary: 'Found 3 exports.', link: '/chats/t' }],
        });
        // A late background signal for a run that already reported changes nothing.
        expect(applyLifecycle(lifecycle.state('t'), { kind: 'background', runId: 'run-1' })).toBe(lifecycle.state('t'));
        expect(told).toBe(2);
        stop();
        expect(lifecycle.state('other')).toBe(NO_LIFECYCLE);
    });

    it('puts the notes at the end of the transcript, in their words', () => {
        const lifecycle = applyLifecycle(applyLifecycle(NO_LIFECYCLE, { kind: 'background', runId: 'run-2' }), {
            kind: 'finished',
            runId: 'run-1',
            summary: '',
            link: null,
        });
        const rows = transcriptRows(runs, NO_LIVE_TURN, { lifecycle });
        expect(rows.slice(-2)).toEqual([
            { kind: 'run-note', id: 'background:run-2', note: 'background', runId: 'run-2' },
            { kind: 'run-note', id: 'report:run-1', note: 'report', runId: 'run-1', summary: '', link: null },
        ]);
        expect(runNoteText(rows.at(-2) as never, 'Ada')).toBe(
            'Ada is working on this in the background. You can keep chatting.',
        );
        expect(runNoteText(rows.at(-1) as never, null)).toBe('Your socio finished working in the background.');
        expect(runNoteText({ note: 'report', summary: 'Found 3 exports.' }, 'Ada')).toBe('Found 3 exports.');
    });
});

describe('the disclosure on screen (turn-disclosure.tsx)', () => {
    const source = readFileSync(new URL('../../src/screens/turn-disclosure.tsx', import.meta.url), 'utf8');
    const chat = readFileSync(new URL('../../src/screens/chat.tsx', import.meta.url), 'utf8');

    it("is each platform's own: iOS's chevron turning a quarter, Material's expand turning half over", () => {
        expect(source).toContain("const TURN = ios ? '90deg' : '180deg';");
        expect(source).toMatch(/<AppSymbol\s+name=\{ios \? 'chevron-right' : 'chevron-down'\}/);
        expect(source).toContain('accessibilityState={opens ? { expanded: open } : undefined}');
        expect(source).toContain('turn.setValue(open ? 1 : 0)');
    });

    it("sits a running turn's lines closer and keeps a tappable line's target (CB-502)", () => {
        // A quarter to a third closer than the 44 pt and 48 dp rows they had.
        for (const platform of ['ios', 'android'] as const) {
            const { tappable, quiet } = TRACE_LINE_MIN_HEIGHT[platform];
            expect(1 - quiet / tappable).toBeGreaterThanOrEqual(0.25);
            expect(1 - quiet / tappable).toBeLessThanOrEqual(1 / 3);
        }
        expect(traceLineMinHeight('ios', false)).toBe(32);
        expect(traceLineMinHeight('android', false)).toBe(36);
        // The tap targets: 44 pt on iOS, 48 dp on Android.
        expect(traceLineMinHeight('ios', true)).toBe(44);
        expect(traceLineMinHeight('android', true)).toBe(48);
        expect(source).toContain('style={{ minHeight: traceLineMinHeight(Platform.OS, onPress !== undefined) }}');
        // The line's own minimum is that one alone, and the text keeps its size.
        expect(source).not.toMatch(/'min-h-1[12] flex-row items-center gap-2 rounded-md px-1\.5/);
        expect(source).toMatch(/<Text variant="footnote" tone="muted" numberOfLines=\{1\} className="min-w-0 flex-1">/);
    });

    it('stays folded until the person opens it, and a line opens the sheet at its step', () => {
        expect(chat).toContain('useState<ReadonlySet<string>>(() => new Set())');
        expect(chat).toContain('open={openTraces.has(item.id)}');
        expect(chat).toContain("navigation.navigate('TurnTrace', { chat, turn, step })");
        expect(chat).not.toContain('function TraceLine(');
    });
});
