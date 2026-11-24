import type { AppEnvironment } from '@socio/shared/operator';

import { dataKeyId } from './secret-box.js';

/** DATA_ENCRYPTION_KEY and the previous one, as bytes (CB-62). */
export interface DataKeys {
    current?: Buffer;
    previous?: Buffer;
}

const HEX = /^[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/_-]{43}={0,2}$/;

/** 32 bytes as 64 hex characters, or base64 / base64url; never echoed back. */
export function parseDataKey(raw: string, name: string): Buffer {
    const value = raw.trim();
    const key = HEX.test(value)
        ? Buffer.from(value, 'hex')
        : BASE64.test(value)
          ? Buffer.from(value.replace(/=+$/, ''), 'base64url')
          : undefined;
    if (key?.length !== 32) {
        throw new Error(`${name} must be 32 random bytes as 64 hex characters or base64 (openssl rand -hex 32).`);
    }
    return key;
}

/** Unset, or `none`: the stack's placeholder secret. */
const setting = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed && trimmed !== 'none' ? trimmed : undefined;
};

/**
 * The data encryption keys from the environment (`_FILE` secrets are loaded
 * by then); `none` is unset. A previous key alone is a mistake: new seals
 * would fall back to SESSION_SECRET's key, so it stops startup.
 */
export function dataKeysFromEnv(env: Record<string, string | undefined>): DataKeys {
    const current = setting(env.DATA_ENCRYPTION_KEY);
    const previous = setting(env.DATA_ENCRYPTION_KEY_PREVIOUS);
    if (previous && !current) {
        throw new Error('DATA_ENCRYPTION_KEY_PREVIOUS is set without DATA_ENCRYPTION_KEY.');
    }
    return {
        ...(current ? { current: parseDataKey(current, 'DATA_ENCRYPTION_KEY') } : {}),
        ...(previous
            ? {
                  previous: parseDataKey(previous, 'DATA_ENCRYPTION_KEY_PREVIOUS'),
              }
            : {}),
    };
}

/** The startup line about the data key, or undefined when there is nothing to say. */
export function dataKeyWarning(keys: DataKeys, environment: AppEnvironment): string | undefined {
    if (keys.current || environment === 'development') {
        return undefined;
    }
    return 'Data key: DATA_ENCRYPTION_KEY is not set, so files and stored credentials are sealed with a key from SESSION_SECRET. Rotating SESSION_SECRET would make them unreadable, and backups need it. Set DATA_ENCRYPTION_KEY (openssl rand -hex 32); see docs/SETUP.md "Data encryption key".';
}

/**
 * The ids of the current and previous data keys (CB-322): the fingerprint
 * seals name them by, safe to show, never the keys themselves.
 */
export function dataKeyIds(keys: DataKeys | undefined): { current?: string; previous?: string } {
    return {
        ...(keys?.current ? { current: dataKeyId(keys.current) } : {}),
        ...(keys?.previous ? { previous: dataKeyId(keys.previous) } : {}),
    };
}

/**
 * A data key's id from its text (CB-322), for `key-id-cli`: parsed as the
 * server parses DATA_ENCRYPTION_KEY, and the bytes wiped once hashed.
 */
export function keyIdFromText(text: string): string {
    const key = parseDataKey(text, 'The key');
    try {
        return dataKeyId(key);
    } finally {
        key.fill(0);
    }
}
