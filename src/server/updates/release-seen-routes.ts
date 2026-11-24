import { Hono, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import {
    isReleaseVersion,
    MAX_RELEASE_VIEWS,
    type PersonReleases,
    type ReleaseSeen,
} from '@socio/shared/updates/release-seen';

import type { PeopleShape } from '../workspace/contract.js';

import type { ReleaseData } from './contract.js';
import { releaseData } from './releases.js';

/**
 * What's new (CB-166), for signed-in people only: data tokens and service
 * keys never reach these.
 * - `/api/releases/seen`: the newest release the person has opened What's
 *   new on. It only moves forward, so an older tab can't bring back a
 *   release's unread dot.
 * - `POST /api/releases/views`: the releases whose cards the person was
 *   shown, kept with the first time (for support).
 * - `GET /api/admin/people/:id/releases`: admins read both for a person.
 * `seen` and `views` are never a release's tag (`v` and three numbers), so
 * they sit beside `GET /api/releases/:tag`.
 */
export function releaseSeenRoutes(workspace: PeopleShape, data: () => ReleaseData = releaseData) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app for What’s new.' }, 403);
        }
        await next();
    };
    for (const path of ['/releases/seen', '/releases/views', '/admin/people/:id/releases']) {
        app.use(path, signedIn);
    }
    app.use('/admin/people/:id/releases', requireAdmin);
    app.get('/releases/seen', (c) =>
        c.json({
            lastSeen: workspace.lastSeenRelease(c.get('user').id),
        } satisfies ReleaseSeen),
    );
    app.post('/releases/seen', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            version?: unknown;
        } | null;
        if (
            !body ||
            typeof body !== 'object' ||
            Object.keys(body).some((key) => key !== 'version') ||
            !isReleaseVersion(body.version)
        ) {
            return c.json({ error: 'Send { "version" } with a release version, like "0.7.0".' }, 400);
        }
        return c.json({
            lastSeen: workspace.markReleaseSeen(c.get('user').id, body.version),
        } satisfies ReleaseSeen);
    });
    app.post('/releases/views', async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
            versions?: unknown;
        } | null;
        const known = new Set(data().releases.map((release) => release.version));
        const versions = body?.versions;
        if (
            !body ||
            typeof body !== 'object' ||
            Object.keys(body).some((key) => key !== 'versions') ||
            !Array.isArray(versions) ||
            versions.length < 1 ||
            versions.length > MAX_RELEASE_VIEWS ||
            !versions.every((version) => isReleaseVersion(version) && known.has(version))
        ) {
            return c.json(
                {
                    error: `Send { "versions" } with 1 to ${MAX_RELEASE_VIEWS} versions of releases, like ["0.7.0"].`,
                },
                400,
            );
        }
        workspace.recordReleaseViews(c.get('user').id, [...new Set(versions as string[])]);
        return c.json({ ok: true });
    });
    app.get('/admin/people/:id/releases', (c) => {
        const userId = c.req.param('id');
        if (!workspace.hasUser(userId)) {
            return c.json({ error: 'No such person.' }, 404);
        }
        return c.json({
            userId,
            lastSeen: workspace.lastSeenRelease(userId),
            views: workspace.releaseViews(userId),
        } satisfies PersonReleases);
    });
    return app;
}
