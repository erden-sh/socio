import { FAILURE_CATEGORIES, type FailureCategory } from './failure-taxonomy.js';

/**
 * The classification and extraction seam (CB-198, CB-164): what the
 * client and the server share. A "use" is one job the seam does
 * (`failures`: labeling the failures the taxonomy's rules leave
 * Unclassified; `intent` and `themes`: what people's sessions are for
 * and about, CB-199; `learning`: which conversations show a procedure
 * worth Learning's analysis, CB-200), with its own versioned labels, provider, threshold,
 * daily cap and switch, off unless an admin turns it on.
 */

/**
 * The uses the seam serves: failure labels (CB-198), each session's
 * intent and themes (CB-199), and Learning's evidence triage and checks
 * (CB-200).
 */
export const CLASSIFY_USES = ['failures', 'intent', 'themes', 'learning'] as const;
export type ClassifyUse = (typeof CLASSIFY_USES)[number];

/**
 * The providers that ship. `workspace` is the workspace's own model (the
 * default shared backend, as titles and Learning use it).
 */
export const CLASSIFY_PROVIDERS = ['workspace'] as const;
export type ClassifyProviderId = (typeof CLASSIFY_PROVIDERS)[number];

/**
 * What a failure may be labeled: every failure category but Stopped
 * (a stop is never a guess), with Unclassified for "the text doesn't
 * say". Bump `FAILURE_LABELS_VERSION` when the list or its meaning
 * changes: older labels then stop counting for evaluation.
 */
export const FAILURE_LABELS = FAILURE_CATEGORIES.filter((category) => category !== 'stopped') as Exclude<
    FailureCategory,
    'stopped'
>[];
export type FailureLabel = (typeof FAILURE_LABELS)[number];
export const FAILURE_LABELS_VERSION = 1;

/** The most characters of a failure's text the model sees, after scrubbing. */
export const FAILURE_INPUT_CHARS = 300;

/** A use's settings: an admin's, over the server's (`CLASSIFY_FAILURES*`). */
export interface ClassifyUseSettings {
    enabled: boolean;
    provider: ClassifyProviderId;
    /**
     * 0.5 to 0.99. A label is applied when the model is at least this sure,
     * and only once the provider's version was right at least this often,
     * when that sure, on the golden set.
     */
    threshold: number;
    /** Model calls a day for the use's labeling, evaluation aside. */
    perDay: number;
}
/** What an admin saved for a use; `labels` only for `intent`. */
export interface SavedUseSettings extends Partial<ClassifyUseSettings> {
    /** Intent's own list (CB-199); none: `INTENT_LABELS`. */
    labels?: ClassifyOption[];
}
export type ClassifySettings = Partial<Record<ClassifyUse, SavedUseSettings>>;

/** One label a use can give, with what it means (shown to the model). */
export interface ClassifyOption {
    value: string;
    hint: string;
}

export const CLASSIFY_THRESHOLD = { min: 0.5, max: 0.99 } as const;
export const CLASSIFY_PER_DAY = { min: 0, max: 10_000 } as const;
/** The golden set needs this many admin labels before an evaluation counts. */
export const MIN_GOLDEN = 20;
/** And the model must have answered (been sure enough) this many of them. */
export const MIN_ANSWERED = 10;

/** One label's numbers in an evaluation. */
export interface ClassifyLabelScore {
    label: string;
    /** Golden items with this label. */
    support: number;
    /** Times the model gave it (sure enough). */
    predicted: number;
    correct: number;
    precision: number | null;
    recall: number | null;
}

/** An evaluation of one provider version against the golden set. */
export interface ClassifyEvalReport {
    id: string;
    use: ClassifyUse;
    provider: string;
    version: string;
    labelsVersion: number;
    threshold: number;
    startedAt: number;
    finishedAt: number | null;
    status: 'running' | 'done' | 'failed';
    error: string | null;
    /** Golden items. */
    golden: number;
    /** Items the model answered at or above the threshold with a category. */
    answered: number;
    correct: number;
    /** Of the answered ones, right; null when none was. */
    precision: number | null;
    /** Right over every golden item, abstentions counted as Unclassified. */
    accuracy: number | null;
    /** Calls that failed or answered invalid JSON. */
    failedCalls: number;
    passed: boolean;
    labels: ClassifyLabelScore[];
    /** `confusion[gold][predicted]`: counts; abstentions are Unclassified. */
    confusion: Record<string, Record<string, number>>;
}

/**
 * Intent (CB-199): what a person came to a session for, one label from a
 * list admins can edit. Each list is its own version of the labels
 * (`intentLabelsVersion`): editing it starts a new golden set, and the
 * model must pass an evaluation on it again.
 */
export const INTENT_LABELS: readonly ClassifyOption[] = [
    { value: 'ask', hint: 'A question, to get an answer or an explanation.' },
    {
        value: 'write',
        hint: 'Writing or editing text: a message, a document, a page, code.',
    },
    {
        value: 'analyse',
        hint: 'Looking into data, files or results to find out something.',
    },
    {
        value: 'automate',
        hint: 'Setting up or changing work that runs on its own: schedules, goals, tools.',
    },
    {
        value: 'research',
        hint: 'Finding and gathering information from several sources.',
    },
    {
        value: 'admin',
        hint: 'Running the workspace: people, access, settings, socios.',
    },
    { value: 'other', hint: 'None of the others.' },
];
/** An intent value: a short lowercase word. */
export const INTENT_VALUE = /^[a-z][a-z0-9-]{0,23}$/;
export const INTENT_HINT_CHARS = 160;
export const INTENT_LABEL_COUNT = { min: 2, max: 16 } as const;

/**
 * The version of an intent list: 1 for `INTENT_LABELS`, else a number
 * made from the values and hints, so the same list always has the same
 * version and any edit gives another.
 */
export function intentLabelsVersion(labels: readonly ClassifyOption[]) {
    const same =
        labels.length === INTENT_LABELS.length &&
        labels.every((label, i) => label.value === INTENT_LABELS[i]!.value && label.hint === INTENT_LABELS[i]!.hint);
    if (same) {
        return 1;
    }
    // FNV-1a over the list, kept above 1 and within SQLite's INTEGER.
    let hash = 0x811c9dc5;
    for (const char of JSON.stringify(labels.map((l) => [l.value, l.hint]))) {
        hash ^= char.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return 2 + (hash % 2_000_000_000);
}

/**
 * Themes (CB-199): one to three short topics per session, and a hint of
 * whether the person got what they came for, read from the chat's title
 * and the session's first person messages.
 */
export const THEME_TOPICS = 3;
export const THEME_TOPIC_CHARS = 48;
export const THEME_OUTCOMES = ['resolved', 'unresolved', 'unclear'] as const;
export type ThemeOutcome = (typeof THEME_OUTCOMES)[number];
export const THEME_OUTCOME_LABELS: Record<ThemeOutcome, string> = {
    resolved: 'Seems resolved',
    unresolved: 'Seems unresolved',
    unclear: 'Unclear',
};
export const THEMES_LABELS_VERSION = 1;
/** A theme label: its topics and outcome hint, as `classify_labels.label` keeps it (JSON). */
export interface ThemeLabel {
    topics: string[];
    outcome: ThemeOutcome;
}
/** A theme label as `classify_labels.label` keeps it (JSON), if valid. */
export function parseTheme(label: string): ThemeLabel | undefined {
    try {
        const value = JSON.parse(label) as Partial<ThemeLabel>;
        if (!Array.isArray(value.topics) || !(THEME_OUTCOMES as readonly string[]).includes(value.outcome as string)) {
            return undefined;
        }
        return {
            topics: value.topics.filter((topic): topic is string => typeof topic === 'string'),
            outcome: value.outcome as ThemeOutcome,
        };
    } catch {
        return undefined;
    }
}
/** The first person messages of a session the model reads, after the title. */
export const SESSION_MESSAGES = 3;
/** The most characters of the title and of each message, after scrubbing. */
export const SESSION_INPUT_CHARS = 300;

/**
 * The privacy floor of Themes (CB-199): a theme is shown only when at
 * least this many different people had sessions on it in the range and
 * filters. Smaller ones are counted together as "other", never named.
 */
export const THEMES_MIN_PEOPLE = 3;

/**
 * A topic's key, for clustering: lowercase words without accents,
 * punctuation or filler words, plurals folded, sorted. "Invoices for
 * March" and "march invoice" are one theme.
 */
export function topicKey(topic: string): string {
    const words = topic
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word && !TOPIC_FILLER.has(word))
        .map((word) =>
            word.length > 3 && word.endsWith('ies')
                ? `${word.slice(0, -3)}y`
                : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
                  ? word.slice(0, -1)
                  : word,
        );
    return [...new Set(words)].sort().join(' ');
}
const TOPIC_FILLER = new Set(
    'a an and the of for to in on at by with from about into our my your their its is are be how what new'.split(' '),
);

/**
 * Learning's triage (CB-200): whether a finished conversation shows a
 * procedure the team repeats, so only those go to Learning's analysis.
 * A conversation is the subject (`classify_labels.runId` holds its
 * thread ID, `idx` -1). Bump `LEARNING_LABELS_VERSION` when the list or
 * its meaning changes.
 */
export const LEARNING_LABELS = ['repeatable', 'one-off'] as const;
export type LearningLabel = (typeof LEARNING_LABELS)[number];
export const LEARNING_LABEL_NAMES: Record<LearningLabel, string> = {
    repeatable: 'Shows a repeatable procedure',
    'one-off': 'One-off',
};
export const LEARNING_LABELS_VERSION = 1;
/** The most characters of a conversation's text the triage reads, after scrubbing. */
export const LEARNING_INPUT_CHARS = 1_500;

/** Operations → Settings → Failure labels, Intent, Themes, Learning triage. */
export interface ClassifyUseView extends ClassifyUseSettings {
    use: ClassifyUse;
    defaults: ClassifyUseSettings;
    /** The provider's model is set up (a default shared backend is ready). */
    available: boolean;
    /** The provider's current version (its model and prompt), when available. */
    version: string | null;
    /** That version passed an evaluation: its sure labels are applied. */
    versionPassed: boolean;
    /** Admin labels for the current label list: the golden set. */
    golden: number;
    /** In the last 24 hours: labeling calls (the cap counts these), all calls, tokens and the known cost. */
    callsToday: number;
    evalCallsToday: number;
    tokensToday: number;
    costToday: number | null;
    /** Calls whose cost the provider didn't report. */
    unknownCostCalls: number;
    evaluating: boolean;
    /** The latest evaluation of the current version, else of any. */
    lastEval: ClassifyEvalReport | null;
    /** Intent's labels in force and the server's (`INTENT_LABELS`); none for other uses. */
    labels?: ClassifyOption[];
    defaultLabels?: ClassifyOption[];
    labelsVersion: number;
}

/** A failure's label, as Reliability's relabel panel shows it. */
export interface FailureLabelView {
    runId: string;
    level: 'turn' | 'tool';
    /** The tool call's place in the turn's trace; null for the turn. */
    idx: number | null;
    tool: string | null;
    code: string | null;
    /** The rules' category and rule; labels apply only over Unclassified. */
    rulesCategory: FailureCategory | null;
    rule: string;
    /** Whether it can be labeled: the rules left it Unclassified. */
    labelable: boolean;
    /** The text the model is given: scrubbed, at most `FAILURE_INPUT_CHARS`. */
    input: string;
    /** The label in force: an admin's, or the model's when it was applied. */
    label: {
        label: FailureLabel;
        source: 'admin' | 'model';
        provider: string | null;
        at: number;
        by: string | null;
    } | null;
    /** The model's newest answer, applied or not. */
    suggestion: {
        label: FailureLabel;
        confidence: number;
        provider: string;
        version: string;
        applied: boolean;
        at: number;
    } | null;
}

/** Who gave a session's label in force, or the model's newest answer. */
interface GivenBy {
    source: 'admin' | 'model';
    provider: string | null;
    at: number;
    by: string | null;
}
interface Suggested {
    confidence: number;
    provider: string;
    version: string;
    applied: boolean;
    at: number;
}

/**
 * A session's intent and themes (CB-199), as Themes' review shows them:
 * the label in force (an admin's, or the model's once applied) and the
 * model's newest answer. A session is known by the turn that opened it.
 */
export interface SessionLabelRow {
    runId: string;
    threadId: string;
    socioId: string | null;
    /** When the session's first person message came. */
    startedAt: number;
    intent: {
        label: ({ value: string } & GivenBy) | null;
        suggestion: ({ value: string } & Suggested) | null;
    };
    themes: {
        label: (ThemeLabel & GivenBy) | null;
        suggestion: (ThemeLabel & Suggested) | null;
    };
}

/** One session's labels, with the scrubbed text the model reads. */
export interface SessionLabelView extends SessionLabelRow {
    input: { title: string; messages: string[] };
    /** Intent's labels in force, to pick from. */
    intentLabels: ClassifyOption[];
}
