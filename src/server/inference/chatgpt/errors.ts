/**
 * A ChatGPT plan's provider answers (HTTP errors, failed stream events,
 * OAuth errors) as typed failures, and the redaction of anything about a
 * connection that may reach a log. The failures themselves (`ChatGptError`,
 * its codes and messages, `chatGptFailure`, `OVER_LENGTH_WORDING`) moved to
 * `@socio/foundation/inference/chatgpt-errors`.
 */
import { ChatGptError, OVER_LENGTH_WORDING, PROVIDER_CODE } from '@socio/foundation/inference/chatgpt-errors';

const PLAN_NAMES: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro',
    promax: 'Pro (Max)',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    ent26: 'Enterprise',
    edu: 'Edu',
    edu_plus: 'Edu Plus',
    edu_pro: 'Edu Pro',
};
/**
 * A plan's display name (after `PlanType::display_name` in the CLI's
 * `protocol/src/auth.rs`); unknown plans are shown capitalized, or not at all
 * when they don't look like a plan id.
 */
export function planLabel(plan: unknown): string | undefined {
    if (typeof plan !== 'string' || !/^[a-z0-9_]{1,40}$/i.test(plan)) {
        return;
    }
    const known = PLAN_NAMES[plan.toLowerCase()];
    if (known) {
        return known;
    }
    return plan
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};
const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

interface ProviderError {
    code?: string;
    type?: string;
    message?: string;
    plan?: string;
    resetsAt?: Date;
}
function providerError(value: unknown): ProviderError {
    const body = record(value);
    const error = record(body?.error) ?? body;
    if (!error) {
        return {};
    }
    const resetsAt =
        typeof error.resets_at === 'number'
            ? new Date(error.resets_at * 1000)
            : typeof error.resets_in_seconds === 'number'
              ? new Date(Date.now() + error.resets_in_seconds * 1000)
              : undefined;
    return {
        code: str(error.code),
        type: str(error.type),
        message: str(error.message) ?? str(body?.detail),
        plan: planLabel(error.plan_type),
        resetsAt,
    };
}

const MODEL_WORDING =
    /model[^.\n]*\b(?:not (?:found|supported|available)|does not exist|unsupported|not allowed)|unsupported model|model_not_found/i;
const LIMIT_WORDING = /usage limit|limit (?:reached|exceeded)|rate limit/i;

/**
 * A provider error code (an HTTP error body or a `response.failed` event)
 * mapped as the CLI maps it: `codex-api/src/api_bridge.rs` (HTTP 429:
 * `usage_limit_reached`, `usage_not_included`, quota codes) and
 * `codex-api/src/sse/responses_error.rs` (`response.failed` codes).
 */
function fromProviderCode(error: ProviderError, status: number | undefined): ChatGptError | undefined {
    const providerCode = error.type ?? error.code;
    const options = { status, providerCode };
    const codes = [error.type, error.code];
    if (codes.includes('usage_limit_reached')) {
        return new ChatGptError('chatgpt_usage_limit', {
            ...options,
            resetsAt: error.resetsAt,
            plan: error.plan,
        });
    }
    if (codes.includes('usage_not_included')) {
        return new ChatGptError('chatgpt_not_entitled', options);
    }
    if (
        codes.some(
            (code) =>
                code !== undefined &&
                [
                    'insufficient_quota',
                    'credit_balance_exhausted',
                    'organization_spend_limit_exceeded',
                    'project_spend_limit_exceeded',
                    'organization_usage_limit_exceeded',
                ].includes(code),
        )
    ) {
        return new ChatGptError('chatgpt_quota_exceeded', options);
    }
    if (codes.includes('context_length_exceeded')) {
        return new ChatGptError('chatgpt_context_too_long', options);
    }
    if (
        codes.some(
            (code) => code !== undefined && ['rate_limit_exceeded', 'slow_down', 'server_is_overloaded'].includes(code),
        )
    ) {
        return new ChatGptError('chatgpt_rate_limited', options);
    }
    if (codes.includes('model_not_found')) {
        return new ChatGptError('chatgpt_model_unavailable', options);
    }
    return undefined;
}

/** The longest wait a hint may ask for that is still read as one. */
const RETRY_HINT_MAX_MS = 24 * 3600_000;
/**
 * How long a rate-limited answer asks to wait: `retry-after-ms`, then
 * `Retry-After` (seconds or an HTTP date), then the body's reset time.
 */
export function retryAfterMs(headers: Headers | undefined, resetsAt?: Date, now = Date.now()): number | undefined {
    const valid = (ms: number) =>
        Number.isFinite(ms) && ms >= 0 && ms <= RETRY_HINT_MAX_MS ? Math.ceil(ms) : undefined;
    const ms = headers?.get('retry-after-ms')?.trim();
    if (ms && /^\d+(?:\.\d+)?$/.test(ms)) {
        return valid(Number(ms));
    }
    const after = headers?.get('retry-after')?.trim();
    if (after) {
        return /^\d+(?:\.\d+)?$/.test(after) ? valid(Number(after) * 1000) : valid(Date.parse(after) - now);
    }
    return resetsAt ? valid(Math.max(0, resetsAt.getTime() - now)) : undefined;
}

/** A non-2xx answer from the Responses endpoint, as a typed error. */
export function responsesHttpError(status: number, bodyText: string, headers?: Headers): ChatGptError {
    const error = providerError(parseJson(bodyText));
    const known = fromProviderCode(error, status);
    if (known?.code === 'chatgpt_rate_limited') {
        const wait = retryAfterMs(headers, error.resetsAt);
        if (wait !== undefined) {
            return new ChatGptError(known.code, {
                status,
                providerCode: known.providerCode,
                retryAfterMs: wait,
            });
        }
    }
    if (known) {
        return known;
    }
    const providerCode = error.type ?? error.code;
    const options = { status, providerCode };
    const wording = `${error.message ?? ''} ${providerCode ?? ''}`;
    if (status === 401) {
        return new ChatGptError('chatgpt_needs_relogin', options);
    }
    if (status === 429) {
        if (LIMIT_WORDING.test(wording) && /usage/i.test(wording)) {
            return new ChatGptError('chatgpt_usage_limit', {
                ...options,
                resetsAt: error.resetsAt,
                plan: error.plan,
            });
        }
        return new ChatGptError('chatgpt_rate_limited', {
            ...options,
            resetsAt: error.resetsAt,
            retryAfterMs: retryAfterMs(headers, error.resetsAt),
        });
    }
    if ((status === 400 || status === 404) && MODEL_WORDING.test(wording)) {
        return new ChatGptError('chatgpt_model_unavailable', options);
    }
    if (status === 413 || (status === 400 && OVER_LENGTH_WORDING.test(wording))) {
        return new ChatGptError('chatgpt_context_too_long', options);
    }
    if (status === 403) {
        return new ChatGptError(
            /plan|entitle|not included|upgrade/i.test(wording) ? 'chatgpt_not_entitled' : 'chatgpt_forbidden',
            options,
        );
    }
    if (status === 408 || status >= 500) {
        return new ChatGptError('chatgpt_unavailable', {
            ...options,
            retryAfterMs: retryAfterMs(headers),
        });
    }
    return new ChatGptError('chatgpt_rejected', options);
}

/** A `response.failed` or `error` stream event, as a typed error. */
export function responsesStreamError(event: unknown): ChatGptError {
    const value = record(event);
    const error = providerError(value?.type === 'error' ? value : record(value?.response)?.error);
    const message = error.message ?? '';
    return (
        fromProviderCode(error, undefined) ??
        new ChatGptError(
            MODEL_WORDING.test(message)
                ? 'chatgpt_model_unavailable'
                : OVER_LENGTH_WORDING.test(message)
                  ? 'chatgpt_context_too_long'
                  : 'chatgpt_rejected',
            { providerCode: error.code ?? error.type },
        )
    );
}

/** The provider's OAuth error code from a token endpoint body. */
export function oauthErrorCode(bodyText: string): string | undefined {
    const body = record(parseJson(bodyText));
    const code = str(body?.error) ?? str(record(body?.error)?.code) ?? str(body?.code);
    return code && PROVIDER_CODE.test(code) ? code : undefined;
}

const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/**
 * Text with every credential removed: the given secret values verbatim
 * (and URL-encoded), bearer tokens, JWTs (access and ID tokens), long opaque
 * strings and email addresses. For anything about a connection that may
 * reach a log or an event.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
    let result = text;
    for (const secret of secrets) {
        if (!secret || secret.length < 6) {
            continue;
        }
        for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
            result = result.split(form).join('[redacted]');
        }
    }
    return result
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(JWT, '[redacted]')
        .replace(/[^\s@'"`<>]+@[^\s@'"`<>]+\.\w+/g, '[email]')
        .replace(/[A-Za-z0-9+/_=.-]{32,}/g, '[redacted]');
}
