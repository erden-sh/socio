/**
 * What other features may know of inference (the model registry): its
 * tags, the slices of its services they call, and plain types and
 * constants. It imports only `effect`, `@socio/*` and, with `import type`,
 * the allowlisted modules, and holds no logic.
 *
 * Moved into packages; the types are re-exported here, the rest is imported
 * from the package (the old paths are gone):
 * - `ChatCompletionsEndpoint`, `ModelSettings`, `EndpointSource`,
 *   `endpointOf` and `settingsEndpoint`: `@socio/foundation/inference/endpoints`.
 * - `RoundKind`, `TimingSample`, `WaitEstimate` and `InferenceTimingsShape`:
 *   `@socio/foundation/inference/timings`.
 * - `ChatGptError`, its codes and messages, `chatGptFailure` and
 *   `OVER_LENGTH_WORDING`: `@socio/foundation/inference/chatgpt-errors`.
 * - `connectionTurnError`: `@socio/foundation/inference/chatgpt-turn-error`.
 * - `timingKey`: `@socio/foundation/inference/timing-key`.
 * - `modelChoiceInput`: `@socio/shared/inference/model-choice-input`.
 * - `InferencePurpose`: `@socio/foundation/turns/inference-purpose`.
 *
 * Not here, on purpose:
 * - `InferenceService` itself: the CLIs (`auth/cli.ts`, `classify/eval-cli.ts`)
 *   construct it, as the composition will. Other folders get the `Inference`
 *   tag below.
 * - The bring-your-own kinds (`chatGptKind`, `chatGptEndpointsFromEnv`,
 *   `claudeApiKeyKind`, `fakeByoKind`) and `inferenceRoutes`: the composition
 *   registers and mounts them; `inferenceSchema` is the modules registry's.
 * - `ByoError` and `PERSONAL_PURPOSES`: only inference uses them.
 * - `INFERENCE_SEALED_SQL` (`infra/sqlite/sealed.ts`, read by backup's
 *   recovery drill): inference's SQL stays inside its infra
 *   (tests/integration/inference-boundary.test.ts), so the drill should be
 *   handed it by the composition rather than import it from here.
 */
import type { AnyTextAdapter } from '@tanstack/ai';
import { Context } from 'effect';

import type { ChatCompletionsEndpoint, EndpointSource, ModelSettings } from '@socio/foundation/inference/endpoints';
import type { InferenceTimingsShape } from '@socio/foundation/inference/timings';
import type { SealState } from '@socio/foundation/keys/secret-box';
import type { InferencePurpose } from '@socio/foundation/turns/inference-purpose';
import type {
    BackendTest,
    ByoConnectStep,
    ConnectionState,
    InferenceAvailability,
    InferenceCapabilities,
    ModelChoice,
    ModelOptions,
    OpenAICompatibleConfig,
    OperatorInferenceState,
} from '@socio/shared/inference';

export type { ChatCompletionsEndpoint, EndpointSource, InferencePurpose, ModelSettings };

// ── Models and resolution ────────────────────────────────────────────────

/**
 * The model one turn or request runs on: a shared backend or a user's own
 * connection. Built per use; holds the secrets it needs, so it never goes to
 * a client, a log or an event.
 */
export interface InferenceModel {
    source: { type: 'shared'; backendId: string } | { type: 'byo'; kind: string };
    /** For people: "Homelab (qwen38-flash)", "ChatGPT". */
    label: string;
    /** The model id; null when the kind hides it. */
    model: string | null;
    capabilities: InferenceCapabilities;
    /**
     * The TanStack AI text adapter for a Dot turn. `maxRetries` is the HTTP
     * client's own retries (one when unset); a turn sets 0 and retries itself.
     */
    adapter: (options?: { maxRetries?: number }) => AnyTextAdapter;
    /** `chat()` model options for a Dot turn (the completion cap, …). */
    modelOptions: Record<string, unknown>;
    /** Present when the model also speaks plain Chat Completions. */
    chatCompletions?: ChatCompletionsEndpoint;
}

/**
 * Why nothing is available: `connect_byo` (the user may connect their own
 * subscription), `ask_operator` (they can't: an operator must set up a
 * backend), `not_configured` (stand-alone use without model settings),
 * `choice_unavailable` (the conversation's own model can't be used now).
 */
export type NoInferenceReason = 'connect_byo' | 'ask_operator' | 'not_configured' | 'choice_unavailable';

export type InferenceResolution = { ok: true; model: InferenceModel } | { ok: false; reason: NoInferenceReason };

export interface InferenceRequest {
    /** The user the work is for (a turn's acting user); absent for background work. */
    userId?: string;
    purpose: InferencePurpose;
    /**
     * The model the turn should run on: the conversation's override, else its
     * Dot's default. Personal purposes only (`PERSONAL_PURPOSES`).
     */
    choice?: ModelChoice;
    /**
     * The conversation chose it: when it can't be used, the turn fails with
     * `choice_unavailable`. Otherwise (a Dot's default, which someone else
     * set) the turn falls back to the automatic order.
     */
    strict?: boolean;
}

/** Resolves the model per turn; no live probing (a backend is not pinged). */
export interface InferenceResolver {
    resolve(request: InferenceRequest): Promise<InferenceResolution>;
    /** Response times per model, for wait estimates (the registry has them). */
    readonly timings?: InferenceTimingsShape;
}

// ── Response times ───────────────────────────────────────────────────────

// In @socio/foundation, so turns' round timer reads them without importing the
// inference feature.
export type { InferenceTimingsShape, RoundKind, TimingSample, WaitEstimate } from '@socio/foundation/inference/timings';

// ── Bring-your-own kinds ─────────────────────────────────────────────────

/** A model a kind offers; the operator picks one per kind (Platform page). */
export interface ByoModelChoice {
    id: string;
    label: string;
    description?: string;
}

/** A user's stored connection of one kind, decrypted for its kind's hooks. */
export interface ByoConnection {
    userId: string;
    kind: string;
    /** The kind's own credential shape (tokens, expiry); encrypted at rest. */
    credentials: unknown;
    /** Non-secret facts the kind wants to show (an account label, a plan). */
    meta: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
}

export interface ByoStatus {
    state: ConnectionState;
    /** Shown under the kind's name; never a token or an email address. */
    detail?: string;
}

/** What a kind's hooks may do with the user's stored connection. */
export interface ByoConnectionAccess {
    userId: string;
    /** The stored connection, if any (pending ones included). */
    connection(): Promise<ByoConnection | undefined>;
    /**
     * Stores (or replaces) the user's connection, encrypted. With
     * `whileConnected`, only while one is still stored (undefined if not).
     */
    save(
        credentials: unknown,
        meta?: Record<string, unknown>,
        options?: { whileConnected?: boolean },
    ): Promise<ByoConnection | undefined>;
    /** Deletes the user's connection of this kind. */
    remove(): Promise<void>;
}

/**
 * A bring-your-own kind, registered by code (`InferenceService.register`).
 * The operator allows kinds; users connect them from Account → Inference.
 * The ChatGPT kind registers `byo-chatgpt` (ChatGPT/Codex device-code login).
 */
export interface ByoKind {
    /** Lowercase letters, digits and dashes, e.g. `byo-chatgpt`. */
    id: string;
    label: string;
    /** One line for the account dialog and the Operator page. */
    description: string;
    /**
     * The models an operator may choose from for this kind (a static list:
     * showing it makes no request), the default, and a help line for the
     * Platform page. Kinds without it have no model setting.
     */
    models?: {
        choices: readonly ByoModelChoice[];
        default: string;
        help?: string;
    };
    /**
     * `POST /api/me/inference/:kind/connect`: starts or advances a connection
     * (a device-code login answers `pending` with the code first, then is
     * polled until it saves the credentials and answers `connected`). The
     * step goes to the client as is, so it must not hold credentials. Throw
     * `ByoError` for a message the user sees.
     */
    connect(access: ByoConnectionAccess, body: unknown): Promise<ByoConnectStep>;
    /** The state the account dialog shows; cheap and offline. */
    status(connection: ByoConnection): ByoStatus;
    /**
     * Before the stored connection is deleted (on disconnect or when the user
     * is removed), e.g. to revoke a token. Failures are logged and ignored.
     */
    disconnect?(connection: ByoConnection): Promise<void>;
    /**
     * The model for one turn, or undefined when the connection can't serve
     * (expired, refresh failed): the turn then falls back to the shared
     * backend. May refresh tokens and `save` them through `access`.
     * `settings.model` is the operator's choice for the kind (`models`).
     */
    adapterFor(
        connection: ByoConnection,
        access: ByoConnectionAccess,
        settings: { model?: string },
    ): Promise<InferenceModel | undefined> | InferenceModel | undefined;
    /**
     * A person's plan as a coding backend through the model gateway (CB-239):
     * a raw Responses transport holding the person's credential
     * in this process. Kinds without it can't serve coding sessions. Called
     * only for the connection's own person, for their own coding sessions.
     */
    codingTransport?(
        connection: ByoConnection,
        access: ByoConnectionAccess,
        settings: { model?: string },
    ): Promise<ByoCodingTransport | undefined>;
}

/** A person's own plan as the model gateway's upstream (CB-239). */
export interface ByoCodingTransport {
    /** The upstream model: the operator's choice for the kind. */
    model: string;
    /** For people: "ChatGPT (Plus)". */
    label: string;
    acceptsImages: boolean;
    /** Most output tokens one answer may have (the gateway's hard cap). */
    maxOutputTokens: number;
    /**
     * The wire API this transport speaks (per-user providers): `'responses'`
     * for a ChatGPT plan, `'messages'` for a Claude API key. The gateway
     * refuses a request whose API doesn't match. Defaults to `'responses'` so
     * the ChatGPT transport (which predates this field) keeps its behavior.
     */
    api?: 'responses' | 'messages' | 'gemini';
    /**
     * POSTs a body in this transport's wire API with the person's credential
     * and returns the answer as it comes; refreshes and retries once on a 401
     * (a plan session token; an API key doesn't expire this way).
     */
    send(body: string, signal?: AbortSignal): Promise<Response>;
}

// ── Shared backends ──────────────────────────────────────────────────────

/** A backend as stored, its secrets opened. */
export interface BackendRecord {
    id: string;
    kind: string;
    label: string;
    enabled: boolean;
    config: OpenAICompatibleConfig;
    capabilities: InferenceCapabilities;
    lastTest: BackendTest | null;
    createdAt: number;
    updatedAt: number;
    /** The API key, if one is stored and readable. */
    apiKey?: string;
    /** A key is stored but can't be decrypted (its data key or SESSION_SECRET changed). */
    keyUnreadable: boolean;
    hasApiKey: boolean;
}

/**
 * The slice of `InferenceStore` other folders reach through
 * `inference.store`: the backends (operations' pricing) and the sealed
 * values (the data key status and re-seal, CB-62).
 */
export interface InferenceStoreShape {
    backends(): Promise<BackendRecord[]>;
    /** How many stored secrets each key state seals (CB-62). */
    sealStates(): Promise<Record<SealState, number>>;
    /** Seals every stored secret again under the current key (CB-62). */
    reseal(): Promise<{ resealed: number; unreadable: number }>;
}

// ── Inference ────────────────────────────────────────────────────────────

/**
 * The inference registry, as the composition, the server entry and other
 * folders call it (`InferenceService`): per-turn resolution, the shared
 * model, the model options and availability people see, the coding
 * gateway's endpoints and personal plans, the operator's view, and the
 * kinds code registers. `inference/service.ts`'s `InferenceService`
 * implements it.
 */
export interface InferenceShape extends InferenceResolver {
    readonly timings: InferenceTimingsShape;
    readonly store: InferenceStoreShape;
    /** Registers a bring-your-own kind; the operator then decides whether users may connect it. */
    register(kind: ByoKind): void;
    byoKinds(): ByoKind[];
    /** The operator's model for a kind, else its default; undefined without `models`. */
    byoModel(kind: ByoKind): Promise<string | undefined>;
    /** Seeds the first backend from these settings on the registry's first read. */
    seedOnFirstUse(settings: ModelSettings): void;
    /** Whether anything is registered: a backend, or an allowed kind. */
    registered(): Promise<boolean>;
    /** The default shared backend's model (titles, learning). */
    shared(): Promise<InferenceModel | undefined>;
    /** What a user (or, without one, background work) can run on now. */
    availability(userId?: string): Promise<InferenceAvailability>;
    /** A user's model picker. */
    options(userId: string): Promise<ModelOptions>;
    /** Why a choice can't be saved for a user, if it can't. */
    choiceProblem(choice: ModelChoice, userId?: string): Promise<string | undefined>;
    /** One ready shared backend's endpoint for a coding session's model. */
    codingEndpoint(backendId: string, model: string): Promise<ChatCompletionsEndpoint | undefined>;
    /** A named kind's plan for a person's coding session, if they can use it. */
    personalCodingPlanFor(
        userId: string,
        kindId: string,
    ): Promise<{ kind: string; label: string; model: string } | undefined>;
    /** The transport to that plan for one request; holds the person's credential. */
    personalCodingTransport(userId: string, kindId: string): Promise<ByoCodingTransport | undefined>;
    /** The operators' view of the backends and kinds (`GET /api/inference`). */
    operatorState(): Promise<OperatorInferenceState>;
    /** Deletes every connection of a removed user. */
    forgetUser(userId: string): Promise<void>;
    /** How many connections `forgetUser` would delete (CB-360's deactivation preview). */
    connectionCountOf(userId: string): Promise<number>;
}

export class Inference extends Context.Service<Inference, InferenceShape>()('socio/inference/Inference') {}

// ── SettingsInference ────────────────────────────────────────────────────

/**
 * A fixed resolver from model settings, for code that runs without the
 * registry (tests, stand-alone agents): `dots/` falls back to it when it is
 * given no `Inference`. `inference/openai-compatible.ts`'s
 * `settingsResolvers` implements it.
 */
export interface SettingsInferenceShape {
    readonly resolver: (settings: ModelSettings) => InferenceResolver;
}

export class SettingsInference extends Context.Service<SettingsInference, SettingsInferenceShape>()(
    'socio/inference/SettingsInference',
) {}

// ── InferenceConfig ──────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields inference reads: the environment's model
 * settings, which seed the first shared backend (`seedOnFirstUse`).
 * `PlatformConfig` has each of them with this type, so the composition root
 * can provide the tag from it.
 *
 * Not here: the data keyring (`secret`) the registry seals with. The
 * platform derives it from `dataKeys` and the session secret and hands the
 * same one to several features, so it isn't inference's config.
 */
export type InferenceConfigShape = Readonly<ModelSettings>;

export class InferenceConfig extends Context.Service<InferenceConfig, InferenceConfigShape>()(
    'socio/inference/InferenceConfig',
) {}

// ── InferenceViews ───────────────────────────────────────────────────────

/**
 * Inference's views, as live/ and web/ read them. `inference/views.ts`
 * implements them; inference's layer provides the tag.
 */
export interface InferenceViewsShape {
    /**
     * `GET /api/inference` (operators): the backends (keys are write-only and
     * never in it), the default, and the subscriptions users may connect.
     */
    readonly operatorInferenceView: (inference: InferenceShape) => Promise<OperatorInferenceState>;
}

export class InferenceViews extends Context.Service<InferenceViews, InferenceViewsShape>()(
    'socio/inference/InferenceViews',
) {}
