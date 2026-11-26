import type { DeploymentMode } from './contract.js';
/**
 * The requests the deployment makes of the issuer (protocol §2): discovery
 * (RFC 8414), registration (RFC 7591), a token (RFC 6749 §4.4 with an RFC
 * 7523 assertion and one RFC 8707 resource) and sync (§2.7).
 *
 * Every URL comes from the issuer's metadata, and must be on the issuer's
 * own origin: the enrollment token and the assertions go nowhere else, even
 * if the metadata says so. Redirects are refused, answers are bounded in
 * time and size, and an error carries a code, never a body or a token.
 */
import { clientAssertion, publicJwk, type DeploymentKey } from './key.js';

const TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 64 * 1024;
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/**
 * Why a request failed:
 *
 * - `unreachable`: no answer, a server error or "too many requests". Worth another try later.
 * - `refused`: the issuer said no (4xx), with its OAuth error `code` when it gave one.
 * - `protocol`: an answer this client doesn't accept. Not worth retrying soon.
 */
export class CloudRequestError extends Error {
    constructor(
        readonly kind: 'unreachable' | 'refused' | 'protocol',
        what: string,
        readonly status?: number,
        readonly code?: string,
    ) {
        super(`${what}: ${code ?? kind}${status ? ` (${status})` : ''}`);
        this.name = 'CloudRequestError';
    }
}

/** The issuer's endpoints this client uses, each checked to be on the issuer's origin. */
export interface IssuerMetadata {
    issuer: string;
    registrationEndpoint: string;
    tokenEndpoint: string;
    syncEndpoint: string;
}

export interface Registration {
    clientId: string;
    deploymentMode: DeploymentMode;
    scopes: string[];
    termsVersion?: string;
}

export interface IssuedToken {
    accessToken: string;
    /** Seconds the token is good for, as the issuer said. */
    expiresIn: number;
}

export interface SyncAnswer {
    deploymentMode: DeploymentMode;
    scopes: string[];
    /** `active`, or `paused` while staff review a changed origin. */
    status: string;
    accepts: string[];
}

const text = (value: unknown, max = 200): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

/** An OAuth error code as the RFCs spell them; anything else isn't repeated. */
const errorCode = (value: unknown) => (typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : undefined);

const mode = (value: unknown): DeploymentMode | undefined =>
    value === 'hosted' || value === 'self-hosted' ? value : undefined;

/** Scope tokens (RFC 6749 §3.3), at most 50 of them. */
const scopeList = (value: unknown): string[] | undefined => {
    if (typeof value !== 'string' || value.length > 2000) {
        return undefined;
    }
    const scopes = value.split(' ').filter(Boolean);
    return scopes.length <= 50 && scopes.every((scope) => /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(scope))
        ? scopes
        : undefined;
};

export class IssuerClient {
    constructor(
        private readonly issuer: string,
        private readonly transport: typeof fetch = fetch,
    ) {}

    /** One request and its JSON answer; throws `CloudRequestError` for anything but 2xx JSON. */
    private async call(what: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
        let response: Response;
        let body: string;
        try {
            response = await this.transport(url, {
                ...init,
                redirect: 'error',
                signal: AbortSignal.timeout(TIMEOUT_MS),
                headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
            });
            body = await bounded(response);
        } catch {
            // The cause may quote the URL or a header: never passed on.
            throw new CloudRequestError('unreachable', what);
        }
        let json: unknown;
        try {
            json = JSON.parse(body);
        } catch {
            json = undefined;
        }
        const answer =
            json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
        if (response.status >= 500 || response.status === 429 || response.status === 408) {
            throw new CloudRequestError('unreachable', what, response.status);
        }
        if (response.status >= 400) {
            throw new CloudRequestError('refused', what, response.status, errorCode(answer?.error));
        }
        if (response.status < 200 || response.status >= 300 || !answer) {
            throw new CloudRequestError('protocol', what, response.status);
        }
        return answer;
    }

    /** An endpoint the metadata names, only if it is an https URL (or the issuer's own scheme) on the issuer's origin. */
    private endpoint(value: unknown, name: string): string {
        const raw = text(value, 500);
        let url: URL | undefined;
        try {
            url = raw ? new URL(raw) : undefined;
        } catch {
            url = undefined;
        }
        if (!url || url.origin !== this.issuer || url.username || url.password || url.hash) {
            throw new CloudRequestError('protocol', `issuer metadata (${name})`);
        }
        return url.href;
    }

    /** RFC 8414 §3: the metadata, accepted only if it is this issuer's own. */
    async discover(): Promise<IssuerMetadata> {
        const answer = await this.call('issuer metadata', `${this.issuer}/.well-known/oauth-authorization-server`, {
            method: 'GET',
        });
        if (answer.issuer !== this.issuer) {
            throw new CloudRequestError('protocol', 'issuer metadata (issuer)');
        }
        return {
            issuer: this.issuer,
            registrationEndpoint: this.endpoint(answer.registration_endpoint, 'registration_endpoint'),
            tokenEndpoint: this.endpoint(answer.token_endpoint, 'token_endpoint'),
            // §2.7: sync is the issuer's own, at a fixed path.
            syncEndpoint: `${this.issuer}/v1/sync`,
        };
    }

    /** RFC 7591: registers the deployment's public key with an initial access token. */
    async register(
        metadata: IssuerMetadata,
        initialAccessToken: string,
        key: DeploymentKey,
        version: string,
    ): Promise<Registration> {
        const answer = await this.call('registration', metadata.registrationEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${initialAccessToken}` },
            body: JSON.stringify({
                token_endpoint_auth_method: 'private_key_jwt',
                jwks: { keys: [publicJwk(key)] },
                software_version: version,
            }),
        });
        const clientId = text(answer.client_id);
        const deploymentMode = mode(answer.deployment_mode);
        const scopes = scopeList(answer.scope);
        if (!clientId || !/^[A-Za-z0-9_-]+$/.test(clientId) || !deploymentMode || !scopes) {
            throw new CloudRequestError('protocol', 'registration');
        }
        return { clientId, deploymentMode, scopes, termsVersion: text(answer.terms_version, 100) };
    }

    /** A token for one service (`resource`), for a signed assertion; no secret travels. */
    async token(
        metadata: IssuerMetadata,
        clientId: string,
        key: DeploymentKey,
        resource: string,
        nowMs: number,
    ): Promise<IssuedToken> {
        const answer = await this.call('token', metadata.tokenEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_assertion_type: ASSERTION_TYPE,
                // The assertion is for the issuer (RFC 7523 §3): its identifier, not an endpoint.
                client_assertion: clientAssertion(key, clientId, metadata.issuer, nowMs),
                resource,
            }).toString(),
        });
        const accessToken = text(answer.access_token, 8192);
        const expiresIn = answer.expires_in;
        if (
            !accessToken ||
            !/^[\x21-\x7e]+$/.test(accessToken) ||
            String(answer.token_type).toLowerCase() !== 'bearer' ||
            typeof expiresIn !== 'number' ||
            !Number.isFinite(expiresIn) ||
            expiresIn <= 0
        ) {
            throw new CloudRequestError('protocol', 'token');
        }
        return { accessToken, expiresIn };
    }

    /** §2.7: the deployment's version, origin and fingerprint in; its mode, scopes and status out. */
    async sync(
        metadata: IssuerMetadata,
        accessToken: string,
        deployment: { version: string; origin?: string; fingerprint: string },
    ): Promise<SyncAnswer> {
        const answer = await this.call('sync', metadata.syncEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
            // Version 1 sends no sections (§2.7): nothing about people, counts or content.
            body: JSON.stringify({ v: 1, deployment, sections: {} }),
        });
        const deploymentMode = mode(answer.deployment_mode);
        const scopes = scopeList(answer.scope);
        const status = text(answer.status, 40);
        if (!deploymentMode || !scopes || !status) {
            throw new CloudRequestError('protocol', 'sync');
        }
        const accepts = Array.isArray(answer.accepts)
            ? answer.accepts
                  .filter((name): name is string => typeof name === 'string' && name.length <= 100)
                  .slice(0, 50)
            : [];
        return { deploymentMode, scopes, status, accepts };
    }
}

/** The answer's text, read no further than the bound. */
async function bounded(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new Error('answer too large');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}
