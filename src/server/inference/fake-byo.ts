import { randomBytes } from 'node:crypto';

import type { ByoKind } from './contract.js';
import { openAICompatibleModel } from './openai-compatible.js';

export const FAKE_BYO_KIND = 'byo-fake';

/**
 * A stand-in bring-your-own kind for tests and local smoke runs, never for
 * deployments: `INFERENCE_FAKE_BYO_URL` registers it, pointed at a local
 * fake OpenAI-compatible server. Its connect flow mimics a device-code
 * login (the first step is `pending` with a code, the next one connects),
 * which is the shape the ChatGPT kind follows.
 */
export function fakeByoKind(options: { baseUrl: string; model?: string }): ByoKind {
    const model = options.model ?? 'fake-subscription';
    return {
        id: FAKE_BYO_KIND,
        label: 'Fake subscription',
        description: 'A local stand-in for a personal subscription (testing).',
        connect: async (access, body) => {
            const cancel = !!(body as { cancel?: unknown } | null)?.cancel;
            const current = (await access.connection())?.credentials as
                | { pending?: boolean; token?: string }
                | undefined;
            if (cancel) {
                if (current?.pending) {
                    await access.remove();
                }
                return { state: 'disconnected' };
            }
            if (!current?.pending) {
                await access.save({ pending: true }, {});
                return {
                    state: 'pending',
                    userCode: 'FAKE-0000',
                    message: 'Confirm the code to finish connecting.',
                    pollMs: 500,
                };
            }
            await access.save({ token: randomBytes(16).toString('base64url') }, { account: 'Fake plan' });
            return { state: 'connected' };
        },
        status: (connection) => {
            const credentials = connection.credentials as { pending?: boolean };
            return credentials.pending
                ? { state: 'pending', detail: 'Waiting for the code to be confirmed.' }
                : { state: 'connected', detail: 'Connected to the fake plan.' };
        },
        adapterFor: (connection) => {
            const { token } = connection.credentials as { token?: string };
            if (!token) {
                return undefined;
            }
            return openAICompatibleModel({
                source: { type: 'byo', kind: FAKE_BYO_KIND },
                label: 'Fake subscription',
                baseUrl: options.baseUrl,
                model,
                apiKey: token,
                capabilities: { acceptsImages: false },
            });
        },
    };
}
