import type { TextOptions } from '@tanstack/ai';
import { OpenAICompatibleResponsesAdapter } from '@tanstack/ai-openai/compatible';

import { ChatGptError } from '@socio/foundation/inference/chatgpt-errors';
import type { ReasoningOutput } from '@socio/shared/reasoning-output';

import type { ChatGptCredentials } from './credentials.js';
import { responsesHttpError, responsesStreamError } from './errors.js';
import type { ChatGptHttpOptions } from './http.js';
import {
    CHATGPT_CONTEXT_WINDOW,
    CHATGPT_DEFAULT_MODEL,
    CHATGPT_OUTPUT_RESERVE,
    chatGptModel,
    type ChatGptModel,
} from './models.js';
import { ensureFresh, type SaveCredentials } from './refresh.js';
import { postResponses } from './transport.js';

export interface ChatGptAdapterOptions extends ChatGptHttpOptions {
    /** Defaults to {@link CHATGPT_DEFAULT_MODEL}. */
    model?: string;
    /** The user's credentials, decrypted, read for every request. */
    getCredentials: () => Promise<ChatGptCredentials | undefined>;
    /** Persists rotated credentials (before they are used). */
    saveCredentials: SaveCredentials;
    /** Marks the connection as needing a new sign-in. */
    markNeedsRelogin?: () => Promise<void>;
    /** Defaults to the catalog's value for the model, else `medium`. */
    reasoningEffort?: ChatGptModel['reasoningEffort'];
    /** Defaults to the catalog's value for the model, else `low`. */
    verbosity?: ChatGptModel['verbosity'];
}

/** What a backend registry needs to know about the model. */
export function chatGptCapabilities(model = CHATGPT_DEFAULT_MODEL) {
    return {
        model,
        acceptsImages: chatGptModel(model)?.acceptsImages ?? false,
        tools: true,
        contextWindow: CHATGPT_CONTEXT_WINDOW,
        outputReserve: CHATGPT_OUTPUT_RESERVE,
    };
}

type ResponsesClient = ConstructorParameters<typeof OpenAICompatibleResponsesAdapter>[0];
type Json = Record<string, unknown>;

const ERROR_BODY_LIMIT = 64 * 1024;

/**
 * Models whose backend refused `reasoning.summary` (an HTTP 400 naming it):
 * their requests go without it from then on, for this process. Every model
 * the CLI lists supports it, so this is a safety net, not a code path.
 */
const summariesRefused = new Set<string>();
const withoutSummary = (params: Json): Json => {
    const reasoning = { ...(params.reasoning as Json | undefined) };
    delete reasoning.summary;
    return { ...params, reasoning };
};

async function readLimited(response: Response) {
    if (!response.body) {
        return '';
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
        while (text.length < ERROR_BODY_LIMIT) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            text += decoder.decode(value, { stream: true });
        }
    } catch {
        // A truncated error body still has its status.
    } finally {
        reader.cancel().catch(() => {});
    }
    return text.slice(0, ERROR_BODY_LIMIT);
}

/**
 * The Responses event stream as parsed events. A `response.failed` or
 * `error` event becomes a typed {@link ChatGptError} so the provider's own
 * message (which may quote the conversation) never reaches the chat events.
 */
async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += value ? decoder.decode(value, { stream: true }) : done ? decoder.decode() : '';
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = done ? '' : (blocks.pop() ?? '');
            for (const block of blocks) {
                const data = block
                    .split(/\r?\n/)
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).replace(/^ /, ''))
                    .join('\n');
                if (!data) {
                    continue;
                }
                if (data === '[DONE]') {
                    return;
                }
                let event: unknown;
                try {
                    event = JSON.parse(data);
                } catch {
                    continue;
                }
                if (event === null || typeof event !== 'object') {
                    continue;
                }
                const type = (event as Json).type;
                if (type === 'response.failed' || type === 'error') {
                    throw responsesStreamError(event);
                }
                // A summary comes in parts, each opening with a **heading**; the
                // adapter joins their deltas as they are, so the next part starts
                // on a new paragraph (else "…fetches**Checking…" isn't Markdown).
                const part = event as Json;
                if (
                    type === 'response.reasoning_summary_part.added' &&
                    typeof part.summary_index === 'number' &&
                    part.summary_index > 0
                ) {
                    yield {
                        type: 'response.reasoning_summary_text.delta',
                        item_id: part.item_id,
                        output_index: part.output_index,
                        summary_index: part.summary_index,
                        delta: '\n\n',
                    };
                }
                yield event as Json;
            }
            if (done) {
                return;
            }
        }
    } finally {
        reader.cancel().catch(() => {});
    }
}

/**
 * The request body the CLI sends on a ChatGPT plan (`build_responses_request`
 * in `core/src/client.rs`): system prompt as `instructions`, `store: false`,
 * `stream: true`, `tool_choice: "auto"`, encrypted reasoning included so
 * tool rounds can pass it back, reasoning summaries on (`summary: "auto"`).
 * Everything else TanStack or the app adds (`max_output_tokens`, sampling,
 * metadata, structured output) is dropped: the CLI never sends it, and the
 * backend may refuse unknown fields.
 */
function codexRequest(request: Json, options: Pick<ChatGptAdapterOptions, 'reasoningEffort' | 'verbosity'>): Json {
    const catalog = chatGptModel(String(request.model));
    const tools = Array.isArray(request.tools)
        ? request.tools.filter(
              (tool) => tool !== null && typeof tool === 'object' && (tool as Json).type === 'function',
          )
        : [];
    const input = Array.isArray(request.input)
        ? request.input.map((item: unknown) => {
              const entry = item as Json;
              // The CLI sends assistant text as output_text parts.
              return entry?.type === 'message' && entry.role === 'assistant' && typeof entry.content === 'string'
                  ? {
                        ...entry,
                        content: [{ type: 'output_text', text: entry.content }],
                    }
                  : entry;
          })
        : [];
    const instructions = typeof request.instructions === 'string' ? request.instructions : '';
    return {
        model: request.model,
        ...(instructions ? { instructions } : {}),
        input,
        ...(tools.length ? { tools } : {}),
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: {
            effort: options.reasoningEffort ?? catalog?.reasoningEffort ?? 'medium',
            // Readable reasoning summaries for the chat (the CLI sends this when
            // `model_reasoning_summary` is set; every listed model supports it).
            ...(summariesRefused.has(String(request.model)) ? {} : { summary: 'auto' }),
        },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        text: { verbosity: options.verbosity ?? catalog?.verbosity ?? 'low' },
    };
}

function responsesClient(options: ChatGptAdapterOptions) {
    const refreshOptions = {
        fetch: options.fetch,
        endpoints: options.endpoints,
        markNeedsRelogin: options.markNeedsRelogin,
    };
    const send = (credentials: ChatGptCredentials, body: string, signal?: AbortSignal) =>
        postResponses(options, credentials, body, signal);
    const create = async (
        params: Json,
        requestOptions?: { signal?: AbortSignal | null },
    ): Promise<AsyncIterable<Json>> => {
        const signal = requestOptions?.signal ?? undefined;
        const stored = await options.getCredentials();
        if (!stored) {
            throw new ChatGptError('chatgpt_not_connected');
        }
        let credentials = await ensureFresh(stored, options.saveCredentials, refreshOptions);
        const body = JSON.stringify(params);
        let response = await send(credentials, body, signal);
        if (response.status === 401) {
            // As the CLI does on a 401: refresh once and retry once.
            await response.body?.cancel().catch(() => {});
            credentials = await ensureFresh(credentials, options.saveCredentials, {
                ...refreshOptions,
                force: true,
            });
            response = await send(credentials, body, signal);
            if (response.status === 401) {
                await response.body?.cancel().catch(() => {});
                await options.markNeedsRelogin?.().catch(() => {});
                throw new ChatGptError('chatgpt_needs_relogin', { status: 401 });
            }
        }
        const summary = (params.reasoning as Json | undefined)?.summary;
        if (response.status === 400 && summary !== undefined) {
            const text = await readLimited(response);
            if (!/summary/i.test(text)) {
                throw responsesHttpError(400, text);
            }
            // Refused: once more without it, and never again for this model.
            summariesRefused.add(String(params.model));
            console.log(
                `ChatGPT: the backend refused reasoning summaries for ${String(params.model).slice(0, 40)}; sending none from now on.`,
            );
            response = await send(credentials, JSON.stringify(withoutSummary(params)), signal);
        }
        if (!response.ok) {
            throw responsesHttpError(response.status, await readLimited(response), response.headers);
        }
        if (!response.body) {
            throw new ChatGptError('chatgpt_unavailable', {
                providerCode: 'empty_body',
            });
        }
        return events(response.body);
    };
    return { responses: { create } } as unknown as ResponsesClient;
}

/**
 * A TanStack AI text adapter that runs chats on the user's ChatGPT plan
 * through the backend the Codex CLI uses (`POST {codexBaseUrl}/responses`
 * with `Authorization: Bearer <access token>`, `ChatGPT-Account-ID`,
 * `originator`; `model-provider/src/bearer_auth_provider.rs`,
 * `codex-api/src/endpoint/responses.rs`). A drop-in for the app's
 * `openaiCompatibleText(...)` in `chat({ adapter, ... })`: TanStack's own
 * Responses mapping (messages, images, tool calls and results, streamed
 * text and reasoning, usage) does the rest; only the transport, the request
 * shape and the errors are ChatGPT's.
 *
 * Credentials are read per request, refreshed when near expiry (rotations
 * saved first), and live only in memory here.
 */
export class ChatGptTextAdapter extends OpenAICompatibleResponsesAdapter<string> {
    /**
     * Its reasoning shows as the provider's summaries (`summary: 'auto'`);
     * a round without one, on a model that refused them, is `hidden`
     * (CB-185).
     */
    readonly reasoningOutput: ReasoningOutput = 'summary';
    private readonly shaping: Pick<ChatGptAdapterOptions, 'reasoningEffort' | 'verbosity'>;
    constructor(options: ChatGptAdapterOptions) {
        super(responsesClient(options), options.model ?? CHATGPT_DEFAULT_MODEL, 'chatgpt', {
            strictFallbackWarning: false,
        });
        this.shaping = {
            reasoningEffort: options.reasoningEffort,
            verbosity: options.verbosity,
        };
    }
    protected mapOptionsToRequest(options: TextOptions<Record<string, unknown>>) {
        const request = super.mapOptionsToRequest(options);
        return codexRequest(request as unknown as Json, this.shaping) as unknown as typeof request;
    }
    // Structured output needs a non-streaming request, which the CLI never
    // makes on a ChatGPT plan. Dot chats don't use it.
    async structuredOutput(): Promise<never> {
        throw new ChatGptError('chatgpt_unsupported');
    }
    // oxlint-disable-next-line require-yield
    async *structuredOutputStream(): AsyncGenerator<never> {
        throw new ChatGptError('chatgpt_unsupported');
    }
    supportsCombinedToolsAndSchema() {
        return false;
    }
}

export const chatGptAdapter = (options: ChatGptAdapterOptions) => new ChatGptTextAdapter(options);
