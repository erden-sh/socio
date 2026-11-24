// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';

import type { WebReadResult, WebResponse } from '@socio/foundation/web/reads';
import type { WebIdentity } from '@socio/shared/web/web-types';

import type { WebCapabilitiesShape, WebCapability, WebReaderShape } from './contract.js';
import { ALLOWED_HEADERS } from './web-reads.js';

/** Characters of a body or JSON selection given to the model by default. */
const DEFAULT_CHARS = 20_000;
const MAX_CHARS = 100_000;

const textual = (type: string) =>
    !type ||
    /^text\//i.test(type) ||
    /[/+](json|xml|csv|javascript|x-ndjson)\b/i.test(type) ||
    /^application\/(x-www-form-urlencoded|ld\+json)/i.test(type);

/** The decoded text of a body, in its declared charset when known. */
function decode(response: WebResponse) {
    const charset = /charset="?([\w-]+)"?/i.exec(response.contentType)?.[1];
    try {
        return new TextDecoder(charset || 'utf-8').decode(response.body);
    } catch {
        return new TextDecoder('utf-8').decode(response.body);
    }
}

function refusal(result: Extract<WebReadResult, { ok: false }>) {
    return {
        error: result.message,
        reason: result.reason,
        ...(result.retryAfterSeconds !== undefined ? { retry_after_seconds: result.retryAfterSeconds } : {}),
    };
}

function summary(response: WebResponse) {
    return {
        status: response.status,
        url: response.url,
        content_type: response.contentType,
        bytes: response.bytes,
        ...(response.contentLength !== undefined ? { content_length: response.contentLength } : {}),
        // False when the size cap stopped the download.
        complete: response.complete,
        cached: response.cached,
        ...(response.headers.etag ? { etag: response.headers.etag } : {}),
        ...(response.headers['last-modified'] ? { last_modified: response.headers['last-modified'] } : {}),
        ...(response.notice ? { notice: response.notice } : {}),
    };
}

const QUERY = /([^.[\]]+)|\[(\d+|\*)\]/g;
/**
 * A small path into JSON: `data.items[0].name`, `items[*].id`, `rows.0`.
 * `*` maps the rest of the path over an array's items or an object's values.
 */
export function selectJson(value: unknown, query: string): unknown {
    const steps = [...query.matchAll(QUERY)].map((match) => match[1] ?? match[2]);
    const walk = (current: unknown, index: number): unknown => {
        if (index === steps.length || current === undefined) {
            return current;
        }
        const step = steps[index];
        if (step === '*') {
            if (current === null || typeof current !== 'object') {
                return undefined;
            }
            return Object.values(current).map((item) => walk(item, index + 1));
        }
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        return walk((current as Record<string, unknown>)[step], index + 1);
    };
    return walk(value, 0);
}

const headersInput = z
    .record(z.string(), z.string().max(512))
    .optional()
    .describe(
        `Optional request headers: only ${ALLOWED_HEADERS.join(', ')}. Cookies, Authorization and any other credentials are refused: these reads never carry the user's identity or logins.`,
    );
const maxChars = z
    .number()
    .int()
    .min(200)
    .max(MAX_CHARS)
    .optional()
    .describe(`Most characters of content to return (default ${DEFAULT_CHARS}).`);

/**
 * `http_get` and `http_json`: declared-agent reads of public URLs, with the
 * user never identified. `check` throws once the turn must stop.
 */
export function webTools(
    reads: Pick<WebReaderShape, 'read'>,
    dotId: string,
    check: () => void,
    signal: AbortSignal,
    userId?: string,
) {
    const read = async (url: string, method: 'GET' | 'HEAD', headers?: Record<string, string>) => {
        check();
        const result = await reads.read({
            dotId,
            userId,
            url,
            method,
            headers,
            signal,
        });
        check();
        return result;
    };
    return [
        defineTool({
            name: 'http_get',
            description:
                "Fetch a public HTTP(S) URL (text, HTML, JSON, CSV) with GET or HEAD as Socio's declared, user-directed agent. Returns status, content type, size and the body (truncated). Public addresses only; redirects are followed to public addresses (at most 5). Rate-limited per site; responses are cached briefly. If a site refuses (HTTP 403 or 429), reads from it pause: tell the user rather than retrying. Never send credentials or personal data in the URL.",
            parameters: z.object({
                url: z.string().url().max(2048),
                method: z.enum(['GET', 'HEAD']).optional(),
                headers: headersInput,
                max_chars: maxChars,
            }),
            execute: async ({ url, method, headers, max_chars }) => {
                const result = await read(url, method ?? 'GET', headers);
                if (!result.ok) {
                    return refusal(result);
                }
                if (method === 'HEAD') {
                    return summary(result);
                }
                if (!textual(result.contentType)) {
                    return {
                        ...summary(result),
                        body: null,
                        note: `Binary content (${result.contentType}) is not returned.`,
                    };
                }
                const limit = max_chars ?? DEFAULT_CHARS;
                const text = decode(result);
                return {
                    ...summary(result),
                    body: text.slice(0, limit),
                    truncated: text.length > limit || !result.complete,
                    ...(text.length > limit ? { body_chars: text.length } : {}),
                };
            },
        }),
        defineTool({
            name: 'http_json',
            description:
                "GET a public JSON URL (an API) as Socio's declared, user-directed agent and parse it. Use `query` to select part of the response and keep it small, e.g. `data.items[0].name` or `items[*].id`. Same rules as http_get: public addresses only, rate limits, brief caching, and a pause after a site refuses.",
            parameters: z.object({
                url: z.string().url().max(2048),
                query: z
                    .string()
                    .max(200)
                    .optional()
                    .describe(
                        'Optional path into the JSON: keys separated by dots, [n] for an index, [*] for every item.',
                    ),
                headers: headersInput,
                max_chars: maxChars,
            }),
            execute: async ({ url, query, headers, max_chars }) => {
                const result = await read(url, 'GET', {
                    accept: 'application/json',
                    ...headers,
                });
                if (!result.ok) {
                    return refusal(result);
                }
                const base = summary(result);
                if (result.status < 200 || result.status >= 300) {
                    return { ...base, body: decode(result).slice(0, 2000) };
                }
                if (!result.complete) {
                    return {
                        ...base,
                        error: `The response is larger than the ${result.bytes}-byte cap, so it can't be parsed.`,
                    };
                }
                let parsed: unknown;
                try {
                    parsed = JSON.parse(decode(result));
                } catch {
                    return {
                        ...base,
                        error: 'The response is not valid JSON.',
                        body: decode(result).slice(0, 2000),
                    };
                }
                const value = query ? selectJson(parsed, query) : parsed;
                const limit = max_chars ?? DEFAULT_CHARS;
                const json = JSON.stringify(value ?? null);
                const shape = Array.isArray(value)
                    ? { length: value.length }
                    : value && typeof value === 'object'
                      ? { keys: Object.keys(value).slice(0, 50) }
                      : {};
                if (json.length <= limit) {
                    return {
                        ...base,
                        ...(query ? { query } : {}),
                        ...(value === undefined ? { note: 'The query matched nothing.' } : {}),
                        value: value ?? null,
                    };
                }
                return {
                    ...base,
                    ...(query ? { query } : {}),
                    ...shape,
                    truncated: true,
                    value_chars: json.length,
                    preview: json.slice(0, limit),
                    note: 'The selection is larger than max_chars: narrow it with query.',
                };
            },
        }),
    ];
}

/**
 * The Dot's web-read capability, for the `capabilities` tool's registry:
 * its identity, tools, limits and the hosts that refused recently.
 */
export async function webCapabilityFor(reads: Pick<WebReaderShape, 'status'>, dotId: string): Promise<WebCapability> {
    const status = await reads.status(dotId, false);
    const identity: WebIdentity = status.identity;
    return {
        id: 'web_reads',
        title: 'Web reads',
        available: identity === 'agent',
        identity,
        tools: identity === 'agent' ? ['http_get', 'http_json'] : [],
        summary:
            identity === 'agent'
                ? `Reads public URLs with http_get/http_json as a declared agent (User-Agent "${status.userAgent}"). Nothing identifies the user.`
                : "Reads the web through the computer's browser (computer_navigate, computer_read); http_get/http_json refer there.",
        limits: status.limits,
        stoppedHosts: status.stoppedHosts,
    };
}

/** `WebCapabilities` (the contract's) over `webCapabilityFor`, on the workspace's reader. */
export const webCapabilities = (reads: Pick<WebReaderShape, 'status'>): WebCapabilitiesShape => ({
    capabilityFor: (dotId) => webCapabilityFor(reads, dotId),
});
