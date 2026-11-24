/**
 * Socio Secrets for a workspace app or a service plugin (phases 1 and 2):
 * reads the secrets an
 * admin granted to it from `GET /api/workload/secrets/:name`, with an app's
 * own data token, or a plugin's own identity token (`SOCIO_IDENTITY_FILE`)
 * and the proof of its id.
 *
 * Values live in this process's memory only, each until the `expiresAt`
 * Socio sent with it; they are never written to disk or to the
 * environment, and errors name secrets, never values.
 */

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The soonest a rotation watch fetches again, whatever `expiresAt` says. */
const MIN_REFRESH_MS = 1_000;

export interface SecretValue {
    value: string;
    version: number;
    expiresAt: number;
}

/** A read Socio refused: which secret, the HTTP status, and Socio's reason. Never a value. */
export class SecretReadError extends Error {
    constructor(
        readonly names: string[],
        readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = 'SecretReadError';
    }
}

export interface SecretsClientOptions {
    /** Socio's `/api` base. */
    apiUrl: string;
    /**
     * The app's `authorization` header, or a plugin's with its proof, read
     * again on every call (the token file may have been renewed or rotated).
     */
    credentials: () => Record<string, string> | undefined;
    fetch: typeof fetch;
    now: () => number;
    /** Set for a service plugin, which reads with its identity token. */
    pluginId?: string;
}

export type RotateListener = (value: string, version: number) => void;

/** `socio.secrets`: `get`, `require` and `onRotate`, with an in-memory cache. */
export function secretsClient(options: SecretsClientOptions) {
    const cache = new Map<string, SecretValue>();
    const inflight = new Map<string, Promise<SecretValue>>();
    const listeners = new Map<string, Set<RotateListener>>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const configured = () => {
        if (!options.apiUrl || !options.credentials()) {
            throw new Error(
                options.pluginId === undefined
                    ? 'Socio’s API is not configured for this app (CB_DATA_URL and its data token).'
                    : 'Socio’s API is not configured for this plugin (SOCIO_API_URL, SOCIO_IDENTITY_FILE and CB_PLUGIN_PROOF).',
            );
        }
    };
    const checkName = (name: string) => {
        if (!NAME.test(name)) {
            throw new Error(`"${name.slice(0, 64)}" is not a secret name (UPPER_CASE letters, digits and _).`);
        }
    };
    /** One GET, again once on a 401 with the token read afresh. */
    const request = async (path: string) => {
        let answer: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            const auth = options.credentials();
            if (!auth) {
                break;
            }
            answer = await options.fetch(`${options.apiUrl}/workload/secrets${path}`, {
                method: 'GET',
                headers: auth,
                cache: 'no-store',
            });
            if (answer.status !== 401) {
                break;
            }
        }
        return answer;
    };
    const refusal = async (answer: Response | undefined, names: string[]) => {
        const body = (answer ? await answer.json().catch(() => ({})) : {}) as { error?: unknown; denied?: unknown };
        const denied = Array.isArray(body.denied) ? body.denied.filter((n): n is string => typeof n === 'string') : [];
        const which = denied.length ? denied : names;
        return new SecretReadError(
            which,
            answer?.status ?? 0,
            typeof body.error === 'string' ? body.error : `Socio refused the secret read: ${which.join(', ')}.`,
        );
    };
    const isValue = (value: unknown): value is SecretValue =>
        !!value &&
        typeof (value as SecretValue).value === 'string' &&
        typeof (value as SecretValue).version === 'number' &&
        typeof (value as SecretValue).expiresAt === 'number';

    /** Keeps a value; a new version tells `onRotate`'s listeners, and a watched name is fetched again at expiry. */
    const keep = (name: string, fresh: SecretValue) => {
        const before = cache.get(name);
        cache.set(name, fresh);
        if (before && before.version !== fresh.version) {
            for (const listener of listeners.get(name) ?? []) {
                try {
                    listener(fresh.value, fresh.version);
                } catch {
                    // A listener's failure is its own; the others still hear.
                }
            }
        }
        schedule(name, fresh.expiresAt);
    };
    const schedule = (name: string, at: number) => {
        clearTimeout(timers.get(name));
        timers.delete(name);
        if (!listeners.get(name)?.size) {
            return;
        }
        const timer = setTimeout(
            () => {
                timers.delete(name);
                // The cached value stays until the new one lands, so its version is compared.
                void load(name).catch(() => {
                    // Refused or unreachable: try again a little later.
                    schedule(name, options.now() + 30_000);
                });
            },
            Math.max(MIN_REFRESH_MS, at - options.now()),
        );
        (timer as { unref?: () => void }).unref?.();
        timers.set(name, timer);
    };
    const fetchOne = async (name: string): Promise<SecretValue> => {
        const answer = await request(`/${encodeURIComponent(name)}`);
        if (!answer?.ok) {
            throw await refusal(answer, [name]);
        }
        const body = (await answer.json()) as unknown;
        if (!isValue(body)) {
            throw new SecretReadError([name], answer.status, `Socio sent no value for ${name}.`);
        }
        keep(name, body);
        return body;
    };
    const fresh = (name: string) => {
        const found = cache.get(name);
        return found && found.expiresAt > options.now() ? found : undefined;
    };

    /**
     * A secret's value: from memory until its `expiresAt`, then from Socio
     * again. Throws `SecretReadError` (names only) when it isn't granted.
     */
    const get = async (name: string): Promise<string> => {
        checkName(name);
        const cached = fresh(name);
        if (cached) {
            return cached.value;
        }
        return (await load(name)).value;
    };
    /** A fetch from Socio, shared by concurrent callers. */
    const load = (name: string) => {
        configured();
        let pending = inflight.get(name);
        if (!pending) {
            pending = fetchOne(name).finally(() => inflight.delete(name));
            inflight.set(name, pending);
        }
        return pending;
    };

    /**
     * Fails fast at start: reads every name at once and throws one
     * `SecretReadError` naming each that isn't readable (never a value).
     * What it read is cached for `get`.
     */
    const require = async (names: readonly string[]): Promise<void> => {
        const wanted = [...new Set(names)];
        wanted.forEach(checkName);
        const missing = wanted.filter((name) => !fresh(name));
        if (!missing.length) {
            return;
        }
        configured();
        for (let start = 0; start < missing.length; start += 20) {
            const batch = missing.slice(start, start + 20);
            const answer = await request(`?names=${batch.map(encodeURIComponent).join(',')}`);
            if (!answer?.ok) {
                throw await refusal(answer, batch);
            }
            const body = (await answer.json()) as { secrets?: Record<string, unknown> };
            for (const name of batch) {
                const value = body.secrets?.[name];
                if (!isValue(value)) {
                    throw new SecretReadError([name], answer.status, `Socio sent no value for ${name}.`);
                }
                keep(name, value);
            }
        }
    };

    /**
     * Calls `listener` with each new version of `name`: the SDK fetches it
     * again when the cached value expires. Returns a function that stops it.
     */
    const onRotate = (name: string, listener: RotateListener) => {
        checkName(name);
        const set = listeners.get(name) ?? new Set<RotateListener>();
        set.add(listener);
        listeners.set(name, set);
        const cached = cache.get(name);
        if (cached) {
            schedule(name, cached.expiresAt);
        } else {
            void get(name).catch(() => schedule(name, options.now() + 30_000));
        }
        return () => {
            set.delete(listener);
            if (!set.size) {
                listeners.delete(name);
                clearTimeout(timers.get(name));
                timers.delete(name);
            }
        };
    };

    /** Forgets every cached value and stops every rotation watch. */
    const clear = () => {
        cache.clear();
        for (const timer of timers.values()) {
            clearTimeout(timer);
        }
        timers.clear();
        listeners.clear();
    };

    return { get, require, onRotate, clear };
}

export type SecretsClient = ReturnType<typeof secretsClient>;
