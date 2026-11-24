/**
 * Bring-your-own ChatGPT plan (release 3): a user signs in with the Codex
 * CLI's device-code flow, and their Dot turns run on their plan through the
 * backend the CLI uses.
 *
 * The interface below was assumed while the registry was built in parallel;
 * `../chatgpt-kind.ts` adapts it to the registry's `ByoKind` (connect steps,
 * a sync status, the store's sealed blob). What it assumed:
 *
 * - A BYO kind is `{ id, label, startConnect, pollConnect, status,
 *   disconnect, adapterFor }`; every hook gets a {@link ByoConnectionContext}
 *   for one user's connection of this kind.
 * - The context's `load`/`save`/`remove` read and write that user's
 *   encrypted connection blob (encrypted at rest under the data key, or
 *   the legacy key from `SESSION_SECRET`, decrypted only in memory). The
 *   blob is opaque to the registry; this module defines it
 *   ({@link ChatGptConnectionBlob}). `save`
 *   must replace the blob atomically: a refresh saves rotated credentials
 *   before using them.
 * - `startConnect`/`pollConnect`/`status` results are safe to send to the
 *   client as they are: no tokens, ids, names or emails.
 * - `adapterFor` returns a TanStack AI text adapter for `chat({ adapter })`,
 *   used in place of `openaiCompatibleText(...)` for that user's turns.
 *   `capabilities(model)` gives what the backend interface reports.
 * - A failed turn's RUN_ERROR carries a `chatgpt_*` code and a friendly
 *   message; `chatGptFailure(error)` recognizes it so the runtime can show
 *   that message instead of the generic one.
 */
import { z } from 'zod';

import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';

import { chatGptAdapter, chatGptCapabilities, type ChatGptTextAdapter } from './adapter.js';
import { publicStatus, type ChatGptCredentials } from './credentials.js';
import type { ChatGptHttpOptions } from './http.js';
import { startLogin, type DeviceLogin, type LoginFailure } from './login.js';
import { listModels, type ChatGptModel } from './models.js';
import { ensureFresh, revoke } from './refresh.js';

export { ChatGptTextAdapter, chatGptAdapter, chatGptCapabilities, type ChatGptAdapterOptions } from './adapter.js';
export { publicStatus, type ChatGptCredentials, type ChatGptPublicStatus } from './credentials.js';
export { CHATGPT_ENDPOINTS, type ChatGptEndpoints } from './endpoints.js';
export { redactSecrets } from './errors.js';
export { startLogin, type DeviceLogin, type LoginFailure, type LoginPoll } from './login.js';
export {
    CHATGPT_DEFAULT_MODEL,
    CHATGPT_MODELS,
    CHATGPT_STANDARD_MODEL,
    listModels,
    type ChatGptModel,
} from './models.js';
export { ensureFresh, revoke, type SaveCredentials } from './refresh.js';

/** One user's connection of one BYO kind, as the registry hands it to a hook. */
export interface ByoConnectionContext {
    /** The app user who owns the connection. Never sent to any outside service. */
    userId: string;
    /** The decrypted connection blob, or undefined when there is none. */
    load(): Promise<unknown>;
    /** Encrypts and stores the blob, replacing the previous one atomically. */
    save(blob: unknown): Promise<void>;
    /** Deletes the blob. */
    remove(): Promise<void>;
}

/** What this kind stores (encrypted) per user. */
export interface ChatGptConnectionBlob {
    version: 1;
    credentials?: ChatGptCredentials;
    /** The sign-in can't be refreshed any more; the user must connect again. */
    needsRelogin?: true;
}

export type ConnectionState = 'not_connected' | 'connecting' | 'connected' | 'needs_reconnect';

export interface ConnectionStatus {
    state: ConnectionState;
    /** e.g. "Connected · plan: Plus". */
    label: string;
    plan?: string;
}

export interface ConnectStart {
    userCode: string;
    verificationUrl: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

export type ConnectPoll =
    | { state: 'pending' }
    | { state: 'connected'; status: ConnectionStatus }
    | { state: 'failed'; error: LoginFailure; message: string }
    | { state: 'none' };

/** A sign-in in progress, for a registry that shows its code on every poll. */
export interface PendingConnect extends ConnectStart {
    /** How often to poll (the auth server's interval). */
    pollMs: number;
}

export interface ChatGptByoKind {
    readonly id: 'byo-chatgpt';
    readonly label: string;
    startConnect(context: ByoConnectionContext): Promise<ConnectStart>;
    pollConnect(context: ByoConnectionContext): Promise<ConnectPoll>;
    /** The user's sign-in in progress, if any (in memory; no request). */
    pending(userId: string): PendingConnect | undefined;
    /** Gives up the user's sign-in in progress; a stored connection stays. */
    cancelConnect(userId: string): void;
    status(context: ByoConnectionContext): Promise<ConnectionStatus>;
    /**
     * Refreshes the stored credentials if they are near expiry (single
     * flight, rotations saved first). False when they can't serve a turn:
     * none stored, the sign-in ended (marked for a new one), or ChatGPT's
     * auth server can't be reached and the access token has expired.
     */
    prepare(context: ByoConnectionContext): Promise<boolean>;
    disconnect(context: ByoConnectionContext): Promise<void>;
    adapterFor(context: ByoConnectionContext, options?: { model?: string }): ChatGptTextAdapter;
    capabilities(model?: string): ReturnType<typeof chatGptCapabilities>;
    listModels(): readonly ChatGptModel[];
}

const credentialsSchema = z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    idToken: z.string().optional(),
    accountId: z.string().min(1),
    planType: z.string().optional(),
    expiresAt: z.number(),
});
const blobSchema = z.object({
    version: z.literal(1),
    credentials: credentialsSchema.optional(),
    needsRelogin: z.literal(true).optional(),
});

/** The stored blob, or undefined if absent or not this kind's shape. */
export function readBlob(blob: unknown): ChatGptConnectionBlob | undefined {
    const parsed = blobSchema.safeParse(blob);
    if (!parsed.success) {
        return undefined;
    }
    const { credentials, needsRelogin } = parsed.data;
    return {
        version: 1,
        ...(credentials && !needsRelogin ? { credentials } : {}),
        ...(needsRelogin ? { needsRelogin } : {}),
    };
}

const connected = (credentials: ChatGptCredentials): ConnectionStatus => {
    const status = publicStatus(credentials);
    return {
        state: 'connected',
        label: status.label,
        ...(status.plan ? { plan: status.plan } : {}),
    };
};

/** A stored blob's status, offline and without a sign-in in progress. */
export function blobStatus(blob: unknown): ConnectionStatus {
    const read = readBlob(blob);
    if (read?.credentials) {
        return connected(read.credentials);
    }
    if (read?.needsRelogin) {
        return { state: 'needs_reconnect', label: 'Sign in to ChatGPT again' };
    }
    return { state: 'not_connected', label: 'Not connected' };
}

/**
 * The ChatGPT BYO kind. Sign-ins in progress are held in memory, one per
 * user, until they finish or expire (a restart drops them; the user starts
 * again). `options` exist for tests (loopback fake endpoints and fetch).
 */
export function createChatGptByoKind(options: ChatGptHttpOptions & { now?: () => number } = {}): ChatGptByoKind {
    const now = options.now ?? Date.now;
    const logins = new Map<string, DeviceLogin>();
    const prune = () => {
        for (const [userId, login] of logins) {
            if (login.expiresAt <= now()) {
                logins.delete(userId);
            }
        }
    };
    const markNeedsRelogin = (context: ByoConnectionContext) => () =>
        context.save({
            version: 1,
            needsRelogin: true,
        } satisfies ChatGptConnectionBlob);

    return {
        id: 'byo-chatgpt',
        label: 'ChatGPT (your plan)',

        async startConnect(context) {
            prune();
            const login = await startLogin(options);
            logins.set(context.userId, login);
            return {
                userCode: login.userCode,
                verificationUrl: login.verificationUrl,
                expiresAt: login.expiresAt,
            };
        },

        async pollConnect(context) {
            const login = logins.get(context.userId);
            if (!login) {
                return { state: 'none' };
            }
            const result = await login.poll();
            if (result === 'pending') {
                return { state: 'pending' };
            }
            if (logins.get(context.userId) === login) {
                logins.delete(context.userId);
            }
            if ('error' in result) {
                return {
                    state: 'failed',
                    error: result.error,
                    message: result.message,
                };
            }
            await context.save({
                version: 1,
                credentials: result.credentials,
            } satisfies ChatGptConnectionBlob);
            return { state: 'connected', status: connected(result.credentials) };
        },

        pending(userId) {
            prune();
            const login = logins.get(userId);
            return (
                login && {
                    userCode: login.userCode,
                    verificationUrl: login.verificationUrl,
                    expiresAt: login.expiresAt,
                    pollMs: login.intervalMs,
                }
            );
        },

        cancelConnect(userId) {
            logins.delete(userId);
        },

        async status(context) {
            prune();
            const status = blobStatus(await context.load());
            if (status.state !== 'connected' && logins.has(context.userId)) {
                return { state: 'connecting', label: 'Waiting for ChatGPT sign-in' };
            }
            return status;
        },

        async prepare(context) {
            const credentials = readBlob(await context.load())?.credentials;
            if (!credentials) {
                return false;
            }
            try {
                await ensureFresh(credentials, (next) => context.save({ version: 1, credentials: next }), {
                    ...options,
                    markNeedsRelogin: markNeedsRelogin(context),
                });
                return true;
            } catch (error) {
                if (error instanceof ChatGptError) {
                    return false;
                }
                throw error;
            }
        },

        async disconnect(context) {
            logins.delete(context.userId);
            const blob = readBlob(await context.load());
            try {
                if (blob?.credentials) {
                    await revoke(blob.credentials, options);
                }
            } finally {
                await context.remove();
            }
        },

        adapterFor(context, adapterOptions = {}) {
            return chatGptAdapter({
                ...options,
                model: adapterOptions.model,
                getCredentials: async () => readBlob(await context.load())?.credentials,
                saveCredentials: (credentials) =>
                    context.save({
                        version: 1,
                        credentials,
                    } satisfies ChatGptConnectionBlob),
                markNeedsRelogin: markNeedsRelogin(context),
            });
        },

        capabilities: chatGptCapabilities,
        listModels,
    };
}

export const chatGptByoKind = createChatGptByoKind();
