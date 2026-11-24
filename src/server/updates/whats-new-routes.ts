import { Hono, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { User } from '@socio/shared/types';
import { compareVersions, isReleaseVersion } from '@socio/shared/updates/release-seen';
import {
    WHATS_NEW_API_VERSION,
    WHATS_NEW_MAX_RELEASES,
    WHATS_NEW_SEEN_MAX_PLUGINS,
    type PluginReleaseNotesResponse,
    type WhatsNewPlugin,
    type WhatsNewResponse,
    type WhatsNewWorkspace,
} from '@socio/shared/updates/whats-new';

import type { PeopleShape } from '../workspace/contract.js';

import type { PluginReleaseNotesSource, ReleaseData } from './contract.js';
import { releaseData, releaseSummary } from './releases.js';

type Seen = Pick<PeopleShape, 'lastSeenRelease' | 'markReleaseSeen'>;

/**
 * What's new across the workspace and its plugins (CB-527), version 1 of
 * the API the web app and Socio Mobile share (`@socio/shared/updates/whats-new`):
 * - `GET /api/v1/release-notes/plugins`: a card per installed plugin the
 *   person may open now, with its stored notes.
 * - `GET /api/v1/whats-new`: what is new to them since they last looked,
 *   for the once-per-person modal. Someone who has never seen a release
 *   starts at the running one, as What's new does (CB-166).
 * - `POST /api/v1/whats-new/seen`: they saw those versions; each only moves
 *   forward. The modal's dismissal, kept per person on the server.
 * A plugin's part is there only while the person may open it, checked on
 * the server on every request (the plugins' `mayUse`).
 */
export function whatsNewRoutes(
    workspace: Seen,
    plugins: PluginReleaseNotesSource | undefined,
    data: () => ReleaseData = releaseData,
) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app for What’s new.' }, 403);
        }
        c.header('Cache-Control', 'no-store');
        await next();
    };
    app.use('/v1/release-notes/*', signedIn);
    app.use('/v1/whats-new', signedIn);
    app.use('/v1/whats-new/*', signedIn);

    const workspacePart = (user: User): WhatsNewWorkspace | null => {
        const { version, releases } = data();
        let lastSeen = workspace.lastSeenRelease(user.id);
        if (lastSeen === null && isReleaseVersion(version)) {
            lastSeen = workspace.markReleaseSeen(user.id, version);
        }
        if (!lastSeen || !isReleaseVersion(lastSeen)) {
            return null;
        }
        const seen = lastSeen;
        const newer = releases.filter(
            (release) =>
                isReleaseVersion(release.version) &&
                compareVersions(release.version, seen) > 0 &&
                (!isReleaseVersion(version) || compareVersions(release.version, version) <= 0),
        );
        if (!newer.length) {
            return null;
        }
        return {
            from: seen,
            to: newer[0]!.version,
            releases: newer.slice(0, WHATS_NEW_MAX_RELEASES).map(releaseSummary),
            count: newer.length,
        };
    };

    const whatsNew = async (user: User): Promise<WhatsNewResponse> => {
        const workspaceNews = workspacePart(user);
        const cards = (await plugins?.cards(user)) ?? [];
        const pluginNews = cards.flatMap((card): WhatsNewPlugin[] => {
            const newer = card.releases.filter((note) => compareVersions(note.version, card.lastSeen) > 0);
            if (!newer.length) {
                return [];
            }
            return [
                {
                    id: card.id,
                    name: card.name,
                    ...(card.icon ? { icon: card.icon } : {}),
                    from: card.lastSeen,
                    to: card.version,
                    releases: newer.slice(0, WHATS_NEW_MAX_RELEASES),
                    count: newer.length,
                },
            ];
        });
        return {
            apiVersion: WHATS_NEW_API_VERSION,
            show: !!workspaceNews || pluginNews.length > 0,
            workspace: workspaceNews,
            plugins: pluginNews,
        };
    };

    app.get('/v1/release-notes/plugins', async (c) =>
        c.json({
            apiVersion: WHATS_NEW_API_VERSION,
            plugins: (await plugins?.cards(c.get('user'))) ?? [],
        } satisfies PluginReleaseNotesResponse),
    );

    app.get('/v1/whats-new', async (c) => c.json((await whatsNew(c.get('user'))) satisfies WhatsNewResponse));

    app.post('/v1/whats-new/seen', async (c) => {
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const refuse = () =>
            c.json(
                {
                    error: `Send { "workspace"?: "0.7.0", "plugins"?: { "<plugin id>": "1.2.0" } } with at most ${WHATS_NEW_SEEN_MAX_PLUGINS} plugins.`,
                },
                400,
            );
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return refuse();
        }
        if (Object.keys(body).some((key) => key !== 'workspace' && key !== 'plugins')) {
            return refuse();
        }
        const { workspace: version, plugins: asked } = body;
        if (version !== undefined && !isReleaseVersion(version)) {
            return refuse();
        }
        if (
            asked !== undefined &&
            (!asked ||
                typeof asked !== 'object' ||
                Array.isArray(asked) ||
                Object.keys(asked).length > WHATS_NEW_SEEN_MAX_PLUGINS ||
                Object.values(asked).some((item) => !isReleaseVersion(item)))
        ) {
            return refuse();
        }
        const user = c.get('user');
        if (version !== undefined) {
            // Only a release this build has, or the running version: a
            // client can't mark a future release seen.
            const { version: running, releases } = data();
            if (version === running || releases.some((release) => release.version === version)) {
                workspace.markReleaseSeen(user.id, version);
            }
        }
        if (asked) {
            await plugins?.markSeen(user, asked as Record<string, string>);
        }
        return c.json((await whatsNew(user)) satisfies WhatsNewResponse);
    });
    return app;
}
