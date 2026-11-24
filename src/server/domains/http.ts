/**
 * What the domains clients share: typed errors, secret redaction and one
 * JSON request with a timeout, no redirects and a capped answer.
 */

import { DomainsError, type Upstream } from './contract.js';

const REDACTED = '[redacted]';

/**
 * Replaces known secrets (the NPM password and current token, the
 * Cloudflare token) and anything shaped like a credential with
 * `[redacted]`. Applied to every error message, audit row and log line.
 */
export class Redactor {
    private secrets = new Set<string>();
    add(secret: string | undefined) {
        if (secret && secret.length >= 4) {
            this.secrets.add(secret);
        }
    }
    remove(secret: string | undefined) {
        if (secret) {
            this.secrets.delete(secret);
        }
    }
    redact(text: string) {
        let out = text;
        // Longest first, so a secret containing another goes whole.
        for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
            out = out.split(secret).join(REDACTED);
        }
        return out
            .replace(/(dns_cloudflare_api_token\s*=\s*)\S+/gi, `$1${REDACTED}`)
            .replace(/(bearer\s+)[\w.~+/=-]+/gi, `$1${REDACTED}`)
            .replace(/eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/g, REDACTED)
            .replace(/("(?:password|secret|token)"\s*:\s*")[^"]*"/gi, `$1${REDACTED}"`);
    }
}

const RESPONSE_LIMIT = 2_000_000;
const NAMES: Record<Upstream, string> = {
    npm: 'Nginx Proxy Manager',
    cloudflare: 'Cloudflare',
};

export interface JsonRequest {
    method?: string;
    headers?: Record<string, string>;
    json?: unknown;
    timeoutMs: number;
}

export interface JsonResponse {
    status: number;
    ok: boolean;
    body: unknown;
}

/**
 * One request; throws `unavailable` when there is no answer in time. Other
 * statuses come back to the caller, which knows its service's error shape.
 */
export async function requestJson(
    service: Upstream,
    transport: typeof fetch,
    url: string,
    init: JsonRequest,
): Promise<JsonResponse> {
    let response: Response;
    try {
        response = await transport(url, {
            method: init.method ?? 'GET',
            headers: {
                Accept: 'application/json',
                ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...init.headers,
            },
            body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
            redirect: 'error',
            signal: AbortSignal.timeout(init.timeoutMs),
        });
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new DomainsError(
            'unavailable',
            timedOut
                ? `${NAMES[service]} did not answer within ${Math.round(init.timeoutMs / 1000)} s.`
                : `${NAMES[service]} is unreachable.`,
            service,
        );
    }
    const text = await response.text().catch(() => '');
    if (text.length > RESPONSE_LIMIT) {
        throw new DomainsError('unavailable', `${NAMES[service]}'s answer is too large.`, service, response.status);
    }
    let body: unknown;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = null;
    }
    return { status: response.status, ok: response.ok, body };
}

/** A failed answer as a typed error, its message redacted and short. */
export function failure(service: Upstream, status: number, message: string | undefined, redactor: Redactor) {
    const text = redactor
        .redact(message?.trim() || `HTTP ${status}`)
        .replace(/\s+/g, ' ')
        .slice(0, 300);
    const code = status === 401 || status === 403 ? 'unauthorized' : status >= 500 ? 'unavailable' : 'refused';
    return new DomainsError(code, `${NAMES[service]} answered ${status}: ${text}`, service, status);
}
