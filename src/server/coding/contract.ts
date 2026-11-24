/**
 * What other features may know of coding sessions (CB-239, CB-326):
 * their tags, the slices of the services other folders call, and plain
 * types and constants. It imports only `effect`, `@socio/*` and the
 * allowlisted types, and holds no logic.
 *
 * This file took over the coding tables (`codingSessionMigrations`,
 * `codingHarnessMigrations`, `codingThreadEventsMigration`,
 * `codingHostMarkerMigration`, `gatewayExchangesMigration`: versions 3, 4 and 6
 * to 9 of the gateway module's schema, which `gateway/schema.ts` orders; plain
 * data, unchanged, so their checksums hold), `GatewayExchangeRecord`, and the
 * environment's coding settings as `CodingSessionsConfig` (`CodingConfig` is
 * the config tag below).
 *
 * Tags:
 * - `Sessions`: what the gateway module calls of `CodingSessions`
 *   (`configured`, `tick`, `shutdown`). `CodingSessions` implements it.
 * - `Tools`: the socio's `coding_*` tools for one turn, what
 *   `gateway/module.ts` gets through `HostedGateway` (`hostedCoding`,
 *   `composition/coding.ts`).
 * - `CodingGateway`: what coding sessions call of the coding gateways,
 *   which the gateways' layer offers.
 * - `GatewayExchanges`: the coding session gateway exchange log
 *   (CB-326 step 6), what `gateway/model.ts` and `gateway/exchangeLogger.ts`
 *   use. `GatewayExchangeRows` implements it.
 * - `CodingConfig`: what coding reads of the platform's configuration.
 *
 * Not here, on purpose:
 * - `CodingSessions` itself: the composition builds the service from the
 *   tags at the gateways' step (`codingSessionsLayer`, `composition/coding.ts`,
 *   placed by `composition/gateway.ts`); other folders get the `Sessions` tag.
 * - `sessionRoutes`: mounted under `/api/gateway` by the gateway's module
 *   (`hostedCoding`, `composition/coding.ts`); its mount moves with the
 *   module's routes.
 * - `CodingRefusal`, `SupervisorError`, `SandboxSettingsError`: plain
 *   `Error` subclasses thrown and caught only inside `coding/`.
 * - `codingConfigFromEnv`, `RUN_WORK`, `socioSlug`, `volumeKeyOf`: only
 *   `coding/` and its tests use them.
 *
 * The coding gateways as coding sessions call them: `CodingGateway` and its
 * slices, types and `GitProxyError`, which the gateways implement.
 */
import type { ToolDefinition } from '@copilotkit/runtime/v2';
import { Context } from 'effect';

import type { Migration } from '@socio/data/migrate';
import type { ChatCompletionsEndpoint } from '@socio/foundation/inference/endpoints';
import type { DotTurn } from '@socio/foundation/turns/turn';
import type { CodingLimits, CodingModelView } from '@socio/shared/coding/coding-gateway';
import type { CodingRepositoryView } from '@socio/shared/coding/coding-repos';
import type { NotificationDailyLimits } from '@socio/shared/notifications';

import type { AudiencePolicy } from '../actors/contract.js';

// ── Tables ───────────────────────────────────────────────────────────────

/**
 * Coding sessions' tables (CB-239): versions 3 and 4 of the
 * gateway module's schema (gateway/schema.ts), both expand migrations.
 * Nothing here holds a token, a prompt, a diff or a file's contents; a
 * run's `summary` and `progress` are the agent's own words, bounded and
 * redacted of token shapes, shown back to the person they were for.
 *
 * - `coding_sessions`: one per session: who, where, which model, its
 *   branch and lifetime. Live rows are counted inside the transaction that
 *   creates one, so the per-person, per-socio and per-instance caps hold
 *   across both runtimes of a deploy. The short id and branch are unique
 *   per repository, so no session can address another's branch: checked
 *   in that same transaction (one writer at a time), as the gateway's
 *   migrations carry no UNIQUE constraint.
 * - `coding_runs`: the setup and each prompt as durable runs: a
 *   `runtime_work` lease (kind `coding-run`) says which runtime follows
 *   the supervisor's detached exec; another takes it over on a drain or a
 *   death.
 * - `coding_denials`: the first egress denial per session and host, so
 *   its `actor_audit` row is written once across runtimes.
 * - `coding_settings`: an admin's values over the environment's for the
 *   package registries a sandbox may read (`CODING_EGRESS_ALLOW`) and how
 *   long an unused workspace is kept (`CODING_WORKSPACE_RETENTION_DAYS`); a
 *   missing row is the default.
 */
export const codingSessionMigrations: readonly Migration[] = [
    {
        version: 3,
        name: 'coding sessions, their runs, egress denials and sandbox settings',
        phase: 'expand',
        up: `CREATE TABLE coding_sessions(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
        personId TEXT NOT NULL CHECK(length(personId) > 0),
        socioId TEXT NOT NULL CHECK(length(socioId) > 0),
        threadId TEXT NOT NULL,
        conversationKind TEXT NOT NULL CHECK(conversationKind IN ('private','room')),
        repository TEXT NOT NULL,
        repositoryKey TEXT NOT NULL CHECK(repositoryKey = lower(repositoryKey)),
        base TEXT NOT NULL,
        branch TEXT NOT NULL,
        shortId TEXT NOT NULL CHECK(length(shortId) BETWEEN 6 AND 16),
        model TEXT NOT NULL,
        push INTEGER NOT NULL CHECK(push IN (0, 1)),
        volumeKey TEXT NOT NULL CHECK(length(volumeKey) = 64),
        grantId TEXT,
        approvalId TEXT,
        opencodeSession TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('starting','ready','ended')),
        endReason TEXT,
        createdAt INTEGER NOT NULL,
        endsAt INTEGER NOT NULL,
        lastPromptAt INTEGER NOT NULL,
        endedAt INTEGER,
        sandboxGoneAt INTEGER,
        volumeGoneAt INTEGER,
        prNumber INTEGER,
        prUrl TEXT);
      CREATE INDEX coding_sessions_live ON coding_sessions(state, personId, socioId);
      CREATE INDEX coding_sessions_branch ON coding_sessions(repositoryKey, shortId);
      CREATE INDEX coding_sessions_grant ON coding_sessions(grantId);
      CREATE TABLE coding_runs(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
        sessionId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('setup','prompt')),
        state TEXT NOT NULL CHECK(state IN ('running','done','failed','lost','stopped')),
        startedAt INTEGER NOT NULL,
        endedAt INTEGER,
        tokensAtStart INTEGER NOT NULL DEFAULT 0,
        tokens INTEGER,
        progress TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        changedFiles TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        answered INTEGER NOT NULL DEFAULT 0 CHECK(answered IN (0, 1)),
        reportedAt INTEGER);
      CREATE INDEX coding_runs_session ON coding_runs(sessionId, startedAt);
      CREATE INDEX coding_runs_state ON coding_runs(state);
      CREATE TABLE coding_denials(
        sessionId TEXT NOT NULL,
        target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 300),
        firstAt INTEGER NOT NULL,
        count INTEGER NOT NULL CHECK(count >= 0),
        PRIMARY KEY(sessionId, target));
      CREATE TABLE coding_settings(
        key TEXT PRIMARY KEY CHECK(key IN ('registries','retentionDays')),
        value TEXT NOT NULL CHECK(length(value) <= 4000),
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL);`,
    },
    {
        // What the sandbox's proxy credential was signed for: its subnet
        // and allow list, so the credential can be signed again and its
        // password redacted by value from what the agent prints. Neither is
        // secret; the password never is stored. Null on sessions from
        // before.
        version: 4,
        name: 'coding sessions keep their proxy credential’s subnet and allow list',
        phase: 'expand',
        up: `ALTER TABLE coding_sessions ADD COLUMN proxySubnet TEXT;
      ALTER TABLE coding_sessions ADD COLUMN proxyAllow TEXT;`,
    },
];

/**
 * The coding harness port (CB-326): version 6 of the gateway
 * module's schema, after version 5 (gateway/infra/g5-tables.ts), expand
 * only. `coding_sessions.harness` is the harness that runs the
 * session (coding/harness.ts). Nullable with a default: SQLite adds it
 * without rewriting a row, every existing session reads `opencode`, and a
 * release from before that inserts without the column gets `opencode`
 * too. The harness's own session id stays in `opencodeSession`.
 */
export const codingHarnessMigrations: readonly Migration[] = [
    {
        version: 6,
        name: 'coding sessions record their harness',
        phase: 'expand',
        up: `ALTER TABLE coding_sessions ADD COLUMN harness TEXT DEFAULT 'opencode';`,
    },
];

/**
 * The session host's thread events (CB-326 step 3):
 * version 7 of the gateway module's schema, expand only. One row per
 * `ProviderAdapterV2Event` the session host streams out — the long-lived
 * session's turn lifecycle, items, messages and terminals — written as the
 * host emits them, named with the person and the requester, soft-deleted with
 * the session (a session's events go when it does; CB-64).
 *
 * The `payload` is the event's data as the host received it, bounded and
 * redacted of token shapes and Socio Secrets values (the same redaction the
 * gateway applies), never a prompt or completion verbatim where the gateway
 * already logged one. `kind` is the `ProviderAdapterV2Event` type
 * (`app_thread.created`, `provider_turn.updated`, `turn.terminal`, …). The
 * native ids (`nativeThreadId`, `nativeTurnId`, `nativeItemId`) tie a row to
 * the provider's own ids for resume/fork/rollback; `ordinal` is the event's
 * place in the stream so the UI can order and page it.
 */
export const codingThreadEventsMigration: readonly Migration[] = [
    {
        version: 7,
        name: 'coding session host thread events',
        phase: 'expand',
        up: `CREATE TABLE coding_thread_events(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
        sessionId TEXT NOT NULL,
        personId TEXT NOT NULL CHECK(length(personId) > 0),
        requesterId TEXT NOT NULL CHECK(length(requesterId) > 0),
        kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64),
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        nativeThreadId TEXT,
        nativeTurnId TEXT,
        nativeItemId TEXT,
        payload TEXT NOT NULL CHECK(length(payload) <= 16384),
        createdAt INTEGER NOT NULL,
        deletedAt INTEGER,
        deletedBy TEXT,
        deletedWith TEXT);
      CREATE INDEX coding_thread_events_session ON coding_thread_events(sessionId, ordinal);
      CREATE INDEX coding_thread_events_live ON coding_thread_events(sessionId) WHERE deletedAt IS NULL;`,
    },
];

/**
 * The session host marker (CB-326 step 3): version 8
 * of the gateway module's schema, expand only. Two nullable columns on
 * `coding_sessions` that mark a session as host-backed and track its idle
 * clock, so the T3 idle stop (30 min idle → stop the provider, keep the
 * sandbox up to a 4 h pin) applies only to host-backed
 * sessions. The one-shot `exec`-per-prompt path keeps its shipped
 * idle→end→remove-sandbox behavior; CB-326 step 8 retires it.
 *
 * - `hostStartedAt`: set (to ms) when the session host starts for this
 *   session; null for a one-shot session. Presence is the marker the idle
 *   stop keys off.
 * - `hostIdleSince`: set (to ms) when the host transitions to idle (the
 *   provider stopped, the sandbox kept); null while the host is active or
 *   the session is one-shot. A new prompt clears it (resume) and refreshes
 *   `hostStartedAt`'s pin window.
 */
export const codingHostMarkerMigration: readonly Migration[] = [
    {
        version: 8,
        name: 'coding sessions record their host and idle clock',
        phase: 'expand',
        up: `ALTER TABLE coding_sessions ADD COLUMN hostStartedAt INTEGER;
      ALTER TABLE coding_sessions ADD COLUMN hostIdleSince INTEGER;`,
    },
];

/**
 * The gateway exchange log (CB-326 step 6): version 9 of the gateway module's
 * schema, expand only. One row per gateway request and response for a coding
 * session, with the request body as-forwarded and the response as-received
 * stored out-of-line in the object store (SeaweedFS), Brotli-compressed and
 * sealed under the `gateway-log` purpose. The DB row holds the metadata and the
 * object-store path; it joins `gateway_usage` on the usage row's id for token
 * counts. Soft delete follows the session.
 *
 * Bodies are not in the column: the row carries only the object-store
 * reference (`bodyPath`), sizes and hashes (the request's hash dedups shared
 * prefixes; images once per content hash; reasoning kept as size+hash
 * only). Credentials never reach the log by construction: the inbound body
 * is post-`cbgw_`-removal, and vendor creds are only in upstream headers,
 * which are not logged.
 */
export const gatewayExchangesMigration: readonly Migration[] = [
    {
        version: 9,
        name: 'coding session gateway exchange log',
        phase: 'expand',
        up: `CREATE TABLE gateway_exchanges(
        id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 64),
        usageId INTEGER,
        sessionId TEXT NOT NULL CHECK(length(sessionId) > 0),
        holderId TEXT NOT NULL CHECK(length(holderId) > 0),
        requesterId TEXT,
        harness TEXT NOT NULL CHECK(length(harness) BETWEEN 1 AND 64),
        api TEXT NOT NULL CHECK(length(api) BETWEEN 1 AND 32),
        route TEXT NOT NULL CHECK(length(route) BETWEEN 1 AND 128),
        model TEXT,
        upstreamKind TEXT NOT NULL CHECK(length(upstreamKind) BETWEEN 1 AND 32),
        requestAt INTEGER NOT NULL,
        responseAt INTEGER,
        status TEXT CHECK(status IS NULL OR length(status) <= 32),
        -- The object-store path: gateway-log/<session>/<seq>, Brotli-compressed, sealed.
        bodyPath TEXT,
        requestBytes INTEGER,
        responseBytes INTEGER,
        requestHash TEXT,
        responseHash TEXT,
        deletedAt INTEGER,
        deletedBy TEXT,
        deletedWith TEXT);
      CREATE INDEX gateway_exchanges_session ON gateway_exchanges(sessionId, requestAt);
      CREATE INDEX gateway_exchanges_usage ON gateway_exchanges(usageId);
      CREATE INDEX gateway_exchanges_live ON gateway_exchanges(sessionId) WHERE deletedAt IS NULL;`,
    },
];

// ── Types ────────────────────────────────────────────────────────────────

/**
 * The coding session gateway exchange log (CB-326 step 6): one row per gateway
 * request and response for a coding session. The bodies are stored out-of-line
 * in the object store (`bodyPath`), Brotli-compressed and sealed under the
 * `gateway-log` purpose; the row carries the metadata, sizes and hashes, and
 * joins `gateway_usage` on `usageId` for token counts. Soft-deleted with the
 * session (CB-64).
 */
export interface GatewayExchangeRecord {
    id: string;
    usageId: number | null;
    sessionId: string;
    holderId: string;
    requesterId: string | null;
    harness: string;
    api: string;
    route: string;
    model: string | null;
    upstreamKind: string;
    requestAt: number;
    responseAt: number | null;
    status: string | null;
    bodyPath: string | null;
    requestBytes: number | null;
    responseBytes: number | null;
    requestHash: string | null;
    responseHash: string | null;
    deletedAt: number | null;
    deletedBy: string | null;
    deletedWith: string | null;
}

/** The environment's coding settings (`CodingConfig` in `sessions.ts`). */
export interface CodingSessionsConfig {
    /** `COMPUTER_SUPERVISOR_URL` and `_TOKEN` (the sandbox API). */
    supervisorUrl?: string;
    supervisorToken?: string;
    /** `CODING_EGRESS_SECRET`: signs the sandbox's proxy credential. */
    egressSecret?: string;
    /** `CODING_EGRESS_DIAGNOSTICS_URL`: the proxy's diagnostics listener. */
    diagnosticsUrl?: string;
    /**
     * `CODING_EGRESS_ALLOW`: the registries a sandbox may read, the default
     * under Settings → Coding → Sandboxes.
     */
    registries?: string;
    /**
     * `CODING_WORKSPACE_RETENTION_DAYS`: unused volumes go after (14), the
     * default under Settings → Coding → Sandboxes.
     */
    retentionDays: number;
    /**
     * `CODING_HARNESSES_DISABLED`: harness ids that may not start new
     * sessions (CB-326, the per-harness kill switch); none by default.
     */
    disabledHarnesses?: string[];
    /** Seconds a follower's long poll waits for an exec (10). */
    pollSeconds: number;
    /** A pause between polls after an error, in ms (2 000). */
    retryMs: number;
    /** How long a tool waits for a run within its turn, in ms; else from the turn limit. */
    waitMs?: number;
    fetch?: typeof fetch;
    /**
     * `CODING_HOST_MODE` (CB-326 step 3): when set, new sessions run on the
     * session host (the long-lived provider in the sandbox) instead of the
     * one-shot exec-per-prompt path. Off by default; the one-shot path stays
     * until CB-326 step 8 retires it. Dark behind the `coding-sessions` flag.
     */
    hostMode?: boolean;
}

// ── The coding gateways, as coding sessions call them ───────────────────

/**
 * The plain types, error and slices of the coding gateways (CB-239, the
 * `gateway/` folder) that coding sessions call. Coding states the port it
 * needs (`CodingGateway`, below); the gateways, above it in the folder
 * order, implement it (`gateway/service.ts`), and `gateway/contract.ts`
 * builds its `Gateway` tag's shape on it.
 */

/** A coding model the admin listed (Settings → Coding → Models, CB-239). */
export interface ModelRecord {
    id: string;
    label: string;
    backendId: string;
    upstreamModel: string;
    maxOutputTokens: number;
    contextWindow: number | null;
    acceptsImages: boolean;
    /** null: follow the backend's address. */
    outsideProvider: boolean | null;
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
    updatedBy: string;
}

/** A model a session on a repository may use now, with its endpoint. */
export interface UsableModel {
    model: ModelRecord;
    outsideProvider: boolean;
    endpoint: ChatCompletionsEndpoint;
}

/** A coding session's tokens used and held now (`coding_status`). */
export interface SessionTokens {
    used: number;
    inFlight: number;
    reserved: number;
    left: number;
    dropped: { field: string; count: number }[];
}

/** A draft pull request from a coding session (CB-239). */
export interface SessionPullRequestInput {
    /** The coding session's grant. */
    grantId: string;
    /** The turn's person and socio: they must be the grant's. */
    personId: string;
    socioId: string;
    /** The agent's or socio's title, untrusted. */
    title: string;
    /** The agent's summary, untrusted. */
    summary: string;
    /** The Socio session's link for the body. */
    sessionLink?: string;
    signal?: AbortSignal;
}

/** The draft pull request GitHub opened. */
export interface SessionPullRequest {
    number: number;
    url: string;
    draft: boolean;
}

/**
 * The coding gateways' refusal, with its HTTP status and audit reason
 * code: the Git gateway throws it, and coding sessions catch it with
 * `instanceof` from `CodingGateway.openSessionPullRequest`. Still a plain
 * `Error`: its name and message stay what they are.
 */
export class GitProxyError extends Error {
    constructor(
        readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 502 | 503,
        readonly reason: string,
        message: string,
    ) {
        super(message);
    }
}

// ── Slices of the model gateway ──────────────────────────────────────────

/** What coding sessions read of Settings → Coding's models and limits (`CodingSettings`). */
export interface CodingSettingsShape {
    /** The limits in force, read on every use. */
    limits(): CodingLimits;
    model(id: string): ModelRecord | undefined;
    /** The listed models offered for the repository. */
    forRepository(repository: string): Promise<CodingModelView[]>;
    /** A model a session on the repository may use now, or undefined. */
    usable(modelId: string, repository: string): Promise<UsableModel | undefined>;
}

/** Settings → Coding's switches (`GatewayOptions`). */
export interface GatewayOptionsShape {
    personalPlans(): boolean;
}

/** The token ledger (`GatewayLedger`). */
export interface GatewayLedgerShape {
    session(sessionId: string, limits: CodingLimits): SessionTokens;
}

/** The model gateway of one platform, as coding sessions call it (`ModelGateway`). */
export interface ModelGatewayShape {
    readonly settings: CodingSettingsShape;
    readonly ledger: GatewayLedgerShape;
    readonly options: GatewayOptionsShape;
    /** The `gateway:model` audience policy. */
    policy(): AudiencePolicy;
    /** Ends a session's open model requests. */
    abortSession(sessionId: string, reason?: string): void;
}

// ── Slices of the Git gateway ────────────────────────────────────────────

/** The listed repositories (`GitRepositories`, CB-239). */
export interface CodingRepositoriesShape {
    get(repository: string): CodingRepositoryView | undefined;
    /** Whether the person may use a listed repository. */
    personMay(personId: string, repository: CodingRepositoryView, onCodeList: boolean): boolean;
}

/** The Git gateway of one platform, as coding sessions call it (`GitGateway`). */
export interface GitGatewayShape {
    readonly repos: CodingRepositoriesShape;
    /** The socio's commit identity. */
    identity(socioId: string): { name: string; email: string } | undefined;
    /** Whether the person is on the code-access list in force (CB-124). */
    mayUseCode(personId: string): Promise<boolean>;
}

/**
 * What coding sessions call of the coding gateways: the code-access check,
 * the Git and model gateways, and a session's draft pull request. The
 * gateways' layer (`gateway/layer.ts`) offers it, the same value as its
 * `Gateway` tag.
 */
export interface CodingGatewayShape {
    /** Whether a person may run code (CB-376): the `code:run` permission (admins, and groups that give it). */
    mayRunCode(personId: string): Promise<boolean>;
    /** The Git gateway. */
    readonly git: GitGatewayShape;
    /** The model gateway. */
    readonly model: ModelGatewayShape;
    /** A draft pull request from a coding session's branch; throws `GitProxyError` when refused. */
    openSessionPullRequest(input: SessionPullRequestInput): Promise<SessionPullRequest>;
}

export class CodingGateway extends Context.Service<CodingGateway, CodingGatewayShape>()('socio/coding/CodingGateway') {}

// ── Gateway exchanges ────────────────────────────────────────────────────

/**
 * The exchange log's rows, as the model gateway writes them and coding
 * sessions page and soft-delete them, with the signatures
 * `GatewayExchangeRows` (`infra/rows.ts`) has today (synchronous, on the
 * shared connection; the caller's transaction, if any).
 */
export interface GatewayExchangesShape {
    /** Inserts one exchange row; the id and hashes are the caller's to assign. */
    insert(exchange: GatewayExchangeRecord): void;
    /** A session's live exchanges in request order, paged by `after` (exclusive). */
    page(sessionId: string, after: number, limit: number): GatewayExchangeRecord[];
    /** Soft-deletes a session's exchanges when the session ends (CB-64). */
    softDelete(sessionId: string, by: string, withKind: string, at: number): void;
}

export class GatewayExchanges extends Context.Service<GatewayExchanges, GatewayExchangesShape>()(
    'socio/coding/GatewayExchanges',
) {}

// ── Sessions ─────────────────────────────────────────────────────────────

/**
 * What other features call of the platform's coding sessions: the gateway
 * module's capability status, its leader tick and its stop. Everything else
 * (starting, prompting, the Computer panel's list, the routes) is coding's
 * own. `CodingSessions` (`sessions.ts`) implements it.
 */
export interface SessionsShape {
    /** Whether the supervisor and the egress secret are set. */
    readonly configured: boolean;
    /**
     * The leader's tick (every 15 s): runs taken over after a drain, limits,
     * the reaper, and ended prompts nobody reported.
     */
    tick(): Promise<void>;
    /** The platform stops: followers end; the execs run on. */
    shutdown(): void;
}

export class Sessions extends Context.Service<Sessions, SessionsShape>()('socio/coding/Sessions') {}

// ── Tools ────────────────────────────────────────────────────────────────

/**
 * The socio's coding tools (`coding_start`, `coding_prompt`,
 * `coding_status`, `coding_diff`, `coding_open_pr`, `coding_stop`) for one
 * turn; none when sandboxes aren't set up: `sessionTools` (`tools.ts`)
 * over the runtime's service.
 */
export interface ToolsShape {
    dotTools(turn: DotTurn): ToolDefinition[];
}

export class Tools extends Context.Service<Tools, ToolsShape>()('socio/coding/Tools') {}

// ── CodingConfig ─────────────────────────────────────────────────────────

/**
 * What coding reads of the platform's configuration. `sessions` is what
 * `codingConfigFromEnv(process.env, config)` builds today when the service
 * is constructed (it reads `config.computerSupervisorUrl` and `_Token`, and
 * throws on a malformed `CODING_WORKSPACE_RETENTION_DAYS` or
 * `CODING_EGRESS_ALLOW`); the rest are `PlatformConfig`'s fields as they
 * are. The turn time limit comes from settings' `Limits` tag.
 */
export interface CodingConfigShape {
    readonly sessions: CodingSessionsConfig;
    /** `config.sessionSecret`: keys the workspace volumes' HMAC. */
    readonly sessionSecret?: string;
    /** `config.appOrigin`: the session's link in the pull requests it opens. */
    readonly appOrigin?: string;
    /** `config.notificationLimits`: the daily caps of a run's report notifications. */
    readonly notificationLimits?: NotificationDailyLimits;
}

export class CodingConfig extends Context.Service<CodingConfig, CodingConfigShape>()('socio/coding/CodingConfig') {}
