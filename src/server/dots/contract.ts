/**
 * What other features may know of Dots (socios at work): the tags for what
 * they ask of this folder, as slices of the methods they call. It imports
 * only `effect`, `@socio/*` and, with `import type`, the allowlisted
 * modules, and holds no logic.
 *
 * Not here, on purpose:
 * - The turn vocabulary (`DotTurn`, `MessageTurn`, `TurnCause`,
 *   `ComputerExecEnv`, `ComputerHooks`) is in `@socio/foundation/turns/*`.
 * - `dotAdminRoutes` (`dot-admin.ts`) is route mounting: it moves into the
 *   composition's HTTP files with the rest of the routes, not behind a tag.
 * - Views: `live/` has no views of `dots/`, so there is no `DotsViews` tag.
 *
 * The contract also declares `TurnExtensions` (the extensions as a
 * service) and `DotTurnHooks` (what the composition root adds to them);
 * `dots/layer.ts` implements both steps.
 */
import type { AbstractAgent, Message } from '@ag-ui/client';
import type { BuiltInAgentFactoryContext, ToolDefinition } from '@copilotkit/runtime/v2';
import type { AgentLoopStrategy, AnyTextAdapter, AnyTool, ChatMiddleware } from '@tanstack/ai';
import { Context } from 'effect';

import type { SearchWebConfig } from '@socio/foundation/search/providers';
import type { ToolImageSource } from '@socio/foundation/turns/tool-images';
import type { ComputerHooks, DotTurn, MessageTurn } from '@socio/foundation/turns/turn';
import type { ContextSettings } from '@socio/shared/context-settings';
import type { LimitValues } from '@socio/shared/limits';
import type { OperationsSettings } from '@socio/shared/operations/operations';
import type { RunWaitInfo } from '@socio/shared/runs/run-phase';
import type { RunRefRecorder } from '@socio/shared/runs/run-refs';
import type {
    BusyReason,
    RetryCause,
    TraceEntry,
    TraceFallback,
    TraceToolInput,
    TraceRetry,
    TraceTurn,
} from '@socio/shared/runs/run-trace';
import type { Settings } from '@socio/shared/types';

import type { ComputersShape } from '../computers/contract.js';
import type {
    ChatNotesShape,
    ContextFittingShape,
    FitTrace,
    SteeringQueue,
    TimeMarkersShape,
} from '../context/contract.js';
import type { CycleLedger } from '../cycles/contract.js';
import type { InferenceResolver, InferenceTimingsShape } from '../inference/contract.js';
import type { TelegramThreadInfo } from '../integrations/contract.js';
import type { SkillDeliveryShape } from '../learning/contract.js';
import type { EpisodeRepository, TimeZoneNoteRepository, TimeZonesShape, TurnMemoryShape } from '../memory/contract.js';
import type { SearchProvider, WebSearchShape } from '../search/contract.js';
import type { WorkspaceSettingsShape } from '../settings/contract.js';
import type { CompactShape, SkillRegistryShape, SkillSessionsRepository } from '../skills/contract.js';
import type { RetryPolicy } from '../turns/contract.js';
import type { ConversationsShape, PeopleShape, SociosShape } from '../workspace/contract.js';

// ── DotExtensions ──────────────────────────────────────────────────────

/**
 * What modules add to every Dot turn: tools (a module's `dotTools`) and the
 * computer hooks. Built once by the graph (`LegacyDotExtensions`) and passed to each DotAgent,
 * including the Telegram channel's.
 */
export interface DotExtensions {
    tools: (turn: DotTurn) => ToolDefinition[];
    /**
     * Tool names the turn's person can't have (feature flags, CB-169): left
     * out of every turn's tools, core and module ones alike.
     */
    toolsOff?: (turn: DotTurn) => ReadonlySet<string>;
    /** The page the turn's conversation is about, for the prompt (`ServerModule.dotPageContext`). */
    pageContext?: (turn: DotTurn) => unknown;
    /** News for the prompt: what changed since the Dot last spoke (`ServerModule.dotNews`). */
    news?: (turn: DotTurn) => string | Promise<string>;
    /** A note for the person's newest message (`ServerModule.dotTurnNote`). */
    turnNote?: (turn: DotTurn) => string | Promise<string>;
    computer?: ComputerHooks;
    /**
     * The conversation as the model gets it, from the messages the runner
     * stores (CB-54: attachment references become images and notes). The
     * stored messages are never changed.
     */
    messages?: (turn: MessageTurn, messages: Message[]) => Promise<Message[]>;
    /**
     * Whether the socio running in a room reads this queued message in its
     * turn (CB-206): not one that names another of the room's socios, which
     * waits for that socio's own turn.
     */
    readsMidTurn?: (threadId: string, dotId: string, text: string) => boolean;
    /**
     * The bytes of the images tools' results name (CB-157, a screenshot),
     * for the model: this conversation's images only.
     */
    toolImages?: (threadId: string, userId?: string) => ToolImageSource;
    /** Where a turn records what grounded it (CB-194, `DotTurn.ref`). */
    runRefs?: (runId: string, threadId: string) => RunRefRecorder;
}

/**
 * The extensions every DotAgent gets (web, Telegram, scheduled turns), built
 * once by `dots/layer.ts`.
 */
export class TurnExtensions extends Context.Service<TurnExtensions, DotExtensions>()('socio/dots/TurnExtensions') {}

/**
 * What the composition root adds to every turn, from what this folder can't
 * reach through a contract: the core and module tools, the flags' tools
 * that are off (read at each turn: tests replace the flags), and the
 * modules' prompt hooks, run in registry order.
 */
export type DotTurnHooksShape = Required<
    Pick<DotExtensions, 'tools' | 'toolsOff' | 'pageContext' | 'news' | 'turnNote'>
>;

export class DotTurnHooks extends Context.Service<DotTurnHooks, DotTurnHooksShape>()('socio/dots/DotTurnHooks') {}

// ── DotAgents ────────────────────────────────────────────────────────────

/** Whose turn an agent runs, as a caller outside `dots/` asks for it. */
export interface DotAgentRequest {
    /** The Dot that answers. */
    readonly dotId: string;
    /** A channel (Telegram) turn: `DotTurn.channel`. */
    readonly channel: boolean;
    /**
     * The person the turn acts as when not its conversation's owner: a
     * channel's linked sender, or a room member whose queued messages start
     * it. Set by the server, never taken from request input.
     */
    readonly actingUserId?: string;
}

/**
 * A Dot's agent for one turn, as `telegram/` and `context/` build it today
 * (`new DotAgentCore(services, store, workspace, config, dotId, channel,
 * actingUserId, { inference, extensions })`): the workspace's inference registry and the
 * modules' tools and computer hooks come from the implementation, not the
 * caller. The caller sets the agent's `threadId` and messages and hands it to
 * the runner. `dots/dot-agent.ts`'s `DotAgentFactoryCore` implements it.
 */
export interface DotAgentsShape {
    readonly agent: (request: DotAgentRequest) => AbstractAgent;
}

export class DotAgents extends Context.Service<DotAgents, DotAgentsShape>()('socio/dots/DotAgents') {}

// ── DotsConfig ───────────────────────────────────────────────────────────

/**
 * The `PlatformConfig` fields `dots/` reads itself. `PlatformConfig` has
 * each of them with this type, so the composition root can provide the tag
 * from it.
 *
 * Not yet here: `modelRetry` (its type is `turns/`'s `RetryPolicy`), which
 * `DotTurnConfig` adds. The fields other features' helpers read
 * (`limitDefaults`, `turnTimeLimitMs`, `searchProviderFor`,
 * `settingsInference`, the computers') are bound by the composition root
 * into `DotTurnServices`, and those features' own config tags carry them.
 */
export interface DotsConfigShape {
    /** The context settings' env defaults (`contextSettings`). */
    readonly context?: Partial<ContextSettings>;
    /** The operations settings' env defaults: the workspace time zone a turn falls back to. */
    readonly operations?: OperationsSettings;
}

export class DotsConfig extends Context.Service<DotsConfig, DotsConfigShape>()('socio/dots/DotsConfig') {}

// ── A Dot's turn: what it reads of other features ───────────────────────

/**
 * The config a Dot's turn reads itself (`dots/dot-agent.ts`): `DotsConfig`'s
 * fields, whether search is on (`searches`), and how a busy model's requests
 * are retried within a turn, over the built-in policy.
 */
export interface DotTurnConfig extends DotsConfigShape, SearchWebConfig {
    readonly modelRetry?: Partial<RetryPolicy>;
}

/** The settings store, as a Dot's turn reads it: the settings, a fold's episodes, the time zone notes. */
export interface DotTurnStore extends Pick<WorkspaceSettingsShape, 'settings'> {
    readonly episodes: Pick<EpisodeRepository, 'capture'>;
    readonly timeZoneNotes: Pick<TimeZoneNoteRepository, 'shown'>;
}

/** The workspace, as a Dot's turn reads it: its socio, the conversation and its people. */
export type DotTurnWorkspace = Pick<SociosShape, 'dot'> &
    Pick<PeopleShape, 'users' | 'isDeactivated'> &
    Pick<ConversationsShape, 'requireThread' | 'answers' | 'allows' | 'thread' | 'convertedFrom' | 'saveCapture'> & {
        /** The Telegram chat a thread came from, if any (CB-66). */
        readonly telegram: { readonly threadInfo: (threadId: string) => Promise<TelegramThreadInfo | undefined> };
    };

/** A turn's model rounds (CB-127): `turns/agent-loop.ts`'s `agentLoop`. */
export interface TurnRoundsShape {
    readonly cap: number;
    readonly strategy: AgentLoopStrategy;
    readonly middleware: ChatMiddleware;
    /** Model rounds started so far. */
    rounds(): number;
    /** Whether the last, tool-less round ran. */
    capped(): boolean;
    /** Whether it ended waiting for the person. */
    waiting(): boolean;
}

/** A turn's trace (CB-128), as a Dot's turn writes it: `turns/turn-trace.ts`'s `TurnTracer`. */
export interface TurnTracerShape {
    /** The context fitting's side of the trace (CB-129). */
    readonly fit: FitTrace;
    /** A busy model's waits and the requests after them (CB-140). */
    readonly retries: {
        retry(entry: Omit<TraceRetry, 'kind' | 'round' | 'at'> & { at?: number }): void;
        again(kind: { retry: number; cause: RetryCause }): void;
    };
    fallback(entry: Omit<TraceFallback, 'kind' | 'round' | 'at'>): void;
    /** A server tool input that failed its schema, repaired or not. */
    toolInput(entry: Omit<TraceToolInput, 'kind' | 'round' | 'at'>): void;
    note(entry: TraceEntry): void;
    start(turn: Omit<TraceTurn, 'kind'>): void;
    /** The model's own stream, each request timed and traced. */
    adapter(adapter: AnyTextAdapter): AnyTextAdapter;
    /** Numbers the rounds and traces the calls as the loop gets them. */
    toolCalls(adapter: AnyTextAdapter, clientTools: ReadonlySet<string>): AnyTextAdapter;
    /** The tools, each call's result traced. */
    tools<T extends { name: string; execute?: (input: never, context?: never) => unknown }>(tools: T[]): T[];
}

/** The shared model a busy one hands the turn to (`turns/model-busy.ts`'s `FallbackModel`). */
export interface TurnFallbackModel {
    /** Fitted to the shared model's context, its requests retried and traced. */
    adapter: AnyTextAdapter;
    label: string;
    model: string | null;
    modelOptions: Record<string, unknown>;
    /** The most recent images it takes; 0 for a model that sees none. */
    maxImages: number;
}

/** How a busy model hands over or ends the round (`turns/model-busy.ts`'s `BusyOptions`). */
export interface TurnBusyOptions {
    /** The turn's model, as people know it ("ChatGPT"). */
    label: string;
    /** The shared model, when the turn may move to it; resolves to undefined when there is none. */
    fallback?: () => Promise<TurnFallbackModel | undefined>;
    /** The switch, as it happens (the trace, the loop end, the phase line). */
    onFallback?: (info: { from: string; to: string; reason: BusyReason }) => void;
    /** The turn ends with a status written here, without a model. */
    onUnavailable?: (reason: BusyReason) => void;
}

/** What `timedRounds` reads to estimate and record a turn's response times (`turns/round-timer.ts`). */
export interface TimedRoundsOptions {
    key: string;
    /** The first round's messages and system prompts, in characters. */
    promptChars: number;
    timings?: InferenceTimingsShape;
    /** Include the prompt size (self-hosted models, where it drives the wait). */
    showTokens: boolean;
    emit: (wait: RunWaitInfo) => void;
}

/**
 * The model chain a Dot's turn is built of (`turns/`): its rounds, trace,
 * retries and busy model, its response times and its tools as `chat()`
 * takes them (the output limit and tool calls' checks are in
 * `@socio/foundation/turns/*`). Each is today's function.
 */
export interface DotTurnEngine {
    /** `agentLoop`. */
    agentLoop(cap: number): TurnRoundsShape;
    /** `new TurnTracer(emit, Date.now, ledger)`. */
    tracer(emit: (entry: TraceEntry) => void, ledger?: CycleLedger): TurnTracerShape;
    /**
     * `retriedRequests` over one `RetryBudget` for the turn, made now: every
     * adapter it wraps draws on the same budget (CB-140).
     */
    retries(
        deadline: number,
        limitMs: number,
        policy: RetryPolicy,
    ): (adapter: AnyTextAdapter, trace: TurnTracerShape['retries']) => AnyTextAdapter;
    /** `busyModel`. */
    busyModel(primary: AnyTextAdapter, options: TurnBusyOptions): AnyTextAdapter;
    /** `timedRounds`. */
    timedRounds<T extends { type: string }>(stream: AsyncIterable<T>, options: TimedRoundsOptions): AsyncGenerator<T>;
    /** `tanstackTools`. */
    tanstackTools(tools: ToolDefinition[]): AnyTool[];
    /** `learnedSkillTools`. */
    learnedSkillTools(context: BuiltInAgentFactoryContext, check: () => void): AnyTool[];
    /** `toolInputRepair`: schema failures traced, numbers and booleans sent as text read. */
    toolInputRepair(trace: (entry: Omit<TraceToolInput, 'kind' | 'round' | 'at'>) => void): ChatMiddleware;
}

/**
 * What a Dot's turn calls of other features, each today's function over the
 * store, workspace and config the agent was built with. The composition
 * root builds it (`composition/app/dot-turns.ts`'s `dotTurnServices`), so
 * `dots/` imports only those features' contracts.
 */
export interface DotTurnServices {
    /** `settings/`'s `limitDefaults(config)`. */
    readonly limitDefaults: () => LimitValues;
    /** `settings/`'s `turnTimeLimitMs(settings, config)`. */
    readonly turnTimeLimitMs: (settings: Settings) => number;
    /** `inference/`'s `settingsInference(config)`: the model when the turn is given no registry. */
    readonly settingsInference: () => InferenceResolver;
    /** `search/`'s `searchProviderFor(config)`. */
    readonly searchProvider: () => SearchProvider | undefined;
    /** `search/`'s `gatherSources`. */
    readonly gatherSources: WebSearchShape['gather'];
    /** `computers/`'s `ComputerService` on the workspace and config, for the turn. */
    readonly computer: (paused: () => boolean, hooks?: ComputerHooks) => Pick<ComputersShape, 'configured'>;
    /** `context/`'s `fitContext`. */
    readonly fitContext: ContextFittingShape['fit'];
    /** `context/`'s `contextNotes(workspace.db)`. */
    readonly notes: () => ChatNotesShape;
    /** `context/`'s `timeMarkers(workspace.db)`. */
    readonly markers: () => TimeMarkersShape;
    /** `context/`'s `steeringQueue(workspace.db)`. */
    readonly steering: () => SteeringQueue;
    /** `learning/`'s `learnedSkillsFor(workspace.skills, ...)`. */
    readonly learnedSkillsFor: SkillDeliveryShape['learnedSkillsFor'];
    /** `memory/`'s `sharedChat`, `personalContext` and `spaceMemoryForTurn` on the store and workspace. */
    readonly memory: TurnMemoryShape;
    /** `memory/`'s `turnTimeZone` and `movedTimeZone` on the store. */
    readonly timeZones: Pick<TimeZonesShape, 'turnTimeZone' | 'movedTimeZone'>;
    /** `skills/`'s `compactWith({ compactNow })`'s `compact`. */
    readonly compact: CompactShape['compact'];
    /** `skills/`'s `chatSkills` and `skillSessions` on the workspace's database. */
    readonly chatSkills: () => { skills: SkillRegistryShape; sessions: SkillSessionsRepository };
    /** `turns/`'s model chain. */
    readonly turns: DotTurnEngine;
}
