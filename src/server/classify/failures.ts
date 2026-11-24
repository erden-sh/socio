import type { DatabaseSync } from 'node:sqlite';

import { scrubState } from '@socio/foundation/classify/scrub-state';
import { runFacts } from '@socio/foundation/operations/run-facts';
import { readRunsWatermark } from '@socio/foundation/operations/runs-watermark';
import {
    FAILURE_INPUT_CHARS,
    FAILURE_LABELS,
    FAILURE_LABELS_VERSION,
    type FailureLabel,
    type FailureLabelView,
} from '@socio/shared/classify';
import { FAILURE_CATEGORY_HINTS, isFailure, type FailureCategory } from '@socio/shared/failure-taxonomy';

import type { RunSourceShape, SourceRun } from '../operations/contract.js';

import type { StoredLabel, Question, UseDefinition } from './contract.js';
import type { ClassifyStore } from './infra/sqlite/store.js';
import type { Classifier } from './seam.js';

/**
 * The `failures` use (CB-198): a label for each failed turn or tool call
 * the failure taxonomy's rules leave Unclassified (CB-189), from the
 * text they couldn't read: the run's operator detail, or the failed tool
 * call's result. Labels are kept per subject (`runId`, and the tool
 * call's place in the trace, -1 for the turn); the analytics ETL applies
 * the ones in force over Unclassified.
 */
export const FAILURES_USE: UseDefinition = {
    labelsVersion: FAILURE_LABELS_VERSION,
    maxChars: FAILURE_INPUT_CHARS,
    subject:
        'A turn of an AI assistant, or one of its tool calls, failed, and the codes it recorded don’t say why. Sort it from the record below.',
    promptVersion: 1,
};

export const FAILURE_QUESTIONS: readonly Question[] = [
    {
        id: 'category',
        ask: 'Why did it fail?',
        options: FAILURE_LABELS.map((value) => ({
            value,
            hint:
                value === 'unclassified'
                    ? 'The record doesn’t say which of the others. Answer this rather than guess.'
                    : FAILURE_CATEGORY_HINTS[value],
        })),
    },
];

/** At most this many labeling calls a tick (a minute). */
export const CALLS_PER_TICK = 5;
/** When labeling is first turned on, it starts this far back. */
export const LOOKBACK_MS = 7 * 86_400_000;
/** Turns read a tick: their facts are worked out in the app's process. */
const RUNS_PER_TICK = 50;
const BYTES_PER_TICK = 4 * 1024 * 1024;
const USE = 'failures';

/** A failed turn or tool call, as the rules sorted it, with the text the model gets. */
export interface FailureSubject {
    runId: string;
    seq: number;
    level: 'turn' | 'tool';
    /** -1 for the turn. */
    idx: number;
    tool: string | null;
    code: string | null;
    endReason: string | null;
    rulesCategory: FailureCategory | null;
    rule: string;
    /** The raw text: scrubbed and clipped only by the seam. */
    text: string;
}

const subjectKey = (subject: Pick<FailureSubject, 'runId' | 'idx'>) => `${subject.runId}:${subject.idx}`;

/** What the model is given about a subject, before the seam scrubs it. */
export const failureState = (subject: FailureSubject) => ({
    level: subject.level,
    tool: subject.tool,
    code: subject.code,
    endReason: subject.endReason,
    text: subject.text,
});

/** The tool results of a turn's stored events, by call id. */
function toolResults(events: string) {
    const results = new Map<string, string>();
    let parsed: unknown;
    try {
        parsed = JSON.parse(events);
    } catch {
        return results;
    }
    if (!Array.isArray(parsed)) {
        return results;
    }
    for (const event of parsed as Record<string, unknown>[]) {
        if (event?.type !== 'TOOL_CALL_RESULT') {
            continue;
        }
        if (typeof event.toolCallId !== 'string') {
            continue;
        }
        results.set(
            event.toolCallId,
            typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? null),
        );
    }
    return results;
}

function callIds(trace: string | null): (string | undefined)[] {
    try {
        const tools = (JSON.parse(trace ?? '{}') as { tools?: unknown[] }).tools;
        return Array.isArray(tools)
            ? tools.map((tool) =>
                  typeof (tool as { callId?: unknown })?.callId === 'string'
                      ? (tool as { callId: string }).callId
                      : undefined,
              )
            : [];
    } catch {
        return [];
    }
}

/**
 * A turn's failed parts, as the rules sort them: the turn when it
 * failed, and each failed tool call. `detail` is the run's operator
 * detail, read apart (the ETL never reads it).
 */
export function failureSubjects(run: SourceRun, detail: string | null): FailureSubject[] {
    const facts = runFacts(run);
    const out: FailureSubject[] = [];
    if (isFailure(facts.turn.failureCategory)) {
        out.push({
            runId: run.runId,
            seq: run.seq,
            level: 'turn',
            idx: -1,
            tool: null,
            code: facts.turn.failureCode,
            endReason: facts.turn.endReason,
            rulesCategory: facts.turn.failureCategory,
            rule: facts.turn.failureRule,
            text: detail ?? '',
        });
    }
    const failedTools = facts.tools.filter((tool) => isFailure(tool.category));
    if (failedTools.length) {
        const ids = callIds(run.trace);
        const results = toolResults(run.events);
        for (const tool of failedTools) {
            const callId = ids[tool.idx];
            out.push({
                runId: run.runId,
                seq: run.seq,
                level: 'tool',
                idx: tool.idx,
                tool: tool.tool,
                code: tool.code,
                endReason: null,
                rulesCategory: tool.category,
                rule: tool.categoryRule,
                text: (callId && results.get(callId)) || '',
            });
        }
    }
    return out;
}

/** Labels apply only where the rules say Unclassified. */
const labelable = (subject: FailureSubject) => subject.rulesCategory === 'unclassified';

/**
 * Labels Unclassified failures with the seam while an admin has the use
 * on, a few calls a minute, under its daily cap; and the admins' side of
 * it: a failure's labels, and their relabels, which are the golden set.
 */
export class FailureLabels {
    constructor(
        private deps: {
            db: DatabaseSync;
            /** The stored turns (Operations' `RunSource`). */
            runs: RunSourceShape;
            store: ClassifyStore;
            classifier: Classifier;
            now?: () => number;
            log?: (line: string) => void;
        },
    ) {}

    private now() {
        return (this.deps.now ?? Date.now)();
    }
    private get reader() {
        return this.deps.runs;
    }
    private detail(runId: string) {
        const row = this.deps.db.prepare('SELECT errorDetail FROM agent_runs WHERE runId=?').get(runId) as
            | { errorDetail: string | null }
            | undefined;
        return row?.errorDetail ?? null;
    }

    /** The subject Reliability shows for a turn: the turn, or its first failed tool call. */
    subject(runId: string, level: 'turn' | 'tool') {
        if (!this.reader.ready()) {
            return undefined;
        }
        const row = this.deps.db.prepare('SELECT seq FROM agent_runs WHERE runId=?').get(runId) as
            | { seq: number }
            | undefined;
        if (!row) {
            return undefined;
        }
        const [run] = this.reader.runsBySeq([row.seq]);
        if (!run || run.status === 'running') {
            return undefined;
        }
        return failureSubjects(run, this.detail(runId)).find((subject) => subject.level === level);
    }

    /** The scrubbed state the model is (or would be) given, as stored with a label. */
    input(subject: FailureSubject) {
        return JSON.stringify(scrubState(failureState(subject), FAILURES_USE.maxChars));
    }

    view(subject: FailureSubject, name: (id: string) => string | undefined): FailureLabelView {
        const labels = this.deps.store.labels(USE, subject.runId, subject.idx);
        const inForce = labels.find((label) => label.applied);
        const suggestion = labels.find((label) => label.source === 'model');
        const text = scrubState(failureState(subject), FAILURES_USE.maxChars).text;
        return {
            runId: subject.runId,
            level: subject.level,
            idx: subject.idx < 0 ? null : subject.idx,
            tool: subject.tool,
            code: subject.code,
            rulesCategory: subject.rulesCategory,
            rule: subject.rule,
            labelable: labelable(subject),
            input: typeof text === 'string' ? text : '',
            label:
                inForce && labelable(subject)
                    ? {
                          label: inForce.label as FailureLabel,
                          source: inForce.source,
                          provider: inForce.provider,
                          at: inForce.at,
                          by: inForce.actorId ? (name(inForce.actorId) ?? inForce.actorId) : null,
                      }
                    : null,
            suggestion: suggestion
                ? {
                      label: suggestion.label as FailureLabel,
                      confidence: suggestion.confidence ?? 0,
                      provider: suggestion.provider ?? '',
                      version: suggestion.version ?? '',
                      applied: suggestion.applied,
                      at: suggestion.at,
                  }
                : null,
        };
    }

    /** An admin's label: in force at once, and part of the golden set. */
    async relabel(subject: FailureSubject, label: FailureLabel, actorId: string) {
        const seq = await this.deps.store.addLabel({
            use: USE,
            labelsVersion: FAILURES_USE.labelsVersion,
            runId: subject.runId,
            idx: subject.idx,
            label,
            source: 'admin',
            provider: null,
            version: null,
            confidence: null,
            applied: true,
            input: this.input(subject),
            actorId,
            at: this.now(),
        });
        return seq;
    }

    /** Asks the model about one subject and keeps its answer. */
    private async label(subject: FailureSubject) {
        const result = await this.deps.classifier.decide('failures', failureState(subject), FAILURE_QUESTIONS, {
            subject: subjectKey(subject),
        });
        if (result.status !== 'answered') {
            return result.status;
        }
        const answer = result.answers.category!;
        const stored: Omit<StoredLabel, 'seq'> = {
            use: USE,
            labelsVersion: FAILURES_USE.labelsVersion,
            runId: subject.runId,
            idx: subject.idx,
            label: answer.answer,
            source: 'model',
            provider: result.provider,
            version: result.version,
            confidence: answer.confidence,
            // Only a sure answer, from a version that passed, is applied;
            // Unclassified changes nothing, so it stays a suggestion.
            applied: result.passed && answer.sure && answer.answer !== 'unclassified',
            input: this.input(subject),
            actorId: null,
            at: this.now(),
        };
        await this.deps.store.addLabel(stored);
        return 'answered' as const;
    }

    /** Where labeling starts the first time: `LOOKBACK_MS` back. */
    private start() {
        const row = this.deps.db
            .prepare('SELECT max(seq) AS seq FROM agent_runs WHERE startedAt < ?')
            .get(this.now() - LOOKBACK_MS) as { seq: number | null };
        return { seq: row.seq ?? 0, running: [] as number[] };
    }

    /**
     * One tick: reads the turns after the cursor (and the ones that were
     * still running), and labels their Unclassified parts that have text
     * and no label or earlier try, at most `CALLS_PER_TICK`. The cursor
     * stops before a turn it couldn't finish (the cap, or the tick's
     * calls), so it is read again next time; what it already did is
     * skipped then.
     */
    async tick() {
        const { classifier, store } = this.deps;
        if (!classifier.settings('failures').enabled || !this.reader.ready()) {
            return;
        }
        if (!(await classifier.current('failures'))) {
            return;
        }
        const saved = store.cursor(USE);
        const state = saved ? readRunsWatermark(saved) : this.start();
        const again = this.reader.runsBySeq(state.running);
        const fresh = this.reader.runsAfter(state.seq, RUNS_PER_TICK, BYTES_PER_TICK);
        let calls = 0;
        /** Labels what it may in `run`; false when it had to stop. */
        const work = async (run: SourceRun) => {
            // Turned on again after a while: older failures aren't asked about.
            if (run.startedAt < this.now() - LOOKBACK_MS) {
                return true;
            }
            let detail: string | null | undefined;
            const facts = failureSubjectsLazy(run, () =>
                detail === undefined ? (detail = this.detail(run.runId)) : detail,
            );
            for (const subject of facts) {
                if (!labelable(subject) || !subject.text.trim()) {
                    continue;
                }
                if (store.labelled(USE, subject.runId, subject.idx)) {
                    continue;
                }
                if (store.triedSubject(USE, subjectKey(subject))) {
                    continue;
                }
                if (calls >= CALLS_PER_TICK) {
                    return false;
                }
                calls++;
                const status = await this.label(subject);
                if (status === 'off' || status === 'capped') {
                    return false;
                }
            }
            return true;
        };
        const running: number[] = [];
        let stopped = false;
        for (const run of again) {
            if (run.status === 'running') {
                running.push(run.seq);
            } else if (stopped || !(await work(run))) {
                stopped = true;
                running.push(run.seq);
            }
        }
        // Turns read again that are gone stay gone.
        let seq = state.seq;
        if (!stopped) {
            for (const run of fresh) {
                if (run.status === 'running') {
                    running.push(run.seq);
                } else if (!(await work(run))) {
                    break;
                }
                seq = run.seq;
            }
        }
        await store.setCursor(USE, JSON.stringify({ seq, running: [...new Set(running)] }));
    }
}

/** `failureSubjects`, reading the detail only for a turn that may be labeled. */
function failureSubjectsLazy(run: SourceRun, detail: () => string | null) {
    return failureSubjects(run, null).map((subject) =>
        subject.level === 'turn' && labelable(subject) ? { ...subject, text: detail() ?? '' } : subject,
    );
}
