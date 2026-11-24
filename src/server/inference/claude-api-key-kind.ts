import type { ByoConnection, ByoKind } from './contract.js';
import { ByoError } from './types.js';

/**
 * A bring-your-own Claude API key (per-user providers): the owner's decision is
 * that Claude is API-key-only (Anthropic's terms forbid intermediating
 * Claude.ai credentials; an API key is allowed). The connect flow is just
 * "paste your API key" — no OAuth, no device code. The key is sealed in the
 * per-person connection store (`user_inference_connections` under
 * `inference-credentials`), the same store byo-chatgpt uses: sealed per person,
 * gateway-injected, the sandbox never holds it.
 *
 * The kind's `codingTransport` forwards to Anthropic's Messages API with the
 * user's key as `x-api-key` — not a plan session token. This is the first
 * kind that speaks Messages (not Responses), so the gateway's Responses-only
 * restriction on a byo upstream is lifted for api-key kinds.
 */

export const CLAUDE_API_KEY_KIND = 'byo-claude-key';

/** The model an operator may pick for a Claude API key. */
const CLAUDE_MODELS = {
    choices: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    ],
    default: 'claude-sonnet-5-5',
    help: 'Claude Sonnet 5.5 is the default. Pick Opus 5.5 for harder work (higher cost).',
} as const;

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

interface ApiKeyCredentials {
    apiKey: string;
}

function readKey(connection: ByoConnection | undefined): string | undefined {
    const credentials = connection?.credentials as ApiKeyCredentials | undefined;
    return credentials?.apiKey?.trim() || undefined;
}

/**
 * The bring-your-own Claude API key as a kind of the inference registry.
 * Connect stores the key (sealed); status is connected when one is stored;
 * `adapterFor` serves chat turns; `codingTransport` forwards a coding
 * session's Messages request with the key as `x-api-key`.
 */
export function claudeApiKeyKind(options: { fetch?: typeof fetch } = {}): ByoKind {
    const doFetch = options.fetch ?? fetch;
    return {
        id: CLAUDE_API_KEY_KIND,
        label: 'Claude API key',
        description:
            'Your own Anthropic API key (not a Claude.ai plan). Chats and coding sessions use your key’s allowance.',
        models: CLAUDE_MODELS,

        async connect(access, body) {
            const cancel = !!(body as { cancel?: unknown } | null)?.cancel;
            if (cancel) {
                await access.remove();
                return { state: 'disconnected' };
            }
            const key = (body as { apiKey?: unknown } | null)?.apiKey;
            if (typeof key !== 'string' || !key.trim()) {
                throw new ByoError('Give your Anthropic API key to connect.', 400);
            }
            await access.save({ apiKey: key.trim() }, { plan: 'Claude API key' });
            return { state: 'connected' };
        },

        status(connection) {
            return readKey(connection)
                ? { state: 'connected', detail: 'Connected with your Anthropic API key.' }
                : { state: 'disconnected' };
        },

        disconnect: undefined,

        async adapterFor() {
            // Chat turns are not served by this kind yet: a Claude API key
            // speaks the Messages API, which needs a TanStack text adapter this
            // build doesn't wire (chat stays on the shared backend). The kind
            // serves coding sessions through `codingTransport` below — the
            // path per-user providers generalizes. Conservative option.
            return undefined;
        },

        // A coding session's model calls on the person's own Claude API key
        // (per-user providers), through the model gateway: the key stays here.
        // Forwards a Messages body with `x-api-key`, not a plan session token.
        async codingTransport(connection, _access, settings) {
            const apiKey = readKey(connection);
            if (!apiKey) {
                return undefined;
            }
            const model = settings.model ?? CLAUDE_MODELS.default;
            return {
                model,
                label: 'Claude API key',
                acceptsImages: true,
                maxOutputTokens: 4096,
                api: 'messages',
                send: async (body, signal) => {
                    // The gateway has rebuilt the body from checked fields
                    // (messages-request.ts); forward it as-is with the key.
                    return doFetch(ANTHROPIC_MESSAGES_URL, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            accept: 'application/json',
                            'anthropic-version': ANTHROPIC_VERSION,
                            'x-api-key': apiKey,
                        },
                        body,
                        redirect: 'error',
                        ...(signal ? { signal } : {}),
                    });
                },
            };
        },
    };
}
