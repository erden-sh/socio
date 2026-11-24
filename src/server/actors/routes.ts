import { Hono, type Context } from 'hono';

import { requireFlag } from '@socio/foundation/flags/guard';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import {
    CARD_TEXT,
    GRANT_END_WORDS,
    grantAccess,
    type SocioGrantView,
    type SocioGrantsState,
} from '@socio/shared/socio-access';
import { inertText } from '@socio/shared/text/inert-text';

import type { FlagsShape } from '../flags/contract.js';

import { newCorrelation, pluginOpensAt, type ActorAppServices } from './approvals.js';
import type { ActorsShape, GrantRecord } from './contract.js';

/**
 * What `/api/actors` reads: socio access itself, the flags, and the apps,
 * plugins and workspace a grant's view names.
 */
export interface ActorRouteServices extends ActorAppServices {
    readonly actors: ActorsShape;
    readonly flags: FlagsShape;
}

/**
 * `/api/actors` (CB-232): a person's own grants with
 * their ends (Account → Socio access) and ending one; everyone's live
 * grants for admins (Operations → Socio access) and ending any. Every
 * route needs the flag `socio-actor-access` on for whoever asks, and
 * revokes through `platform.actors.revoke`. Nobody sees or ends another
 * person's grant here but an admin, who can end it and never approve it.
 */
export function actorRoutes(platform: ActorRouteServices) {
    const app = new Hono<AppEnv>();
    const flag = requireFlag(platform.flags, 'socio-actor-access');
    app.use('/actors', flag);
    app.use('/actors/*', flag);
    app.use('/actors/admin', requireAdmin);
    app.use('/actors/admin/*', requireAdmin);

    const view = (grant: GrantRecord, admin = false) => grantView(platform, grant, admin);

    app.get('/actors/grants', (c) =>
        c.json<SocioGrantsState>({
            grants: platform.actors.grants.ofPerson(c.get('user').id).map((grant) => view(grant)),
        }),
    );

    const end = async (c: Context<AppEnv>, by: 'person' | 'admin'): Promise<Response> => {
        const user = c.get('user');
        const grant = platform.actors.grants.get(c.req.param('id') ?? '');
        // Another person's grant is "not found" to a person (no probing).
        if (!grant || (by === 'person' && grant.personId !== user.id)) {
            return c.json({ error: 'Grant not found.' }, 404);
        }
        if (grant.revokedAt !== null) {
            return c.json({ grant: view(grant, by === 'admin') });
        }
        await platform.actors.revoke(
            { grantId: grant.id },
            user.id,
            by === 'admin' ? 'admin_revoked' : 'person_revoked',
            newCorrelation(),
        );
        return c.json({
            grant: view(platform.actors.grants.get(grant.id)!, by === 'admin'),
        });
    };

    app.delete('/actors/grants/:id', (c) => end(c, 'person'));

    app.get('/actors/admin/grants', (c) =>
        c.json<SocioGrantsState>({
            grants: platform.actors.grants.live().map((grant) => view(grant, true)),
        }),
    );
    app.delete('/actors/admin/grants/:id', (c) => end(c, 'admin'));
    return app;
}

/** A grant as its person, or an admin, sees it. */
export function grantView(platform: ActorAppServices, grant: GrantRecord, admin = false): SocioGrantView {
    const { workspace, apps, plugins } = platform;
    const now = Date.now();
    const audience = grant.audiences[0] ?? '';
    const appId = audience.startsWith('app:') ? audience.slice(4) : null;
    const record = appId && apps.enabled ? apps.get(appId) : undefined;
    // A plugin's grant (CB-232): its name and where it opens.
    const plugin = audience.startsWith('plugin:') ? plugins.get(audience.slice('plugin:'.length)) : undefined;
    const thread = grant.conversationId.startsWith('schedule:') ? undefined : workspace.thread(grant.conversationId);
    const ended = (): SocioGrantView['ended'] => {
        if (grant.revokedAt !== null) {
            const by =
                grant.revokedBy === grant.personId
                    ? 'you'
                    : grant.revokedBy?.startsWith('socio:')
                      ? 'the socio'
                      : grant.revokedBy === 'system' || !grant.revokedBy
                        ? 'Socio'
                        : 'an admin';
            return {
                at: grant.revokedAt,
                reason: GRANT_END_WORDS[grant.revokeReason ?? ''] ?? 'It ended',
                by,
            };
        }
        if (grant.expiresAt <= now) {
            return {
                at: grant.expiresAt,
                reason: GRANT_END_WORDS.expired!,
                by: 'Socio',
            };
        }
        if (now - grant.lastUsedAt >= grant.idleMs) {
            return {
                at: grant.lastUsedAt + grant.idleMs,
                reason: GRANT_END_WORDS.idle!,
                by: 'Socio',
            };
        }
        return null;
    };
    const end = ended();
    const person = admin ? workspace.users().find((user) => user.id === grant.personId) : undefined;
    return {
        id: grant.id,
        socioId: grant.socioId,
        socioName: workspace.dot(grant.socioId)?.name ?? 'A deleted socio',
        ...(admin
            ? {
                  personId: grant.personId,
                  personName: person?.name ?? 'A former member',
              }
            : {}),
        audience,
        app: record
            ? {
                  label: inertText(record.name, { max: CARD_TEXT.label, lines: false }),
                  origin: safeUrl(() => apps.url(record)),
              }
            : plugin
              ? {
                    label: inertText(plugin.manifest.name, {
                        max: CARD_TEXT.label,
                        lines: false,
                    }),
                    origin: pluginOpensAt(plugins, plugin),
                }
              : null,
        access: grantAccess(grant.scopes),
        scopes: grant.scopes,
        task: inertText(grant.task, { max: CARD_TEXT.task }),
        conversation: {
            kind: grant.conversationKind,
            // Another person's chat title is theirs: admins see the kind only.
            title: !admin || grant.conversationKind === 'room' ? (thread?.title ?? null) : null,
        },
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        lastUsedAt: grant.lastUsedAt,
        idleMinutes: Math.round(grant.idleMs / 60_000),
        state: end ? 'ended' : 'live',
        ended: end,
    };
}

function safeUrl(url: () => string) {
    try {
        return url();
    } catch {
        return null;
    }
}
