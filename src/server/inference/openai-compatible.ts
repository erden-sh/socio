import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';

import { safeFailure } from '@socio/foundation/observability/failures';
import { withLengthFinish } from '@socio/foundation/turns/output-limit';
import { withReasoningLifecycle } from '@socio/foundation/turns/reasoning-lifecycle';
import { withNumberedToolCalls } from '@socio/foundation/turns/tool-call-args';
import type { InferenceCapabilities } from '@socio/shared/inference';
import { OPENAI_COMPATIBLE } from '@socio/shared/inference';
import { withReasoningOutput } from '@socio/shared/reasoning-output';

import type {
    ChatCompletionsEndpoint,
    InferenceModel,
    InferenceResolver,
    ModelSettings,
    SettingsInferenceShape,
} from './contract.js';
import type { BackendFields } from './store.js';

/** The completion cap of a Dot turn when the backend sets none. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 2200;

/**
 * The model of an OpenAI-compatible endpoint: today's path (Chat
 * Completions through TanStack AI), unchanged. Without a key the SDK, which
 * needs one, gets a placeholder; keyless servers ignore it.
 */
export function openAICompatibleModel(endpoint: {
    source: InferenceModel['source'];
    label: string;
    baseUrl: string;
    model: string;
    apiKey?: string;
    capabilities: InferenceCapabilities;
    titleModelOptions?: Record<string, unknown>;
}): InferenceModel {
    const { baseUrl, model, apiKey, capabilities } = endpoint;
    const chatCompletions: ChatCompletionsEndpoint = {
        baseUrl,
        apiKey,
        model,
        maxCompletionTokens: capabilities.maxCompletionTokens,
        titleModelOptions: endpoint.titleModelOptions,
    };
    return {
        source: endpoint.source,
        label: endpoint.label,
        model,
        capabilities,
        // A turn's own retries replace the client's (`maxRetries: 0`); the one-shot
        // callers (approvals, notes) keep its one.
        // Reasoning these servers stream is the model's own thinking
        // (`reasoning_content`, `<think>`): `raw` (CB-185). Its events are
        // kept well formed last, over what the other wrappers pass on.
        adapter: (options) =>
            withReasoningOutput(
                withReasoningLifecycle(
                    withLengthFinish(
                        withNumberedToolCalls(
                            openaiCompatibleText(model, {
                                apiKey: apiKey || 'unused',
                                baseURL: baseUrl,
                                api: 'chat-completions',
                                maxRetries: options?.maxRetries ?? 1,
                            }),
                        ),
                    ),
                ),
                'raw',
            ),
        modelOptions: {
            max_completion_tokens: capabilities.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        },
        chatCompletions,
    };
}

/** The first backend's fields from the environment's model settings. */
export function backendFromSettings(settings: ModelSettings): BackendFields {
    return {
        kind: OPENAI_COMPATIBLE,
        label: settings.model ? `Self-hosted (${settings.model})` : 'Self-hosted',
        enabled: true,
        config: {
            baseUrl: settings.baseUrl,
            model: settings.model ?? '',
            ...(settings.titleModelOptions ? { titleModelOptions: settings.titleModelOptions } : {}),
        },
        capabilities: capabilitiesOf(settings),
        apiKey: settings.apiKey || null,
    };
}

const capabilitiesOf = (settings: ModelSettings): InferenceCapabilities => ({
    acceptsImages: !!settings.acceptsImages,
    ...(settings.maxImages ? { maxImages: settings.maxImages } : {}),
    ...(settings.maxCompletionTokens ? { maxCompletionTokens: settings.maxCompletionTokens } : {}),
    ...(settings.contextWindow ? { contextWindow: settings.contextWindow } : {}),
});

/**
 * A fixed resolver from model settings, for code that runs without the
 * platform's registry (tests, stand-alone agents). Needs all of URL, key and
 * model, as the environment did; otherwise every turn is `not_configured`.
 */
export function settingsInference(settings: ModelSettings): InferenceResolver {
    return {
        resolve: async () =>
            settings.baseUrl && settings.apiKey && settings.model
                ? {
                      ok: true,
                      model: openAICompatibleModel({
                          source: { type: 'shared', backendId: 'settings' },
                          label: settings.model,
                          baseUrl: settings.baseUrl,
                          model: settings.model,
                          apiKey: settings.apiKey,
                          capabilities: capabilitiesOf(settings),
                          titleModelOptions: settings.titleModelOptions,
                      }),
                  }
                : { ok: false, reason: 'not_configured' },
    };
}

/** The contract's `SettingsInference`: `settingsInference`, as it is. */
export const settingsResolvers: SettingsInferenceShape = { resolver: settingsInference };

const positive = (max: number) => z.number().int().min(1).max(max);

/** An operator's create or edit of an `openai-compatible` backend. */
export const backendInput = z
    .object({
        label: z.string().trim().min(1).max(80),
        enabled: z.boolean().optional(),
        baseUrl: z
            .string()
            .trim()
            .max(2048)
            .url()
            .refine((value) => /^https?:\/\//i.test(value), 'http(s) only'),
        model: z.string().trim().min(1).max(200),
        apiKey: z.string().trim().max(4096).nullable().optional(),
        acceptsImages: z.boolean().optional(),
        maxImages: positive(32).nullable().optional(),
        maxCompletionTokens: positive(1_000_000).nullable().optional(),
        contextWindow: z.number().int().min(1_024).max(10_000_000).nullable().optional(),
        titleModelOptions: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .strict();

export function fieldsOf(input: z.infer<typeof backendInput>, enabled: boolean): BackendFields {
    return {
        kind: OPENAI_COMPATIBLE,
        label: input.label,
        enabled: input.enabled ?? enabled,
        config: {
            baseUrl: input.baseUrl,
            model: input.model,
            ...(input.titleModelOptions ? { titleModelOptions: input.titleModelOptions } : {}),
        },
        capabilities: {
            acceptsImages: !!input.acceptsImages,
            ...(input.maxImages ? { maxImages: input.maxImages } : {}),
            ...(input.maxCompletionTokens ? { maxCompletionTokens: input.maxCompletionTokens } : {}),
            ...(input.contextWindow ? { contextWindow: input.contextWindow } : {}),
        },
        // An empty key field is "no change"; null removes the key.
        apiKey: input.apiKey === '' ? undefined : input.apiKey,
    };
}

/**
 * The operator's "Test": `GET <baseUrl>/models` with the key, 10 s at most.
 * Only ever run when an operator asks. Reports the status and whether the
 * model is listed; never the server's own text.
 */
export async function probeBackend(
    endpoint: { baseUrl: string; model: string; apiKey?: string },
    fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
    try {
        const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, '')}/models`, {
            headers: endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {},
            signal: AbortSignal.timeout(10_000),
            redirect: 'error',
        });
        if (!response.ok) {
            return {
                ok: false,
                detail:
                    response.status === 401 || response.status === 403
                        ? `The server refused the key (HTTP ${response.status}).`
                        : `The server answered HTTP ${response.status}.`,
            };
        }
        const body = (await response.json().catch(() => null)) as {
            data?: { id?: unknown }[];
        } | null;
        const ids = Array.isArray(body?.data)
            ? body.data.map((entry) => entry?.id).filter((id) => typeof id === 'string')
            : undefined;
        if (!ids) {
            return { ok: true, detail: 'Reachable.' };
        }
        return ids.includes(endpoint.model)
            ? { ok: true, detail: `Reachable; ${endpoint.model} is listed.` }
            : {
                  ok: false,
                  detail: `Reachable, but ${endpoint.model} is not among its ${ids.length} models.`,
              };
    } catch (error) {
        return {
            ok: false,
            detail: `Could not reach the server (${safeFailure(error)}).`,
        };
    }
}
