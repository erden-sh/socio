import { Hono } from 'hono';

import { requireFlag } from '@socio/foundation/flags/guard';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { CodingHarnessView, CodingSandboxList, CodingSessionView } from '@socio/shared/coding/coding-sessions';
import { isAdmin } from '@socio/shared/roles';

import type { CodingParts } from './parts.js';
import { CodingRefusal, type CodingSessions } from './sessions.js';
import { SandboxSettingsError } from './settings.js';

/** What the routes read: the service (reached on each request), the flags and the audit. */
export interface SessionRoutesParts {
    readonly sessions: () => CodingSessions;
    readonly flags: CodingParts['flags'];
    readonly actors: Pick<CodingParts['actors'], 'audit'>;
}

/**
 * The routes over a coding sessions service, mounted under `/gateway`.
 *
 * A person's own coding sessions (CB-239), for the session card in the
 * chat: `GET /api/gateway/sessions` (`?thread=` for one conversation's)
 * and `GET /api/gateway/sessions/:id`.
 * Only the session's own person sees it; anyone else, an admin included,
 * gets the same 404 as for a session that doesn't exist. 404 while the
 * flag `coding-sessions` is off for them. Outside the gateways'
 * `/coding/*`, whose guards are for admins.
 *
 * The Computer panel's list: `GET /api/gateway/sandboxes?socio=` and
 * `POST /api/gateway/sandboxes/:id/stop` (below).
 *
 * Settings → Coding → Sandboxes (`GET`/`PUT /api/gateway/sandbox`): the
 * registries and the workspace retention over their environment defaults,
 * for admins only, 404 while the flag is off for them (as the gateways'
 * Coding settings are).
 *
 * Settings → Coding → Coding agents (`GET /api/gateway/harnesses`, CB-326):
 * the harnesses this build has, each with its route, whether
 * `CODING_HARNESSES_DISABLED` turned it off, and its terms record. Read
 * only, for admins, behind the same flag.
 */
export function sessionRoutes(parts: SessionRoutesParts) {
    const app = new Hono<AppEnv>();
    const gate = requireFlag(parts.flags, 'coding-sessions');
    app.use('/sessions', gate);
    app.use('/sessions/*', gate);
    app.use('/sandboxes', gate);
    app.use('/sandboxes/*', gate);
    app.use('/sandbox', gate);
    app.use('/sandbox', requireAdmin);
    app.use('/harnesses', gate);
    app.use('/harnesses', requireAdmin);
    app.get('/harnesses', (c) =>
        c.json<{ harnesses: CodingHarnessView[] }>({ harnesses: parts.sessions().harnessViews() }),
    );
    app.get('/sandbox', (c) => c.json(parts.sessions().settings.view()));
    app.put('/sandbox', async (c) => {
        const body: unknown = await c.req.json().catch(() => null);
        try {
            return c.json(await parts.sessions().settings.save(body, c.get('user').id));
        } catch (error) {
            if (error instanceof SandboxSettingsError) {
                return c.json({ error: error.message }, 400);
            }
            throw error;
        }
    });
    // The Computer panel's coding list: `GET /api/gateway/
    // sandboxes?socio=` (the viewer's own on that socio; an admin's view
    // has everyone's) and `POST /api/gateway/sandboxes/:id/stop` (the same
    // end as `coding_stop`). Anyone else's session is the 404 of one that
    // doesn't exist.
    app.get('/sandboxes', (c) => {
        const user = c.get('user');
        const socio = c.req.query('socio') ?? '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(socio)) {
            return c.json({ error: 'Name a socio.' }, 400);
        }
        return c.json<CodingSandboxList>(parts.sessions().sandboxList({ id: user.id, admin: isAdmin(user) }, socio));
    });
    app.post('/sandboxes/:id/stop', async (c) => {
        const user = c.get('user');
        const stopped = await parts.sessions().stopFromPanel({ id: user.id, admin: isAdmin(user) }, c.req.param('id'));
        if (!stopped) {
            return c.json({ error: 'No such session.' }, 404);
        }
        return c.json(stopped);
    });
    app.get('/sessions', async (c) => {
        const service = parts.sessions();
        // One conversation's, when asked (the chat's card while a tool runs).
        const thread = c.req.query('thread');
        const sessions: CodingSessionView[] = await Promise.all(
            service.sessions
                .ofPerson(c.get('user').id, 20)
                .filter((session) => !thread || session.threadId === thread)
                .map((session) => service.cardView(session)),
        );
        return c.json({ sessions });
    });
    app.get('/sessions/:id', async (c) => {
        const service = parts.sessions();
        const session = service.sessions.get(c.req.param('id'));
        if (!session || session.personId !== c.get('user').id) {
            return c.json({ error: 'No such session.' }, 404);
        }
        return c.json(await service.cardView(session));
    });
    // The live transcript (CB-326 step 4): a session's thread events, paged by
    // `?after` (exclusive ordinal; the first page is `after=0`). The person's
    // own session only; anyone else reads 404.
    app.get('/sessions/:id/events', async (c) => {
        const service = parts.sessions();
        const user = c.get('user');
        const after = Math.max(0, Number.parseInt(c.req.query('after') ?? '0', 10) || 0);
        const limit = Math.max(1, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100);
        const page = await service.eventsPage({ id: user.id, admin: isAdmin(user) }, c.req.param('id'), after, limit);
        if (!page) {
            return c.json({ error: 'No such session.' }, 404);
        }
        return c.json(page);
    });
    // The host controls (CB-326 step 4): interrupt the running turn, steer
    // it, roll back to a checkpoint (a turn), or fork from one. The person's
    // own session only; anyone else reads 404. Resume is a new prompt
    // (coding_prompt); stop is coding_stop / the sandbox stop route.
    app.post('/sessions/:id/control', async (c) => {
        const service = parts.sessions();
        const user = c.get('user');
        const body = (await c.req.json().catch(() => null)) as {
            op?: string;
            message?: string;
            beforeTurnId?: string;
            lastTurnId?: string;
        } | null;
        const op = body?.op ?? '';
        if (op !== 'interrupt' && op !== 'steer' && op !== 'rollback' && op !== 'fork') {
            return c.json({ error: 'Unknown control.' }, 400);
        }
        try {
            const outcome = await service.hostControl(
                { id: user.id, admin: isAdmin(user) },
                c.req.param('id'),
                op,
                body,
            );
            if (!outcome) {
                return c.json({ error: 'No such session.' }, 404);
            }
            return c.json(outcome);
        } catch (error) {
            if (error instanceof CodingRefusal) {
                return c.json({ error: error.message }, 409);
            }
            throw error;
        }
    });
    // The gateway exchange log viewer (CB-326 step 5): a session's logged model
    // exchanges, paged by `?after` (exclusive `requestAt`). The session's own
    // person (the holder) or an admin. An admin read is audited (the same
    // pattern as the logged view of private artifacts); the person's own read
    // is not. Metadata + hashes only — bodies are the object store's job (the
    // IaC handoff).
    app.get('/sessions/:id/exchanges', (c) => {
        const service = parts.sessions();
        const user = c.get('user');
        const admin = isAdmin(user);
        const after = Math.max(0, Number.parseInt(c.req.query('after') ?? '0', 10) || 0);
        const limit = Math.max(1, Number.parseInt(c.req.query('limit') ?? '100', 10) || 100);
        const page = service.exchangesPage({ id: user.id, admin }, c.req.param('id'), after, limit);
        if (!page) {
            return c.json({ error: 'No such session.' }, 404);
        }
        if (admin) {
            auditAdminExchangeRead(parts.actors, user.id, c.req.param('id'), 'view');
        }
        return c.json(page);
    });
    // The exchange log export (CB-326 step 5): a session's exchanges as JSON
    // Lines (one metadata record per exchange), downloaded. The holder's or
    // an admin's only; an admin export is audited. Socios never read logs.
    app.get('/sessions/:id/exchanges/export', (c) => {
        const service = parts.sessions();
        const user = c.get('user');
        const admin = isAdmin(user);
        const lines = service.exchangesExport({ id: user.id, admin }, c.req.param('id'));
        if (lines === undefined) {
            return c.json({ error: 'No such session.' }, 404);
        }
        if (admin) {
            auditAdminExchangeRead(parts.actors, user.id, c.req.param('id'), 'export');
        }
        return c.body(lines, 200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="coding-exchanges-${c.req.param('id')}.jsonl"`,
        });
    });
    return app;
}

/**
 * Audits an admin's read of a session's exchange log (CB-326 step 5, the same
 * pattern as the logged view of private artifacts): one `actor_audit` row
 * naming the admin and the session, so the admin's access is itself logged. The
 * person's own read is not audited.
 */
function auditAdminExchangeRead(
    actors: SessionRoutesParts['actors'],
    adminId: string,
    sessionId: string,
    kind: 'view' | 'export',
) {
    actors.audit.recordSoon({
        at: Date.now(),
        correlationId: `coding-exchange-${kind}-${sessionId}-${Date.now()}`,
        phase: 'context',
        actorBy: adminId,
        action: `coding.exchange.${kind}`,
        resourceKind: 'coding',
        resourceId: sessionId,
        detail: kind,
    });
}
