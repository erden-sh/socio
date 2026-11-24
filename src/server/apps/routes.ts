import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import type { AppAttemptsState, AppsState, DotAppsState } from '@socio/shared/apps/app-types';

import type { ActorActionsShape, ActorCall } from '../actors/contract.js';

import type { AppExtractions } from './contract.js';
import { AppError, AppsService, safeNext } from './service.js';

/**
 * The socio-access calls the routes share with plugins: actors'
 * `ActorActions`, which the module reads from its services.
 */
export type AppsRoutesActions = Pick<ActorActionsShape, 'continuationCall' | 'approvalCall' | 'consumeCall'>;

const share = z.object({ sharedSpaceId: z.string().min(1).max(64).nullable() }).strict();
const launch = z.object({ next: z.string().max(1000).optional() }).strict();
const choice = z
    .object({
        ref: z.string().min(1).max(100),
        choice: z.enum(['move', 'share', 'keep']),
        spaceId: z.string().min(1).max(64).optional(),
        name: z.string().max(80).optional(),
        dotReads: z.boolean().optional(),
    })
    .strict();
const promote = z
    .object({
        version: z.number().int().min(1),
        datasets: z.array(choice).max(20),
        env: z.record(z.string().max(64), z.string().max(300)).default({}),
    })
    .strict();
const remove = z.object({ data: z.enum(['keep', 'delete']) }).strict();
const OBO_HEADER = 'x-cb-obo';

const attemptQuery = z.object({
    version: z.coerce.number().int().min(1).optional(),
    attempt: z.coerce.number().int().min(1).optional(),
    tail: z.coerce.number().int().min(1).max(400).optional(),
});

/**
 * `/api/apps` on the app's own origin: the signed-in user's mini apps and
 * those shared with their Spaces; the launch code hand-off to an app's
 * origin; sharing and unregistering, by the owner only. `extractions`:
 * socio access's extraction delivery (`AppExtractionDelivery`), which the
 * coding gateways provide; without it, the extraction route refuses.
 */
export function appRoutes(apps: AppsService, actions: AppsRoutesActions, extractions?: AppExtractions) {
    const app = new Hono<AppEnv>();
    const fail = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof AppError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };

    // ---- socio access: calls from the app itself (CB-232) -----------------
    // With the app's own data token (app.ts lets app tokens reach these
    // paths) and the request's `cbob_` in `x-cb-obo`; never a person's
    // session. The `cbob_` must be this app's: another app's token can't
    // use it, and the grant always comes from it, never from the app.
    const caller = async (
        c: Context<AppEnv>,
    ): Promise<{ actors: NonNullable<AppsService['actors']>; call: ActorCall } | undefined> => {
        const token = c.get('dataToken');
        if (!token || token.purpose !== 'app') {
            return undefined;
        }
        const appId = token.appId ?? (token.session.startsWith('app:') ? token.session.slice(4) : undefined);
        const record = appId ? apps.get(appId) : undefined;
        const actors = apps.actors;
        // Nothing on behalf of anyone while an older runtime is live.
        if (!record || !actors || !actors.issuable()) {
            return undefined;
        }
        const obo = actors.openObo(c.req.header(OBO_HEADER), record.id);
        if (!obo) {
            return undefined;
        }
        return {
            actors,
            call: {
                audience: `app:${record.id}`,
                obo,
                personSession: async (hash) => !!(await apps.sessionByHash(record.id, hash)),
                mintPersonObo: (sessionHash, requestId, ttlMs) =>
                    actors.mintObo({ appId: record.id, sessionHash, requestId, ttlMs }),
            },
        };
    };
    const refused = (c: Context<AppEnv>) =>
        c.json({ error: 'Send the app’s data token and the request’s x-cb-obo.' }, 403);
    // The handlers are shared with plugins (actors' `ActorActions`).
    app.post('/apps/actor/continuations', async (c) => {
        const found = await caller(c);
        if (!found) {
            return refused(c);
        }
        return actions.continuationCall(c, found.actors, found.call);
    });
    // A consequential action asks for the person's approval: the actors
    // module's `requestAppAction` checks the tier, the grant's `app:act`,
    // the size and the cap, with the grant from the `cbob_` and the app
    // from the token, never from the body.
    app.post('/apps/actor/approvals', async (c) => {
        const found = await caller(c);
        if (!found) {
            return refused(c);
        }
        return actions.approvalCall(c, found.call);
    });
    // The repeated request consumes it, once: the grant from this
    // request's `cbob_`.
    app.post('/apps/actor/approvals/:id/consume', async (c) => {
        const found = await caller(c);
        if (!found) {
            return refused(c);
        }
        return actions.consumeCall(c, found.call, c.req.param('id'));
    });

    // A repository extraction the person approved for this app (CB-239,
    // CB-267): read with the app's own data token (a promoted
    // app's, never a development app's) and the request's `x-cb-obo`. Only
    // the app id comes from here; the extraction's person, socio, the read
    // window and the audit are the `Gateway` service's `deliverExtraction`
    // (`AppExtractionDelivery`).
    app.get('/apps/actor/extractions/:id', async (c) => {
        const token = c.get('dataToken');
        const appId = token && token.purpose === 'app' && token.appId ? token.appId : undefined;
        const record = appId ? apps.get(appId) : undefined;
        const actors = apps.actors;
        // Nothing on behalf of anyone while an older runtime is live.
        if (!extractions || !record || !actors || !actors.issuable()) {
            return refused(c);
        }
        const id = c.req.param('id');
        if (!/^[0-9a-f-]{36}$/.test(id)) {
            return c.json({ error: 'No such extraction.' }, 404);
        }
        const answer = await extractions({
            id,
            appId: record.id,
            obo: c.req.header(OBO_HEADER),
        });
        if (answer.status !== 200) {
            return c.json({ error: answer.error }, answer.status);
        }
        return new Response(new Uint8Array(answer.body), {
            status: 200,
            headers: {
                'content-type': `${answer.contentType}; charset=utf-8`,
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
            },
        });
    });

    app.get('/apps', async (c) =>
        c.json<AppsState>({
            enabled: apps.enabled,
            ...(apps.settings ? { host: apps.settings.host } : {}),
            apps: await apps.listFor(c.get('user').id),
            // Admins: the apps they can't open, by name and owner (CB-442).
            ...((others) => (others ? { others } : {}))(apps.othersFor(c.get('user').id)),
        }),
    );
    // A socio's home page (CB-260): its apps this user may open, from the
    // registry only (no probe, no start). Before `/apps/:id/…`.
    app.get('/apps/dots/:dotId', (c) => {
        try {
            return c.json<DotAppsState>({
                enabled: apps.enabled,
                apps: apps.homeFor(c.get('user').id, c.req.param('dotId')),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    // POST (JSON, same origin): a cross-site page can't start a launch.
    app.post('/apps/:id/launch', async (c) => {
        const parsed = launch.safeParse(await c.req.json().catch(() => ({})));
        if (!parsed.success) {
            return c.json({ error: 'Invalid request.' }, 400);
        }
        try {
            return c.json({
                url: apps.launch(c.req.param('id'), c.get('user').id, safeNext(parsed.data.next)),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.patch('/apps/:id', async (c) => {
        const parsed = share.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Choose a Space, or none.' }, 400);
        }
        try {
            return c.json(await apps.share(c.req.param('id'), c.get('user').id, parsed.data.sharedSpaceId));
        } catch (error) {
            return fail(c, error);
        }
    });
    // Promotion: the wizard's plan, the user's own promotion (their
    // choice is the review), rollback, unpublish, publish, delete, logs.
    const promotions = apps.promotions;
    const owner = (c: Context<AppEnv>) => c.get('user').id;
    const view = (id: string, userId: string) => apps.view(apps.get(id)!, userId);
    app.get('/apps/:id/promotion', (c) => {
        try {
            const version = Number(c.req.query('version') ?? '') || undefined;
            return c.json(promotions.plan(c.req.param('id'), owner(c), version));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/apps/:id/promote', async (c) => {
        const parsed = promote.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: 'Choose a version and, for each dataset, what happens to it.',
                },
                400,
            );
        }
        try {
            const outcome = await promotions.promote(owner(c), {
                appId: c.req.param('id'),
                ...parsed.data,
            });
            return c.json({ outcome, app: view(c.req.param('id'), owner(c)) });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/apps/:id/rollback', async (c) => {
        try {
            const rolled = await promotions.rollback(c.req.param('id'), owner(c));
            return c.json({ app: apps.view(rolled, owner(c)) });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/apps/:id/unpublish', async (c) => {
        try {
            const done = await promotions.unpublish(c.req.param('id'), owner(c));
            return c.json({ app: apps.view(done, owner(c)) });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.post('/apps/:id/publish', async (c) => {
        try {
            const done = await promotions.publish(c.req.param('id'), owner(c));
            return c.json({
                app: apps.view(done.app, owner(c)),
                ...(done.warning ? { warning: done.warning } : {}),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    // Promoted apps: deleting is explicit about the data.
    app.post('/apps/:id/delete', async (c) => {
        const parsed = remove.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Say whether its data goes too: data keep or delete.' }, 400);
        }
        try {
            const target = apps.get(c.req.param('id'));
            if (target && target.ownerUserId === owner(c) && !AppsService.inRuntime(target)) {
                return c.json(await apps.unregister(target.id, owner(c)));
            }
            // The id it is kept under, which the datasets deleted with it name.
            const retired = AppsService.retiredId();
            const result = await promotions.remove(c.req.param('id'), owner(c), parsed.data.data === 'delete', retired);
            await apps.dropRecord(c.req.param('id'), owner(c), retired);
            return c.json({ ok: true, ...result });
        } catch (error) {
            return fail(c, error);
        }
    });
    app.get('/apps/:id/logs', async (c) => {
        try {
            return c.json({
                lines: await promotions.logs(apps.logsOf(c.req.param('id'), owner(c))),
            });
        } catch (error) {
            return fail(c, error);
        }
    });
    // CB-146: each build and start attempt, its exit reason and its log; for
    // the app's owner and workspace admins only (CB-175).
    app.get('/apps/:id/attempts', async (c) => {
        const parsed = attemptQuery.safeParse(c.req.query());
        if (!parsed.success) {
            return c.json({ error: 'Ask for a version or attempt number.' }, 400);
        }
        try {
            const target = apps.logsOf(c.req.param('id'), owner(c));
            return c.json<AppAttemptsState>(await promotions.diagnostics(target, parsed.data));
        } catch (error) {
            return fail(c, error);
        }
    });
    app.delete('/apps/:id', async (c) => {
        try {
            return c.json(await apps.unregister(c.req.param('id'), c.get('user').id));
        } catch (error) {
            return fail(c, error);
        }
    });
    return app;
}
