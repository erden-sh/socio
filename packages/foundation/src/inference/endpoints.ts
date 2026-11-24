/**
 * Where one-shot model requests (titles, learning, classification) find
 * their OpenAI Chat Completions endpoint. Moved from the server's
 * `inference/contract.ts` and `inference/openai-compatible.ts`
 * (the contract re-exports it). Server-only: an endpoint holds its API key.
 */

/** An OpenAI Chat Completions endpoint, for one-shot requests (titles, learning). */
export interface ChatCompletionsEndpoint {
    baseUrl: string;
    apiKey?: string;
    model: string;
    maxCompletionTokens?: number;
    titleModelOptions?: Record<string, unknown>;
}

/**
 * The model settings `modelSettingsFromEnv` reads: these fields of the
 * server's `PlatformConfig`, with the same types.
 */
export interface ModelSettings {
    baseUrl: string;
    apiKey?: string;
    model?: string;
    /** Includes reasoning tokens on reasoning models. */
    maxCompletionTokens?: number;
    /** Extra Chat Completions fields for title requests, e.g. to skip thinking. */
    titleModelOptions?: Record<string, unknown>;
    /** Whether the model takes image input. */
    acceptsImages?: boolean;
    /** Most recent images a request keeps. */
    maxImages?: number;
    /** The model's context window in tokens. */
    contextWindow?: number;
}

/** The Chat Completions endpoint of fixed settings, if complete. */
export function settingsEndpoint(settings: Partial<ModelSettings>): ChatCompletionsEndpoint | undefined {
    if (!settings.baseUrl || !settings.model) {
        return undefined;
    }
    return {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        maxCompletionTokens: settings.maxCompletionTokens,
        titleModelOptions: settings.titleModelOptions,
    };
}

/**
 * Where one-shot requests (titles, learning analysis) find their endpoint:
 * looked up per request (the platform passes the default shared backend's),
 * or fixed model settings (tests, stand-alone use).
 */
export type EndpointSource =
    | (() => ChatCompletionsEndpoint | undefined | Promise<ChatCompletionsEndpoint | undefined>)
    | Partial<ModelSettings>;
export const endpointOf = async (source: EndpointSource): Promise<ChatCompletionsEndpoint | undefined> =>
    typeof source === 'function' ? source() : settingsEndpoint(source);
