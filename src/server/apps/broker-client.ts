import { readFileSync } from 'node:fs';

import { contextKey } from '@socio/foundation/actors/keys';
import type { Audience } from '@socio/shared/actor-scopes';

import { sealForWorker, type BrowserCommand } from '../../app-browser/protocol.js';
import {
    ActorAccessError,
    BROWSER_CONTEXT_LIMITS,
    type ActorsShape,
    type ContextLimits,
    type ContextRecord,
    type GrantRecord,
} from '../actors/contract.js';

/**
 * Socio's side of the app browser (CB-232): the HTTP client of the
 * `app-browser` service's router, and the broker that opens a context per
 * grant, hands its worker the credential and keeps the service and the
 * `actor_contexts` rows in step.
 *
 * The credential and the context key go to the worker sealed to that
 * worker's own key, so the router that relays them can't read them.
 * Nothing a later request needs is kept here: contexts are rows and leases
 * (the actors module's), the service is asked what it holds, and this
 * process keeps only a cache of when it last asked.
 */

export class AppBrowserError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

/** A context as the router reports it. */
export interface BrokerContext {
    id: string;
    grantId: string;
    workerKey: string;
    openedAt: number;
    lastUsedAt: number;
}

/** The `app-browser` router's API (src/app-browser/router.ts). */
export interface AppBrowserClient {
    list(): Promise<{ bootId: string; contexts: BrokerContext[] }>;
    open(input: {
        contextId: string;
        grantId: string;
        origin: string;
        bootId?: string;
    }): Promise<{ bootId: string; workerKey: string }>;
    deliver(contextId: string, sealed: string): Promise<void>;
    command(contextId: string, command: BrowserCommand): Promise<Record<string, unknown>>;
    close(contextId: string): Promise<void>;
    closeGrant(grantId: string): Promise<void>;
}

export class HttpAppBrowserClient implements AppBrowserClient {
    constructor(
        private options: {
            url: string;
            /** `APP_BROWSER_SECRET`: never the socio browser's `BROWSER_SECRET`. */
            secret: string;
            timeoutMs?: number;
            fetch?: typeof fetch;
        },
    ) {}

    private async call(method: string, path: string, body?: unknown) {
        const send = this.options.fetch ?? fetch;
        let response: Response;
        try {
            response = await send(new URL(path, this.options.url), {
                method,
                headers: {
                    authorization: `Bearer ${this.options.secret}`,
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                redirect: 'error',
                signal: AbortSignal.timeout(this.options.timeoutMs ?? 50_000),
            });
        } catch {
            throw new AppBrowserError('The app browser is not reachable.', 503);
        }
        const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
            throw new AppBrowserError(
                typeof json.error === 'string' ? json.error.slice(0, 300) : 'The app browser failed.',
                response.status,
            );
        }
        return json;
    }

    async list() {
        const json = await this.call('GET', '/contexts');
        return {
            bootId: String(json.bootId ?? ''),
            contexts: Array.isArray(json.contexts) ? (json.contexts as BrokerContext[]) : [],
        };
    }
    async open(input: Parameters<AppBrowserClient['open']>[0]) {
        const json = await this.call('POST', '/contexts', input);
        return { bootId: String(json.bootId), workerKey: String(json.workerKey) };
    }
    async deliver(contextId: string, sealed: string) {
        await this.call('PUT', `/contexts/${contextId}/credential`, { sealed });
    }
    async command(contextId: string, command: BrowserCommand) {
        const json = await this.call('POST', `/contexts/${contextId}/commands`, {
            command,
        });
        return (json.result ?? {}) as Record<string, unknown>;
    }
    async close(contextId: string) {
        await this.call('DELETE', `/contexts/${contextId}`);
    }
    async closeGrant(grantId: string) {
        await this.call('DELETE', `/grants/${grantId}`);
    }
}

/**
 * The client from the environment: `APP_BROWSER_URL` and
 * `APP_BROWSER_SECRET_FILE` (or `APP_BROWSER_SECRET`). None without both:
 * the `app_*` tools are then not offered.
 */
export function appBrowserClientFromEnv(env: Record<string, string | undefined>): AppBrowserClient | undefined {
    const url = env.APP_BROWSER_URL?.trim();
    if (!url) {
        return undefined;
    }
    let secret = env.APP_BROWSER_SECRET?.trim() ?? '';
    if (env.APP_BROWSER_SECRET_FILE) {
        try {
            secret = readFileSync(env.APP_BROWSER_SECRET_FILE, 'utf8').trim();
        } catch {
            return undefined;
        }
    }
    if (secret.length < 24) {
        return undefined;
    }
    return new HttpAppBrowserClient({ url, secret });
}

/** A context opened this long ago may be missing from the router. */
const OPEN_GRACE_MS = 60_000;
/** How often the router is asked what it holds, at most, per runtime. */
const RECONCILE_MS = 15_000;
/** A context's credential is renewed here when it ends sooner than this. */
const RENEW_WITHIN_MS = 2 * 60_000;
/** A count past this reads as this: the audit's status holds 32 characters. */
const COUNT_MAX = 999_999;
/** Contexts whose last recorded navigation counts this runtime keeps. */
const RECORDED_KEPT = 1000;

export interface AppBrowserBrokerOptions {
    actors: ActorsShape;
    client: AppBrowserClient;
    /** The instance secret the context key derives from. */
    secret: string;
    limits?: ContextLimits;
    now?: () => number;
    log?: (line: string) => void;
}

/**
 * Contexts for grants: one per grant, opened under the actors module's
 * caps, its credential issued for that context alone and delivered sealed;
 * closed when the grant ends (here or on another runtime), when the
 * router lost it, or when the router restarted.
 */
export class AppBrowserBroker {
    private lastReconcile = 0;
    /** The navigation counts last recorded per context, on this runtime. */
    private recorded = new Map<string, string>();
    private now: () => number;
    private detach: Array<() => void> = [];
    constructor(private options: AppBrowserBrokerOptions) {
        this.now = options.now ?? Date.now;
    }

    get limits(): ContextLimits {
        return this.options.limits ?? BROWSER_CONTEXT_LIMITS;
    }

    /**
     * Hooks into the actors module on this runtime: renewed credentials go
     * to the worker (sealed), and a revoked grant's contexts close in the
     * router.
     */
    attach() {
        const { actors } = this.options;
        this.detach.push(
            actors.deliverWith('browser', async (context, token, expiresAt) => {
                const held = (await this.options.client.list()).contexts.find((entry) => entry.id === context.id);
                if (!held) {
                    return;
                }
                await this.options.client.deliver(context.id, this.seal(held.workerKey, context.id, token, expiresAt));
            }),
            actors.revocations.onRevoked(({ grantIds }) => {
                for (const id of grantIds) {
                    void this.options.client
                        .closeGrant(id)
                        .catch(() =>
                            this.options.log?.(
                                'App browser: closing a revoked grant’s context failed; the next reconcile closes it.',
                            ),
                        );
                }
            }),
        );
        return () => {
            for (const off of this.detach.splice(0)) {
                off();
            }
        };
    }

    private seal(workerKey: string, contextId: string, token: string, expiresAt: number) {
        return sealForWorker(workerKey, contextId, {
            token,
            key: contextKey(this.options.secret, contextId).toString('base64url'),
            expiresAt,
        });
    }

    /** The grant's open browser context, if any (rows, any runtime's). */
    contextOf(grantId: string): ContextRecord | undefined {
        return this.options.actors.contexts
            .openContexts()
            .find((context) => context.grantId === grantId && context.kind === 'browser');
    }

    /**
     * Makes the router and the rows agree: a context of an older router
     * boot, or one the router no longer holds (idle, crashed), is closed; a
     * router context whose row is closed (a revocation no listener here
     * heard) is closed in the router.
     */
    async reconcile({ force = false } = {}) {
        if (!force && this.now() - this.lastReconcile < RECONCILE_MS) {
            return;
        }
        this.lastReconcile = this.now();
        const { actors, client } = this.options;
        const listing = await client.list();
        const held = new Set(listing.contexts.map((entry) => entry.id));
        const stale: string[] = [];
        const lost: string[] = [];
        for (const context of actors.contexts.openContexts()) {
            if (context.kind !== 'browser') {
                continue;
            }
            if (context.worker !== listing.bootId) {
                stale.push(context.id);
            } else if (!held.has(context.id) && this.now() - context.openedAt > OPEN_GRACE_MS) {
                lost.push(context.id);
            }
        }
        const correlationId = `app-browser-reconcile-${this.now()}`;
        if (stale.length) {
            await actors.contexts.close(stale, 'broker_restarted', correlationId);
        }
        if (lost.length) {
            await actors.contexts.close(lost, 'broker_closed', correlationId);
        }
        for (const entry of listing.contexts) {
            const row = actors.contexts.get(entry.id);
            if (!row || row.closedAt !== null) {
                await client.close(entry.id).catch(() => undefined);
            }
        }
    }

    /**
     * The grant's context, opened if it has none: the row under the actors
     * module's caps (person, socio, instance; counted in the inserting
     * transaction), the router's worker, then a credential for that context
     * alone.
     */
    async ensure(
        grant: GrantRecord,
        audience: Audience,
        origin: string,
        correlationId: string,
    ): Promise<ContextRecord> {
        const { actors, client } = this.options;
        await this.reconcile();
        const existing = this.contextOf(grant.id);
        if (existing) {
            const held = (await client.list()).contexts.find((entry) => entry.id === existing.id);
            if (held) {
                await this.freshen(existing, grant, held.workerKey, correlationId);
                return existing;
            }
            await actors.contexts.close([existing.id], 'broker_closed', correlationId);
        }
        const { bootId } = await client.list();
        const open = (record = true) =>
            actors.contexts.open({
                grant,
                kind: 'browser',
                audience,
                worker: bootId,
                limits: this.limits,
                correlationId: record ? correlationId : `${correlationId}-retry`,
            });
        let context: ContextRecord;
        try {
            context = await open();
        } catch (error) {
            // Caps count open rows: rows the router already let go of first.
            if (!(error instanceof ActorAccessError) || error.reason !== 'limit_reached') {
                throw error;
            }
            await this.reconcile({ force: true });
            context = await open(false);
        }
        try {
            const opened = await client.open({
                contextId: context.id,
                grantId: grant.id,
                origin,
                bootId,
            });
            await this.deliver(context, grant, opened.workerKey, correlationId);
            return context;
        } catch (error) {
            await actors.contexts.close([context.id], 'open_failed', correlationId).catch(() => undefined);
            await client.close(context.id).catch(() => undefined);
            throw error;
        }
    }

    /** A new `cbsa_` for the context alone, sealed to its worker. */
    private async deliver(context: ContextRecord, grant: GrantRecord, workerKey: string, correlationId: string) {
        const { token, expiresAt } = await this.options.actors.credentials.issue({
            grant,
            kind: 'cbsa',
            audiences: [context.audience as Audience],
            contextId: context.id,
            holder: { kind: 'context', id: context.id },
            correlationId,
        });
        await this.options.client.deliver(context.id, this.seal(workerKey, context.id, token, expiresAt));
    }

    /**
     * Renewal on use: the lease holder renews every 30 s, and a turn
     * on any runtime renews a credential that ends within two minutes, so a
     * context whose holder just drained keeps working.
     */
    private async freshen(context: ContextRecord, grant: GrantRecord, workerKey: string, correlationId: string) {
        const newest = this.options.actors.credentials.newestExpiry('context', context.id) ?? 0;
        if (newest - this.now() > RENEW_WITHIN_MS) {
            return;
        }
        await this.deliver(context, grant, workerKey, correlationId);
    }

    async command(context: ContextRecord, command: BrowserCommand, correlationId = `app-browser-${context.id}`) {
        const result = await this.options.client.command(context.id, command);
        this.recordNavigations(context, result, correlationId);
        return result;
    }

    /**
     * Navigations the app browser's lock ended in a context: blocked
     * requests and off-origin redirects, the counts its worker keeps and
     * returns with each result, as a `context` row when they change (once
     * per context per change on this runtime). Counts only: no URL, no page
     * content.
     */
    private recordNavigations(context: ContextRecord, result: Record<string, unknown>, correlationId: string) {
        const count = (value: unknown) =>
            typeof value === 'number' && Number.isInteger(value) && value > 0 ? Math.min(value, COUNT_MAX) : 0;
        const blocked = count(result.blocked);
        const offOrigin = count(result.offOriginRedirects);
        if (!blocked && !offOrigin) {
            return;
        }
        const status = `blocked:${blocked};off_origin:${offOrigin}`;
        if (this.recorded.get(context.id) === status) {
            return;
        }
        this.recorded.delete(context.id);
        this.recorded.set(context.id, status);
        if (this.recorded.size > RECORDED_KEPT) {
            this.recorded.delete(this.recorded.keys().next().value!);
        }
        this.options.actors.audit.recordSoon({
            correlationId,
            phase: 'context',
            status,
            personId: context.personId,
            socioId: context.socioId,
            grantId: context.grantId,
            actorBy: 'system',
            audience: context.audience,
            resourceKind: context.kind,
            resourceId: context.id,
        });
    }

    /** `app_close`: the context ends; the grant stays (end_app_access ends it). */
    async close(context: ContextRecord, correlationId: string) {
        await this.options.actors.contexts.close([context.id], 'closed_by_socio', correlationId);
        this.recorded.delete(context.id);
        await this.options.client.close(context.id).catch(() => undefined);
    }
}
