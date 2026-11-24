/**
 * The classification seam's vocabulary (CB-198): a use and its questions,
 * a call and its result, a stored label, and the slices of the classifier
 * (`SeamShape`) and its label store (`LabelsShape`) that Learning's triage
 * calls. Types only, server-only. Moved from `classify/contract.ts`, which
 * re-exports them with its `Seam` and `Labels` tags, so Learning, below the
 * seam in the folder order, names them without importing it.
 */
import type { ClassifyUse, ClassifyUseSettings } from '@socio/shared/classify';

// ── A use and its questions ──────────────────────────────────────────────

/** A use's fixed parts: its label list's version and how much text it sends. */
export interface UseDefinition {
    labelsVersion: number;
    /** The most characters of each text in the state, after scrubbing. */
    maxChars: number;
    /** What the model is told the state is (one line, no data). */
    subject: string;
    /** The prompt's version: part of every provider version, so a change needs a new evaluation. */
    promptVersion: number;
}

/** A closed question: the model picks one option and says how sure it is. */
export interface Question {
    id: string;
    ask: string;
    options: readonly { value: string; hint: string }[];
}

/** A typed field to extract. */
export type ExtractField =
    | { type: 'string'; description: string; max: number }
    | { type: 'number'; description: string; min: number; max: number }
    | { type: 'boolean'; description: string }
    | { type: 'enum'; description: string; options: readonly string[] };

// ── Calls and their results ──────────────────────────────────────────────

export interface CallOptions {
    /** `eval`: an admin's evaluation, neither switched nor capped. */
    purpose?: 'label' | 'eval';
    /** Only this provider, no fallback (evaluation). */
    provider?: string;
    /** What the call is about, for the log (`runId:idx`). */
    subject?: string;
    signal?: AbortSignal;
}

export type Unanswered = { status: 'off' } | { status: 'capped' } | { status: 'unlabelled' };

export interface Answer {
    answer: string;
    confidence: number;
    /** At or above the use's threshold. */
    sure: boolean;
}
export type DecideResult =
    | {
          status: 'answered';
          answers: Record<string, Answer>;
          provider: string;
          version: string;
          /** The version passed an evaluation at the use's threshold. */
          passed: boolean;
      }
    | Unanswered;
export type ExtractResult =
    | {
          status: 'answered';
          values: Record<string, unknown>;
          provider: string;
          version: string;
          passed: boolean;
      }
    | Unanswered;

/** The provider that would answer a use now, and its version. */
export interface CurrentProvider {
    provider: string;
    version: string;
}

// ── Labels ───────────────────────────────────────────────────────────────

/** One stored label (`classify_labels`). */
export interface StoredLabel {
    seq: number;
    use: string;
    labelsVersion: number;
    runId: string;
    /** The tool call's place in the trace; -1 for the turn. */
    idx: number;
    label: string;
    source: 'admin' | 'model';
    provider: string | null;
    version: string | null;
    confidence: number | null;
    applied: boolean;
    input: string;
    actorId: string | null;
    at: number;
}
export type NewLabel = Omit<StoredLabel, 'seq'>;

/**
 * A use's calls in the last 24 hours: counts, tokens and the known cost. A
 * type, not an interface, so a SQLite row converts to it.
 */
export type ClassifyUsage = {
    /** Labeling calls. */
    label: number;
    /** Evaluation calls. */
    eval: number;
    tokens: number;
    /** In US dollars; null when no call reported one. */
    cost: number | null;
    /** Calls whose cost is unknown. */
    unknown: number;
};

// ── The classifier's and the label store's slices ─────────────────────

/**
 * The seam's classifier (`Classifier`), the slice Learning's triage and
 * checks call (CB-200): a use's settings and provider, whether a version
 * passed an evaluation, and the two kinds of call.
 */
export interface SeamShape {
    /** The use's settings in force. */
    settings(use: ClassifyUse): ClassifyUseSettings;
    /** The use's provider (or `id`) and its version now, if it is set up. */
    current(use: ClassifyUse, id?: string): Promise<CurrentProvider | undefined>;
    /** Whether `version` passed an evaluation at the use's threshold. */
    passed(use: ClassifyUse, provider: string, version: string): boolean;
    /** Asks closed `questions` about `state`. */
    decide(
        use: ClassifyUse,
        state: Record<string, unknown>,
        questions: readonly Question[],
        options?: CallOptions,
    ): Promise<DecideResult>;
    /** Extracts typed `fields` from `state`. */
    extract(
        use: ClassifyUse,
        state: Record<string, unknown>,
        fields: Record<string, ExtractField>,
        options?: CallOptions,
    ): Promise<ExtractResult>;
}

/**
 * The seam's labels and call log (`ClassifyStore`), the slice Learning
 * reads and writes: a subject's labels, whether it was tried, a new label,
 * the day's usage and the golden set's size.
 */
export interface LabelsShape {
    /** A subject's labels, newest first. */
    labels(use: string, runId: string, idx: number): StoredLabel[];
    /** Whether a labeling call was made for this subject before. */
    triedSubject(use: string, subject: string): boolean;
    /** Stores a label; resolves to its `seq`. */
    addLabel(label: NewLabel): Promise<number>;
    /** The last 24 hours' calls of `use`. */
    usage(use: string, now?: number): ClassifyUsage;
    /** How many subjects admins labeled for this label list. */
    goldenCount(use: string, labelsVersion: number): number;
}
