import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import type { ChatGptCredentials } from './credentials.js';
import { CODEX_ORIGINATOR, CODEX_USER_AGENT, responsesUrl } from './endpoints.js';
import { endpointsOf, fetchOf, type ChatGptHttpOptions } from './http.js';
import { ensureFresh, type SaveCredentials } from './refresh.js';

/**
 * One POST of a Responses body to the ChatGPT backend the Codex CLI uses
 * on a ChatGPT plan, with the person's access token and account id and
 * the CLI's `originator` (`model-provider/src/bearer_auth_provider.rs`).
 * No other header: nothing about the person beyond what the plan's own
 * sign-in carries, a fixed User-Agent, no redirects. A network failure is
 * `chatgpt_unavailable`; the caller's abort is rethrown.
 */
export async function postResponses(
    options: ChatGptHttpOptions,
    credentials: ChatGptCredentials,
    body: string,
    signal?: AbortSignal,
): Promise<Response> {
    try {
        return await fetchOf(options)(responsesUrl(endpointsOf(options).codexBaseUrl), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${credentials.accessToken}`,
                'ChatGPT-Account-ID': credentials.accountId,
                originator: CODEX_ORIGINATOR,
                'User-Agent': CODEX_USER_AGENT,
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
            },
            body,
            redirect: 'error',
            ...(signal ? { signal } : {}),
        });
    } catch (error) {
        if (signal?.aborted) {
            throw error;
        }
        throw new ChatGptError('chatgpt_unavailable', { providerCode: 'network' });
    }
}

export interface ChatGptTransportOptions extends ChatGptHttpOptions {
    /** The person's credentials, decrypted, read for every request. */
    getCredentials: () => Promise<ChatGptCredentials | undefined>;
    /** Persists rotated credentials (before they are used). */
    saveCredentials: SaveCredentials;
    /** Marks the connection as needing a new sign-in. */
    markNeedsRelogin?: () => Promise<void>;
}

/**
 * The model gateway's raw transport to a person's ChatGPT plan (CB-239):
 * the gateway has already rebuilt the body from checked fields
 * (responses-request.ts) and streams the answer back as it comes. The
 * credentials are read per request, refreshed when near expiry (rotations
 * saved first), and on a 401 refreshed once and sent once more, as the CLI
 * does; a second 401 marks the connection for a new sign-in and is
 * returned as is, for the gateway to answer without its body. The token
 * lives only in this process: never in the sandbox, which holds its
 * session's `cbgw_`.
 */
export function chatGptTransport(options: ChatGptTransportOptions) {
    const refreshOptions = {
        fetch: options.fetch,
        endpoints: options.endpoints,
        markNeedsRelogin: options.markNeedsRelogin,
    };
    return async (body: string, signal?: AbortSignal): Promise<Response> => {
        const stored = await options.getCredentials();
        if (!stored) {
            throw new ChatGptError('chatgpt_not_connected');
        }
        let credentials = await ensureFresh(stored, options.saveCredentials, refreshOptions);
        let response = await postResponses(options, credentials, body, signal);
        if (response.status !== 401) {
            return response;
        }
        await response.body?.cancel().catch(() => {});
        credentials = await ensureFresh(credentials, options.saveCredentials, {
            ...refreshOptions,
            force: true,
        });
        response = await postResponses(options, credentials, body, signal);
        if (response.status === 401) {
            await options.markNeedsRelogin?.().catch(() => {});
        }
        return response;
    };
}
