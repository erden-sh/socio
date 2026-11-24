import type { DatabaseSync } from 'node:sqlite';

import { scrubState } from '@socio/foundation/classify/scrub-state';
import { runFacts } from '@socio/foundation/operations/run-facts';
import { readRunsWatermark } from '@socio/foundation/operations/runs-watermark';
import {
    SESSION_INPUT_CHARS,
    SESSION_MESSAGES,
    THEME_OUTCOMES,
    THEME_TOPIC_CHARS,
    THEME_TOPICS,
    THEMES_LABELS_VERSION,
    intentLabelsVersion,
    parseTheme,
    topicKey,
    type ClassifyOption,
    type SessionLabelRow,
    type SessionLabelView,
    type ThemeLabel,
    type ThemeOutcome,
} from '@socio/shared/classify';
import { runSource } from '@socio/shared/runs/run-sources';

import type { RunSourceShape, SourceRun } from '../operations/contract.js';

import type { StoredLabel, ExtractField, Question, UseDefinition } from './contract.js';
import type { ClassifyStore } from './infra/sqlite/store.js';
import type { Classifier } from './seam.js';

/**
 * Intent and themes (CB-199): what each of people's sessions was for, as
 * one label from intent's admin-edited list (`decide`), and one to three
 * topics with a hint of how it went (`extract`), read from the chat's
 * title and the session's first person messages. A session is known by
 * the turn that opened it: the first turn a person started after the
 * chat was quiet for the session gap (Operations → Settings), labeled
 * as `runId` with `idx` -1 in `classify_labels`. Sessions themselves are
 * cut again when Operations asks (CB-190), so a session takes the labels
 * of the earliest labeled turn in it, whatever the gap is then.
 *
 * Both are off until an admin turns them on, scrubbed and clipped by the
 * seam before any provider sees them, capped per day, and count only
 * once the provider's version passed an evaluation on the golden set:
 * admins' own labels, given in Themes' review.
 */

export type SessionUse = 'intent' | 'themes';
export const SESSION_USES: readonly SessionUse[] = ['intent', 'themes'];

/** The prompt's versions: a change needs a new evaluation. */
const INTENT_PROMPT = 1;
const THEMES_PROMPT = 1;

/** Intent's definition for a list of labels: each list is its own version. */
export function intentUse(labels: readonly ClassifyOption[]): UseDefinition {
    return {
        labelsVersion: intentLabelsVersion(labels),
        maxChars: SESSION_INPUT_CHARS,
        subject:
            'A person started a session in a chat with an AI assistant at work. Below are the chat’s title and the first messages the person wrote in it. Say what they came for.',
        promptVersion: INTENT_PROMPT,
    };
}

export const THEMES_USE: UseDefinition = {
    labelsVersion: THEMES_LABELS_VERSION,
    maxChars: SESSION_INPUT_CHARS,
    subject:
        'A person started a session in a chat with an AI assistant at work. Below are the chat’s title and the first messages the person wrote in it. Name what it is about, for a report of common topics across the workspace.',
    promptVersion: THEMES_PROMPT,
};

export function intentQuestions(labels: readonly ClassifyOption[]): readonly Question[] {
    return [
        {
            id: 'intent',
            ask: 'What did the person come for?',
            options: labels.map(({ value, hint }) => ({ value, hint })),
        },
    ];
}

const topicField = (which: string): ExtractField => ({
    type: 'string',
    max: THEME_TOPIC_CHARS,
    description: `${which} A few plain words for the subject matter (such as "march invoices" or "onboarding checklist"). Never a person’s name, contact details, figures or anything that identifies someone.`,
});
export const THEME_FIELDS: Record<string, ExtractField> = {
    topic1: topicField('The main topic.'),
    topic2: topicField('A second topic, only if the session clearly has one.'),
    topic3: topicField('A third topic, only if the session clearly has one.'),
    outcome: {
        type: 'enum',
        options: THEME_OUTCOMES,
        description:
            'Whether the person’s messages suggest they got what they came for: "resolved", "unresolved" (they say it didn’t work or they gave up) or "unclear".',
    },
    confidence: {
        type: 'number',
        min: 0,
        max: 1,
        description: 'How likely your topics are right.',
    },
};

/** At most this many calls a use makes a tick (a minute). */
export const SESSION_CALLS_PER_TICK = 5;
/** When a use is first turned on, it starts this far back. */
export const SESSION_LOOKBACK_MS = 7 * 86_400_000;
const RUNS_PER_TICK = 50;
const BYTES_PER_TICK = 4 * 1024 * 1024;
/** The later turns of a session read for its first messages. */
const FOLLOWING_RUNS = 6;

/** A session as the model reads it: where it is, and its text before scrubbing. */
export interface SessionSubject {
    runId: string;
    seq: number;
    threadId: string;
    socioId: string | null;
    startedAt: number;
    title: string;
    /** The session's first person messages, at most `SESSION_MESSAGES`. */
    messages: string[];
}

/** What the model is given about a session, before the seam scrubs it. */
export const sessionState = (subject: SessionSubject) => ({
    title: subject.title,
    first: subject.messages[0] ?? null,
    second: subject.messages[1] ?? null,
    third: subject.messages[2] ?? null,
});

const subjectKey = (runId: string) => `${runId}:-1`;
const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A message's text: a string, or its text parts (attachments left out). */
function textOf(content: unknown) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .flatMap((part) => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
        .join('\n');
}

/** The person messages a turn brought (`RUN_STARTED.input.messages`), with text. */
export function personTexts(events: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(events);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    const out: string[] = [];
    for (const event of parsed) {
        if (!isObject(event) || event.type !== 'RUN_STARTED') {
            continue;
        }
        const input = isObject(event.input) ? event.input : {};
        for (const message of Array.isArray(input.messages) ? input.messages : []) {
            if (isObject(message) && message.role === 'user') {
                const text = textOf(message.content).trim();
                if (text) {
                    out.push(text);
                }
            }
        }
    }
    return out;
}

/** A turn a person started, from a source the registry calls human. */
function personTurn(run: SourceRun) {
    return runSource(run.source).kind === 'human' && runFacts(run).turn.triggerKind === 'person';
}

/** Topics as kept: trimmed, clipped, one per key, at most three. */
export function cleanTopics(topics: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const topic of topics) {
        if (typeof topic !== 'string') {
            continue;
        }
        const text = topic.trim().replace(/\s+/g, ' ').slice(0, THEME_TOPIC_CHARS);
        const key = topicKey(text);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(text);
        if (out.length === THEME_TOPICS) {
            break;
        }
    }
    return out;
}

/**
 * Labels sessions' intent and themes while an admin has a use on, a few
 * calls a minute each, under its daily cap; and the admins' side: a
 * session's labels, and their own, which are each use's golden set.
 */
export class SessionLabels {
    constructor(
        private deps: {
            db: DatabaseSync;
            /** The stored turns (Operations' `RunSource`). */
            runs: RunSourceShape;
            store: ClassifyStore;
            classifier: Classifier;
            /** Intent's labels in force. */
            intentLabels: () => ClassifyOption[];
            /** The session gap in force (Operations → Settings), in minutes. */
            sessionGapMinutes: () => number;
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
    private get gapMs() {
        return this.deps.sessionGapMinutes() * 60_000;
    }

    /** The chat's title and socio. */
    private chat(threadId: string) {
        return this.deps.db.prepare('SELECT title, dotId FROM thread_bindings WHERE id=?').get(threadId) as
            | { title: string; dotId: string }
            | undefined;
    }

    /**
     * The session `run` opens, once its first messages are in: undefined
     * when it doesn't open one (another turn of the chat came within the
     * gap before it, or no person started it); `'pending'` while the
     * session may still bring more of its first messages.
     */
    subjectOf(run: SourceRun): SessionSubject | 'pending' | undefined {
        if (run.status === 'running') {
            return 'pending';
        }
        if (!personTurn(run)) {
            return undefined;
        }
        const first = personTexts(run.events);
        if (!first.length) {
            return undefined;
        }
        const gap = this.gapMs;
        const before = this.deps.db
            .prepare(
                'SELECT COALESCE(finishedAt, startedAt) AS last FROM agent_runs WHERE threadId=? AND seq<? ORDER BY seq DESC LIMIT 1',
            )
            .get(run.threadId, run.seq) as { last: number } | undefined;
        if (before && run.startedAt - before.last < gap) {
            return undefined;
        }
        const messages = [...first];
        let last = run.finishedAt ?? run.startedAt;
        let closed = false;
        if (messages.length < SESSION_MESSAGES) {
            const later = this.deps.db
                .prepare(
                    'SELECT seq, runId, status, startedAt, finishedAt, events FROM agent_runs WHERE threadId=? AND seq>? ORDER BY seq LIMIT ?',
                )
                .all(run.threadId, run.seq, FOLLOWING_RUNS) as unknown as Pick<
                SourceRun,
                'seq' | 'runId' | 'status' | 'startedAt' | 'finishedAt' | 'events'
            >[];
            for (const next of later) {
                // A later session's turn: this one has ended.
                if (next.startedAt - last >= gap) {
                    closed = true;
                    break;
                }
                messages.push(...personTexts(next.events));
                if (messages.length >= SESSION_MESSAGES) {
                    break;
                }
                if (next.status === 'running') {
                    return 'pending';
                }
                last = next.finishedAt ?? next.startedAt;
            }
        }
        if (messages.length < SESSION_MESSAGES && !closed && this.now() - last < gap) {
            return 'pending';
        }
        const chat = this.chat(run.threadId);
        return {
            runId: run.runId,
            seq: run.seq,
            threadId: run.threadId,
            socioId: chat?.dotId ?? run.socioId,
            startedAt: run.startedAt,
            title: chat?.title ?? '',
            messages: messages.slice(0, SESSION_MESSAGES),
        };
    }

    /** The session a turn opened, for the review; whatever came of it so far. */
    subject(runId: string): SessionSubject | undefined {
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
        const found = this.subjectOf(run);
        if (found && found !== 'pending') {
            return found;
        }
        // A session still bringing messages, or one an earlier gap cut: the
        // turn's own messages, if it has any.
        const messages = personTexts(run.events);
        if (!messages.length) {
            return undefined;
        }
        const chat = this.chat(run.threadId);
        return {
            runId,
            seq: run.seq,
            threadId: run.threadId,
            socioId: chat?.dotId ?? run.socioId,
            startedAt: run.startedAt,
            title: chat?.title ?? '',
            messages: messages.slice(0, SESSION_MESSAGES),
        };
    }

    /** The scrubbed state the model is (or would be) given, as stored with a label. */
    input(subject: SessionSubject) {
        return JSON.stringify(scrubState(sessionState(subject), SESSION_INPUT_CHARS));
    }

    private definition(use: SessionUse) {
        return use === 'intent' ? intentUse(this.deps.intentLabels()) : THEMES_USE;
    }

    /** Asks the model about one session for `use`, and keeps its answer. */
    private async label(use: SessionUse, subject: SessionSubject) {
        const { classifier, store } = this.deps;
        const base = {
            use,
            labelsVersion: this.definition(use).labelsVersion,
            runId: subject.runId,
            idx: -1,
            source: 'model' as const,
            input: this.input(subject),
            actorId: null,
            at: this.now(),
        };
        if (use === 'intent') {
            const result = await classifier.decide(
                'intent',
                sessionState(subject),
                intentQuestions(this.deps.intentLabels()),
                { subject: subjectKey(subject.runId) },
            );
            if (result.status !== 'answered') {
                return result.status;
            }
            const answer = result.answers.intent!;
            await store.addLabel({
                ...base,
                label: answer.answer,
                provider: result.provider,
                version: result.version,
                confidence: answer.confidence,
                // Only a sure answer, from a version that passed, counts.
                applied: result.passed && answer.sure,
            });
            return 'answered' as const;
        }
        const result = await classifier.extract('themes', sessionState(subject), THEME_FIELDS, {
            subject: subjectKey(subject.runId),
        });
        if (result.status !== 'answered') {
            return result.status;
        }
        const values = result.values;
        const topics = cleanTopics([values.topic1, values.topic2, values.topic3]);
        // No topic: nothing to keep; the call is logged, so it isn't asked again.
        if (!topics.length) {
            return 'answered' as const;
        }
        const confidence = typeof values.confidence === 'number' ? values.confidence : 0;
        const outcome = (values.outcome as ThemeOutcome | null) ?? 'unclear';
        await store.addLabel({
            ...base,
            label: JSON.stringify({ topics, outcome } satisfies ThemeLabel),
            provider: result.provider,
            version: result.version,
            confidence,
            applied: result.passed && confidence >= classifier.settings('themes').threshold,
        });
        return 'answered' as const;
    }

    /** An admin's intent for a session: in force at once, and part of the golden set. */
    relabelIntent(subject: SessionSubject, value: string, actorId: string) {
        return this.deps.store.addLabel({
            use: 'intent',
            labelsVersion: this.definition('intent').labelsVersion,
            runId: subject.runId,
            idx: -1,
            label: value,
            source: 'admin',
            provider: null,
            version: null,
            confidence: null,
            applied: true,
            input: this.input(subject),
            actorId,
            at: this.now(),
        });
    }

    /** An admin's themes for a session: in force at once, and part of the golden set. */
    relabelThemes(subject: SessionSubject, label: ThemeLabel, actorId: string) {
        return this.deps.store.addLabel({
            use: 'themes',
            labelsVersion: THEMES_LABELS_VERSION,
            runId: subject.runId,
            idx: -1,
            label: JSON.stringify({
                topics: cleanTopics(label.topics),
                outcome: label.outcome,
            } satisfies ThemeLabel),
            source: 'admin',
            provider: null,
            version: null,
            confidence: null,
            applied: true,
            input: this.input(subject),
            actorId,
            at: this.now(),
        });
    }

    /** A session's labels for the review, from its stored rows. */
    row(runId: string, name: (id: string) => string | undefined): SessionLabelRow | undefined {
        const { store } = this.deps;
        const meta = this.deps.db
            .prepare(
                'SELECT r.threadId, r.startedAt, b.dotId FROM agent_runs r LEFT JOIN thread_bindings b ON b.id = r.threadId WHERE r.runId=?',
            )
            .get(runId) as { threadId: string; startedAt: number; dotId: string | null } | undefined;
        if (!meta) {
            return undefined;
        }
        const given = (label: StoredLabel) => ({
            source: label.source,
            provider: label.provider,
            at: label.at,
            by: label.actorId ? (name(label.actorId) ?? label.actorId) : null,
        });
        const suggested = (label: StoredLabel) => ({
            confidence: label.confidence ?? 0,
            provider: label.provider ?? '',
            version: label.version ?? '',
            applied: label.applied,
            at: label.at,
        });
        const intents = store.labels('intent', runId, -1);
        const intentLabel = intents.find((label) => label.applied);
        const intentSuggestion = intents.find((label) => label.source === 'model');
        const themes = store.labels('themes', runId, -1);
        const themeLabel = themes.find((label) => label.applied);
        const themeSuggestion = themes.find((label) => label.source === 'model');
        const theme = (label: StoredLabel | undefined) => (label ? parseTheme(label.label) : undefined);
        const inForce = theme(themeLabel);
        const suggestion = theme(themeSuggestion);
        return {
            runId,
            threadId: meta.threadId,
            socioId: meta.dotId,
            startedAt: meta.startedAt,
            intent: {
                label: intentLabel ? { value: intentLabel.label, ...given(intentLabel) } : null,
                suggestion: intentSuggestion ? { value: intentSuggestion.label, ...suggested(intentSuggestion) } : null,
            },
            themes: {
                label: inForce && themeLabel ? { ...inForce, ...given(themeLabel) } : null,
                suggestion: suggestion && themeSuggestion ? { ...suggestion, ...suggested(themeSuggestion) } : null,
            },
        };
    }

    view(subject: SessionSubject, name: (id: string) => string | undefined): SessionLabelView | undefined {
        const row = this.row(subject.runId, name);
        if (!row) {
            return undefined;
        }
        const state = scrubState(sessionState(subject), SESSION_INPUT_CHARS);
        const text = (value: unknown) => (typeof value === 'string' ? value : '');
        return {
            ...row,
            input: {
                title: text(state.title),
                messages: [state.first, state.second, state.third].map(text).filter(Boolean),
            },
            intentLabels: this.deps.intentLabels(),
        };
    }

    /** Where a use starts the first time: `SESSION_LOOKBACK_MS` back. */
    private start() {
        const row = this.deps.db
            .prepare('SELECT max(seq) AS seq FROM agent_runs WHERE startedAt < ?')
            .get(this.now() - SESSION_LOOKBACK_MS) as { seq: number | null };
        return { seq: row.seq ?? 0, running: [] as number[] };
    }

    /** One tick of each use that is on. */
    async tick() {
        for (const use of SESSION_USES) {
            await this.tickUse(use);
        }
    }

    /**
     * One tick of `use`: reads the turns after its cursor (and the ones
     * still running, or whose session was still bringing messages), and
     * labels the sessions they open that have no label or earlier try, at
     * most `SESSION_CALLS_PER_TICK`. The cursor stops before a turn it
     * couldn't finish (the cap, or the tick's calls), so it is read again
     * next time; what it already did is skipped then.
     */
    async tickUse(use: SessionUse) {
        const { classifier, store } = this.deps;
        if (!classifier.settings(use).enabled || !this.reader.ready()) {
            return;
        }
        if (!(await classifier.current(use))) {
            return;
        }
        const saved = store.cursor(use);
        const state = saved ? readRunsWatermark(saved) : this.start();
        const again = this.reader.runsBySeq(state.running);
        const fresh = this.reader.runsAfter(state.seq, RUNS_PER_TICK, BYTES_PER_TICK);
        let calls = 0;
        /** Labels the session `run` opens; `'stop'` when it had to stop, `'later'` to read it again. */
        const work = async (run: SourceRun) => {
            // Turned on again after a while: older sessions aren't asked about.
            if (run.startedAt < this.now() - SESSION_LOOKBACK_MS) {
                return 'done';
            }
            const subject = this.subjectOf(run);
            if (subject === 'pending') {
                return 'later';
            }
            if (!subject) {
                return 'done';
            }
            if (store.labelled(use, subject.runId, -1)) {
                return 'done';
            }
            if (store.triedSubject(use, subjectKey(subject.runId))) {
                return 'done';
            }
            if (calls >= SESSION_CALLS_PER_TICK) {
                return 'stop';
            }
            calls++;
            const status = await this.label(use, subject);
            return status === 'off' || status === 'capped' ? 'stop' : 'done';
        };
        const later: number[] = [];
        let stopped = false;
        for (const run of again) {
            if (stopped) {
                later.push(run.seq);
                continue;
            }
            const done = await work(run);
            if (done === 'stop') {
                stopped = true;
            }
            if (done !== 'done') {
                later.push(run.seq);
            }
        }
        // Turns read again that are gone stay gone.
        let seq = state.seq;
        if (!stopped) {
            for (const run of fresh) {
                const done = await work(run);
                if (done === 'stop') {
                    break;
                }
                if (done === 'later') {
                    later.push(run.seq);
                }
                seq = run.seq;
            }
        }
        await store.setCursor(use, JSON.stringify({ seq, running: [...new Set(later)] }));
    }
}
