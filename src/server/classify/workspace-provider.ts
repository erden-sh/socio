import { endpointOf, type EndpointSource } from '@socio/foundation/inference/endpoints';

import type { ClassifyProvider, ProviderReply } from './contract.js';

/**
 * The `workspace` provider (CB-198): the workspace's own model, the
 * default shared backend, as titles, triage and Learning use it, over
 * Chat Completions. Its version is the backend's model name: another
 * model is another version, which needs its own evaluation. The answer
 * is asked for as plain JSON in the reply (some servers reject
 * `response_format`); the seam validates it.
 */
export function workspaceProvider(
    endpoint: EndpointSource,
    fetchImpl: typeof fetch = (...args) => fetch(...args),
): ClassifyProvider {
    return {
        id: 'workspace',
        async version() {
            return (await endpointOf(endpoint))?.model || undefined;
        },
        async complete(request): Promise<ProviderReply> {
            const found = await endpointOf(endpoint);
            if (!found) {
                throw new Error('No shared backend is set up.');
            }
            const response = await fetchImpl(`${found.baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${found.apiKey ?? ''}`,
                },
                signal: request.signal,
                redirect: 'error',
                body: JSON.stringify({
                    ...found.titleModelOptions,
                    model: found.model,
                    max_completion_tokens: request.maxTokens,
                    messages: [
                        { role: 'system', content: request.system },
                        { role: 'user', content: request.user },
                    ],
                }),
            });
            if (!response.ok) {
                throw Object.assign(new Error('The model could not be reached.'), {
                    status: response.status,
                });
            }
            const body = (await response.json()) as {
                choices?: { message?: { content?: unknown } }[];
                usage?: {
                    prompt_tokens?: unknown;
                    completion_tokens?: unknown;
                    cost?: unknown;
                };
            };
            const count = (value: unknown) =>
                typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
            return {
                text: body.choices?.[0]?.message?.content,
                inputTokens: count(body.usage?.prompt_tokens),
                outputTokens: count(body.usage?.completion_tokens),
                // OpenRouter-style servers report the call's cost; others don't.
                costUsd: count(body.usage?.cost),
            };
        },
    };
}
