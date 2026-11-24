import {
    RUNTIME_HEADER_APP,
    RUNTIME_HEADER_KEY,
    RUNTIME_HEADER_SIG,
    type RuntimeAppStatus,
    type RuntimeAttempt,
    type RuntimeRegistryGrant,
    type RuntimeServiceStatus,
    type RuntimeStartRequest,
} from '@socio/shared/apps/apps-runtime-types';
import type { IdentityGrant } from '@socio/shared/identity-delivery';
import type { PluginServiceSpec } from '@socio/shared/plugins/plugin-service';

import { identitySignature, ingressKey } from '../../apps-runtime/keys.js';

import type { AppsRuntimeSettings } from './contract.js';

/** How the app reaches the workspace app runtime: now in the contract. */
export type { AppsRuntimeSettings };

export function appsRuntimeFromEnv(
    env: Record<string, string | undefined>,
    dataApiUrl: string | undefined,
): AppsRuntimeSettings | undefined {
    const raw = env.APPS_RUNTIME_URL?.trim();
    if (!raw) {
        return undefined;
    }
    if (!/^https?:\/\/[^/?#@]+\/?$/.test(raw)) {
        throw new Error('APPS_RUNTIME_URL must be an http(s) origin, e.g. http://company-brain-apps:4330.');
    }
    const token = env.APPS_RUNTIME_TOKEN?.trim();
    if (!token || token.length < 24) {
        throw new Error('APPS_RUNTIME_TOKEN (or _FILE) must be set, at least 24 characters, with APPS_RUNTIME_URL.');
    }
    const url = new URL(raw);
    const port = Number(env.APPS_RUNTIME_INGRESS_PORT?.trim() || 4331);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('APPS_RUNTIME_INGRESS_PORT must be a port.');
    }
    const data = env.APPS_RUNTIME_DATA_URL?.trim() || dataApiUrl;
    return {
        url: url.origin,
        token,
        ingress: { host: url.hostname, port },
        ...(data ? { dataApiUrl: data.replace(/\/$/, '') } : {}),
    };
}

/**
 * The runtime could not do the work. `status` 503 is an outage the person
 * may be told about (unreachable, its token refused, or the runtime's own
 * 503 sentence); 502 is any other runtime failure, whose message stays in
 * the server log.
 */
export class RuntimeUnavailable extends Error {
    constructor(
        message: string,
        readonly status: 502 | 503 = 503,
    ) {
        super(message);
    }
}
export class RuntimeRefused extends Error {
    constructor(
        message: string,
        readonly status: number,
        /** The runtime said why (its route exists); else a bare HTTP error. */
        readonly answered = true,
    ) {
        super(message);
    }
}

/** What the apps service needs from the runtime (tests may fake it). */
export interface AppsRuntime {
    readonly settings: AppsRuntimeSettings;
    /** What the apps proxy adds to reach an app through the ingress. */
    ingressHeaders(id: string): Record<string, string>;
    /**
     * `x-cb-runtime-sig` over the identity headers the proxy adds (CB-232),
     * which the ingress requires before it passes them on.
     */
    signIdentity?(id: string, method: string, target: string, headers: Record<string, string>): Record<string, string>;
    deploy(id: string, version: number, bundle: Buffer, sha256: string): Promise<RuntimeAppStatus>;
    start(id: string, request: RuntimeStartRequest): Promise<RuntimeAppStatus>;
    stop(id: string): Promise<RuntimeAppStatus>;
    remove(id: string): Promise<void>;
    status(id: string): Promise<RuntimeAppStatus | undefined>;
    logs(id: string, tail?: number): Promise<string[]>;
    /**
     * Its build and start attempts, oldest first, and the runtime's boot
     * (CB-146); `missing` when the runtime doesn't have the app (yet);
     * `unsupported` from a runtime too old to keep attempts.
     */
    attempts(id: string): Promise<{ boot: string; attempts: RuntimeAttempt[] } | 'missing' | 'unsupported'>;
    setToken(id: string, token: string): Promise<RuntimeAppStatus>;
    /** Plugin services. 503 when this runtime was not started with Docker. */
    provisionService(
        id: string,
        spec: PluginServiceSpec,
        identity?: IdentityGrant,
        registry?: RuntimeRegistryGrant,
    ): Promise<RuntimeServiceStatus>;
    repairServiceNetworks(id: string, egress: boolean): Promise<void>;
    scaleService(id: string, replicas: number): Promise<RuntimeServiceStatus>;
    removeService(id: string): Promise<void>;
    serviceStatus(id: string): Promise<RuntimeServiceStatus | undefined>;
}

const RESPONSE_LIMIT = 1_000_000;

/**
 * The app's side of the runtime API: bearer token, timeouts, no redirects,
 * capped responses. The runtime never calls back.
 */
export class AppsRuntimeClient implements AppsRuntime {
    constructor(
        readonly settings: AppsRuntimeSettings,
        private transport: typeof fetch = fetch,
    ) {}
    /** Headers the apps proxy adds for the runtime's ingress. */
    ingressHeaders(id: string) {
        return {
            [RUNTIME_HEADER_APP]: id,
            [RUNTIME_HEADER_KEY]: ingressKey(this.settings.token),
        };
    }
    /** The ingress signature over the proxy's identity headers. */
    signIdentity(id: string, method: string, target: string, headers: Record<string, string>) {
        return {
            [RUNTIME_HEADER_SIG]: identitySignature(this.settings.token, id, method, target, headers),
        };
    }
    private async call<T>(
        path: string,
        init: {
            method?: string;
            json?: unknown;
            body?: Buffer;
            headers?: Record<string, string>;
            timeoutMs?: number;
        } = {},
    ): Promise<T> {
        let response: Response;
        try {
            response = await this.transport(`${this.settings.url}${path}`, {
                method: init.method ?? 'GET',
                headers: {
                    Authorization: `Bearer ${this.settings.token}`,
                    ...(init.json !== undefined
                        ? { 'Content-Type': 'application/json' }
                        : init.body
                          ? { 'Content-Type': 'application/octet-stream' }
                          : {}),
                    ...init.headers,
                },
                body:
                    init.json !== undefined
                        ? JSON.stringify(init.json)
                        : init.body
                          ? new Uint8Array(init.body)
                          : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
            });
        } catch {
            throw new RuntimeUnavailable('The workspace app runtime is unavailable right now.');
        }
        const text = await response.text();
        if (text.length > RESPONSE_LIMIT) {
            throw new RuntimeUnavailable('The runtime’s answer is too large.');
        }
        let body: unknown;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = null;
        }
        if (!response.ok) {
            const answered = !!body && typeof (body as { error?: unknown }).error === 'string';
            const message = answered
                ? (body as { error: string }).error
                : `The runtime answered HTTP ${response.status}.`;
            if (response.status === 401 || response.status >= 500) {
                throw new RuntimeUnavailable(
                    response.status === 401
                        ? 'The workspace app runtime refused the app’s token (APPS_RUNTIME_TOKEN).'
                        : message,
                    response.status === 401 || response.status === 503 ? 503 : 502,
                );
            }
            throw new RuntimeRefused(message.slice(0, 300), response.status, answered);
        }
        return body as T;
    }
    deploy(id: string, version: number, bundle: Buffer, sha256: string) {
        return this.call<RuntimeAppStatus>(`/v1/apps/${encodeURIComponent(id)}/versions/${version}`, {
            method: 'PUT',
            body: bundle,
            headers: { 'x-bundle-sha256': sha256 },
            // Locked dependencies may be installed.
            timeoutMs: 10 * 60_000,
        });
    }
    start(id: string, request: RuntimeStartRequest) {
        return this.call<RuntimeAppStatus>(`/v1/apps/${encodeURIComponent(id)}/start`, {
            method: 'POST',
            json: request,
            timeoutMs: 10 * 60_000,
        });
    }
    stop(id: string) {
        return this.call<RuntimeAppStatus>(`/v1/apps/${encodeURIComponent(id)}/stop`, {
            method: 'POST',
            json: {},
            timeoutMs: 30_000,
        });
    }
    async remove(id: string) {
        await this.call(`/v1/apps/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            timeoutMs: 30_000,
        });
    }
    async status(id: string) {
        try {
            return await this.call<RuntimeAppStatus>(`/v1/apps/${encodeURIComponent(id)}`, { timeoutMs: 5_000 });
        } catch (error) {
            if (error instanceof RuntimeRefused && error.status === 404) {
                return undefined;
            }
            throw error;
        }
    }
    async logs(id: string, tail = 200) {
        const result = await this.call<{ lines: string[] }>(`/v1/apps/${encodeURIComponent(id)}/logs?tail=${tail}`);
        return result.lines;
    }
    async attempts(id: string) {
        try {
            return await this.call<{ boot: string; attempts: RuntimeAttempt[] }>(
                `/v1/apps/${encodeURIComponent(id)}/attempts`,
                { timeoutMs: 5_000 },
            );
        } catch (error) {
            if (error instanceof RuntimeRefused && error.status === 404) {
                return error.answered ? 'missing' : 'unsupported';
            }
            throw error;
        }
    }
    setToken(id: string, token: string) {
        return this.call<RuntimeAppStatus>(`/v1/apps/${encodeURIComponent(id)}/token`, {
            method: 'PUT',
            json: { token },
        });
    }
    provisionService(id: string, spec: PluginServiceSpec, identity?: IdentityGrant, registry?: RuntimeRegistryGrant) {
        return this.call<RuntimeServiceStatus>(`/v1/services/${encodeURIComponent(id)}`, {
            method: 'PUT',
            json: { spec, ...(identity ? { identity } : {}), ...(registry ? { registry } : {}) },
            timeoutMs: 120_000,
        });
    }
    async repairServiceNetworks(id: string, egress: boolean) {
        await this.call(`/v1/services/${encodeURIComponent(id)}/networks`, {
            method: 'POST',
            json: { egress },
            timeoutMs: 60_000,
        });
    }
    scaleService(id: string, replicas: number) {
        return this.call<RuntimeServiceStatus>(`/v1/services/${encodeURIComponent(id)}/scale`, {
            method: 'POST',
            json: { replicas },
            timeoutMs: 60_000,
        });
    }
    async removeService(id: string) {
        await this.call(`/v1/services/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            timeoutMs: 60_000,
        });
    }
    async serviceStatus(id: string) {
        try {
            return await this.call<RuntimeServiceStatus>(`/v1/services/${encodeURIComponent(id)}`, {
                timeoutMs: 5_000,
            });
        } catch (error) {
            if (error instanceof RuntimeRefused && error.status === 404) {
                return undefined;
            }
            throw error;
        }
    }
}
