/**
 * Which app versions this server works with (CB-553): `GET
 * /api/client/compat` publishes them, and the guard refuses an app below its
 * platform's minimum with one answer, 426 `client_update_required`, before
 * any feature sees the request. Only the app's own User-Agent
 * (`Socio/<version> (<iPhone|iPad|Android>; …)`) is read; the web, MCP,
 * connected agents and plugins send none, so they are never refused for a
 * version. Sign-in and sign-out (all of `/api/auth/`) and the compat endpoint
 * stay open to an old app, so it can still sign in, sign out and learn what
 * it needs; everything outside `/api/` (the pages, `/ping`, `/healthz`, the
 * workspace manifest, static files) never reaches the guard.
 *
 * The numbers are `CLIENT_COMPAT` (@socio/shared/client-compat), raised in the
 * release that stops serving older apps (docs/RELEASING.md), unless an
 * operator sets APP_MINIMUM_VERSION or APP_RECOMMENDED_VERSION
 * (`clientCompatFromEnv`).
 */
import type { Hono, MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import {
    APP_PLATFORMS,
    appFromUserAgent,
    appVerdict,
    CLIENT_COMPAT,
    CLIENT_COMPAT_PATH,
    CLIENT_UPDATE_REQUIRED,
    CLIENT_UPDATE_STATUS,
    CLIENT_UPDATE_WORDS,
    compareAppVersions,
    isAppVersion,
    type AppPlatform,
    type ClientCompat,
    type ClientUpdateRequired,
    type PlatformCompat,
} from '@socio/shared/client-compat';

/** What an app below the minimum may still reach: sign-in, sign-out and the session, and the numbers. */
export function exemptFromClientCompat(path: string): boolean {
    return path === CLIENT_COMPAT_PATH || path === '/api/auth' || path.startsWith('/api/auth/');
}

const readVersion = (value: string | undefined, name: string): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    if (!isAppVersion(trimmed)) {
        throw new Error(`${name} must be an app version such as 0.2.7.`);
    }
    return trimmed;
};

/**
 * The numbers this server publishes and enforces: `CLIENT_COMPAT`, or for
 * every platform `APP_MINIMUM_VERSION` and `APP_RECOMMENDED_VERSION` when
 * set. A recommendation below the minimum is the minimum. Malformed values
 * stop startup.
 */
export function clientCompatFromEnv(
    env: Record<string, string | undefined>,
    defaults: ClientCompat = CLIENT_COMPAT,
): ClientCompat {
    const minimum = readVersion(env.APP_MINIMUM_VERSION, 'APP_MINIMUM_VERSION');
    const recommended = readVersion(env.APP_RECOMMENDED_VERSION, 'APP_RECOMMENDED_VERSION');
    if (minimum === undefined && recommended === undefined) {
        return defaults;
    }
    const platform = (platform: AppPlatform): PlatformCompat => {
        const floor = minimum ?? defaults.platforms[platform].minimum;
        const wanted = recommended ?? defaults.platforms[platform].recommended;
        return { minimum: floor, recommended: compareAppVersions(wanted, floor) < 0 ? floor : wanted };
    };
    return { platforms: { ios: platform('ios'), android: platform('android') } };
}

/** `GET /api/client/compat`: the numbers, for anyone, no session read. */
export function clientCompatRoutes(compat: ClientCompat) {
    return (app: Hono<AppEnv>) => {
        app.get(CLIENT_COMPAT_PATH, function clientCompat(c) {
            c.header('Cache-Control', 'no-store');
            return c.json({
                platforms: Object.fromEntries(APP_PLATFORMS.map((platform) => [platform, compat.platforms[platform]])),
            });
        });
    };
}

/**
 * The guard on `/api/*`: an app below its platform's minimum gets the one refusal.
 *
 * A compatibility aid, not access control: it trusts the User-Agent the app reports about itself,
 * which any client can set or leave out. It only spares an old app the errors of shapes it can't
 * read; every route still checks the session and permissions on its own.
 */
export function clientCompatGuard(compat: ClientCompat): MiddlewareHandler<AppEnv> {
    return async function clientVersion(c, next) {
        if (exemptFromClientCompat(c.req.path)) {
            return next();
        }
        const app = appFromUserAgent(c.req.header('user-agent'));
        if (app === null) {
            return next();
        }
        const { minimum } = compat.platforms[app.platform];
        if (appVerdict(app.version, compat.platforms[app.platform]) !== 'required') {
            return next();
        }
        c.header('Cache-Control', 'no-store');
        return c.json(
            {
                error: CLIENT_UPDATE_WORDS,
                code: CLIENT_UPDATE_REQUIRED,
                minimum,
                platform: app.platform,
            } satisfies ClientUpdateRequired,
            CLIENT_UPDATE_STATUS,
        );
    };
}
