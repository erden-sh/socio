/**
 * The chat's status line: what a running turn is doing now, derived from its
 * AG-UI events. The server adds one CUSTOM event right after RUN_STARTED,
 * naming the model the turn runs on (`RUN_MODEL_EVENT`), and one as each
 * model round starts with its expected wait (`RUN_WAIT_EVENT`).
 */
export const RUN_MODEL_EVENT = 'socio.run-model';
/**
 * As each model round starts: the expected wait for its first output,
 * learned from the model's past response times (`InferenceTimings`).
 */
export const RUN_WAIT_EVENT = 'socio.run-wait';
/**
 * As the server starts tidying a long conversation's notes (CB-129): older
 * turns are being summarized so the model's context fits. The status line
 * says "Tidying notes" until the compaction event that follows.
 */
export const RUN_TIDYING_EVENT = 'socio.run-tidying';
/**
 * After each round whose context was compacted (CB-129), with
 * `ContextCompactionInfo`: sizes and counts only, never content.
 */
export const CONTEXT_COMPACTION_EVENT = 'company-brain.context-compaction';

/** `CONTEXT_COMPACTION_EVENT`'s value. */
export interface ContextCompactionInfo {
    /** The round's estimated prompt before and after, in tokens. */
    beforeTokens: number;
    afterTokens: number;
    /** The model's context window, in tokens. */
    window: number;
    /** Tool results and arguments cut to an excerpt or set aside. */
    stubbed: number;
    /** Earlier turns now in the running notes (0: none this round). */
    summarised: number;
    /** Retries after the model refused the prompt as too long. */
    retried: number;
    /**
     * With notes (CB-134): how their pinned facts were chosen, how many the
     * prompt carries of how many are stored, the notes' estimated tokens,
     * and how long choosing took (a ranking request included).
     */
    selection?: 'age' | 'relevance' | 'pointer';
    pinnedShown?: number;
    pinnedStored?: number;
    notesTokens?: number;
    selectMs?: number;
}

/** `RUN_WAIT_EVENT`'s value. */
export interface RunWaitInfo {
    expectedMs: number;
    /** The prompt's expected size (self-hosted models only). */
    tokens?: number;
}

/** `RUN_MODEL_EVENT`'s value: for people, never a secret. */
export interface RunModelInfo {
    /** "ChatGPT (Pro)", "Homelab". */
    label: string;
    /** The model id, when the kind shows it: "gpt-6.1-sol". */
    model: string | null;
}

export type RunPhaseKind = 'connecting' | 'waiting' | 'thinking' | 'answering' | 'tool' | 'tidying';

export interface RunPhase {
    kind: RunPhaseKind;
    /** When this phase began (ms). */
    since: number;
    /** The turn's model, once the server named it. */
    model?: RunModelInfo;
    /** The running tool's name (`tool`). */
    tool?: string;
    /** The current wait's estimate; cleared once the model answers. */
    wait?: RunWaitInfo;
    /**
     * The person's message the turn just took (CB-151): its text events are
     * theirs, not the Dot writing, so the phase stays as it was.
     */
    person?: string;
}

export const startPhase = (now: number): RunPhase => ({
    kind: 'connecting',
    since: now,
});

/** The next phase after one event; the same object when nothing changes. */
export function nextPhase(
    phase: RunPhase,
    event: {
        type: string;
        name?: string;
        value?: unknown;
        toolCallName?: string;
        messageId?: string;
        role?: string;
    },
    now: number,
): RunPhase {
    const to = (kind: RunPhaseKind, extra: Partial<RunPhase> = {}): RunPhase =>
        phase.kind === kind && !extra.tool
            ? phase
            : {
                  ...phase,
                  kind,
                  since: now,
                  tool: undefined,
                  // The estimate is for a wait: the model's output ends it. (It may
                  // arrive just before the tool result that starts the wait.)
                  wait: kind === 'waiting' ? phase.wait : undefined,
                  ...extra,
              };
    switch (event.type) {
        case 'RUN_STARTED':
            return to('waiting');
        case 'CUSTOM':
            if (event.name === RUN_MODEL_EVENT) {
                return { ...phase, model: event.value as RunModelInfo };
            }
            if (event.name === RUN_WAIT_EVENT) {
                return { ...phase, wait: event.value as RunWaitInfo };
            }
            if (event.name === RUN_TIDYING_EVENT) {
                return to('tidying');
            }
            // The notes are tidy: the round goes to the model.
            if (event.name === CONTEXT_COMPACTION_EVENT && phase.kind === 'tidying') {
                return to('waiting');
            }
            return phase;
        case 'REASONING_START':
        case 'REASONING_MESSAGE_START':
        case 'REASONING_MESSAGE_CONTENT':
        case 'THINKING_START':
        case 'THINKING_TEXT_MESSAGE_CONTENT':
            return to('thinking');
        case 'TEXT_MESSAGE_START':
            if (event.role === 'user') {
                return { ...phase, person: event.messageId };
            }
            return to('answering');
        case 'TEXT_MESSAGE_CONTENT':
            if (event.messageId && event.messageId === phase.person) {
                return phase;
            }
            return to('answering');
        case 'TOOL_CALL_START':
            return to('tool', { tool: event.toolCallName ?? 'a tool' });
        // A tool's result goes back to the model: another wait for its reply.
        case 'TOOL_CALL_RESULT':
            return to('waiting');
        default:
            return phase;
    }
}

/** What a tool is doing, for people. */
export function toolActivity(name: string) {
    if (name.startsWith('computer_')) {
        return 'Using its computer';
    }
    if (name === 'search_web') {
        return 'Searching the web';
    }
    if (name === 'http_get' || name === 'http_json') {
        return 'Reading a web page';
    }
    if (name === 'unfurl_link') {
        return 'Saving a link to a page';
    }
    if (name === 'search_space_pages') {
        return 'Searching pages';
    }
    if (/space_page|spaces|_page$/.test(name)) {
        return 'Working on pages';
    }
    if (/^(data|dataset|query)_/.test(name)) {
        return 'Working with data';
    }
    if (/^(job|schedule|app)_/.test(name)) {
        return 'Setting things up';
    }
    if (name === 'review_space_page') {
        return 'Waiting for your review';
    }
    return `Running ${name.replace(/_/g, ' ')}`;
}

const modelText = (model: RunModelInfo) =>
    model.model && !model.label.includes(model.model) ? `${model.label} · ${model.model}` : model.label;

/**
 * The status line's text, without the clock: "Waiting for ChatGPT (Pro) ·
 * gpt-6.1-sol", "Ada is thinking", "Searching the web".
 */
export function phaseLabel(phase: RunPhase, dotName: string) {
    switch (phase.kind) {
        case 'connecting':
            return `Sending to ${dotName}`;
        case 'waiting':
            return `Waiting for ${phase.model ? modelText(phase.model) : 'the model'}`;
        case 'thinking':
            return `${dotName} is thinking`;
        case 'answering':
            return `${dotName} is writing`;
        case 'tool':
            return toolActivity(phase.tool ?? '');
        case 'tidying':
            return 'Tidying notes';
    }
}

/**
 * The clock after the label, " · 4 s", from the phase's first second on;
 * none while the Dot writes (the text itself shows progress).
 */
export function phaseElapsed(phase: RunPhase, now: number) {
    if (phase.kind === 'answering') {
        return '';
    }
    const seconds = Math.floor((now - phase.since) / 1000);
    return seconds >= 1 ? ` · ${seconds} s` : '';
}

/**
 * The status line's tooltip, for debugging a slow wait: the usual wait
 * and, for a self-hosted model, the prompt's size ("Usually ~7 s · ~18k
 * tokens"); undefined when there is nothing to add.
 */
export function phaseHint(phase: RunPhase) {
    const wait = phase.kind === 'waiting' ? phase.wait : undefined;
    if (!wait) {
        return undefined;
    }
    return [
        `Usually ~${Math.max(1, Math.round(wait.expectedMs / 1_000))} s`,
        ...(wait.tokens && wait.tokens >= 1_000 ? [`~${Math.round(wait.tokens / 1_000)}k tokens`] : []),
    ].join(' · ');
}

/** The status line as text: "Waiting for ChatGPT (Pro) · gpt-6.1-sol · 4 s". */
export function phaseText(phase: RunPhase, dotName: string, now: number) {
    return phaseLabel(phase, dotName) + phaseElapsed(phase, now);
}
