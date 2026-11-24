/**
 * The models the pinned Codex CLI lists for ChatGPT plans, from its bundled
 * catalog (`codex-rs/models-manager/models.json` at `rust-v0.161.0`;
 * `visibility: "list"`, in the catalog's priority order, all available on
 * every plan from Free up). Static on purpose: the CLI's live model
 * discovery calls chatgpt.com, and listing models must not.
 *
 * `responsesLite`: the CLI sends these models an internal variant of the
 * Responses request (header `x-openai-internal-codex-responses-lite`, tools
 * and instructions moved into the input; `core/src/client.rs`). This adapter
 * always sends the standard Responses shape, which the CLI itself uses for
 * `gpt-5.5`; the first live connection shows whether the newer models take
 * it too (if not, pick `gpt-5.5`).
 */
export interface ChatGptModel {
    id: string;
    label: string;
    description: string;
    /** The catalog's default reasoning effort, sent as `reasoning.effort`. */
    reasoningEffort: 'low' | 'medium' | 'high';
    /** The catalog's default verbosity, sent as `text.verbosity`. */
    verbosity: 'low' | 'medium' | 'high';
    acceptsImages: boolean;
    responsesLite: boolean;
}

/**
 * The context window of every listed model, in tokens: the catalog's
 * `context_window` (272,000) at its `effective_context_window_percent`
 * (95), the share the CLI lets a prompt use (CB-129).
 */
export const CHATGPT_CONTEXT_WINDOW = Math.floor(272_000 * 0.95);
/**
 * Tokens kept free for the answer: the requests carry no completion cap,
 * and a reasoning model's answer with its reasoning can be long.
 */
export const CHATGPT_OUTPUT_RESERVE = 32_000;

export const CHATGPT_MODELS: readonly ChatGptModel[] = [
    {
        id: 'gpt-6.1-sol',
        label: 'GPT-6.1-Sol',
        description: 'Latest workhorse model for coding and everyday work.',
        reasoningEffort: 'low',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        description: 'Frontier intelligence for the most demanding work.',
        reasoningEffort: 'low',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-6-sol',
        label: 'GPT-6-Sol',
        description: 'Previous generation workhorse model.',
        reasoningEffort: 'medium',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-6-luna',
        label: 'GPT-6-Luna',
        description: 'Fast and affordable model for easier tasks.',
        reasoningEffort: 'medium',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6-Sol',
        description: 'Older generation workhorse model.',
        reasoningEffort: 'low',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6-Terra',
        description: 'Older balanced model for straightforward work.',
        reasoningEffort: 'medium',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6-Luna',
        description: 'Older fast and efficient model.',
        reasoningEffort: 'medium',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: true,
    },
    {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        description: 'Legacy coding model.',
        reasoningEffort: 'medium',
        verbosity: 'low',
        acceptsImages: true,
        responsesLite: false,
    },
];

/** The CLI's own default on a ChatGPT plan: the catalog's first listed model. */
export const CHATGPT_DEFAULT_MODEL = 'gpt-6.1-sol';
/** The newest listed model the CLI sends the standard Responses shape. */
export const CHATGPT_STANDARD_MODEL = 'gpt-5.5';

export const listModels = (): readonly ChatGptModel[] => CHATGPT_MODELS;
export const chatGptModel = (id: string) => CHATGPT_MODELS.find((model) => model.id === id);
