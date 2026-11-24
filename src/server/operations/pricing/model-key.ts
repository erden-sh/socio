/**
 * Matching models across price lists (CB-195). Providers name one model
 * many ways: `gpt-4o`, `openai/gpt-4o`, `gpt-4o-2024-08-06`, Azure's
 * "gpt 4o 0806", Bedrock's `anthropic.claude-3-5-sonnet-20240620-v1:0` or
 * "Claude 3.5 Sonnet". `modelKey` folds them to one key; prices are looked
 * up by exact name first, then by key.
 */

/** Region and vendor prefixes on Bedrock-style ids. */
const VENDOR_PREFIX =
    /^(?:(?:us|eu|apac|global|jp|au|ca)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|openai|qwen|google|writer|moonshot|zai|minimax|nvidia|stability|twelvelabs|luma)\./;

/**
 * A model's key: lowercase, without the vendor before a `/` or a
 * Bedrock-style `vendor.` prefix, a `-v1:0` revision, a routing tag
 * (`:free`, `:latest`) or a date
 * stamp, and with only letters and digits left.
 */
export function modelKey(model: string): string {
    let name = model.trim().toLowerCase();
    name = name.slice(name.lastIndexOf('/') + 1);
    name = name.replace(VENDOR_PREFIX, '');
    name = name.replace(/-v\d+(?::\d+)?$/, '');
    name = name.replace(/:(?:free|beta|extended|nitro|floor|online|thinking|latest)$/, '');
    name = name.replace(/[-_ ]?(?:20\d{2}-?\d{2}-?\d{2})$/, '');
    return name.replace(/[^a-z0-9]/g, '');
}

/** Known API hosts and the provider their prices are listed under. */
const HOSTS: [RegExp, string][] = [
    [/(^|\.)openai\.com$/, 'openai'],
    [/(^|\.)openrouter\.ai$/, 'openrouter'],
    [/(^|\.)deepinfra\.com$/, 'deepinfra'],
    [/(^|\.)together\.(xyz|ai)$/, 'together'],
    [/(^|\.)(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/, 'azure'],
    [/(^|\.)amazonaws\.com$/, 'aws'],
    [/(^|\.)anthropic\.com$/, 'anthropic'],
    [/(^|\.)googleapis\.com$/, 'google'],
    [/(^|\.)mistral\.ai$/, 'mistral'],
    [/(^|\.)groq\.com$/, 'groq'],
    [/(^|\.)fireworks\.ai$/, 'fireworks'],
    [/(^|\.)x\.ai$/, 'xai'],
    [/(^|\.)deepseek\.com$/, 'deepseek'],
];

/** Loopback, private, link-local and `.local`/`.internal` names: self-hosted. */
function privateHost(host: string) {
    if (host === 'localhost' || /\.(local|internal|lan|home|svc)$/.test(host)) {
        return true;
    }
    if (!host.includes('.')) {
        return true;
    }
    const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return (
            a === 10 ||
            a === 127 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }
    return host === '[::1]' || /^\[f[cd]/.test(host);
}

/**
 * The provider a backend's prices are listed under, from its base URL:
 * a known API's name, `self-hosted` for a private address, else the host.
 */
export function providerOf(baseUrl: string): string {
    let host: string;
    try {
        host = new URL(baseUrl).hostname.toLowerCase();
    } catch {
        return 'unknown';
    }
    for (const [pattern, provider] of HOSTS) {
        if (pattern.test(host)) {
            return provider;
        }
    }
    return privateHost(host) ? 'self-hosted' : host;
}

/** Community lists' provider names, as `providerOf` names them. */
export const PROVIDER_ALIASES: Record<string, string> = {
    togetherai: 'together',
    together_ai: 'together',
    'amazon-bedrock': 'aws',
    bedrock: 'aws',
    bedrock_converse: 'aws',
    azure_ai: 'azure',
    'azure-openai': 'azure',
    'fireworks-ai': 'fireworks',
    fireworks_ai: 'fireworks',
    gemini: 'google',
    'google-vertex': 'google',
    vertex_ai: 'google',
    'vertex_ai-language-models': 'google',
    text_completion_openai: 'openai',
};
export const canonicalProvider = (name: string) => {
    const lower = name.trim().toLowerCase();
    return PROVIDER_ALIASES[lower] ?? lower;
};
