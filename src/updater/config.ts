import { parseUpdaterPlatform, PLATFORM_SECRET_SETTINGS, type UpdaterPlatformName } from './platform.js';

/**
 * The updater sidecar's settings (CB-259), from its own environment. It is
 * opt-in and runs as its own Portainer stack, so updating the app never
 * replaces it mid-update. Malformed values stop startup without echoing
 * secrets.
 */
export interface UpdaterConfig {
    host: string;
    port: number;
    /** `UPDATER_TOKEN` (`_FILE`): the app presents it; shared with nobody else. */
    token: string;
    /** `UPDATER_PLATFORM` (portainer): the adapter that deploys (CB-323). */
    platform: UpdaterPlatformName;
    /** The `portainer` adapter's settings; its API key is its own credential. */
    portainer: {
        /** `UPDATER_PORTAINER_URL`, e.g. http://10.0.0.10:9000. */
        url: string;
        /** `UPDATER_PORTAINER_TOKEN` (`_FILE`): a Portainer API key. */
        token: string;
        /** `UPDATER_ENDPOINT_ID`: the Portainer environment (1). */
        endpointId: number;
        timeoutMs: number;
    };
    /** `UPDATER_STACK`: the stack's name (company-brain). */
    stack: string;
    /**
     * `UPDATER_TAG_KEYS`: the stack env keys it sets to the release tag
     * (IMAGE_TAG); every other key is sent back unchanged.
     */
    tagKeys: string[];
    /** `UPDATER_PULL_IMAGE`: false for images built on the node (no registry). */
    pullImage: boolean;
    health: {
        /** `UPDATER_HEALTH_URL`: the app's /healthz over the internal network. */
        url: string;
        /** `UPDATER_HEALTH_TIMEOUT_SECONDS` (900): drain, pull, start and migrations. */
        timeoutMs: number;
        /** `UPDATER_HEALTH_INTERVAL_SECONDS` (10). */
        intervalMs: number;
        /** `UPDATER_HEALTH_STABLE_CHECKS` (3): healthy in a row, at the version. */
        stableChecks: number;
    };
    /** `UPDATER_BACKUP_MAX_AGE_MINUTES` (60): the pre-update backup is that fresh. */
    backupMaxAgeMs: number;
    /** `UPDATER_STATE_DIR` (/state): the job, so a restart resumes it. */
    stateDir: string;
}

const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

const unset = (value: string | undefined) => {
    const trimmed = value?.trim();
    return !trimmed || trimmed.toLowerCase() === 'none' ? undefined : trimmed;
};

function whole(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) {
    const raw = env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
    }
    return value;
}

function httpUrl(value: string | undefined, name: string) {
    const raw = value?.trim().replace(/\/+$/, '');
    if (!raw) {
        throw new Error(`${name} must be set.`);
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error(`${name} must be an http(s) URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${name} must be an http(s) URL without credentials.`);
    }
    return raw;
}

export function updaterConfigFromEnv(env: Record<string, string | undefined>): UpdaterConfig {
    const token = unset(env.UPDATER_TOKEN);
    if (!token || token.length < 24) {
        throw new Error('UPDATER_TOKEN (UPDATER_TOKEN_FILE) must be set, 24+ characters, and the same as the app’s.');
    }
    // First, so an unknown platform says so rather than asking for Portainer's key.
    const platform = parseUpdaterPlatform(env.UPDATER_PLATFORM);
    const portainerToken = unset(env.UPDATER_PORTAINER_TOKEN);
    if (!portainerToken) {
        throw new Error('UPDATER_PORTAINER_TOKEN (UPDATER_PORTAINER_TOKEN_FILE) must be a Portainer API key.');
    }
    const stack = env.UPDATER_STACK?.trim() || 'company-brain';
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(stack)) {
        throw new Error('UPDATER_STACK must be a stack name such as company-brain.');
    }
    const tagKeys = (env.UPDATER_TAG_KEYS?.trim() || 'IMAGE_TAG')
        .split(',')
        .map((key) => key.trim())
        .filter(Boolean);
    if (!tagKeys.length || tagKeys.some((key) => !ENV_KEY.test(key))) {
        throw new Error('UPDATER_TAG_KEYS must be stack env keys such as IMAGE_TAG,APPS_IMAGE_TAG.');
    }
    const pull = env.UPDATER_PULL_IMAGE?.trim().toLowerCase() || 'false';
    if (!['true', 'false'].includes(pull)) {
        throw new Error('UPDATER_PULL_IMAGE must be true or false.');
    }
    return {
        host: env.UPDATER_HOST?.trim() || '0.0.0.0',
        port: whole(env, 'UPDATER_PORT', 4350, 1, 65_535),
        token,
        platform,
        portainer: {
            url: httpUrl(env.UPDATER_PORTAINER_URL, 'UPDATER_PORTAINER_URL'),
            token: portainerToken,
            endpointId: whole(env, 'UPDATER_ENDPOINT_ID', 1, 1, 1_000_000),
            timeoutMs: whole(env, 'UPDATER_PORTAINER_TIMEOUT_SECONDS', 60, 5, 600) * 1000,
        },
        stack,
        tagKeys: [...new Set(tagKeys)],
        pullImage: pull === 'true',
        health: {
            url: httpUrl(env.UPDATER_HEALTH_URL || 'http://company-brain_app:4310/healthz', 'UPDATER_HEALTH_URL'),
            timeoutMs: whole(env, 'UPDATER_HEALTH_TIMEOUT_SECONDS', 900, 30, 7_200) * 1000,
            intervalMs: whole(env, 'UPDATER_HEALTH_INTERVAL_SECONDS', 10, 1, 300) * 1000,
            stableChecks: whole(env, 'UPDATER_HEALTH_STABLE_CHECKS', 3, 1, 60),
        },
        backupMaxAgeMs: whole(env, 'UPDATER_BACKUP_MAX_AGE_MINUTES', 60, 1, 1_440) * 60_000,
        stateDir: env.UPDATER_STATE_DIR?.trim() || '/state',
    };
}

/**
 * The updater's secrets, read from `<NAME>_FILE` like the app's: its own
 * token, and each platform adapter's credentials.
 */
export const UPDATER_SECRET_SETTINGS: readonly string[] = [
    'UPDATER_TOKEN',
    ...Object.values(PLATFORM_SECRET_SETTINGS).flat(),
];
