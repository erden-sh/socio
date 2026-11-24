import { Effect } from 'effect';
import { Hono, type Context as HonoContext } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import { isAdmin } from '@socio/shared/roles';
import { WEB_IDENTITIES } from '@socio/shared/web/web-types';

import type { SociosShape } from '../workspace/contract.js';

import { WebIdentities, WebReader } from './contract.js';

/** What the routes' Effects read: the reader, and the identity setting. */
export type WebRouteServices = WebReader | WebIdentities;

/**
 * Runs a route's Effect with the app's runtime to its end, even if the
 * client goes away (`appHandle(app).uninterruptible`,
 * `composition/http/handle.ts`).
 */
export type WebHandle = <E>(
    f: (c: HonoContext<AppEnv>) => Effect.Effect<Response, E, WebRouteServices>,
) => (c: HonoContext<AppEnv>) => Promise<Response>;

/**
 * A Dot's web identity (`agent` or `browser`). Members read it; admins and
 * operators change it, as they edit Dots, and see the read audit. The
 * reads go through `WebReader` and `WebIdentities`; `handle` runs them to
 * their end even if the client goes away, as before.
 */
export function webRoutes(workspace: Pick<SociosShape, 'canUseDot' | 'dot'>, handle: WebHandle) {
    const app = new Hono<AppEnv>();
    const status = (dotId: string, withAudit: boolean) =>
        WebReader.use((reader) => Effect.promise(() => reader.status(dotId, withAudit)));
    app.use('/dots/:id/web', async (c, next) =>
        workspace.canUseDot(c.get('user').id, c.req.param('id')) ||
        (isAdmin(c.get('user')) && workspace.dot(c.req.param('id')))
            ? next()
            : c.json({ error: 'Socio not found.' }, 404),
    );
    app.get(
        '/dots/:id/web',
        handle((c) => status(c.req.param('id')!, isAdmin(c.get('user'))).pipe(Effect.map((found) => c.json(found)))),
    );
    app.patch(
        '/dots/:id/web',
        requireAdmin,
        handle((c) =>
            Effect.gen(function* () {
                const parsed = z
                    .object({ identity: z.enum(WEB_IDENTITIES).nullable() })
                    .strict()
                    .safeParse(yield* Effect.promise(() => c.req.json().catch(() => null)));
                if (!parsed.success) {
                    return c.json({ error: 'Identity must be agent, browser, or null for the default.' }, 400);
                }
                const identities = yield* WebIdentities;
                yield* Effect.promise(() =>
                    identities.setIdentity(c.req.param('id')!, parsed.data.identity, c.get('user').id),
                );
                return c.json(yield* status(c.req.param('id')!, true));
            }),
        ),
    );
    return app;
}
