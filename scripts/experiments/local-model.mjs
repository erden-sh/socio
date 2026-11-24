// Your own OpenAI-compatible model for the context experiments, and nothing
// else: the URL must be loopback, or a host ending in the suffix you allow
// with `EXPERIMENT_MODEL_HOST_SUFFIX` (for example `.internal`), so a run
// never sends a synthetic thread to an outside service by accident.
// Requests go one at a time (`EXPERIMENT_CONCURRENCY`, at most 2), leaving
// the server's other streams to its people. The User-Agent is generic.
import { openAICompatibleModel } from '../../src/server/inference/openai-compatible.ts';

export const MODEL_URL = process.env.EXPERIMENT_MODEL_URL ?? 'http://127.0.0.1:8000/v1';
export const MODEL = process.env.EXPERIMENT_MODEL ?? 'local-model';
const host = new URL(MODEL_URL).hostname;
const suffix = process.env.EXPERIMENT_MODEL_HOST_SUFFIX;
if (host !== '127.0.0.1' && host !== 'localhost' && !(suffix && host.endsWith(suffix))) {
    throw new Error(`EXPERIMENT_MODEL_URL must be loopback or end in EXPERIMENT_MODEL_HOST_SUFFIX, not ${host}.`);
}

const CONCURRENCY = Math.min(2, Math.max(1, Number(process.env.EXPERIMENT_CONCURRENCY ?? 1)));
let running = 0;
const waiting = [];
/** Runs `work` when a slot is free. */
export async function slot(work) {
    if (running >= CONCURRENCY) {
        await new Promise((go) => waiting.push(go));
    }
    running += 1;
    try {
        return await work();
    } finally {
        running -= 1;
        waiting.shift()?.();
    }
}

/** One-shot options: no reasoning (what a shared backend's titles use). */
export const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

/** The model as the app builds a shared backend's, for an adapter. */
export const localModel = (contextWindow = 262_144) =>
    openAICompatibleModel({
        source: { type: 'shared', backendId: 'local' },
        label: `Local (${MODEL})`,
        baseUrl: MODEL_URL,
        model: MODEL,
        capabilities: { acceptsImages: false, contextWindow },
        titleModelOptions: NO_THINKING,
    });

/** An adapter whose requests wait for a slot (the stream is read inside it). */
export function slotted(adapter) {
    const wrapped = Object.create(adapter);
    wrapped.chatStream = async function* (options) {
        const chunks = await slot(async () => {
            const out = [];
            for await (const chunk of adapter.chatStream(options)) {
                out.push(chunk);
            }
            return out;
        });
        yield* chunks;
    };
    return wrapped;
}

/**
 * A plain Chat Completions request (answers and tool rounds of the
 * evaluation): the reply's message, usage and time.
 */
export async function complete(body) {
    return slot(async () => {
        const started = performance.now();
        const response = await fetch(`${MODEL_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'research-script/0.1',
            },
            body: JSON.stringify({ model: MODEL, ...body }),
            signal: AbortSignal.timeout(600_000),
        });
        if (!response.ok) {
            throw new Error(`The local model answered ${response.status}.`);
        }
        const data = await response.json();
        return {
            message: data.choices?.[0]?.message ?? {},
            usage: data.usage ?? {},
            ms: performance.now() - started,
        };
    });
}

/** What `chat()` hands adapters as a request's logger: here, silent. */
export const quietLogger = new Proxy({}, { get: () => () => {} });

/** Percentiles of a list of numbers. */
export function percentile(values, p) {
    if (!values.length) {
        return NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * p;
    const low = Math.floor(at);
    return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low);
}
