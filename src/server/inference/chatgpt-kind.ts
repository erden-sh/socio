import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import type { ChatGptHttpOptions } from './chatgpt/http.js';
import {
    CHATGPT_DEFAULT_MODEL,
    CHATGPT_STANDARD_MODEL,
    blobStatus,
    createChatGptByoKind,
    publicStatus,
    readBlob,
    type ByoConnectionContext,
    type ChatGptByoKind,
    type ChatGptEndpoints,
} from './chatgpt/index.js';
import { CHATGPT_OUTPUT_RESERVE } from './chatgpt/models.js';
import { chatGptTransport } from './chatgpt/transport.js';
import type { ByoConnection, ByoConnectionAccess, ByoKind } from './contract.js';
import { ByoError } from './types.js';

export const CHATGPT_KIND = 'byo-chatgpt';

/** Non-secret facts stored beside the sealed blob: the plan's display name. */
const metaOf = (blob: unknown) => {
    const plan = publicStatus(readBlob(blob)?.credentials).plan;
    return plan ? { plan } : {};
};

/**
 * The ChatGPT context on the registry's connection store: `load` reads the
 * decrypted blob, `save` seals and replaces it in one unit of work (rotated
 * refresh tokens included). For a turn (`whileConnected`), a save after the
 * user disconnected is dropped instead of bringing the connection back.
 */
function contextOf(access: ByoConnectionAccess, { whileConnected = false } = {}): ByoConnectionContext {
    return {
        userId: access.userId,
        load: async () => (await access.connection())?.credentials,
        save: async (blob) => {
            await access.save(blob, metaOf(blob), { whileConnected });
        },
        remove: () => access.remove(),
    };
}

/** A stored connection alone: for `disconnect`, after which the registry deletes the row. */
const storedContext = (connection: ByoConnection): ByoConnectionContext => ({
    userId: connection.userId,
    load: async () => connection.credentials,
    save: async () => {},
    remove: async () => {},
});

/** The ChatGPT kind's failures before a turn (starting a sign-in) as the account dialog shows them. */
function connectFailure(error: unknown): never {
    if (error instanceof ChatGptError) {
        throw new ByoError(error.message, error.code === 'chatgpt_rate_limited' ? 429 : 502);
    }
    throw error;
}

const CONNECT_MESSAGE = 'Open the sign-in page, sign in to ChatGPT and enter this code.';

/**
 * Bring-your-own ChatGPT plan (`chatgpt/`) as a kind of the inference
 * registry. Connect is the Codex CLI's device-code sign-in: the first step
 * answers the code, later polls keep answering it until the user has
 * entered it, then the credentials are sealed in the user's connection. Turns refresh
 * the token first (single flight per connection) and fall back to the
 * shared backend when the connection can't serve. `endpoints` exist for
 * tests and local smoke runs (a loopback fake), never for deployments.
 */
export function chatGptKind(options: ChatGptHttpOptions & { now?: () => number } = {}): ByoKind {
    const chatgpt: ChatGptByoKind = createChatGptByoKind(options);
    return {
        id: CHATGPT_KIND,
        label: 'ChatGPT',
        description:
            'Your own ChatGPT plan (Plus, Pro, Business…), signed in with a code like the Codex CLI. Chats use your plan’s Codex limits.',
        models: {
            choices: chatgpt.listModels().map(({ id, label, description }) => ({
                id,
                label,
                description,
            })),
            default: CHATGPT_DEFAULT_MODEL,
            help: `${CHATGPT_DEFAULT_MODEL} is the Codex CLI’s default. If chats on ChatGPT plans fail with “model not available”, choose ${CHATGPT_STANDARD_MODEL}: the CLI sends newer models a request shape this server doesn’t use.`,
        },

        async connect(access, body) {
            const context = contextOf(access);
            // Gives up a sign-in in progress; a stored connection stays as it is.
            if ((body as { cancel?: unknown } | null)?.cancel) {
                chatgpt.cancelConnect(access.userId);
                return { state: 'disconnected' };
            }
            const pending = chatgpt.pending(access.userId);
            if (!pending) {
                const started = await chatgpt.startConnect(context).catch(connectFailure);
                return {
                    state: 'pending',
                    userCode: started.userCode,
                    verificationUrl: started.verificationUrl,
                    message: CONNECT_MESSAGE,
                    pollMs: chatgpt.pending(access.userId)?.pollMs,
                };
            }
            const polled = await chatgpt.pollConnect(context);
            if (polled.state === 'connected') {
                return { state: 'connected' };
            }
            if (polled.state === 'failed') {
                return { state: 'error', message: polled.message };
            }
            if (polled.state === 'none') {
                return {
                    state: 'error',
                    message: 'The sign-in code expired. Start again to get a new code.',
                };
            }
            return {
                state: 'pending',
                userCode: pending.userCode,
                verificationUrl: pending.verificationUrl,
                message: CONNECT_MESSAGE,
                pollMs: pending.pollMs,
            };
        },

        status(connection) {
            const status = blobStatus(connection.credentials);
            if (status.state === 'connected') {
                return {
                    state: 'connected',
                    ...(status.plan ? { detail: `Plan: ${status.plan}` } : {}),
                };
            }
            if (status.state === 'needs_reconnect') {
                return {
                    state: 'expired',
                    detail: 'Sign in again: ChatGPT ended this sign-in.',
                };
            }
            return {
                state: 'error',
                detail: 'This connection can’t be used; disconnect and connect again.',
            };
        },

        // Revokes the refresh token, best effort; the registry deletes the row either way.
        disconnect: (connection) => {
            chatgpt.cancelConnect(connection.userId);
            return chatgpt.disconnect(storedContext(connection));
        },

        async adapterFor(connection, access, settings) {
            if (!readBlob(connection.credentials)?.credentials) {
                return undefined;
            }
            const context = contextOf(access, { whileConnected: true });
            if (!(await chatgpt.prepare(context))) {
                return undefined;
            }
            const model = settings.model ?? CHATGPT_DEFAULT_MODEL;
            const { acceptsImages, contextWindow, outputReserve } = chatgpt.capabilities(model);
            const plan = publicStatus(readBlob(await context.load())?.credentials).plan;
            return {
                source: { type: 'byo', kind: CHATGPT_KIND },
                label: plan ? `ChatGPT (${plan})` : 'ChatGPT',
                model,
                capabilities: { acceptsImages, contextWindow, outputReserve },
                adapter: () => chatgpt.adapterFor(context, { model }),
                // The Codex request carries no completion cap or sampling fields.
                modelOptions: {},
            };
        },

        // A coding session's model calls on the person's own plan (CB-239),
        // through the model gateway: the token stays here.
        async codingTransport(connection, access, settings) {
            if (!readBlob(connection.credentials)?.credentials) {
                return undefined;
            }
            const context = contextOf(access, { whileConnected: true });
            if (!(await chatgpt.prepare(context))) {
                return undefined;
            }
            const model = settings.model ?? CHATGPT_DEFAULT_MODEL;
            const plan = publicStatus(readBlob(await context.load())?.credentials).plan;
            return {
                model,
                label: plan ? `ChatGPT (${plan})` : 'ChatGPT',
                acceptsImages: chatgpt.capabilities(model).acceptsImages,
                maxOutputTokens: CHATGPT_OUTPUT_RESERVE,
                send: chatGptTransport({
                    ...options,
                    getCredentials: async () => readBlob(await context.load())?.credentials,
                    saveCredentials: (credentials) => context.save({ version: 1, credentials }),
                    markNeedsRelogin: () => context.save({ version: 1, needsRelogin: true }),
                }),
            };
        },
    };
}

/**
 * Testing only: `CHATGPT_AUTH_ISSUER` and `CHATGPT_BASE_URL` point the kind
 * at a local fake ChatGPT (auth server and Codex backend) instead of
 * auth.openai.com and chatgpt.com. Undefined when neither is set.
 */
export function chatGptEndpointsFromEnv(
    env: Record<string, string | undefined>,
): Partial<ChatGptEndpoints> | undefined {
    const issuer = env.CHATGPT_AUTH_ISSUER?.trim();
    const codexBaseUrl = env.CHATGPT_BASE_URL?.trim();
    if (!issuer && !codexBaseUrl) {
        return undefined;
    }
    return {
        ...(issuer ? { issuer } : {}),
        ...(codexBaseUrl ? { codexBaseUrl } : {}),
    };
}
