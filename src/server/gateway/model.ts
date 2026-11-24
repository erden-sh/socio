import type { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';
import type { ActorDenyReason } from '@socio/shared/actor-scopes';
import {
    CODING_MODEL_ID,
    normalRepository,
    personalModelId,
    type CodingLimits,
} from '@socio/shared/coding/coding-gateway';

import type { AudiencePolicy, CredentialRecord, GrantRecord } from '../actors/contract.js';
import type { ModelGatewayShape, UsableModel } from '../coding/contract.js';

import { gatewaySourcesOf, type GatewayHolder } from './adopted.js';
import {
    CHAT_API,
    GEMINI_API,
    MESSAGES_API,
    RESPONSES_API,
    type ErrorType,
    type ModelApi,
    type ModelApiId,
    type Sanitized,
} from './apis.js';
import { MAX_BODY_BYTES, requestedModel } from './chat-request.js';
import { tokensOfChars } from './chat-stream.js';
import { codeAccess } from './code-users.js';
import { codingSettingsRoutes } from './coding-routes.js';
import { CodingSettings } from './coding-settings.js';
import { ExchangeLogger } from './exchangeLogger.js';
import { geminiTarget } from './gemini-request.js';
import { codingLimitDefaults, SessionRate, UPSTREAM_TOTAL_MS } from './limits.js';
import { anthropicBetas } from './messages-request.js';
import { GatewayOptions, personalPlansDefault } from './options.js';
import type { GatewayRequestContext, GatewayRoute } from './server.js';
import type { GatewaySources } from './sources.js';
import { GatewayLedger, type LedgerParty, type ReservationRecord, type ReserveRefusal } from './usage.js';

export { openAiError } from './apis.js';

/**
 * The model gateway (CB-239), on the internal gateway listener
 * (server.ts): OpenAI Chat Completions and Responses, Anthropic Messages
 * (Claude Code, CB-326) and the Gemini API's `generateContent` (Gemini
 * CLI, CB-326), for a coding session's sandbox.
 *
 * A session's request is the stamp (checked by the listener) plus a
 * `cbgw_` for `gateway:model` with `model:invoke` naming the stamped
 * sandbox, then `authorizeActor` (`actors.check`); then the session's own
 * model only, which is an operator's listed model or, where the operator
 * allows it, the person's own plan for their own private session; then
 * the request rate (per runtime); then a reservation against the
 * in-flight caps and every budget at once (usage.ts).
 *
 * The body is rebuilt from known, checked fields (the `*-request.ts`
 * files), and goes upstream with only the backend's own key (or, on a
 * personal plan, the person's token, which stays in this process, never
 * in the sandbox), a JSON content type and a generic User-Agent: nothing
 * that names the person, and no client header. Prompts and completions
 * pass through and are never stored; only counts are.
 */

/** Time limits of one upstream request. */
export const UPSTREAM_LIMITS = {
    firstByteMs: 120_000,
    idleMs: 60_000,
    // The ledger settles a reservation past this (plus a margin) whatever
    // its runtime (usage.ts).
    totalMs: UPSTREAM_TOTAL_MS,
};
/** How often an open stream's credential is looked up again. */
const CREDENTIAL_RECHECK_MS = 5_000;
/** A non-streamed answer past this is refused rather than buffered. */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
/**
 * Output past the clamped limit by this much ends a stream: the
 * reservation holds the limit, and a backend that ignores it is cut off
 * with room for the estimate's error (4 characters a token).
 */
const hardCap = (maxCompletion: number) => Math.ceil(maxCompletion * 1.25) + 64;

const AUDIENCE = 'gateway:model' as const;
/** The Messages API version the gateway speaks to Anthropic backends. */
const ANTHROPIC_VERSION = '2023-06-01';
const PLAN_SIGNIN = 'Your plan’s sign-in ended: sign in again under Account → Inference, then send the prompt again.';

/** A `GET …/models` answer. */
const modelList = (entries: { id: string; created: number }[]) =>
    new Response(
        JSON.stringify({
            object: 'list',
            data: entries.map((entry) => ({
                id: entry.id,
                object: 'model',
                created: entry.created,
                owned_by: 'socio',
            })),
        }),
        {
            headers: {
                'content-type': 'application/json',
                'cache-control': 'no-store',
            },
        },
    );

/**
 * The coding session a grant is for: the coding session records the
 * session id, the repository and the card's model in the grant's
 * resources when it asks for it. A grant without a model or a repository
 * can't use the model gateway.
 */
export const codingGrantResources = z
    .object({
        session: z.string().min(1).max(100).optional(),
        repository: z.string().max(200).optional(),
        repositories: z.array(z.string().max(200)).max(1).optional(),
        model: z.string().max(64).optional(),
        /** The model's backend host at approval. */
        modelHost: z.string().max(253).nullable().optional(),
        /**
         * The person's own plan the session runs on: a BYO kind
         * id such as `byo-chatgpt`; `model` is then `personalModelId(plan)`.
         */
        plan: z
            .string()
            .regex(/^[a-z0-9-]{1,40}$/)
            .optional(),
    })
    .passthrough();

export interface CodingSessionRef {
    /** The coding session (the grant's id when none was recorded). */
    sessionId: string;
    /** `owner/name`, lowercase. */
    repository: string;
    /** The gateway model the card named. */
    model: string;
    /** Its backend's host when approved; unset for grants from before. */
    modelHost?: string | null;
    /** The person's own plan, when the session runs on it. */
    plan?: string;
}

/**
 * `usable`, and for an outside provider only at the host the session was
 * approved for: a backend re-pointed
 * elsewhere since would send the code somewhere the person never saw.
 */
async function usableFor(settings: CodingSettings, session: CodingSessionRef) {
    const usable = await settings.usable(session.model, session.repository);
    if (!usable || !usable.outsideProvider || session.modelHost === undefined) {
        return usable;
    }
    let host: string | null;
    try {
        host = new URL(usable.endpoint.baseUrl).hostname;
    } catch {
        host = null;
    }
    return host === session.modelHost ? usable : undefined;
}

export function codingSessionOf(grant: Pick<GrantRecord, 'id' | 'resources'>): CodingSessionRef | undefined {
    const parsed = codingGrantResources.safeParse(grant.resources ?? {});
    if (!parsed.success) {
        return undefined;
    }
    const { session, repository, repositories, model, modelHost, plan } = parsed.data;
    const repo = normalRepository(repository ?? repositories?.[0] ?? '');
    if (!repo || !model || !CODING_MODEL_ID.test(model)) {
        return undefined;
    }
    // A plan session's model is the plan's own name, and a listed model is
    // never a plan's (the `personal-` names are reserved).
    if (plan ? model !== personalModelId(plan) : model.startsWith('personal-')) {
        return undefined;
    }
    return {
        sessionId: session ?? grant.id,
        repository: repo,
        model,
        ...(modelHost !== undefined ? { modelHost } : {}),
        ...(plan ? { plan } : {}),
    };
}

const REFUSALS: Record<ReserveRefusal, { type: ErrorType; code: string; message: string }> = {
    session_busy: {
        type: 'rate_limit_error',
        code: 'too_many_in_flight',
        message: 'This session already has as many requests in flight as it may.',
    },
    person_busy: {
        type: 'rate_limit_error',
        code: 'too_many_in_flight',
        message: 'This person’s sessions already have as many requests in flight as they may.',
    },
    instance_busy: {
        type: 'rate_limit_error',
        code: 'gateway_busy',
        message: 'The gateway is busy; try again shortly.',
    },
    session_budget: {
        type: 'insufficient_quota',
        code: 'session_budget_exhausted',
        message: 'This coding session has used its token budget.',
    },
    person_budget: {
        type: 'insufficient_quota',
        code: 'person_budget_exhausted',
        message: 'The 24-hour token budget for this person is used up.',
    },
    socio_budget: {
        type: 'insufficient_quota',
        code: 'socio_budget_exhausted',
        message: 'The 24-hour token budget for this socio is used up.',
    },
};

/** Reads a request body up to `limit` bytes; undefined past it. */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
    if (!body) {
        return new Uint8Array();
    }
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => undefined);
            return undefined;
        }
        parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
    }
    return out;
}

interface Authenticated {
    token: string;
    grant: GrantRecord;
    credential: CredentialRecord;
    session: CodingSessionRef;
}

/** One request held open: what aborts it, and why. */
interface OpenRequest {
    sessionId: string;
    abort(reason: string): void;
}

/**
 * Who is calling, once their credential is checked: a coding session's
 * prompt run (its grant), with its party, limits, models and what keeps
 * the request allowed.
 */
interface Caller {
    kind: 'session';
    /** For the ledger: the session. */
    party: LedgerParty;
    limits: CodingLimits;
    /** The model a request may use by this name, for this API; or why not. */
    resolve(name: string | undefined, api: ModelApi): Promise<Upstream | Response>;
    /** Registers what ends the request on revocation; returns its removal. */
    track(abort: () => void): () => void;
    /** The credential still resolves (cheap; every 5 s). */
    credentialLive(): boolean | Promise<boolean>;
    /** The model is still allowed for the caller (every 5 s). */
    stillAllowed(upstream: Upstream): Promise<boolean>;
}

/** Where a request goes: an operator's backend, or a person's own plan. */
interface Upstream {
    /** The gateway model name. */
    modelId: string;
    /** The backend id, or the plan's kind. */
    backendId: string;
    acceptsImages: boolean;
    maxOutputTokens: number;
    /** A person's own plan/key (per-user providers): a byo upstream. */
    personalPlan: boolean;
    /**
     * The wire API a byo upstream speaks (per-user providers step 3):
     * `'responses'` for a ChatGPT plan, `'messages'` for a Claude API key.
     * The gateway refuses a request whose API doesn't match. Undefined for a
     * shared backend (no restriction).
     */
    byoApi?: ModelApiId;
    send(
        api: ModelApi,
        body: Record<string, unknown>,
        options: { stream: boolean; betas?: string; signal: AbortSignal },
    ): Promise<Response>;
}

export interface ModelGatewayOptions {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    now?: () => number;
}

/** The model gateway of one platform; built once (`modelGatewayOf`). */
export class ModelGateway implements ModelGatewayShape {
    readonly settings: CodingSettings;
    readonly ledger: GatewayLedger;
    /** Settings → Coding's switches: personal plans. */
    readonly options: GatewayOptions;
    private rate: SessionRate;
    private open = new Set<OpenRequest>();
    private sweep?: ReturnType<typeof setInterval>;
    private fetchImpl: typeof fetch;
    private now: () => number;
    /** CB-326 step 6: the coding session gateway exchange log (null store — the
     * SeaweedFS-backed body store is a deploy pipeline handoff; the row records
     * metadata + hashes until it lands). */
    private exchange: ExchangeLogger | null;
    constructor(
        private sources: GatewaySources,
        options: ModelGatewayOptions = {},
    ) {
        const db = sources.workspace.db;
        const env = options.env ?? process.env;
        this.now = options.now ?? Date.now;
        this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
        this.settings = new CodingSettings(db, {
            inference: sources.inference,
            audit: sources.actors.audit,
            defaults: codingLimitDefaults(env),
            now: this.now,
        });
        this.ledger = new GatewayLedger(db, {
            ownership: sources.runtime.attach(db),
            now: this.now,
        });
        // A malformed CODING_PERSONAL_PLANS stops the start, as limits do.
        const personalPlans = personalPlansDefault(env);
        this.options = new GatewayOptions(db, {
            audit: sources.actors.audit,
            defaults: () => ({ personalPlans }),
            now: this.now,
        });
        this.rate = new SessionRate(this.now);
        // CB-326 step 6: the exchange log records coding sessions' gateway
        // requests/responses. The body store is null here — the
        // SeaweedFS-backed store (Brotli + sealed under gateway-log) is the
        // deploy pipeline handoff; until it lands, rows carry metadata + hashes.
        this.exchange = new ExchangeLogger(sources.exchanges, null);
    }

    /**
     * Whether a person's own plan may serve their session now (per-user
     * providers): the operator turned personal plans on, and they are still
     * connected to the plan's kind. The "private chat only" limit is lifted
     * (a room may run on the person's plan too); the operator's
     * `personalPlans` toggle still gates all byo coding.
     */
    private async planAvailable(grant: Pick<GrantRecord, 'personId'>, plan: string) {
        if (!this.options.personalPlans()) {
            return false;
        }
        const found = await this.sources.inference.personalCodingPlanFor(grant.personId, plan);
        return found?.kind === plan;
    }

    /** The session's model is usable now: its plan, or the listed model. */
    private async sessionAvailable(grant: GrantRecord, session: CodingSessionRef) {
        if (session.plan) {
            return this.planAvailable(grant, session.plan);
        }
        return !!(await usableFor(this.settings, session));
    }

    /**
     * The `gateway:model` audience (CB-232): delegable whenever the
     * flags allow (no app version to follow, so the policy version is '');
     * the person must be on the code-access list (CB-124); a `model`
     * resource must be the session's own model, usable for its repository
     * (or, on a personal plan, still available to the person).
     */
    policy(): AudiencePolicy {
        return {
            policyVersion: () => '',
            personMay: (personId) => codeAccess(this.sources, personId),
            resourceAllowed: async ({ grant, resource }) => {
                if (resource.kind !== 'model') {
                    return false;
                }
                const session = codingSessionOf(grant);
                return !!session && session.model === resource.id && (await this.sessionAvailable(grant, session));
            },
        };
    }

    routes(): GatewayRoute[] {
        const session = (api: ModelApi) => (request: Request, context: GatewayRequestContext) =>
            this.serveSession(api, request, context);
        return [
            {
                method: 'GET',
                match: (path) => path === '/v1/models',
                handle: (request, context) => this.models(request, context),
            },
            {
                method: 'POST',
                match: (path) => path === '/v1/chat/completions',
                handle: session(CHAT_API),
            },
            {
                method: 'POST',
                match: (path) => path === '/v1/responses',
                handle: session(RESPONSES_API),
            },
            // Claude Code's (CB-326): `ANTHROPIC_BASE_URL` at the
            // gateway, the session's token as a bearer.
            {
                method: 'POST',
                match: (path) => path === '/v1/messages',
                handle: session(MESSAGES_API),
            },
            // Gemini CLI's (CB-326): `GOOGLE_GEMINI_BASE_URL` at the
            // gateway, the session's token as its `x-goog-api-key`; the model
            // and whether to stream are in the path.
            {
                method: 'POST',
                match: (path) => geminiTarget(path) !== undefined,
                handle: (request, context) =>
                    this.serveSession(GEMINI_API, request, context, geminiTarget(new URL(request.url).pathname)),
            },
        ];
    }

    /** A deny the listener's check didn't record (the model binding). */
    private deny(auth: Authenticated, context: GatewayRequestContext, reason: ActorDenyReason, resourceId?: string) {
        this.sources.actors.audit.decision(
            {
                correlationId: context.correlationId,
                phase: 'decision',
                decision: 'deny',
                reason,
                personId: auth.grant.personId,
                socioId: auth.grant.socioId,
                grantId: auth.grant.id,
                audience: AUDIENCE,
                action: 'model:invoke',
                ...(resourceId ? { resourceKind: 'model', resourceId: resourceId.slice(0, 64) } : {}),
            },
            `${auth.credential.hash}|deny`,
        );
    }

    /** The stamp's sandbox, a `cbgw_` for it, `authorizeActor`, the session. */
    private async authenticate(
        request: Request,
        context: GatewayRequestContext,
        api: ModelApi = CHAT_API,
    ): Promise<Authenticated | Response> {
        const token =
            /^Bearer (cbgw_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1] ??
            // The Gemini API takes its key in its own header (CB-326).
            (api.keyHeader
                ? /^(cbgw_[A-Za-z0-9_-]{43})$/.exec(request.headers.get(api.keyHeader) ?? '')?.[1]
                : undefined);
        const result = await this.sources.actors.check(
            token,
            {
                kind: 'cbgw',
                audience: AUDIENCE,
                scope: 'model:invoke',
                correlationId: context.correlationId,
            },
            (credential) => credential.contextId === context.sandboxId,
        );
        if (!result.ok) {
            return result.status === 401
                ? api.error(
                      401,
                      'authentication_error',
                      'invalid_api_key',
                      'The gateway credential isn’t valid here. Start a new prompt through Socio.',
                  )
                : api.error(403, 'permission_error', 'access_denied', 'This access was revoked or isn’t allowed.');
        }
        const session = codingSessionOf(result.grant);
        const auth = {
            token: token!,
            grant: result.grant,
            credential: result.credential,
            session: session!,
        };
        if (!session) {
            this.deny(auth, context, 'resource_denied');
            return api.error(403, 'permission_error', 'access_denied', 'This access was revoked or isn’t allowed.');
        }
        return auth;
    }

    /** A shared backend's model as an upstream. */
    private backendUpstream(usable: UsableModel): Upstream {
        return {
            modelId: usable.model.id,
            backendId: usable.model.backendId,
            acceptsImages: usable.model.acceptsImages,
            maxOutputTokens: Math.min(usable.model.maxOutputTokens, usable.endpoint.maxCompletionTokens ?? Infinity),
            personalPlan: false,
            send: (api, body, { stream, betas, signal }) =>
                this.fetchImpl(
                    `${usable.endpoint.baseUrl.replace(/\/+$/, '')}${api.upstreamPath(usable.endpoint.model, stream)}`,
                    {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            accept: stream ? 'text/event-stream' : 'application/json',
                            'user-agent': `socio-gateway/${this.sources.releases.data().version}`,
                            // Anthropic's Messages API takes its key as `x-api-key`,
                            // with the version it speaks; the Gemini API as
                            // `x-goog-api-key`; the others a bearer token.
                            ...(api.id === 'messages'
                                ? {
                                      'anthropic-version': ANTHROPIC_VERSION,
                                      ...(betas ? { 'anthropic-beta': betas } : {}),
                                      ...(usable.endpoint.apiKey ? { 'x-api-key': usable.endpoint.apiKey } : {}),
                                  }
                                : api.id === 'gemini'
                                  ? usable.endpoint.apiKey
                                      ? { 'x-goog-api-key': usable.endpoint.apiKey }
                                      : {}
                                  : usable.endpoint.apiKey
                                    ? { authorization: `Bearer ${usable.endpoint.apiKey}` }
                                    : {}),
                        },
                        body: JSON.stringify(api.modelInBody ? { ...body, model: usable.endpoint.model } : body),
                        signal,
                        redirect: 'error',
                    },
                ),
        };
    }

    /** The session's own plan as an upstream, for one request. */
    private async planUpstream(
        grant: GrantRecord,
        session: CodingSessionRef & { plan: string },
    ): Promise<Upstream | undefined> {
        if (!(await this.planAvailable(grant, session.plan))) {
            return undefined;
        }
        const transport = await this.sources.inference.personalCodingTransport(grant.personId, session.plan);
        if (!transport) {
            return undefined;
        }
        return {
            modelId: session.model,
            backendId: session.plan,
            acceptsImages: transport.acceptsImages,
            maxOutputTokens: transport.maxOutputTokens,
            personalPlan: true,
            byoApi: transport.api ?? 'responses',
            // The Codex backend takes no completion cap: the gateway's hard cap
            // on the stream bounds the answer instead.
            send: (_api, body, { signal }) => {
                const rest = { ...body };
                delete rest.max_output_tokens;
                return transport.send(JSON.stringify({ ...rest, model: transport.model }), signal);
            },
        };
    }

    /** `GET /v1/models`: only the model the session's card named. */
    private async models(request: Request, context: GatewayRequestContext) {
        const auth = await this.authenticate(request, context);
        if (auth instanceof Response) {
            return auth;
        }
        const { session, grant } = auth;
        let entry: { id: string; created: number } | undefined;
        if (session.plan) {
            if (await this.planAvailable(grant, session.plan)) {
                entry = {
                    id: session.model,
                    created: Math.floor(grant.createdAt / 1000),
                };
            }
        } else {
            const usable = await usableFor(this.settings, session);
            if (usable) {
                entry = {
                    id: usable.model.id,
                    created: Math.floor(usable.model.createdAt / 1000),
                };
            }
        }
        return modelList(entry ? [entry] : []);
    }

    /**
     * A coding session's request on one API. `target`: the
     * model and streaming the path named (the Gemini API), where the body
     * doesn't.
     */
    private async serveSession(
        api: ModelApi,
        request: Request,
        context: GatewayRequestContext,
        target?: { model: string; stream: boolean },
    ): Promise<Response> {
        const auth = await this.authenticate(request, context, api);
        if (auth instanceof Response) {
            await request.body?.cancel().catch(() => undefined);
            return auth;
        }
        const { session, grant } = auth;
        const caller: Caller = {
            kind: 'session',
            party: {
                sessionId: session.sessionId,
                personId: grant.personId,
                socioId: grant.socioId,
                grantId: grant.id,
            },
            limits: this.settings.limits(),
            resolve: async (name) => {
                const upstream =
                    name !== session.model
                        ? undefined
                        : session.plan
                          ? await this.planUpstream(grant, {
                                ...session,
                                plan: session.plan,
                            })
                          : await usableFor(this.settings, session).then(
                                (usable) => usable && this.backendUpstream(usable),
                            );
                if (!upstream) {
                    this.deny(auth, context, 'resource_denied', name);
                    return api.error(
                        404,
                        'invalid_request_error',
                        'model_not_found',
                        'That model isn’t available to this session.',
                        'model',
                    );
                }
                // A byo upstream speaks one wire API (per-user providers step 3):
                // a ChatGPT plan speaks Responses; a Claude API key speaks
                // Messages. The gateway refuses a request whose API doesn't
                // match, so a session's agent (the harness) can't send the
                // wrong shape.
                if (upstream.byoApi && api.id !== upstream.byoApi) {
                    return api.error(
                        400,
                        'invalid_request_error',
                        'unsupported_endpoint',
                        `This session runs on your own ${upstream.byoApi === 'messages' ? 'Claude API key' : 'plan'}, which takes the ${upstream.byoApi === 'messages' ? 'Messages' : 'Responses'} API only.`,
                    );
                }
                return upstream;
            },
            // Revocation anywhere (CB-232): closed by a
            // local revocation, another runtime's signal, or the 5-s re-check.
            track: (abort) => this.sources.actors.revocations.track(grant.id, { close: abort }),
            // The prompt's credential ending (its run returned) ends its
            // streams; so does the model's own terms changing: an admin
            // disabling the model, removing the outside provider's allowance
            // for the repository, or turning personal plans off, or the person
            // disconnecting their plan.
            credentialLive: () =>
                this.sources.actors.credentials.resolve(auth.token, {
                    kind: 'cbgw',
                    audience: AUDIENCE,
                }).ok,
            stillAllowed: () => this.sessionAvailable(grant, session),
        };
        return this.serve(api, request, context, caller, target);
    }

    /**
     * One request through the pipeline: the rate (per
     * runtime), the body, the caller's model, the checked body, a
     * reservation against every cap and budget at once, then upstream.
     */
    private async serve(
        api: ModelApi,
        request: Request,
        context: GatewayRequestContext,
        caller: Caller,
        target?: { model: string; stream: boolean },
    ): Promise<Response> {
        const { party, limits } = caller;
        if (!this.rate.take(party.sessionId, limits.requestsPerMinute)) {
            await request.body?.cancel().catch(() => undefined);
            return api.error(
                429,
                'rate_limit_error',
                'rate_limit_exceeded',
                `At most ${limits.requestsPerMinute} requests a minute per session.`,
            );
        }
        if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
            await request.body?.cancel().catch(() => undefined);
            return api.error(
                415,
                'invalid_request_error',
                'unsupported_media_type',
                'Send the request as application/json.',
            );
        }
        const bytes = await readLimited(request.body, MAX_BODY_BYTES);
        if (!bytes) {
            return api.error(413, 'invalid_request_error', 'request_too_large', 'The request is larger than 8 MB.');
        }
        let json: unknown;
        try {
            json = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return api.error(400, 'invalid_request_error', 'invalid_json', 'The body isn’t valid JSON.');
        }
        const upstream = await caller.resolve(target ? target.model : requestedModel(json), api);
        if (upstream instanceof Response) {
            return upstream;
        }
        const clean = api.sanitize(json, {
            acceptsImages: upstream.acceptsImages,
            personalPlan: upstream.personalPlan,
            ...(target ? { stream: target.stream } : {}),
        });
        if (!clean.ok) {
            return api.error(400, 'invalid_request_error', clean.code, clean.message, clean.param ?? null);
        }
        this.ledger.noteDropped(party.sessionId, clean.dropped);
        const reserved = await this.ledger.reserve({
            ...party,
            modelId: upstream.modelId,
            backendId: upstream.backendId,
            promptTokens: clean.promptTokens,
            requestedCompletion: clean.requestedCompletion,
            maxOutputTokens: upstream.maxOutputTokens,
            limits,
        });
        if (!reserved.ok) {
            const refusal = REFUSALS[reserved.refusal];
            return api.error(429, refusal.type, refusal.code, refusal.message);
        }
        return this.forward(api, request, caller, upstream, clean, reserved, context, {
            betas: api.id === 'messages' ? anthropicBetas(request.headers.get('anthropic-beta')) : undefined,
        });
    }

    /** Sends the request upstream and the answer back, metering both. */
    private async forward(
        api: ModelApi,
        request: Request,
        caller: Caller,
        target: Upstream,
        clean: Extract<Sanitized, { ok: true }>,
        reserved: { reservation: ReservationRecord; maxCompletionTokens: number },
        context: GatewayRequestContext,
        extra: { betas?: string },
    ): Promise<Response> {
        const { reservation, maxCompletionTokens } = reserved;
        const started = this.now();
        const controller = new AbortController();
        let reason: string | undefined;
        // CB-326 step 6: capture the response body for the exchange log. The
        // request body is the sanitized body sent upstream; the response is
        // reassembled here (non-stream: the full bytes; stream: a tee of the
        // chunks). Bounded to MAX_ANSWER_BYTES so a runaway stream can't grow
        // the buffer past what the gateway already allows.
        const responseChunks: Uint8Array[] = [];
        let responseBytes = 0;
        const capture = (chunk: Uint8Array) => {
            if (responseBytes < MAX_ANSWER_BYTES) {
                responseChunks.push(chunk);
                responseBytes += chunk.byteLength;
            }
        };
        const capturedBody = (): Uint8Array | null => {
            if (responseChunks.length === 0) {
                return null;
            }
            return Buffer.concat(responseChunks);
        };
        const logExchange = (status: string, usageId: number | null) => {
            // The harness column stores the upstream's backend id (the backend
            // or the plan kind), the identifier the gateway knows; the session
            // row's harness joins on sessionId when the log is viewed.
            if (!this.exchange) {
                return;
            }
            void this.exchange
                .log({
                    session: {
                        sessionId: caller.party.sessionId,
                        holderId: caller.party.personId,
                        requesterId: caller.party.socioId,
                        harness: target.backendId,
                    },
                    api: api.id,
                    route: new URL(request.url).pathname,
                    model: target.modelId,
                    upstreamKind: target.personalPlan ? 'plan' : 'gateway',
                    requestAt: started,
                    responseAt: this.now(),
                    status,
                    usageId,
                    requestBody: new TextEncoder().encode(JSON.stringify(clean.body)),
                    responseBody: capturedBody(),
                })
                .catch(() => undefined);
        };
        const timers = new Set<ReturnType<typeof setTimeout>>();
        const later = (ms: number, fn: () => void) => {
            const timer = setTimeout(fn, ms);
            timer.unref?.();
            timers.add(timer);
            return timer;
        };
        const handle: OpenRequest = {
            sessionId: caller.party.sessionId,
            abort: (why) => {
                reason ??= why;
                controller.abort();
            },
        };
        this.open.add(handle);
        const onClient = () => handle.abort('client_closed');
        context.signal.addEventListener('abort', onClient);
        if (context.signal.aborted) {
            onClient();
        }
        const untrack = caller.track(() => handle.abort('revoked'));
        // Every 5 s on every runtime: the credential, then
        // the model's own terms, each failing closed.
        let rechecking = false;
        const recheck = setInterval(() => {
            if (rechecking) {
                return;
            }
            rechecking = true;
            void (async () => {
                if (!(await caller.credentialLive())) {
                    return handle.abort('revoked');
                }
                if (!(await caller.stillAllowed(target))) {
                    handle.abort('revoked');
                }
            })()
                .catch(() => handle.abort('revoked'))
                .finally(() => (rechecking = false));
        }, CREDENTIAL_RECHECK_MS);
        recheck.unref?.();
        later(UPSTREAM_LIMITS.totalMs, () => handle.abort('timeout'));
        let firstByte: ReturnType<typeof setTimeout> | undefined = later(UPSTREAM_LIMITS.firstByteMs, () =>
            handle.abort('timeout'),
        );
        let idle: ReturnType<typeof setTimeout> | undefined;
        const touch = () => {
            if (firstByte) {
                clearTimeout(firstByte);
                timers.delete(firstByte);
                firstByte = undefined;
            }
            if (idle) {
                clearTimeout(idle);
                timers.delete(idle);
            }
            idle = later(UPSTREAM_LIMITS.idleMs, () => handle.abort('timeout'));
        };
        let finished = false;
        const finish = async (outcome: {
            promptTokens: number;
            completionTokens: number;
            cachedTokens?: number;
            estimated: boolean;
            status: string;
        }) => {
            if (finished) {
                return;
            }
            finished = true;
            for (const timer of timers) {
                clearTimeout(timer);
            }
            clearInterval(recheck);
            untrack();
            context.signal.removeEventListener('abort', onClient);
            this.open.delete(handle);
            // A settle that fails here (a busy database) leaves the reservation
            // to the ledger's sweep, which settles it at its estimate once it
            // is past the upstream limit.
            await this.ledger
                .settle(reservation, {
                    ...outcome,
                    latencyMs: this.now() - started,
                })
                .catch(() => console.error('Coding gateway: settling a request failed.'));
            // CB-326 step 6: record the exchange now the response is reassembled
            // and the request settled. The usageId join is null (the ledger
            // doesn't return the gateway_usage row id); the row joins on
            // session + request time when the log is viewed.
            logExchange(outcome.status, null);
        };
        // What a broken request costs: its whole reservation.
        const atEstimate = (status: string) =>
            finish({
                promptTokens: reservation.promptTokens,
                completionTokens: reservation.completionTokens,
                estimated: true,
                status,
            });

        let upstream: Response;
        try {
            upstream = await target.send(api, api.withLimit(clean.body, maxCompletionTokens), {
                stream: clean.stream,
                betas: extra.betas,
                signal: controller.signal,
            });
        } catch (error) {
            const why =
                reason ??
                (error instanceof ChatGptError &&
                (error.code === 'chatgpt_needs_relogin' || error.code === 'chatgpt_not_connected')
                    ? 'plan_signin'
                    : 'upstream_unreachable');
            await finish({
                promptTokens: 0,
                completionTokens: 0,
                estimated: true,
                status: why,
            });
            return why === 'timeout'
                ? api.error(504, 'api_error', 'upstream_timeout', 'The model’s server didn’t answer in time.')
                : why === 'revoked'
                  ? api.error(403, 'permission_error', 'access_denied', 'This access was revoked or isn’t allowed.')
                  : why === 'plan_signin'
                    ? api.error(403, 'permission_error', 'plan_signin_needed', PLAN_SIGNIN)
                    : api.error(502, 'api_error', 'upstream_unreachable', 'The model’s server couldn’t be reached.');
        }
        if (!upstream.ok) {
            await upstream.body?.cancel().catch(() => undefined);
            // Nothing was generated; the server's own text never passes (it
            // may echo the request or name the key's account).
            await finish({
                promptTokens: 0,
                completionTokens: 0,
                estimated: true,
                status: `upstream_${upstream.status}`,
            });
            if (target.personalPlan && upstream.status === 401) {
                return api.error(403, 'permission_error', 'plan_signin_needed', PLAN_SIGNIN);
            }
            return upstream.status === 429
                ? api.error(
                      429,
                      'rate_limit_error',
                      'upstream_busy',
                      target.personalPlan
                          ? 'Your plan’s usage limit or rate limit was reached; try again later.'
                          : 'The model’s server is busy; try again shortly.',
                  )
                : upstream.status === 400 || upstream.status === 413
                  ? api.error(
                        400,
                        'invalid_request_error',
                        'upstream_rejected',
                        `The model’s server refused the request (HTTP ${upstream.status}).`,
                    )
                  : api.error(
                        502,
                        'api_error',
                        'upstream_error',
                        `The model’s server failed (HTTP ${upstream.status}).`,
                    );
        }

        if (!clean.stream) {
            try {
                touch();
                const bytes = await readLimited(upstream.body, MAX_ANSWER_BYTES);
                if (!bytes) {
                    await atEstimate('answer_too_large');
                    return api.error(502, 'api_error', 'upstream_error', 'The model’s answer was too large.');
                }
                capture(bytes);
                const text = new TextDecoder().decode(bytes);
                let parsed: unknown;
                try {
                    parsed = JSON.parse(text);
                } catch {
                    await atEstimate('upstream_invalid');
                    return api.error(
                        502,
                        'api_error',
                        'upstream_error',
                        'The model’s server sent an answer that isn’t JSON.',
                    );
                }
                const usage = api.usageOf(parsed);
                await finish(
                    usage
                        ? { ...usage, estimated: false, status: 'ok' }
                        : {
                              promptTokens: reservation.promptTokens,
                              completionTokens: tokensOfChars(api.answerChars(parsed)),
                              estimated: true,
                              status: 'ok',
                          },
                );
                return new Response(text, {
                    headers: {
                        'content-type': 'application/json',
                        'cache-control': 'no-store',
                    },
                });
            } catch {
                await atEstimate(reason ?? 'upstream_broken');
                return reason === 'client_closed'
                    ? new Response(null, { status: 499 })
                    : api.error(
                          reason === 'timeout' ? 504 : 502,
                          'api_error',
                          reason === 'timeout' ? 'upstream_timeout' : 'upstream_error',
                          'The model’s answer broke off.',
                      );
            }
        }

        // A stream: chunks pass as they come, metered on the way.
        const reader = upstream.body!.getReader();
        const meter = api.meter();
        const decoder = new TextDecoder();
        const cap = hardCap(maxCompletionTokens);
        const encoder = new TextEncoder();
        const settleStream = (status: string) =>
            meter.usage
                ? finish({ ...meter.usage, estimated: false, status })
                : status === 'ok' || status === 'output_cap'
                  ? finish({
                        promptTokens: reservation.promptTokens,
                        completionTokens: meter.outputTokens,
                        estimated: true,
                        status,
                    })
                  : atEstimate(status);
        const stream = new ReadableStream<Uint8Array>({
            pull: async (out) => {
                let next: ReadableStreamReadResult<Uint8Array>;
                try {
                    next = await reader.read();
                } catch {
                    const why = reason ?? 'upstream_broken';
                    await settleStream(why);
                    if (why !== 'client_closed') {
                        out.enqueue(
                            encoder.encode(
                                why === 'revoked'
                                    ? api.streamError('permission_error', 'access_denied', 'This access was revoked.')
                                    : why === 'timeout'
                                      ? api.streamError(
                                            'api_error',
                                            'upstream_timeout',
                                            'The model’s server stopped answering.',
                                        )
                                      : api.streamError('api_error', 'upstream_error', 'The model’s answer broke off.'),
                            ),
                        );
                    }
                    out.close();
                    return;
                }
                if (next.done) {
                    await settleStream('ok');
                    out.close();
                    return;
                }
                touch();
                meter.push(decoder.decode(next.value, { stream: true }));
                if (meter.outputTokens > cap) {
                    reason ??= 'output_cap';
                    controller.abort();
                    await reader.cancel().catch(() => undefined);
                    await settleStream('output_cap');
                    out.enqueue(
                        encoder.encode(
                            api.streamError(
                                'invalid_request_error',
                                'output_limit_exceeded',
                                'The answer went past its token limit and was cut off.',
                            ),
                        ),
                    );
                    out.close();
                    return;
                }
                out.enqueue(next.value);
                capture(next.value);
            },
            cancel: async () => {
                handle.abort('client_closed');
                await reader.cancel().catch(() => undefined);
                await settleStream('client_closed');
            },
        });
        return new Response(stream, {
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-store',
                'x-accel-buffering': 'no',
            },
        });
    }

    /** Ends a session's requests on this runtime (the session ended). */
    abortSession(sessionId: string, reason = 'revoked') {
        let n = 0;
        for (const request of [...this.open]) {
            if (request.sessionId === sessionId) {
                request.abort(reason);
                n++;
            }
        }
        return n;
    }

    /** Requests open on this runtime (tests, diagnostics). */
    get openRequests() {
        return this.open.size;
    }

    /**
     * Settles dead runtimes' reservations every minute, on every runtime
     * with a listener; harmless twice.
     */
    startSweep(everyMs = 60_000) {
        if (this.sweep) {
            return;
        }
        this.sweep = setInterval(() => {
            void this.ledger
                .settleOrphans()
                .catch(() => console.error('Coding gateway: settling orphaned requests failed.'));
        }, everyMs);
        this.sweep.unref?.();
    }

    /** The listener closes: open requests end, settled at their estimate. */
    stop() {
        clearInterval(this.sweep);
        this.sweep = undefined;
        for (const request of [...this.open]) {
            request.abort('shutdown');
        }
    }
}

const gateways = new WeakMap<GatewaySources, ModelGateway>();

/** The model gateway on these sources, built on first use (every runtime). */
export function modelGatewayOf(sources: GatewaySources, options?: ModelGatewayOptions): ModelGateway {
    let gateway = gateways.get(sources);
    if (!gateway) {
        gateway = new ModelGateway(sources, options);
        gateways.set(sources, gateway);
    }
    return gateway;
}

/** The model gateway of `holder`'s runtime (`adopted.ts`), for tests. */
export function modelGateway(holder: GatewayHolder): ModelGateway {
    return modelGatewayOf(gatewaySourcesOf(holder));
}

/** The listener routes: `GET /v1/models` and each API's `POST` (`routes()`). */
export function modelRoutes(sources: GatewaySources): GatewayRoute[] {
    return modelGatewayOf(sources).routes();
}

/** The model gateway's admin routes (models, limits, usage), mounted under `/api/gateway`. */
export function modelSettingsRoutes(sources: GatewaySources): Hono<AppEnv> | undefined {
    return codingSettingsRoutes(sources, modelGatewayOf(sources));
}

/**
 * Registers the `gateway:model` audience policy with `actors.audiences`
 * (every runtime, at platform start).
 */
export function registerModelAudience(sources: GatewaySources): void {
    sources.actors.audiences.register(AUDIENCE, modelGatewayOf(sources).policy());
}
