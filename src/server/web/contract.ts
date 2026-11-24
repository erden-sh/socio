/**
 * What other features may know of the web pages and of a socio's web reads:
 * their tags, the slices of the services other folders call, and plain
 * types. It imports only `effect`, `@socio/*` and other contracts, and
 * holds no logic.
 *
 * `WebIdentities` is the identity setting web's routes run through the
 * app's runtime; `layer.ts` implements the tags.
 *
 * `PageServices` and `WebOptions` are here; the types below moved from the
 * files that defined them, which re-export them, so every importer keeps
 * compiling until that importer switches to the contract:
 * - `WebSettings` (`web-reads.ts`).
 *
 * The read types (`WebReadRequest`, `WebResponse`, `WebRefusal`,
 * `WebReadResult`) moved to `@socio/foundation/web/reads`, so the folders
 * below web name them without importing web.
 *
 * `WebReaderShape.activity` exposes a socio's web lines to
 * `dots/dot-admin.ts` (`WebReads.store.activity` today), typed with
 * integrations' `WebActivity`.
 *
 * Moved into a package:
 * - `pageGuard`, `MANIFEST_PATH`, `isDataRequest`, `reopenPage` and
 *   `REOPENED_COOKIE`: `@socio/foundation/web/guard` (`docs/http.ts` guards
 *   its pages with it).
 * - research's `ResearchConfig` and `configured`:
 *   `@socio/foundation/web/research-config` (the state view reports it).
 *
 * Not here, on purpose:
 * - The `WebReads` class and `webReadsFor` (`composition/web.ts`):
 *   construction (one reader per database). Other folders get the
 *   `WebReader` tag below.
 * - `webSettingsFromEnv`: only the entry (`index.ts`, `composition/`) reads
 *   the env; the composition hands the result in as `WebConfig.web`.
 * - research's `Config` (`research.ts`): `ResearchConfig` under web's old
 *   name. The `Research` tag below binds the config, so callers don't name
 *   it.
 * - `webModule`, `webRoutes`, `mountWeb`, `serveAgentsPage`,
 *   `productionWeb`, `developmentWeb` and `webServices`: the modules
 *   registry's and the composition's.
 */
import type { DatabaseSync } from 'node:sqlite';

import { Context } from 'effect';

import type { AppContext } from '@socio/foundation/http/app-env';
import type { WebReadRequest, WebReadResult } from '@socio/foundation/web/reads';
import type { Memory, Result } from '@socio/shared/types';
import type { WebServices } from '@socio/shared/web/web';
import type { WebIdentity, WebStatus } from '@socio/shared/web/web-types';

import type { WebActivity } from '../integrations/contract.js';

// ── Pages ────────────────────────────────────────────────────────────────

/** The services for one page request, and what they set on its response (`web/services.ts` builds them). */
export interface PageServices {
    services: WebServices;
    /**
     * Headers for the response, such as a renewed session cookie. Read once
     * the renderer has answered: loaders and middleware run before that.
     */
    headers: [name: string, value: string][];
}

/**
 * The pages' options that don't depend on the build (`web/mount.ts` adds
 * `WebBuild`); `docs/http.ts` reads them too.
 */
export interface WebOptions {
    /** The app's origins (APP_ORIGIN), for the host check. */
    origin?: string | string[];
    /** What page loaders read, per request (services.ts). */
    services: (c: AppContext) => PageServices;
    /** A plugin embed page may frame this origin. Other paths leave CSP alone. */
    frameSrc?: (path: string) => string | undefined;
}

// ── Web reads (`web-reads.ts`) ───────────────────────────────────────────

/*
 * Web reads (release 4): the declared-agent side of a Dot's web
 * identity. Every request carries the same honest User-Agent and nothing
 * else about who asked: no cookies, no Authorization, no From, no
 * Referer, no tracking headers, and never the user's name, email or
 * account. A Dot can add only the headers in `ALLOWED_HEADERS`.
 *
 * Reads keep the browser service's network rules (public addresses only,
 * pinned DNS, standard ports) on every redirect hop, and add per-host and
 * global rate limits, a response cache, size and time caps, and a per-host
 * stop when a site refuses. The read types are in
 * `@socio/foundation/web/reads`.
 */
export interface WebSettings {
    /** `WEB_IDENTITY_DEFAULT`: for Dots without their own setting. */
    identityDefault: WebIdentity;
    /** Derived from `APP_ORIGIN`; see `agentUserAgent`. */
    userAgent: string;
    /** `<APP_ORIGIN>/agents`, when the origin is known. */
    agentsUrl?: string;
    /** `AGENTS_CONTACT`: a URL shown on /agents; never sent in requests. */
    contact?: string;
    /** `WEB_MAX_BYTES`: the most a read downloads (decoded). 2 MB. */
    maxBytes: number;
    /** `WEB_TIMEOUT_MS`: a whole read, redirects included. 15 s. */
    timeoutMs: number;
    /** `WEB_HOST_RATE_PER_MINUTE`: per Dot and host. 30. */
    perHostPerMinute: number;
    /** `WEB_GLOBAL_RATE_PER_MINUTE`: all Dots together. 300. */
    globalPerMinute: number;
    /** `WEB_COOLDOWN_SECONDS`: the stop after a refusal without Retry-After. 15 min. */
    cooldownMs: number;
    /** `WEB_CACHE_TTL_SECONDS`: freshness when a response sets none. 60 s. */
    cacheTtlMs: number;
}

// ── WebReader ────────────────────────────────────────────────────────────

/**
 * The workspace's web reader, as other folders call it (`notifications`,
 * `skills`, `capabilities`, `dots`): one per database, so rate limits, the
 * cache and host stops hold across turns, Dots and routes. `WebReads`
 * (`web-reads.ts`) implements it; `webReadsFor` (`composition/web.ts`)
 * builds it.
 */
export interface WebReaderShape {
    /** The Dot's web identity: its own, or the default. */
    identity(dotId: string): Promise<WebIdentity>;
    /** The Dot's identity, limits and stopped hosts; its audit lines when asked. */
    status(dotId: string, withAudit: boolean): Promise<WebStatus>;
    /** One read as the Dot's declared agent, or why it was refused. */
    read(request: WebReadRequest): Promise<WebReadResult>;
    /** The Dot's web-read audit lines at or before `before` (ms), newest first: its activity. */
    activity(dotId: string, before: number, limit: number): Promise<WebActivity[]>;
}

export class WebReader extends Context.Service<WebReader, WebReaderShape>()('socio/web/WebReader') {}

// ── WebIdentities ────────────────────────────────────────────────────────

/** A Dot's web identity as admins change it (`PATCH /api/dots/:id/web`, `web-routes.ts`). */
export interface WebIdentitiesShape {
    /** Sets (or, with null, clears) the Dot's identity, and audits who did. */
    setIdentity(dotId: string, identity: WebIdentity | null, userId: string): Promise<void>;
}

/**
 * The identity setting: only web's own routes change it today, through the
 * app's runtime. `layer.ts` implements it over the connection's reader.
 */
export class WebIdentities extends Context.Service<WebIdentities, WebIdentitiesShape>()('socio/web/WebIdentities') {}

// ── WebCapabilities (`web-tools.ts`) ─────────────────────────────────────

/** A Dot's web-read capability, as the `capabilities` tool's registry lists it. */
export interface WebCapability {
    id: 'web_reads';
    title: string;
    available: boolean;
    identity: WebIdentity;
    tools: string[];
    summary: string;
    limits: WebStatus['limits'];
    stoppedHosts: WebStatus['stoppedHosts'];
}

/**
 * The web-read capability of a Dot (`webCapabilityFor`): its identity,
 * tools, limits and the hosts that refused recently. `web-tools.ts`'s
 * `webCapabilities` builds it over a `WebReaderShape`.
 */
export interface WebCapabilitiesShape {
    capabilityFor(dotId: string): Promise<WebCapability>;
}

export class WebCapabilities extends Context.Service<WebCapabilities, WebCapabilitiesShape>()(
    'socio/web/WebCapabilities',
) {}

// ── Research (`research.ts`) ─────────────────────────────────────────────

/**
 * Research tasks (`research.ts`), with their config bound: what the task
 * runner (`turns/runner.ts`) runs and what the state view
 * (`live/views/state.ts`) reports. `research.ts`'s `researcher` builds it.
 */
export interface ResearchShape {
    /** `config.mode`: a fictional sample, or live sources and a model. */
    readonly mode: 'sample' | 'live';
    /** `configured(config)`: whether a live run has what it needs. */
    configured(): boolean;
    /** `research(prompt, memories, config, signal, progress)`. */
    research(
        prompt: string,
        memories: Memory[],
        signal: AbortSignal,
        progress: (text: string) => void,
    ): Promise<Result>;
}

export class Research extends Context.Service<Research, ResearchShape>()('socio/web/Research') {}

// ── WebConfig ────────────────────────────────────────────────────────────

/**
 * The connection's one web reader as web's own code reaches it (its layer
 * and its module's tools): the reads, and its store's identity setting.
 * `WebReads` (`web-reads.ts`) implements it.
 */
export interface WebConnectionReader extends WebReaderShape {
    readonly store: WebIdentitiesShape;
}

/**
 * What web reads of the platform's configuration: `config.web`, the web
 * reads' settings (`webSettingsFromEnv(process.env)` at the entry). Without
 * it, `webReadsFor` falls back to `webSettingsFromEnv({})`. And `readerOn`,
 * the connection's one reader, made by its first user with `web`: the
 * composition builds it (`composition/web.ts`, `webConfigOf`), with the
 * store over the Integrations repositories, so web needs none of that
 * context's files.
 *
 * `web/services.ts` reads more of `PlatformConfig` (`dotRequestLimits`,
 * `dictationMethods`, `autoTriage`, `traceContent`, `otlp`, `context`,
 * `appLogs`, `rooms`, `voiceCalls`, `limitDefaults(config)`), but only to
 * hand to other features' views; those features' config tags carry them.
 */
export interface WebConfigShape {
    readonly web?: WebSettings;
    /** The connection's one reader (`webReadsFor(db, web)`): rate limits, the cache and host stops hold across its users. */
    readonly readerOn: (db: DatabaseSync) => WebConnectionReader;
}

export class WebConfig extends Context.Service<WebConfig, WebConfigShape>()('socio/web/WebConfig') {}
