/**
 * Inference backends and per-user connections, as the API shows them.
 * Secrets (API keys, subscription tokens) never appear here: keys are
 * write-only, and a connection only says whether it is connected.
 */

/** The self-hosted kind: any server that speaks OpenAI Chat Completions. */
export const OPENAI_COMPATIBLE = 'openai-compatible';

export interface InferenceCapabilities {
    /** Whether the model takes image input; otherwise images become text notes. */
    acceptsImages: boolean;
    /** Most recent images a request keeps; older ones become notes. Default 4. */
    maxImages?: number;
    /** Includes reasoning tokens on reasoning models. Defaults to 2200. */
    maxCompletionTokens?: number;
    /**
     * The model's context window in tokens: prompt and answer together
     * (CB-129). Long conversations are compacted to fit about 70% of it.
     * 32,768 when unset, a conservative guess.
     */
    contextWindow?: number;
    /** Tokens kept free for the answer; the completion cap when unset. */
    outputReserve?: number;
}

/** An `openai-compatible` backend's settings, without its key. */
export interface OpenAICompatibleConfig {
    baseUrl: string;
    model: string;
    /** Extra Chat Completions fields for title requests, e.g. to skip thinking. */
    titleModelOptions?: Record<string, unknown>;
}

/** The last operator-run "Test" of a backend. */
export interface BackendTest {
    ok: boolean;
    at: number;
    /** What the operator sees, e.g. "Reachable; qwen38-flash is listed." */
    detail: string;
}

/**
 * Whether turns can use a backend. `key_unreadable`: its stored key can't be
 * decrypted (its data key or SESSION_SECRET changed); the operator enters it again.
 */
export type BackendStatus = 'ready' | 'disabled' | 'incomplete' | 'key_unreadable';

export interface InferenceBackendView {
    id: string;
    kind: string;
    label: string;
    enabled: boolean;
    config: OpenAICompatibleConfig;
    /** A key is stored (it is never sent back). */
    hasApiKey: boolean;
    capabilities: InferenceCapabilities;
    status: BackendStatus;
    isDefault: boolean;
    lastTest: BackendTest | null;
    createdAt: number;
    updatedAt: number;
}

/** A bring-your-own kind the server has, and whether users may connect it. */
export interface ByoKindView {
    id: string;
    label: string;
    description: string;
    allowed: boolean;
    /** Kinds with a model setting: the choices, the default and the operator's pick. */
    models?: {
        choices: { id: string; label: string; description?: string }[];
        default: string;
        /** The operator's choice; the default when unset. */
        selected: string;
        help?: string;
    };
}

/** `GET /api/inference` (operators). */
export interface OperatorInferenceState {
    backends: InferenceBackendView[];
    defaultBackendId: string | null;
    byoKinds: ByoKindView[];
}

/** Create or edit an `openai-compatible` backend. */
export interface BackendInput {
    label: string;
    enabled?: boolean;
    baseUrl: string;
    model: string;
    /** Write-only: omitted keeps the stored key, null removes it. */
    apiKey?: string | null;
    acceptsImages?: boolean;
    maxImages?: number | null;
    maxCompletionTokens?: number | null;
    contextWindow?: number | null;
    titleModelOptions?: Record<string, unknown> | null;
}

export type ConnectionState = 'connected' | 'pending' | 'expired' | 'error' | 'disconnected';

/** One allowed kind in the account dialog's Inference section. */
export interface UserInferenceKind {
    id: string;
    label: string;
    description: string;
    state: ConnectionState;
    /** A line for the user ("Signed in as …", "Enter the code …"); no secrets. */
    detail?: string;
    connectedAt?: number;
}

/**
 * One step of a connect flow (`POST /api/me/inference/:kind/connect`). A
 * device-code login answers `pending` with the code and where to enter it;
 * the client posts again every `pollMs` until the state is `connected` (or
 * an error). The client may send `{ cancel: true }` to give up.
 */
export interface ByoConnectStep {
    state: ConnectionState;
    userCode?: string;
    /** Opened by the user in a new tab (the provider's page). */
    verificationUrl?: string;
    /** A line for the user; no secrets. */
    message?: string;
    pollMs?: number;
}

/** `GET /api/me/inference`. */
export interface UserInferenceState {
    kinds: UserInferenceKind[];
    /** What the user's chats run on now; null when nothing is available. */
    active: { source: 'byo' | 'shared'; label: string } | null;
}

/** Part of the workspace setup: whether this user's chats have a model. */
export interface InferenceAvailability {
    available: boolean;
    source?: 'byo' | 'shared';
    label?: string;
    /** The operator allows at least one bring-your-own kind. */
    byoAllowed: boolean;
}

/** What the chat says when no model is available. */
export const NO_INFERENCE_MESSAGES = {
    connect: 'No model is available. Connect your own subscription in Account → Inference.',
    operator: 'No model is available. Ask an operator to set one up.',
    choice: 'This chat is set to a model you can’t use right now. Connect it in Account → Inference, or pick another model for this chat.',
} as const;

/**
 * A chosen model: one of the workspace's backends, or a bring-your-own
 * kind (the person's own connection) with one of its models. A Dot's
 * default and a conversation's override are both one; without one, chats
 * run on the person's own connection, else the workspace default.
 */
export type ModelChoice = { source: 'shared'; backendId: string } | { source: 'byo'; kind: string; model?: string };

/** One entry of a model picker (`GET /api/me/inference/options`). */
export interface ModelOption {
    /** `modelChoiceKey(choice)`: the picker's value. */
    key: string;
    choice: ModelChoice;
    /** The model: "GPT-6-Astra", "qwen38-flash". */
    label: string;
    /** Where it runs: a backend's name, or the kind ("ChatGPT"). */
    group: string;
    description?: string;
    /** Whether this user can run on it now (BYO: they are connected). */
    available: boolean;
    /** Why not, for the picker ("Connect ChatGPT in Account → Inference"). */
    detail?: string;
}

export interface ModelOptions {
    options: ModelOption[];
    /** What a chat with no choice runs on for this user now, if anything. */
    automatic: string | null;
}

export const modelChoiceKey = (choice: ModelChoice) =>
    choice.source === 'shared'
        ? `shared:${choice.backendId}`
        : `byo:${choice.kind}${choice.model ? `:${choice.model}` : ''}`;

/** The picker's label for a choice, "ChatGPT · GPT-6-Astra"; undefined when it is gone. */
export function modelChoiceLabel(options: ModelOption[], choice: ModelChoice) {
    const key = modelChoiceKey(choice);
    const option = options.find((entry) => entry.key === key);
    return option && `${option.group} · ${option.label}`;
}
