import type { AnalyticsHealth, AnalyticsMode } from '@socio/shared/operations/operations-analytics';

import type { AnalyticsShape } from '../contract.js';
import { OPS_QUERIES, type OpsQueryAnswer, type OpsQueryName, type OpsQueryParams } from '../domain/ops-queries.js';

import {
    analyticsAnswer,
    type AnalyticsAnswer,
    type AnalyticsErrorCode,
    type AnalyticsRequest,
    type EngineStatus,
} from './ipc.js';

// In `operations/contract.ts` now; this path keeps working.

/** A query the store couldn't answer; `code` says why. */
export class AnalyticsError extends Error {
    constructor(
        message: string,
        readonly code: AnalyticsErrorCode,
    ) {
        super(message);
    }
}

/**
 * The app's one way to the analytics store (CB-164): the app never
 * runs analytics SQL on its own event loop. Child and service mode differ
 * only in transport. `LegacyAnalytics` holds it, and callers use the `Analytics` tag's
 * slice (`operations/contract.ts`); the dashboard's reader also queries and
 * rebuilds.
 */
export interface AnalyticsClient extends AnalyticsShape {
    readonly mode: AnalyticsMode;
    start(): void;
    stop(): Promise<void>;
    /** The latest known health, without a round trip (`setup()`). */
    health(): AnalyticsHealth;
    query<N extends OpsQueryName>(name: N, params: OpsQueryParams<N>): Promise<OpsQueryAnswer<N>>;
    /** Read SQLite soon (after a finished turn); fire and forget. */
    nudge(): void;
    /** An admin's Rebuild analytics; resolves with the health after asking. */
    rebuild(): Promise<AnalyticsHealth>;
}

/**
 * What both transports share: one `send`, the request and answer checked
 * against the protocol, and the last status kept.
 */
export abstract class AnalyticsTransport implements AnalyticsClient {
    abstract readonly mode: AnalyticsMode;
    protected last: EngineStatus = { state: 'starting' };
    abstract start(): void;
    abstract stop(): Promise<void>;
    /** One request; rejects (with `unavailable`) only when unreachable. */
    protected abstract send(request: AnalyticsRequest): Promise<unknown>;
    health(): AnalyticsHealth {
        return { mode: this.mode, ...this.last };
    }
    protected seen(status: EngineStatus) {
        this.last = status;
    }
    protected async call(request: AnalyticsRequest): Promise<AnalyticsAnswer> {
        const raw = await this.send(request);
        const parsed = analyticsAnswer.safeParse(raw);
        if (!parsed.success) {
            throw new AnalyticsError('The analytics store gave an answer this app can’t read.', 'failed');
        }
        this.seen(parsed.data.status);
        return parsed.data;
    }
    async query<N extends OpsQueryName>(name: N, params: OpsQueryParams<N>): Promise<OpsQueryAnswer<N>> {
        const answer = await this.call({ op: 'query', query: name, params });
        if (!answer.ok) {
            throw new AnalyticsError(answer.error, answer.code);
        }
        const value = OPS_QUERIES[name].answer.safeParse(answer.value);
        if (!value.success) {
            throw new AnalyticsError(`The analytics store’s answer to ${name} doesn’t fit.`, 'failed');
        }
        return value.data as OpsQueryAnswer<N>;
    }
    nudge() {
        void this.call({ op: 'nudge' }).catch(() => undefined);
    }
    async rebuild() {
        const answer = await this.call({ op: 'rebuild' });
        if (!answer.ok) {
            throw new AnalyticsError(answer.error, answer.code);
        }
        return this.health();
    }
}

const RESPONSE_LIMIT = 4_000_000;
/** How often the app asks a service for its status while nothing else does. */
const STATUS_EVERY_MS = 30_000;

/**
 * Service mode: `POST <url>/v1/rpc` with the bearer secret, a timeout, no
 * redirects and a capped answer. The service never calls back.
 */
export class HttpAnalytics extends AnalyticsTransport {
    readonly mode = 'service' as const;
    private timer?: ReturnType<typeof setInterval>;
    constructor(
        private settings: { url: string; secret: string },
        private transport: typeof fetch = fetch,
    ) {
        super();
    }
    start() {
        const poll = () => void this.call({ op: 'status' }).catch(() => undefined);
        poll();
        this.timer = setInterval(poll, STATUS_EVERY_MS);
        this.timer.unref();
    }
    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
        }
        this.timer = undefined;
    }
    protected async send(request: AnalyticsRequest) {
        let refused = false;
        try {
            const response = await this.transport(`${this.settings.url}/v1/rpc`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.settings.secret}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(request),
                redirect: 'error',
                signal: AbortSignal.timeout(30_000),
            });
            refused = response.status === 401;
            const text = await response.text();
            if (!response.ok || text.length > RESPONSE_LIMIT) {
                throw new Error(`HTTP ${response.status}`);
            }
            return JSON.parse(text) as unknown;
        } catch {
            this.seen({
                state: 'unavailable',
                detail: refused
                    ? 'The analytics service refused the secret (OPS_ANALYTICS_SECRET).'
                    : 'The analytics service can’t be reached.',
            });
            throw new AnalyticsError('The analytics service can’t be reached right now.', 'unavailable');
        }
    }
}
