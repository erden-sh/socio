import { bundleLimitsFromEnv, type BundleLimits } from './bundle.js';

/**
 * Mini apps: where they are served and their limits.
 *
 * A mini app lives on its own origin,
 * `<scheme>://<APPS_LABEL_PREFIX><app>--<dot>.<APPS_HOST>` with the scheme
 * and port of the app's own origin (APP_ORIGIN), so its cookies and scripts
 * never share an origin with the app's. One label under `APPS_HOST`, so a
 * single wildcard certificate and DNS entry cover them all. `APPS_HOST` may
 * be the app's own host (`app-tracker--dot-ab12cd.brain.example` next to
 * `brain.example`): the app's session cookies are `__Host-` over https, so
 * an app's pages can't plant cookies the app would read (host-cookies.ts).
 */
export interface AppsSettings {
    /** `apps.brain.example`: mini app hosts are `<label>.<host>`. */
    host: string;
    /**
     * `APPS_LABEL_PREFIX` (`app-`, or ''): an app's host label is the prefix
     * and its id. With a prefix, other labels under the host are no app's.
     */
    labelPrefix: string;
    /** The app's own host name (APP_ORIGIN's), never an app's host. */
    mainHost: string;
    /** `https:` or `http:` (from APP_ORIGIN). */
    protocol: 'http:' | 'https:';
    /** `:8443`, or '' for the scheme's default port (from APP_ORIGIN). */
    port: string;
    /** The app's own origin, where launches start and sign-in happens. */
    mainOrigin: string;
    /** How long a session on a mini app's origin lasts. */
    sessionTtlMs: number;
    /** How long a launch code may wait to be used (at most 60 s). */
    codeTtlMs: number;
    /** Largest request body forwarded to a mini app. */
    maxRequestBytes: number;
    /** Largest response body passed back from a mini app. */
    maxResponseBytes: number;
    /** How long a mini app has to answer with headers. */
    timeoutMs: number;
    /** A proxied connection (stream, WebSocket) closes after this much silence. */
    idleMs: number;
    /** Validity of a mini app's data token; refreshed in place well before. */
    tokenTtlMs: number;
    /** Caps on a packaged version (`APPS_BUNDLE_*`). */
    bundle: BundleLimits;
}

const HOUR = 3_600_000;
const HOST = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Letters, digits and single dashes, may end with one: `app-`, `mini`. */
const LABEL_PREFIX = /^(?=.{1,20}$)[a-z0-9]+(-[a-z0-9]+)*-?$/;
/** One DNS label. */
const MAX_LABEL = 63;

const number = (env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be a number from ${min} to ${max}.`);
    }
    return value;
};

/**
 * `APPS_HOST` (e.g. `apps.brain.example`, or the app's own host); unset
 * means `apps.<APP_ORIGIN's host>`, `off` turns mini apps off, and so does
 * an unset APP_ORIGIN (the origin launches start from and whose scheme and
 * port the apps share). `APPS_LABEL_PREFIX` (e.g. `app-`) starts every
 * app's host label.
 */
export function appsSettingsFromEnv(
    env: Record<string, string | undefined>,
    appOrigin: string | undefined,
): AppsSettings | undefined {
    const raw = env.APPS_HOST?.trim().toLowerCase();
    if (raw === 'off' || !appOrigin) {
        return undefined;
    }
    let main: URL;
    try {
        main = new URL(appOrigin);
    } catch {
        return undefined;
    }
    const host = (raw || `apps.${main.hostname}`).replace(/\.$/, '');
    if (!HOST.test(host)) {
        throw new Error('APPS_HOST must be a host name such as apps.brain.example (or off).');
    }
    const labelPrefix = env.APPS_LABEL_PREFIX?.trim().toLowerCase() ?? '';
    if (labelPrefix && !LABEL_PREFIX.test(labelPrefix)) {
        throw new Error(
            'APPS_LABEL_PREFIX must be up to 20 letters, digits and single dashes, such as app- (or empty).',
        );
    }
    return {
        host,
        labelPrefix,
        mainHost: main.hostname.toLowerCase(),
        protocol: main.protocol === 'https:' ? 'https:' : 'http:',
        port: main.port ? `:${main.port}` : '',
        mainOrigin: main.origin,
        sessionTtlMs: number(env, 'APPS_SESSION_HOURS', 12, 1, 168) * HOUR,
        codeTtlMs: 60_000,
        maxRequestBytes: number(env, 'APPS_MAX_REQUEST_MB', 10, 1, 100) * 1048576,
        maxResponseBytes: number(env, 'APPS_MAX_RESPONSE_MB', 100, 1, 1000) * 1048576,
        timeoutMs: number(env, 'APPS_TIMEOUT_SECONDS', 30, 1, 300) * 1000,
        idleMs: number(env, 'APPS_IDLE_SECONDS', 300, 10, 3600) * 1000,
        tokenTtlMs: 7 * 24 * HOUR,
        bundle: bundleLimitsFromEnv(env),
    };
}

/** `Tracker app!` → `tracker-app`: `[a-z0-9-]{1,30}`, no double or edge dashes. */
export function appSlug(name: string) {
    return name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 30)
        .replace(/-+$/g, '');
}

/**
 * The Dot's part of an app's host label: its name (up to 24 characters, or
 * `nameMax`) and six characters of its id, so two Dots of the same name
 * never collide.
 */
export function dotSlug(dot: { id: string; name: string }, nameMax = 24) {
    const name = appSlug(dot.name).slice(0, nameMax).replace(/-+$/g, '') || 'dot';
    const id = dot.id
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .slice(0, 6);
    return `${name}-${id || '0'}`;
}

/**
 * An app's id, `<slug>--<dot slug>`: with `prefix` (APPS_LABEL_PREFIX) in
 * front it is one DNS label (at most 63 characters), so a prefix shortens
 * the Dot's name in it when needed.
 */
export function appLabel(slug: string, dot: { id: string; name: string }, prefix = '') {
    let label = `${slug}--${dotSlug(dot)}`;
    for (let max = 23; max >= 1 && prefix.length + label.length > MAX_LABEL; max--) {
        label = `${slug}--${dotSlug(dot, max)}`;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*--[a-z0-9]+(-[a-z0-9]+)*$/.test(label)) {
        throw new Error('Invalid app name.');
    }
    if (prefix.length + label.length > MAX_LABEL) {
        throw new Error('The app name is too long.');
    }
    // `xn--` starts a punycode label.
    if (`${prefix}${label}`.startsWith('xn--')) {
        throw new Error('Choose another app name.');
    }
    return label;
}

type HostSettings = Pick<AppsSettings, 'host'> & Partial<Pick<AppsSettings, 'labelPrefix' | 'mainHost'>>;

const hostName = (hostHeader: string) => hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/**
 * The app id a request's Host names, if it is one mini app host under
 * `settings.host` (exactly one label more, starting with the label prefix;
 * any port). Undefined for every other host: the bare apps host, the app's
 * own host, and labels without the prefix.
 */
export function appLabelOfHost(settings: HostSettings, hostHeader: string | undefined | null) {
    if (!hostHeader || !isAppsHost(settings, hostHeader)) {
        return undefined;
    }
    const host = hostName(hostHeader);
    const suffix = `.${settings.host}`;
    if (!host.endsWith(suffix)) {
        return undefined;
    }
    const label = host.slice(0, -suffix.length);
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
        return undefined;
    }
    const prefix = settings.labelPrefix ?? '';
    if (!label.startsWith(prefix) || label.length === prefix.length) {
        return undefined;
    }
    return label.slice(prefix.length);
}

/**
 * Whether the Host is under the apps host at all (served by the proxy
 * only): the apps host and every name under it, except the app's own host.
 */
export function isAppsHost(settings: HostSettings, hostHeader: string | undefined | null) {
    if (!hostHeader) {
        return false;
    }
    const host = hostName(hostHeader);
    if (settings.mainHost && host === settings.mainHost) {
        return false;
    }
    return host === settings.host || host.endsWith(`.${settings.host}`);
}

/** The public origin of an app (by its id). */
export function appOrigin(
    settings: Pick<AppsSettings, 'host' | 'protocol' | 'port'> & Partial<Pick<AppsSettings, 'labelPrefix'>>,
    id: string,
) {
    return `${settings.protocol}//${settings.labelPrefix ?? ''}${id}.${settings.host}${settings.port}`;
}

/** Host-only, and `__Host-` (Secure, no Domain, Path=/) over https. */
export function appSessionCookieName(settings: Pick<AppsSettings, 'protocol'>) {
    return settings.protocol === 'https:' ? '__Host-cb_app' : 'cb_app';
}
