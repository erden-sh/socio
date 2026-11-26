/** Releases at the HTTP edge. */
import { Context } from 'effect';
import type { Hono } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { ClientCompat } from '@socio/shared/client-compat';

import type { AppEdge } from '../../main.js';
import { clientCompatGuard, clientCompatRoutes } from '../../updates/client-compat.js';
import type { ReleaseData } from '../../updates/contract.js';
import { releaseSeenRoutes } from '../../updates/release-seen-routes.js';
import { releaseRoutes } from '../../updates/releases.js';
import { whatsNewRoutes } from '../../updates/whats-new-routes.js';
import { LegacyWorkspace } from '../base.js';
import { LegacyPlugins } from '../plugins.js';

/** Socio's version and its release notes (CB-165, CB-168). */
export function mountReleaseRoutes(app: Hono<AppEnv>, releases: (() => ReleaseData) | undefined) {
    app.route('/api', releaseRoutes(releases));
}

/**
 * What's new (CB-166): what each person has seen of them; and, for the web
 * app and Socio Mobile, the workspace's and its plugins' together (CB-527,
 * `/api/v1/...`), the plugins' notes from the plugins' own service.
 */
export function mountReleaseSeenRoutes(app: Hono<AppEnv>, edge: AppEdge, releases: (() => ReleaseData) | undefined) {
    const workspace = Context.get(edge.services, LegacyWorkspace);
    app.route('/api', releaseSeenRoutes(workspace, releases));
    const notes = Context.get(edge.services, LegacyPlugins).releaseNotes;
    app.route(
        '/api',
        whatsNewRoutes(
            workspace,
            { cards: (person) => notes.cards(person), markSeen: (person, seen) => notes.markSeen(person, seen) },
            releases,
        ),
    );
}

/**
 * Which app versions this server works with (CB-553): `GET /api/client/compat`
 * for anyone, then the guard that answers an app below the minimum with 426
 * `client_update_required`. Before sign-in and the session check, so an old
 * app gets that answer rather than a 401, after the browser checks.
 */
export function mountClientCompat(app: Hono<AppEnv>, compat: ClientCompat) {
    clientCompatRoutes(compat)(app);
    app.use('/api/*', clientCompatGuard(compat));
}

/** Updates' steps, as index.ts mounts them: the app versions, the releases and what each person has seen of them. */
export const updatesRoutes = {
    clientCompat: mountClientCompat,
    releases: mountReleaseRoutes,
    releaseSeen: mountReleaseSeenRoutes,
};
