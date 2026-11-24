import { DomainsError, type DomainsSettings } from './contract.js';
import { failure, requestJson, type JsonRequest, type Redactor } from './http.js';

/** A proxy host as NPM 2.14 returns it (the fields this module reads). */
export interface NpmProxyHost {
    id: number;
    domain_names: string[];
    forward_scheme: 'http' | 'https';
    forward_host: string;
    forward_port: number;
    certificate_id: number | null;
    ssl_forced: boolean | number;
    http2_support: boolean | number;
    hsts_enabled: boolean | number;
    hsts_subdomains: boolean | number;
    block_exploits: boolean | number;
    allow_websocket_upgrade: boolean | number;
    caching_enabled: boolean | number;
    enabled: boolean | number;
    owner_user_id?: number;
}

/** What this module writes to a proxy host (NPM 2.14's request schema). */
export interface NpmProxyHostInput {
    domain_names: string[];
    forward_scheme: 'http' | 'https';
    forward_host: string;
    forward_port: number;
    certificate_id: number;
    ssl_forced: boolean;
    http2_support: boolean;
    hsts_enabled: boolean;
    hsts_subdomains: boolean;
    block_exploits: boolean;
    allow_websocket_upgrade: boolean;
    caching_enabled: boolean;
    enabled: boolean;
    access_list_id?: number;
    advanced_config?: string;
    locations?: unknown[];
    meta?: Record<string, unknown>;
}

export interface NpmCertificate {
    id: number;
    provider: string;
    nice_name: string;
    domain_names: string[];
    /** Set once issued. */
    expires_on?: string | null;
    meta?: Record<string, unknown>;
}

export interface NpmUser {
    id: number;
    email: string;
}

interface Token {
    value: string;
    expiresAt: number;
    issuedAt: number;
}

/** Refresh when less than this much of a token's life is left (or 1 h). */
const REFRESH_FRACTION = 0.5;
const REFRESH_MAX_MS = 60 * 60_000;
/** Never use a token closer than this to its expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Nginx Proxy Manager's admin API (2.14), as the workspace's scoped NPM
 * user: it sees and changes only the proxy hosts and certificates it
 * created. Logs in with `POST /tokens`, keeps the JWT until close to its
 * expiry, renews it with `GET /tokens`, and logs in again once on a 401.
 */
export class NpmClient {
    private token?: Token;
    private pending?: Promise<string>;
    /** Counters for tests and the status line. */
    readonly stats = { logins: 0, refreshes: 0 };
    constructor(
        private settings: DomainsSettings['npm'],
        private redactor: Redactor,
        private transport: typeof fetch = fetch,
        private now: () => number = Date.now,
    ) {
        redactor.add(settings.password);
    }

    private remember(body: unknown) {
        const { token, expires } = (body ?? {}) as {
            token?: unknown;
            expires?: unknown;
        };
        if (typeof token !== 'string' || !token) {
            const twoFactor = !!(body as { requires_2fa?: unknown })?.requires_2fa;
            throw new DomainsError(
                'unauthorized',
                twoFactor
                    ? 'The NPM user has two-factor authentication on; the workspace’s NPM user must not.'
                    : 'Nginx Proxy Manager gave no token.',
                'npm',
            );
        }
        const expiresAt =
            typeof expires === 'string' && Number.isFinite(Date.parse(expires))
                ? Date.parse(expires)
                : this.now() + 60 * 60_000;
        if (this.token) {
            this.redactor.remove(this.token.value);
        }
        this.redactor.add(token);
        this.token = { value: token, expiresAt, issuedAt: this.now() };
        return token;
    }

    private async login() {
        this.stats.logins++;
        const response = await requestJson('npm', this.transport, `${this.settings.url}/tokens`, {
            method: 'POST',
            json: {
                identity: this.settings.email,
                secret: this.settings.password,
            },
            timeoutMs: this.settings.timeoutMs,
        });
        if (!response.ok) {
            this.token = undefined;
            if (response.status === 401 || response.status === 400) {
                throw new DomainsError(
                    'unauthorized',
                    'Nginx Proxy Manager refused the workspace’s NPM login (NPM_CREDENTIALS_FILE).',
                    'npm',
                    response.status,
                );
            }
            throw failure('npm', response.status, npmMessage(response.body), this.redactor);
        }
        return this.remember(response.body);
    }

    private async refresh(current: Token) {
        this.stats.refreshes++;
        const response = await requestJson('npm', this.transport, `${this.settings.url}/tokens`, {
            headers: { Authorization: `Bearer ${current.value}` },
            timeoutMs: this.settings.timeoutMs,
        });
        // A refused refresh falls back to a fresh login.
        if (!response.ok) {
            return this.login();
        }
        return this.remember(response.body);
    }

    /** A usable token: cached, refreshed when it is getting old, or new. */
    private async bearer(): Promise<string> {
        if (this.pending) {
            return this.pending;
        }
        const token = this.token;
        const now = this.now();
        if (token && now < token.expiresAt - EXPIRY_MARGIN_MS) {
            const life = token.expiresAt - token.issuedAt;
            const window = Math.min(life * REFRESH_FRACTION, REFRESH_MAX_MS);
            if (token.expiresAt - now > window) {
                return token.value;
            }
            this.pending = this.refresh(token);
        } else {
            this.pending = this.login();
        }
        try {
            return await this.pending;
        } finally {
            this.pending = undefined;
        }
    }

    private async call<T>(
        path: string,
        init: Omit<JsonRequest, 'timeoutMs'> & { timeoutMs?: number } = {},
    ): Promise<T> {
        const send = async (token: string) =>
            requestJson('npm', this.transport, `${this.settings.url}${path}`, {
                ...init,
                headers: { ...init.headers, Authorization: `Bearer ${token}` },
                timeoutMs: init.timeoutMs ?? this.settings.timeoutMs,
            });
        let response = await send(await this.bearer());
        if (response.status === 401) {
            // Revoked or expired early: one fresh login, then give up.
            this.token = undefined;
            response = await send(await this.bearer());
        }
        if (!response.ok) {
            throw failure('npm', response.status, npmMessage(response.body), this.redactor);
        }
        return response.body as T;
    }

    me() {
        return this.call<NpmUser>('/users/me');
    }
    proxyHosts() {
        return this.call<NpmProxyHost[]>('/nginx/proxy-hosts');
    }
    createProxyHost(input: NpmProxyHostInput) {
        return this.call<NpmProxyHost>('/nginx/proxy-hosts', {
            method: 'POST',
            json: input,
        });
    }
    updateProxyHost(id: number, input: Partial<NpmProxyHostInput>) {
        return this.call<NpmProxyHost>(`/nginx/proxy-hosts/${id}`, {
            method: 'PUT',
            json: input,
        });
    }
    async deleteProxyHost(id: number) {
        await this.call(`/nginx/proxy-hosts/${id}`, { method: 'DELETE' });
    }
    certificates() {
        return this.call<NpmCertificate[]>('/nginx/certificates');
    }
    /**
     * A Let's Encrypt certificate by DNS-01 through Cloudflare. NPM 2.14
     * answers once certbot is done, so this waits up to the certificate
     * timeout. Let's Encrypt registers the NPM user's own email address
     * (NPM 2.14 takes no address in the request); the service checks it is
     * DOMAINS_ACME_EMAIL before calling this.
     */
    createCertificate(domains: string[], cloudflareToken: string) {
        return this.call<NpmCertificate>('/nginx/certificates', {
            method: 'POST',
            json: {
                provider: 'letsencrypt',
                nice_name: domains[0],
                domain_names: domains,
                meta: {
                    dns_challenge: true,
                    dns_provider: 'cloudflare',
                    dns_provider_credentials: `dns_cloudflare_api_token = ${cloudflareToken}`,
                },
            },
            timeoutMs: this.settings.certificateTimeoutMs,
        });
    }
    renewCertificate(id: number) {
        return this.call<NpmCertificate>(`/nginx/certificates/${id}/renew`, {
            method: 'POST',
            timeoutMs: this.settings.certificateTimeoutMs,
        });
    }
    async deleteCertificate(id: number) {
        await this.call(`/nginx/certificates/${id}`, { method: 'DELETE' });
    }
}

/** NPM's error shape: `{ error: { code, message } }`. */
function npmMessage(body: unknown) {
    const error = (body as { error?: { message?: unknown } } | null)?.error;
    return typeof error?.message === 'string' ? error.message : undefined;
}

/** Same set of names, any order or case. */
export function sameDomains(a: readonly string[], b: readonly string[]) {
    const left = [...new Set(a.map((d) => d.toLowerCase()))].sort();
    const right = [...new Set(b.map((d) => d.toLowerCase()))].sort();
    return left.length === right.length && left.every((name, i) => name === right[i]);
}
