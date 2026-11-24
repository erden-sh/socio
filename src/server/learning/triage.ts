import type { DatabaseSync } from 'node:sqlite';

import { clip } from '@socio/foundation/classify/clip';
import { scrubState } from '@socio/foundation/classify/scrub-state';
import type { LabelsShape, Question, SeamShape, StoredLabel, UseDefinition } from '@socio/foundation/classify/seam';
import { messageText } from '@socio/foundation/turns/media-parts';
import { LEARNING_INPUT_CHARS, type LearningLabel } from '@socio/shared/classify';
import type { LearningSeamView, LearningTriageView } from '@socio/shared/learning';

import type { RunnerShape } from '../turns/contract.js';

import {
    LEARNING_USE as CONTRACT_LEARNING_USE,
    TRIAGE_QUESTIONS as CONTRACT_TRIAGE_QUESTIONS,
    type LearningTriageShape,
} from './contract.js';
import type { EvidenceThread } from './evidence.js';

/**
 * Learning on the classification seam (CB-200, CB-164). With the
 * `learning` use on (Operations → Settings → Learning triage, over
 * `CLASSIFY_LEARNING*`), and under the seam's rules (its switch, daily
 * cap, threshold, scrubbing, evaluation gate and the workspace's model):
 *
 * - **Triage.** Each new finished conversation gets one `decide` call:
 *   does it show a procedure the team would repeat? The model reads the
 *   chat's title and what people asked in it, scrubbed and cut to
 *   `LEARNING_INPUT_CHARS`, never the replies. Its answer is a label of
 *   the conversation (`classify_labels`, `use` learning, `runId` the
 *   thread ID, `idx` -1). A conversation whose label in force is
 *   one-off (an admin's, which no model answer replaces, or else the
 *   model's once its version passed an evaluation and it was sure) is
 *   read but not sent to the analysis,
 *   so fewer transcripts leave the store. Admins' labels are the golden
 *   set.
 * - **Intent.** A conversation's sessions carry the intent CB-199 gave
 *   them; when one intent (not "other") recurs in `INTENT_RECURRENCE`
 *   sessions among a container's new conversations, the analysis starts
 *   before the fixed count.
 * - **Checks.** A proposal that passed Learning's own checks (names,
 *   evidence, the privacy patterns) is asked about twice more: is it the
 *   same skill as a rejected or published one (dropped only when the
 *   model is sure and its version passed an evaluation), and does it
 *   hold private details (dropped when the model is sure: a second
 *   privacy check fails safe). Neither replaces the checks before it.
 *
 * With the use off, Learning works exactly as before: no call, no skip,
 * no intent trigger, no extra check.
 */

/** Sessions of one intent, among a container's new conversations, that start an analysis. */
export const INTENT_RECURRENCE = 5;
/** At most this many triage calls a tick (a minute). */
export const TRIAGE_CALLS_PER_TICK = 5;
/** Conversations Learning's page lists with their triage. */
export const TRIAGE_LIST = 20;
/** `classify_labels.input` holds at most this many characters. */
const INPUT_MAX = 4_000;
const TITLE_CHARS = 200;

/** Moved to the contract; typed here as the seam's own types. */
export const LEARNING_USE: UseDefinition = CONTRACT_LEARNING_USE;
export const TRIAGE_QUESTIONS: readonly Question[] = CONTRACT_TRIAGE_QUESTIONS;

export const DUPLICATE_QUESTIONS: readonly Question[] = [
    {
        id: 'duplicate',
        ask: 'Is the proposed skill the same skill as one listed under "reviewed" (rejected by reviewers, or already published), whatever its name?',
        options: [
            {
                value: 'new',
                hint: 'A different skill, or a clear improvement on a published one.',
            },
            {
                value: 'rejected',
                hint: 'The same as, or a close variant of, a rejected one.',
            },
            {
                value: 'published',
                hint: 'The same as a published one, with nothing clearly better.',
            },
        ],
    },
];

export const PRIVACY_QUESTIONS: readonly Question[] = [
    {
        id: 'private',
        ask: 'Does the proposed skill contain private details: a person’s or customer’s name, contact details, account or order numbers, credentials, confidential company or customer data, or quotes from conversations? Placeholders such as <customer> are fine.',
        options: [
            {
                value: 'clean',
                hint: 'General steps only, with placeholders instead of details.',
            },
            { value: 'private', hint: 'Any private detail.' },
        ],
    },
];

/** What triage asks about a conversation, before the seam scrubs it. */
export interface TriageState {
    title: string;
    asked: string;
}

/** A conversation's triage as the analysis reads it. */
export interface TriageVerdict {
    /** The label in force: an admin's newest, else the newest applied model one. */
    label: StoredLabel | undefined;
    /** The model's newest answer. */
    suggestion: StoredLabel | undefined;
}

/** How likely the model's answer says the conversation shows a procedure. */
export function triageScore(label: StoredLabel | undefined) {
    if (!label || label.confidence === null) {
        return null;
    }
    return label.label === 'repeatable' ? label.confidence : 1 - label.confidence;
}

/** The scrubbed state and the input stored with its label: at most `INPUT_MAX`. */
export function triageInput(state: TriageState) {
    const scrubbed = scrubState({ title: clip(state.title, TITLE_CHARS), asked: state.asked }, LEARNING_INPUT_CHARS);
    let input = JSON.stringify(scrubbed);
    while (input.length > INPUT_MAX && typeof scrubbed.asked === 'string') {
        const over = input.length - INPUT_MAX;
        scrubbed.asked = clip(scrubbed.asked, Math.max(1, scrubbed.asked.length - over - 1));
        input = JSON.stringify(scrubbed);
    }
    return { state: scrubbed, input };
}

const subjectKey = (thread: Pick<EvidenceThread, 'threadId' | 'finishedAt'>) =>
    `thread:${thread.threadId}@${thread.finishedAt}`;

export interface TriageDeps {
    db: DatabaseSync;
    classifier: SeamShape;
    store: LabelsShape;
    runner: Pick<RunnerShape, 'messages'>;
    now?: () => number;
}

/** Learning's side of the seam: triage, intent and the proposal checks. */
export class EvidenceTriage implements LearningTriageShape {
    /** Conversations being asked about, so a tick and a run don't both ask. */
    private asking = new Set<string>();
    constructor(private deps: TriageDeps) {}

    private now() {
        return (this.deps.now ?? Date.now)();
    }

    /** The use's switch: off, Learning works as it did before CB-200. */
    get enabled() {
        return this.deps.classifier.settings('learning').enabled;
    }

    /** What triage reads of a conversation: its title and what people asked. */
    async state(threadId: string): Promise<TriageState> {
        const chat = this.deps.db.prepare('SELECT title FROM thread_bindings WHERE id=?').get(threadId) as
            | { title: string }
            | undefined;
        const messages = await this.deps.runner.messages(threadId);
        const asked = messages
            .filter((m) => m.role === 'user')
            .map((m) => messageText(m.content).trim())
            .filter(Boolean)
            .join('\n---\n');
        return { title: chat?.title ?? '', asked };
    }

    /**
     * Asks about one conversation, unless it was labeled or asked about
     * since it last finished. `'off'` or `'capped'`: stop asking for now.
     */
    async triage(thread: EvidenceThread, signal?: AbortSignal) {
        const { classifier, store } = this.deps;
        if (this.asking.has(thread.threadId)) {
            return 'skipped' as const;
        }
        const newest = store.labels('learning', thread.threadId, -1)[0];
        if (newest && newest.at >= thread.finishedAt) {
            return 'skipped' as const;
        }
        if (store.triedSubject('learning', subjectKey(thread))) {
            return 'skipped' as const;
        }
        this.asking.add(thread.threadId);
        try {
            const { state, input } = triageInput(await this.state(thread.threadId));
            const result = await classifier.decide('learning', state, TRIAGE_QUESTIONS, {
                subject: subjectKey(thread),
                signal,
            });
            if (result.status !== 'answered') {
                return result.status;
            }
            const answer = result.answers.procedure!;
            await store.addLabel({
                use: 'learning',
                labelsVersion: LEARNING_USE.labelsVersion,
                runId: thread.threadId,
                idx: -1,
                label: answer.answer,
                source: 'model',
                provider: result.provider,
                version: result.version,
                confidence: answer.confidence,
                // Only a sure answer, from a version that passed, counts.
                applied: result.passed && answer.sure,
                input,
                actorId: null,
                at: this.now(),
            });
            return 'answered' as const;
        } finally {
            this.asking.delete(thread.threadId);
        }
    }

    /**
     * Triage of `threads`, in order, until the use is off or capped, at
     * most `limit` calls; how many calls it made.
     */
    async triageAll(
        threads: readonly EvidenceThread[],
        { signal, limit = Infinity }: { signal?: AbortSignal; limit?: number } = {},
    ) {
        let calls = 0;
        for (const thread of threads) {
            if (calls >= limit || signal?.aborted) {
                break;
            }
            const status = await this.triage(thread, signal);
            if (status === 'skipped') {
                continue;
            }
            calls++;
            if (status === 'off' || status === 'capped') {
                break;
            }
        }
        return calls;
    }

    /** An admin's label of a conversation: in force at once, and the golden set. */
    async relabel(threadId: string, value: LearningLabel, actorId: string) {
        const { input } = triageInput(await this.state(threadId));
        await this.deps.store.addLabel({
            use: 'learning',
            labelsVersion: LEARNING_USE.labelsVersion,
            runId: threadId,
            idx: -1,
            label: value,
            source: 'admin',
            provider: null,
            version: null,
            confidence: null,
            applied: true,
            input,
            actorId,
            at: this.now(),
        });
    }

    /**
     * Each conversation's label in force and the model's newest answer. An
     * admin's newest label is in force until an admin changes it: a later
     * model answer (a re-triage after the conversation finished again, or
     * one an evaluation applied) only refreshes the suggestion, as with
     * CB-198/199 relabels.
     */
    verdict(threadId: string): TriageVerdict {
        const labels = this.deps.store
            .labels('learning', threadId, -1)
            .filter((label) => label.labelsVersion === LEARNING_USE.labelsVersion);
        return {
            label: labels.find((label) => label.source === 'admin') ?? labels.find((label) => label.applied),
            suggestion: labels.find((label) => label.source === 'model'),
        };
    }

    /** Whether the analysis leaves a conversation out: its label in force is one-off. */
    skips(threadId: string) {
        return this.enabled && this.verdict(threadId).label?.label === 'one-off';
    }

    private hasTables() {
        return (
            (
                this.deps.db
                    .prepare(
                        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('classify_labels','agent_runs')",
                    )
                    .get() as { n: number }
            ).n === 2
        );
    }

    /**
     * The intents CB-199 gave the sessions of `threadIds` (applied labels,
     * the newest per session), one entry per session.
     */
    intents(threadIds: readonly string[]): Map<string, string[]> {
        const out = new Map<string, string[]>();
        if (!threadIds.length || !this.hasTables()) {
            return out;
        }
        const rows = this.deps.db
            .prepare(
                `SELECT r.threadId AS threadId, l.label AS label FROM classify_labels l
        JOIN agent_runs r ON r.runId = l.runId
        WHERE l.use = 'intent' AND l.idx = -1 AND l.applied = 1
          AND r.threadId IN (SELECT value FROM json_each(?))
          AND l.seq = (SELECT max(seq) FROM classify_labels x
            WHERE x.use = 'intent' AND x.runId = l.runId AND x.idx = -1 AND x.applied = 1)
        ORDER BY l.seq`,
            )
            .all(JSON.stringify(threadIds)) as { threadId: string; label: string }[];
        for (const { threadId, label } of rows) {
            out.set(threadId, [...(out.get(threadId) ?? []), label]);
        }
        return out;
    }

    /** The intent with the most sessions among `threadIds` ("other" aside), and how many. */
    recurringIntent(threadIds: readonly string[]) {
        const counts = new Map<string, number>();
        for (const labels of this.intents(threadIds).values()) {
            for (const label of labels) {
                if (label !== 'other') {
                    counts.set(label, (counts.get(label) ?? 0) + 1);
                }
            }
        }
        let best: { intent: string; sessions: number } | undefined;
        for (const [intent, sessions] of counts) {
            if (!best || sessions > best.sessions) {
                best = { intent, sessions };
            }
        }
        return best;
    }

    /**
     * The model's checks of a proposal that passed Learning's own; the
     * drop reason, if any. `reviewed` is the list of rejected and
     * published skills the analysis was given.
     */
    async checkProposal(
        proposal: {
            name: string;
            description: string;
            skillMd: string;
            rationale: string;
        },
        reviewed: string,
        subject: string,
        signal?: AbortSignal,
    ): Promise<'model-duplicate' | 'model-private' | undefined> {
        if (!this.enabled) {
            return undefined;
        }
        const { classifier } = this.deps;
        const skill = {
            name: proposal.name,
            description: proposal.description,
            steps: proposal.skillMd,
        };
        if (reviewed.trim()) {
            const result = await classifier.decide('learning', { ...skill, reviewed }, DUPLICATE_QUESTIONS, {
                subject: `${subject}:duplicate`,
                signal,
            });
            const answer = result.status === 'answered' ? result.answers.duplicate : undefined;
            if (result.status === 'answered' && result.passed && answer?.sure && answer.answer !== 'new') {
                return 'model-duplicate';
            }
        }
        const result = await classifier.decide(
            'learning',
            { ...skill, rationale: proposal.rationale },
            PRIVACY_QUESTIONS,
            { subject: `${subject}:private`, signal },
        );
        // A second privacy check fails safe: a sure "private" drops the
        // proposal even before the version passed an evaluation.
        if (
            result.status === 'answered' &&
            result.answers.private?.sure &&
            result.answers.private.answer === 'private'
        ) {
            return 'model-private';
        }
        return undefined;
    }

    /** A container's conversations, newest first, with their triage. */
    threads(
        containerId: string,
        analyzedThrough: number,
        { limit = TRIAGE_LIST, threadId }: { limit?: number; threadId?: string } = {},
    ): LearningTriageView[] {
        const rows = this.deps.db
            .prepare(
                `SELECT e.threadId AS threadId, e.finishedAt AS finishedAt, COALESCE(b.title, '') AS title
        FROM learning_evidence e JOIN thread_bindings b ON b.id = e.threadId
        WHERE e.containerId = ? AND e.eligible = 1 AND b.deletedAt IS NULL
          AND (? IS NULL OR e.threadId = ?)
        ORDER BY e.finishedAt DESC, e.threadId LIMIT ?`,
            )
            .all(containerId, threadId ?? null, threadId ?? null, limit) as {
            threadId: string;
            finishedAt: number;
            title: string;
        }[];
        const intents = this.intents(rows.map((row) => row.threadId));
        return rows.map((row) => {
            const { label, suggestion } = this.verdict(row.threadId);
            return {
                threadId: row.threadId,
                title: row.title,
                finishedAt: row.finishedAt,
                pending: row.finishedAt > analyzedThrough,
                label: label
                    ? {
                          value: label.label as LearningLabel,
                          source: label.source,
                          at: label.at,
                      }
                    : null,
                score: triageScore(suggestion),
                applied: !!suggestion?.applied,
                intent: mostCommon(intents.get(row.threadId) ?? []),
            };
        });
    }

    /** The use's state for Learning's page, with a container's conversations. */
    async view(containerId: string, analyzedThrough: number): Promise<LearningSeamView> {
        const { classifier, store } = this.deps;
        const settings = classifier.settings('learning');
        const current = await classifier.current('learning');
        const usage = store.usage('learning', this.now());
        return {
            enabled: settings.enabled,
            available: !!current,
            version: current?.version ?? null,
            passed: current ? classifier.passed('learning', current.provider, current.version) : false,
            threshold: settings.threshold,
            perDay: settings.perDay,
            callsToday: usage.label,
            tokensToday: usage.tokens,
            costToday: usage.cost,
            golden: store.goldenCount('learning', LEARNING_USE.labelsVersion),
            intentRecurrence: INTENT_RECURRENCE,
            threads: this.threads(containerId, analyzedThrough),
        };
    }
}

function mostCommon(values: readonly string[]) {
    const counts = new Map<string, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let best: string | null = null;
    for (const [value, count] of counts) {
        if (best === null || count > counts.get(best)!) {
            best = value;
        }
    }
    return best;
}
