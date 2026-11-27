/**
 * Which Socio app versions a server works with (CB-553), for the server and
 * the native app. The server publishes, per platform, the lowest app version
 * it still serves (`minimum`) and the one it would like people to run
 * (`recommended`) at `GET /api/client/compat`, with no session, and answers
 * an app below the minimum with one well-defined refusal (426
 * `client_update_required`) instead of whatever breaks first. The app reads
 * the same numbers to show its Update Socio gate, or a banner between the two.
 *
 * The app is told apart by its User-Agent alone,
 * `Socio/<version> (<iPhone|iPad|Android>; <OS> <major>)`
 * (apps/mobile/src/net/user-agent.ts). Requests without it (the web, MCP,
 * connected agents, plugins) are never refused for their version.
 *
 * The numbers live here, in `CLIENT_COMPAT`, and move with the server's code:
 * a breaking server change raises the minimum in the same release
 * (docs/RELEASING.md). An operator may override both for every platform with
 * `APP_MINIMUM_VERSION` and `APP_RECOMMENDED_VERSION` (docs/SETUP.md).
 * Nothing here knows a platform runtime: Hermes runs it too.
 */

/** The app's platforms, as the User-Agent names them (an iPad is `ios`). */
export type AppPlatform = 'ios' | 'android';

export const APP_PLATFORMS: readonly AppPlatform[] = ['ios', 'android'];

/** One platform's versions: below `minimum` is refused; below `recommended` is asked to update. */
export interface PlatformCompat {
    readonly minimum: string;
    readonly recommended: string;
}

/** What `GET /api/client/compat` answers. */
export interface ClientCompat {
    readonly platforms: Readonly<Record<AppPlatform, PlatformCompat>>;
}

/** The unauthenticated endpoint the app reads at launch, on foreground and after a refusal. */
export const CLIENT_COMPAT_PATH = '/api/client/compat';

/** The refusal's status (Upgrade Required) and its `code`. */
export const CLIENT_UPDATE_STATUS = 426;
export const CLIENT_UPDATE_REQUIRED = 'client_update_required';

/** The refusal's body, in the server's usual error shape. */
export interface ClientUpdateRequired {
    readonly error: string;
    readonly code: typeof CLIENT_UPDATE_REQUIRED;
    readonly minimum: string;
    readonly platform: AppPlatform;
}

export const CLIENT_UPDATE_WORDS = 'This version of Socio is out of date. Update it to keep using this workspace.';

/**
 * This release's numbers. Raise `minimum` in the release that stops serving
 * older apps, and only once an app at it is installable (TestFlight and Socio
 * Preview); keep `recommended` at least `minimum`.
 *
 * 0.2.7: since v0.54.0 the server speaks AG-UI 1.0 only, and 0.2.6 and older
 * can't send attachments or read them.
 */
export const CLIENT_COMPAT: ClientCompat = {
    platforms: {
        ios: { minimum: '0.2.7', recommended: '0.2.7' },
        android: { minimum: '0.2.7', recommended: '0.2.7' },
    },
};

// One to four whole numbers of up to four digits, as the app's User-Agent writes its version.
const APP_VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
const USER_AGENT = /^Socio\/(\d{1,4}(?:\.\d{1,4}){0,3}) \((iPhone|iPad|Android);/;

/** Whether `value` is an app version (`0.2.7`, `1.0`, `2`). */
export const isAppVersion = (value: unknown): value is string => typeof value === 'string' && APP_VERSION.test(value);

/** Orders two app versions part by part, a missing part 0 (`0.3` is `0.3.0`): negative when `a` is older. */
export function compareAppVersions(a: string, b: string): number {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return Math.sign(difference);
        }
    }
    return 0;
}

/** The app and its version behind a User-Agent, or null for anything else (the web, agents, plugins). */
export function appFromUserAgent(userAgent: string | null | undefined): {
    readonly version: string;
    readonly platform: AppPlatform;
} | null {
    const match = USER_AGENT.exec(userAgent ?? '');
    if (!match) {
        return null;
    }
    return { version: match[1]!, platform: match[2] === 'Android' ? 'android' : 'ios' };
}

/** Where an app version stands: refused, asked to update, or current. */
export type AppVerdict = 'required' | 'recommended' | 'current';

export function appVerdict(version: string, compat: PlatformCompat): AppVerdict {
    if (compareAppVersions(version, compat.minimum) < 0) {
        return 'required';
    }
    return compareAppVersions(version, compat.recommended) < 0 ? 'recommended' : 'current';
}

/** One platform's numbers as a body or a stored copy holds them, or null when they don't read. */
function readPlatform(value: unknown): PlatformCompat | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const { minimum, recommended } = value as { minimum?: unknown; recommended?: unknown };
    if (!isAppVersion(minimum) || !isAppVersion(recommended)) {
        return null;
    }
    // A recommendation below the minimum means the minimum.
    return { minimum, recommended: compareAppVersions(recommended, minimum) < 0 ? minimum : recommended };
}

/** The compat endpoint's body (or a stored copy) for `platform`, or null when it doesn't read. */
export function readPlatformCompat(body: unknown, platform: AppPlatform): PlatformCompat | null {
    if (!body || typeof body !== 'object') {
        return null;
    }
    const platforms = (body as { platforms?: unknown }).platforms;
    if (!platforms || typeof platforms !== 'object') {
        return null;
    }
    return readPlatform((platforms as Record<string, unknown>)[platform]);
}

/** The refusal's minimum and platform, from a 426's JSON body, or null for any other body. */
export function readClientUpdateRequired(body: unknown): Pick<ClientUpdateRequired, 'minimum' | 'platform'> | null {
    if (!body || typeof body !== 'object') {
        return null;
    }
    const { code, minimum, platform } = body as { code?: unknown; minimum?: unknown; platform?: unknown };
    if (code !== CLIENT_UPDATE_REQUIRED || !isAppVersion(minimum) || (platform !== 'ios' && platform !== 'android')) {
        return null;
    }
    return { minimum, platform };
}
