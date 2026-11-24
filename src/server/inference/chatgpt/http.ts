import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import { CHATGPT_ENDPOINTS, CODEX_ORIGINATOR, CODEX_USER_AGENT, type ChatGptEndpoints } from './endpoints.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ChatGptHttpOptions {
    /** Defaults to the global fetch. Tests pass one bound to a loopback fake. */
    fetch?: FetchLike;
    /** Defaults to OpenAI's hosts ({@link CHATGPT_ENDPOINTS}). */
    endpoints?: Partial<ChatGptEndpoints>;
}

export const endpointsOf = (options: ChatGptHttpOptions): ChatGptEndpoints => ({
    ...CHATGPT_ENDPOINTS,
    ...options.endpoints,
});
export const fetchOf = (options: ChatGptHttpOptions): FetchLike => options.fetch ?? ((url, init) => fetch(url, init));

export const AUTH_TIMEOUT_MS = 20_000;

export const isAbort = (error: unknown) =>
    error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

/**
 * One POST to the auth server, JSON or form-encoded as the CLI sends it. The
 * answer's body is read whole (token responses are small) and never logged.
 * Network failures become `chatgpt_unavailable`; a caller's abort is rethrown.
 */
export async function authPost(
    options: ChatGptHttpOptions,
    url: string,
    body: Record<string, string>,
    { form = false, originator = false, signal }: { form?: boolean; originator?: boolean; signal?: AbortSignal } = {},
): Promise<{ status: number; text: string }> {
    const timeout = AbortSignal.timeout(AUTH_TIMEOUT_MS);
    try {
        const response = await fetchOf(options)(url, {
            method: 'POST',
            headers: {
                'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
                Accept: 'application/json',
                'User-Agent': CODEX_USER_AGENT,
                ...(originator ? { originator: CODEX_ORIGINATOR } : {}),
            },
            body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
            redirect: 'error',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        return { status: response.status, text: await response.text() };
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        throw new ChatGptError('chatgpt_unavailable', {
            providerCode: isAbort(error) ? 'timeout' : 'network',
        });
    }
}
