import {
    FAILURE_LABELS,
    LEARNING_LABELS,
    MIN_ANSWERED,
    MIN_GOLDEN,
    THEME_OUTCOMES,
    parseTheme,
    topicKey,
    type ClassifyEvalReport,
    type ClassifyLabelScore,
    type ClassifyOption,
    type ClassifyUse,
} from '@socio/shared/classify';

import { TRIAGE_QUESTIONS } from '../learning/contract.js';

import { FAILURE_QUESTIONS } from './failures.js';
import type { ClassifyStore } from './infra/sqlite/store.js';
import type { Classifier } from './seam.js';
import { cleanTopics, intentQuestions, THEME_FIELDS } from './sessions.js';

/**
 * Evaluating a provider version for a use against its golden set
 * (CB-198, CB-199, CB-200): each subject's newest admin label, given to the
 * provider again from the input stored with it. An answer below the
 * threshold is an abstention. The version passes when the golden set has
 * `MIN_GOLDEN` items, it answered at least `MIN_ANSWERED` of them, and of
 * those it was right at least the threshold's share of the time; then
 * its labels are applied, the sure suggestions it made before included.
 * The same code runs for the admin's **Evaluate** and for
 * `pnpm run classify:eval`.
 *
 * Right means: the same failure category; the same intent; the same
 * triage answer for Learning (CB-200); for themes, the same outcome hint and a topic in common (half the words of one of
 * the admin's topics, filler words aside).
 */

export class EvalRefused extends Error {}

/** What an abstention counts as: Unclassified for failures, "unsure" for the rest. */
export const ABSTAIN: Record<ClassifyUse, string> = {
    failures: 'unclassified',
    intent: '(unsure)',
    themes: '(unsure)',
    learning: '(unsure)',
};

/** Two topic lists share a topic: half the words of either, at least. */
export function topicsMatch(gold: readonly string[], given: readonly string[]) {
    const words = (topic: string) => new Set(topicKey(topic).split(' '));
    return gold.some((a) => {
        const left = words(a);
        return given.some((b) => {
            const right = words(b);
            const common = [...left].filter((word) => right.has(word)).length;
            return common > 0 && common * 2 >= Math.min(left.size, right.size);
        });
    });
}

/**
 * Per-label precision and recall, the confusion matrix, and the verdict.
 * `right` says whether an answer is right when that isn't the label
 * alone (themes' topics); `abstain` is what an abstention is called.
 */
export function scoreEvaluation(
    items: readonly { gold: string; predicted: string; right?: boolean }[],
    labels: readonly string[],
    threshold: number,
    abstain = 'unclassified',
) {
    const confusion: Record<string, Record<string, number>> = {};
    for (const gold of labels) {
        confusion[gold] = Object.fromEntries(labels.map((label) => [label, 0]));
    }
    for (const { gold, predicted } of items) {
        confusion[gold] ??= {};
        confusion[gold][predicted] = (confusion[gold][predicted] ?? 0) + 1;
    }
    const right = (item: (typeof items)[number]) => item.right ?? item.gold === item.predicted;
    const scores: ClassifyLabelScore[] = labels.map((label) => {
        const support = items.filter((item) => item.gold === label).length;
        const predicted = items.filter((item) => item.predicted === label).length;
        const correct = items.filter((item) => item.gold === label && item.predicted === label && right(item)).length;
        return {
            label,
            support,
            predicted,
            correct,
            precision: predicted ? correct / predicted : null,
            recall: support ? correct / support : null,
        };
    });
    const answered = items.filter((item) => item.predicted !== abstain);
    const answeredRight = answered.filter(right).length;
    const correct = items.filter(right).length;
    const precision = answered.length ? answeredRight / answered.length : null;
    return {
        golden: items.length,
        answered: answered.length,
        correct,
        precision,
        accuracy: items.length ? correct / items.length : null,
        passed:
            items.length >= MIN_GOLDEN &&
            answered.length >= MIN_ANSWERED &&
            precision !== null &&
            precision >= threshold,
        labels: scores,
        confusion,
    };
}

export interface EvalDeps {
    classifier: Classifier;
    store: ClassifyStore;
    /** Intent's labels in force (intent only). */
    intentLabels?: () => readonly ClassifyOption[];
    now?: () => number;
}

export interface EvalOptions {
    provider?: string;
    startedBy?: string | null;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}

/** Runs one evaluation of `failures` to its end; see `startEvaluation`. */
export async function evaluateFailures(deps: EvalDeps, options: EvalOptions = {}): Promise<ClassifyEvalReport> {
    return (await startEvaluation(deps, 'failures', options)).report;
}

/** Runs one evaluation of `use` to its end; see `startEvaluation`. */
export async function evaluateUse(
    deps: EvalDeps,
    use: ClassifyUse,
    options: EvalOptions = {},
): Promise<ClassifyEvalReport> {
    return (await startEvaluation(deps, use, options)).report;
}

/** @deprecated The name from CB-198: `startEvaluation(deps, 'failures', …)`. */
export const startFailureEvaluation = (deps: EvalDeps, options: EvalOptions = {}) =>
    startEvaluation(deps, 'failures', options);

/** How a use asks one golden item again, and what counts as right. */
interface Evaluator {
    /** The labels of the per-label table and confusion matrix. */
    labels: readonly string[];
    /** The gold's label, for the table. */
    gold: (label: string) => string;
    /** Asks the provider about the gold's input; `undefined` when the call failed. */
    ask: (
        state: Record<string, unknown>,
        subject: string,
        gold: string,
    ) => Promise<{ predicted: string; right?: boolean } | undefined>;
}

function evaluator(
    deps: EvalDeps,
    use: ClassifyUse,
    provider: string,
    version: string,
    signal: AbortSignal | undefined,
): Evaluator {
    const { classifier } = deps;
    const abstain = ABSTAIN[use];
    const options = (subject: string) => ({
        purpose: 'eval' as const,
        provider,
        subject,
        signal,
    });
    if (use === 'themes') {
        return {
            labels: [...THEME_OUTCOMES, abstain],
            gold: (label) => parseTheme(label)?.outcome ?? 'unclear',
            async ask(state, subject, label) {
                const want = parseTheme(label);
                const result = await classifier.extract('themes', state, THEME_FIELDS, options(subject));
                if (result.status !== 'answered' || result.version !== version) {
                    return undefined;
                }
                const { values } = result;
                const topics = cleanTopics([values.topic1, values.topic2, values.topic3]);
                const confidence = typeof values.confidence === 'number' ? values.confidence : 0;
                if (!topics.length || confidence < classifier.settings('themes').threshold) {
                    return { predicted: abstain };
                }
                const outcome = (values.outcome as string | null) ?? 'unclear';
                return {
                    predicted: outcome,
                    right: !!want && outcome === want.outcome && topicsMatch(want.topics, topics),
                };
            },
        };
    }
    const questions =
        use === 'intent'
            ? intentQuestions(deps.intentLabels?.() ?? [])
            : use === 'learning'
              ? TRIAGE_QUESTIONS
              : FAILURE_QUESTIONS;
    const id = questions[0]!.id;
    return {
        labels:
            use === 'intent'
                ? [...questions[0]!.options.map((o) => o.value), abstain]
                : use === 'learning'
                  ? [...LEARNING_LABELS, abstain]
                  : FAILURE_LABELS,
        gold: (label) => label,
        async ask(state, subject) {
            const result = await classifier.decide(use, state, questions, options(subject));
            if (result.status !== 'answered' || result.version !== version) {
                return undefined;
            }
            const answer = result.answers[id]!;
            return { predicted: answer.sure ? answer.answer : abstain };
        },
    };
}

/**
 * Starts one evaluation of `use` on `provider` (the use's own by
 * default): refuses (`EvalRefused`) when the provider isn't set up or
 * the golden set is too small; otherwise records it as running and
 * resolves with its report to come, done or failed.
 */
export async function startEvaluation(
    deps: EvalDeps,
    use: ClassifyUse,
    options: EvalOptions = {},
): Promise<{ id: string; report: Promise<ClassifyEvalReport> }> {
    const { classifier, store } = deps;
    const now = deps.now ?? Date.now;
    const settings = classifier.settings(use);
    const current = await classifier.current(use, options.provider ?? settings.provider);
    if (!current) {
        throw new EvalRefused('The provider isn’t set up: the workspace needs a default shared model.');
    }
    const labelsVersion = classifier.definition(use).labelsVersion;
    const golden = store.golden(use, labelsVersion);
    if (golden.length < MIN_GOLDEN) {
        throw new EvalRefused(
            `The golden set has ${golden.length} admin labels; an evaluation needs at least ${MIN_GOLDEN}. ${
                use === 'failures'
                    ? 'Label more Unclassified failures in Reliability.'
                    : use === 'learning'
                      ? 'Label more conversations in Learning’s triage list.'
                      : 'Review more sessions in Operations → Themes.'
            }`,
        );
    }
    const startedAt = now();
    const id = await store.startEval(
        use,
        current.provider,
        current.version,
        labelsVersion,
        settings.threshold,
        options.startedBy ?? null,
        startedAt,
    );
    const base = {
        id,
        use,
        provider: current.provider,
        version: current.version,
        labelsVersion,
        threshold: settings.threshold,
        startedAt,
    };
    const ask = evaluator(deps, use, current.provider, current.version, options.signal);
    const abstain = ABSTAIN[use];
    const run = async (): Promise<ClassifyEvalReport> => {
        const items: { gold: string; predicted: string; right?: boolean }[] = [];
        let failedCalls = 0;
        try {
            for (const [index, item] of golden.entries()) {
                if (options.signal?.aborted) {
                    throw new Error('Stopped.');
                }
                let state: Record<string, unknown>;
                try {
                    state = JSON.parse(item.input) as Record<string, unknown>;
                } catch {
                    state = {};
                }
                const gold = ask.gold(item.label);
                const answer = await ask.ask(state, `${item.runId}:${item.idx}`, item.label);
                if (!answer) {
                    failedCalls++;
                }
                items.push({ gold, ...(answer ?? { predicted: abstain }) });
                options.onProgress?.(index + 1, golden.length);
            }
        } catch (error) {
            const report: ClassifyEvalReport = {
                ...base,
                ...scoreEvaluation(items, ask.labels, settings.threshold, abstain),
                finishedAt: now(),
                status: 'failed',
                error: error instanceof Error ? error.message : 'It failed.',
                failedCalls,
                passed: false,
            };
            await store.finishEval(id, report);
            return report;
        }
        const scored = scoreEvaluation(items, ask.labels, settings.threshold, abstain);
        const report: ClassifyEvalReport = {
            ...base,
            ...scored,
            finishedAt: now(),
            status: 'done',
            error: null,
            failedCalls,
        };
        await store.finishEval(id, report);
        if (report.passed) {
            await store.promote(use, current.provider, current.version, labelsVersion, settings.threshold, now());
        }
        return report;
    };
    return { id, report: run() };
}
