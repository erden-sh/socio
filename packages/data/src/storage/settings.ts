import type { StorageDriver } from '../object-store.js';

/** An S3-compatible service and the key pair the app signs with. */
export interface S3Settings {
    /** An origin, e.g. `http://company-brain-s3:8333` or `https://s3.eu-west-1.amazonaws.com`. */
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /**
     * `S3_FORCE_PATH_STYLE`, true unless false: `<endpoint>/<bucket>/<key>`.
     * False: virtual-hosted style, `<bucket>.<endpoint host>/<key>`.
     */
    forcePathStyle?: boolean;
}

/** Where the data space keeps its files' bytes (CB-54; `PlatformConfig.storage`). */
export interface StorageSettings {
    driver: StorageDriver;
    /** `TENANT_ID`: the object keys' first level; the one workspace today. */
    tenantId: string;
    /** Only with the `s3` driver. */
    s3?: S3Settings;
}

const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,32}$/;

/**
 * `S3_CREDENTIALS` (or `_FILE`): `{"accessKeyId","secretAccessKey"}`, the
 * format any S3-compatible store's key pair fits. SeaweedFS's own identity
 * file (`-s3.config`) is accepted too, so one swarm secret serves both in
 * the bundled stack: then the first key pair of the identity named
 * `identity`.
 */
export function parseS3Credentials(raw: string, identity: string, setting = 'S3_CREDENTIALS') {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`${setting} must be JSON.`);
    }
    const value = (parsed ?? {}) as {
        accessKeyId?: unknown;
        secretAccessKey?: unknown;
        identities?: Array<{
            name?: unknown;
            credentials?: Array<{ accessKey?: unknown; secretKey?: unknown }>;
        }>;
    };
    const pair = Array.isArray(value.identities)
        ? (() => {
              const found = value.identities.find((entry) => entry?.name === identity);
              if (!found) {
                  throw new Error(
                      `${setting} has no identity named ${identity} (${setting.replace('CREDENTIALS', 'IDENTITY')}).`,
                  );
              }
              const first = Array.isArray(found.credentials) ? found.credentials[0] : undefined;
              return { id: first?.accessKey, secret: first?.secretKey };
          })()
        : { id: value.accessKeyId, secret: value.secretAccessKey };
    if (typeof pair.id !== 'string' || typeof pair.secret !== 'string' || !pair.id.trim() || !pair.secret.trim()) {
        throw new Error(
            `${setting} needs an access key and a secret key (accessKeyId and secretAccessKey, or an identity’s credentials).`,
        );
    }
    return { accessKeyId: pair.id.trim(), secretAccessKey: pair.secret.trim() };
}

/**
 * One S3-compatible store's settings from `<prefix>S3_*`: the data space's
 * (`S3_*`) or the off-site backup copy's (`BACKUP_S3_*`). Malformed
 * settings stop startup without echoing secret values.
 */
export function s3SettingsFromEnv(
    env: Record<string, string | undefined>,
    prefix: '' | 'BACKUP_',
    defaults: { bucket?: string; example: string },
): S3Settings {
    const name = (setting: string) => `${prefix}S3_${setting}`;
    const endpoint = env[name('ENDPOINT')]?.trim();
    const credentials = env[name('CREDENTIALS')]?.trim();
    if (!endpoint || !credentials) {
        throw new Error(
            prefix
                ? `${name('ENDPOINT')} needs ${name('CREDENTIALS')} (or ${name('CREDENTIALS_FILE')}).`
                : 'STORAGE_DRIVER=s3 needs S3_ENDPOINT and S3_CREDENTIALS (or S3_CREDENTIALS_FILE).',
        );
    }
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error(`${name('ENDPOINT')} must be a URL, e.g. ${defaults.example}.`);
    }
    if (
        !/^https?:$/.test(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.pathname.replace(/\/+$/, '')
    ) {
        throw new Error(`${name('ENDPOINT')} must be an http(s) origin without a path, e.g. ${defaults.example}.`);
    }
    const bucket = env[name('BUCKET')]?.trim() || defaults.bucket;
    if (!bucket) {
        throw new Error(`${name('ENDPOINT')} needs ${name('BUCKET')}.`);
    }
    if (!BUCKET.test(bucket) || bucket.includes('..')) {
        throw new Error(`${name('BUCKET')} must be a bucket name: lowercase letters, digits, dots and dashes.`);
    }
    const region = env[name('REGION')]?.trim() || 'us-east-1';
    if (!REGION.test(region)) {
        throw new Error(`${name('REGION')} must be a region name such as us-east-1.`);
    }
    const style = env[name('FORCE_PATH_STYLE')]?.trim().toLowerCase() || 'true';
    if (style !== 'true' && style !== 'false') {
        throw new Error(`${name('FORCE_PATH_STYLE')} must be true or false.`);
    }
    const forcePathStyle = style === 'true';
    // Virtual-hosted: the bucket becomes the first label of the endpoint's host.
    if (!forcePathStyle) {
        if (/^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) {
            throw new Error(
                `${name('FORCE_PATH_STYLE')}=false needs a host name in ${name('ENDPOINT')}, not an address.`,
            );
        }
        if (url.protocol === 'https:' && bucket.includes('.')) {
            throw new Error(
                `${name('BUCKET')} has dots, which break TLS with virtual-hosted style: set ${name('FORCE_PATH_STYLE')}=true.`,
            );
        }
    }
    return {
        endpoint: url.origin,
        bucket,
        region,
        forcePathStyle,
        ...parseS3Credentials(credentials, env[name('IDENTITY')]?.trim() || 'company-brain', name('CREDENTIALS')),
    };
}

/**
 * Reads the storage settings: an S3-compatible object store when
 * `S3_ENDPOINT` is set (or `STORAGE_DRIVER=s3`), else the local disk.
 * Malformed settings stop startup without echoing secret values.
 */
export function storageSettingsFromEnv(env: Record<string, string | undefined>): StorageSettings {
    const tenantId = env.TENANT_ID?.trim() || 'main';
    if (!TENANT.test(tenantId)) {
        throw new Error('TENANT_ID must be lowercase letters, digits and dashes (up to 63), e.g. main.');
    }
    const endpoint = env.S3_ENDPOINT?.trim();
    const driver = env.STORAGE_DRIVER?.trim().toLowerCase() || (endpoint ? 's3' : 'local');
    if (driver !== 'local' && driver !== 's3') {
        throw new Error('STORAGE_DRIVER must be local or s3.');
    }
    if (driver === 'local') {
        return { driver, tenantId };
    }
    return {
        driver,
        tenantId,
        s3: s3SettingsFromEnv(env, '', {
            bucket: 'company-brain',
            example: 'http://company-brain-s3:8333',
        }),
    };
}
