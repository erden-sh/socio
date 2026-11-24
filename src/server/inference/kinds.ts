import { chatGptEndpointsFromEnv, chatGptKind } from './chatgpt-kind.js';
import { claudeApiKeyKind } from './claude-api-key-kind.js';
import type { InferenceShape } from './contract.js';
import { fakeByoKind } from './fake-byo.js';

/**
 * The bring-your-own kinds, registered at boot (moved here from
 * composition/lifecycle/inference.ts, which runs it where the process entry
 * always registered them).
 */
export function registerInferenceKinds(
    inference: Pick<InferenceShape, 'register'>,
    env: Record<string, string | undefined>,
) {
    // Bring-your-own ChatGPT plans: always registered; users can connect one
    // only once an operator allows the kind on the Platform page.
    const chatGptEndpoints = chatGptEndpointsFromEnv(env);
    if (chatGptEndpoints) {
        console.warn(
            'Inference: CHATGPT_AUTH_ISSUER/CHATGPT_BASE_URL point ChatGPT connections at a test server (testing only; unset them in deployments).',
        );
    }
    inference.register(chatGptKind({ endpoints: chatGptEndpoints }));
    // A bring-your-own Claude API key (per-user providers): the owner's
    // decision is that Claude is API-key-only. Active only
    // where the operator allowlists `byo-claude-key`.
    inference.register(claudeApiKeyKind());
    // Testing only: a stand-in bring-your-own kind on a local fake model server.
    const fakeByoUrl = env.INFERENCE_FAKE_BYO_URL?.trim();
    if (fakeByoUrl) {
        inference.register(fakeByoKind({ baseUrl: fakeByoUrl }));
    }
}
