/**
 * Typed failures for a ChatGPT-plan connection. Each carries a stable `code`
 * (the RUN_ERROR `code` the chat runtime sees), a message that is safe to
 * show the user as is, and an operator `detail` made only of the HTTP status
 * and the provider's error code. None of them ever holds a token, a provider
 * message (it may echo the conversation), the ID token's claims or the
 * account id; `toJSON` keeps it that way when an error is serialized.
 *
 * Moved from the server's `inference/chatgpt/errors.ts`, which keeps the
 * parsing of provider answers into these errors.
 */
export type ChatGptErrorCode =
    | 'chatgpt_not_connected'
    | 'chatgpt_needs_relogin'
    | 'chatgpt_usage_limit'
    | 'chatgpt_not_entitled'
    | 'chatgpt_quota_exceeded'
    | 'chatgpt_rate_limited'
    | 'chatgpt_model_unavailable'
    | 'chatgpt_context_too_long'
    | 'chatgpt_forbidden'
    | 'chatgpt_rejected'
    | 'chatgpt_unavailable'
    | 'chatgpt_unsupported'
    | 'chatgpt_login_unavailable';

export const CHATGPT_ERROR_MESSAGES: Record<ChatGptErrorCode, string> = {
    chatgpt_not_connected: 'Connect your ChatGPT account (Account → Inference) to chat on your plan.',
    chatgpt_needs_relogin:
        'Your ChatGPT sign-in has expired or was revoked. Connect your ChatGPT account again (Account → Inference).',
    chatgpt_usage_limit: 'You have reached your ChatGPT plan’s usage limit for now. Try again when it resets.',
    chatgpt_not_entitled:
        'Your ChatGPT plan does not include Codex usage, which chats on your plan need. Check your plan, or disconnect it to use Socio’s shared model.',
    chatgpt_quota_exceeded:
        'Your ChatGPT workspace has no Codex credits left. Ask its admin, or disconnect your plan to use Socio’s shared model.',
    chatgpt_rate_limited: 'ChatGPT is busy right now. Please try again in a moment.',
    chatgpt_model_unavailable:
        'The model chosen for ChatGPT plans is not available on your plan. Ask an operator to pick another model.',
    // Rare: long conversations are compacted and retried first (CB-129).
    chatgpt_context_too_long: 'ChatGPT could not take this request just now. Please try again.',
    chatgpt_forbidden: 'ChatGPT refused the request from this server. Please try again later.',
    chatgpt_rejected:
        'ChatGPT could not process this request. If you attached a photo or file, try again without it, or start a new conversation.',
    chatgpt_unavailable: 'Socio could not reach ChatGPT. Please try again shortly.',
    chatgpt_unsupported: 'This request is not supported on a ChatGPT plan.',
    chatgpt_login_unavailable: 'ChatGPT sign-in with a device code is not available right now. Please try again later.',
};

const CODES = new Set(Object.keys(CHATGPT_ERROR_MESSAGES));
export const isChatGptErrorCode = (code: unknown): code is ChatGptErrorCode =>
    typeof code === 'string' && CODES.has(code);

export interface ChatGptErrorOptions {
    status?: number;
    /** The provider's error code or type (a short identifier, never its message). */
    providerCode?: string;
    /** Usage limit: when it resets. */
    resetsAt?: Date;
    /** Usage limit: the plan the provider named, as a display name. */
    plan?: string;
    /** Rate limit: how long the backend asked to wait (Retry-After, CB-140). */
    retryAfterMs?: number;
}

/** A provider error code or type as kept: a short identifier, never a message. */
export const PROVIDER_CODE = /^[a-z0-9_.-]{1,64}$/i;

export class ChatGptError extends Error {
    readonly code: ChatGptErrorCode;
    readonly status?: number;
    readonly providerCode?: string;
    readonly resetsAt?: Date;
    /** Rate limit: how long the backend asked to wait before trying again. */
    readonly retryAfterMs?: number;
    /**
     * What TanStack passes on as the RUN_ERROR's `rawEvent`
     * (`toRunErrorRawEvent`), so the turn's retries (CB-140) see the wait
     * the backend asked for: the code and that wait, nothing else.
     */
    readonly rawEvent?: { code: ChatGptErrorCode; retryAfterMs: number };
    /** For operators (server log, errorDetail): status and provider code only. */
    readonly detail: string;
    constructor(code: ChatGptErrorCode, options: ChatGptErrorOptions = {}) {
        super(friendlyMessage(code, options));
        this.name = 'ChatGptError';
        this.code = code;
        if (options.status !== undefined) {
            this.status = options.status;
        }
        const providerCode =
            options.providerCode && PROVIDER_CODE.test(options.providerCode) ? options.providerCode : undefined;
        if (providerCode) {
            this.providerCode = providerCode;
        }
        if (options.resetsAt) {
            this.resetsAt = options.resetsAt;
        }
        if (options.retryAfterMs !== undefined) {
            this.retryAfterMs = options.retryAfterMs;
            this.rawEvent = { code, retryAfterMs: options.retryAfterMs };
        }
        this.detail = [
            code,
            ...(options.status !== undefined ? [`HTTP ${options.status}`] : []),
            ...(providerCode ? [providerCode] : []),
        ].join(' ');
    }
    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            ...(this.status !== undefined ? { status: this.status } : {}),
        };
    }
}

function friendlyMessage(code: ChatGptErrorCode, options: ChatGptErrorOptions) {
    if (code !== 'chatgpt_usage_limit') {
        return CHATGPT_ERROR_MESSAGES[code];
    }
    const plan = options.plan ? ` ${options.plan}` : '';
    const resets =
        options.resetsAt && !Number.isNaN(options.resetsAt.getTime())
            ? ` It resets at ${options.resetsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
            : ' Try again when it resets.';
    return `You have reached your ChatGPT${plan} plan’s usage limit for now.${resets}`;
}

/** The friendly message and code for a failed turn, if a ChatGPT connection caused it. */
export function chatGptFailure(error: unknown): { code: ChatGptErrorCode; message: string } | undefined {
    if (error instanceof ChatGptError) {
        return { code: error.code, message: error.message };
    }
    // The RUN_ERROR event an adapter failure becomes: this module is the only
    // source of `chatgpt_*` codes, and its messages are already friendly.
    if (error !== null && typeof error === 'object' && 'code' in error) {
        const { code } = error as { code?: unknown };
        const message = (error as { message?: unknown }).message;
        if (isChatGptErrorCode(code)) {
            return {
                code,
                message: typeof message === 'string' && message ? message : CHATGPT_ERROR_MESSAGES[code],
            };
        }
    }
    return undefined;
}

/**
 * A prompt longer than the model takes, in the provider's words: without
 * the `context_length_exceeded` code such a 400 read as a refused request
 * (an attachment's message) rather than one to compact and retry (CB-129).
 * Only wording about context or tokens: "exceeds the maximum size" is an
 * attachment's.
 */
export const OVER_LENGTH_WORDING =
    /context[ _-]?(?:length|window|size)|maximum context|too many (?:input |prompt )?tokens|(?:prompt|input|request) (?:is )?too (?:long|large)|exceeds? (?:the )?(?:model'?s? |available )?(?:maximum |max )?(?:number of )?(?:input |prompt )?(?:context|tokens?\b|token limit)|reduce the length of (?:the )?(?:messages|prompt|input)/i;
