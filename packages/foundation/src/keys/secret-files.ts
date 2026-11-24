import { readFileSync } from 'node:fs';

/** Settings that may come from a file (Docker/Swarm secrets) as `<NAME>_FILE`. */
export const SECRET_SETTINGS = [
    'SESSION_SECRET',
    // Files and stored credentials at rest (CB-62), and the previous key
    // during a rotation.
    'DATA_ENCRYPTION_KEY',
    'DATA_ENCRYPTION_KEY_PREVIOUS',
    'OPENAI_API_KEY',
    'PARALLEL_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'COMPUTER_SUPERVISOR_TOKEN',
    'COMPUTER_TOKEN',
    'VOICE_API_KEY',
    // Server dictation's transcription server, when it wants a key (CB-101).
    'VOICE_TRANSCRIBE_API_KEY',
    // Self-hosted calls' speech server, when it wants a key (CB-265).
    'VOICE_SPEECH_API_KEY',
    // The GitHub App's key (CB-32): the env default under the App an admin
    // connects in Settings. DISPATCH_GITHUB_APP_PRIVATE_KEY is its name
    // before CB-325, read for one release when the new one is unset.
    'GITHUB_APP_PRIVATE_KEY',
    'DISPATCH_GITHUB_APP_PRIVATE_KEY',
    'SMTP_PASSWORD',
    // The workspace app runtime's shared secret.
    'APPS_RUNTIME_TOKEN',
    // The token a plugin service sends when it calls back into Socio.
    'PLUGIN_SERVICE_TOKEN',
    // The registry login plugin images pull with (JSON), under the
    // workspace secret of the same name.
    'PLUGIN_REGISTRY_AUTH',
    // The domains module: the scoped NPM user's login (JSON) and the
    // Cloudflare DNS token; `none` (a placeholder secret) leaves it off.
    'NPM_CREDENTIALS',
    'CLOUDFLARE_DNS_TOKEN',
    // The data space's S3 key pair (CB-54): JSON, or SeaweedFS's own
    // identity file, so one swarm secret serves both.
    'S3_CREDENTIALS',
    // The off-site backup copy's key pair (CB-63), the same JSON.
    'BACKUP_S3_CREDENTIALS',
    // The trace collector's headers (CB-128), which may carry its API key.
    'OTEL_EXPORTER_OTLP_HEADERS',
    // The analytics service's shared secret (CB-186, service mode).
    'OPS_ANALYTICS_SECRET',
    // Updates (CB-259): the release feed's read token, and the token the app
    // and the updater sidecar share; `none` leaves either off.
    'UPDATES_FEED_TOKEN',
    'UPDATER_TOKEN',
    // CB-239: the coding gateway's stamp and egress keys' source, shared with
    // the coding egress proxy; and the key the app and coding-git share.
    'CODING_EGRESS_SECRET',
    'CODING_GIT_SECRET',
] as const;

/**
 * For each secret setting with a `<NAME>_FILE` variable and no value, reads
 * the file (trimmed) into the environment. A set value wins. A missing or
 * unreadable file stops startup without echoing contents.
 */
export function loadSecretFiles(
    env: Record<string, string | undefined> = process.env,
    read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
    names: readonly string[] = SECRET_SETTINGS,
) {
    for (const name of names) {
        const file = env[`${name}_FILE`]?.trim();
        if (!file || env[name]?.trim()) {
            continue;
        }
        let value: string;
        try {
            value = read(file).trim();
        } catch {
            throw new Error(`${name}_FILE could not be read.`);
        }
        if (!value) {
            throw new Error(`${name}_FILE is empty.`);
        }
        env[name] = value;
    }
}
