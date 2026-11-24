import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { conditionalJsonAsync } from '@socio/foundation/http/conditional';
import type { AccessRoomContext } from '@socio/shared/operations/operations-access';
import { isAdmin } from '@socio/shared/roles';

import type { AccessSubject, AuditOptions } from '../operations/contract.js';

import type { RunsViewsShape } from './contract.js';

/** The most runs one answer lists; the page loader asks for fewer. */
export const RUN_LIMIT = 200;
const status = z.enum(['running', 'finished', 'stopped', 'failed', 'interrupted']).optional();

export interface RunRoutesDeps {
    /**
     * The access log's route wrapper (`auditor`, CB-188), for an admin's
     * open of another person's trace. None: nothing is logged (tests).
     */
    audit?: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
}

/**
 * Runs: recent agent turns, across all users for admins and their own for
 * members (a room's by role, CB-213: `runsView`), each with its trace
 * (CB-128). Metadata, the error text and the
 * trace's names, times and counts; never event payloads or message content.
 */
export function runRoutes(views: RunsViewsShape, { audit }: RunRoutesDeps = {}) {
    const app = new Hono<AppEnv>();
    const { runsView, runTraceView } = views;
    // The turns whose trace a request served from someone else's chat, and
    // a room's turn's context: the room, its initiator and socio (CB-213).
    const served = new WeakMap<Context<AppEnv>, { subject: AccessSubject; room?: AccessRoomContext }>();
    const auditedTrace = audit?.({
        surface: 'trace',
        subject: (c) => served.get(c)?.subject,
        content: true,
        once: 'always',
        filters: (c) => ({ ...served.get(c)?.room }),
    });
    app.get('/runs', (c) => {
        const filter = status.safeParse(c.req.query('status') || undefined);
        if (!filter.success) {
            return c.json({ error: 'Unknown run status.' }, 400);
        }
        const limit = Number(c.req.query('limit') ?? RUN_LIMIT);
        if (!Number.isInteger(limit) || limit < 1 || limit > RUN_LIMIT) {
            return c.json({ error: `Ask for 1 to ${RUN_LIMIT} runs.` }, 400);
        }
        const user = c.get('user');
        // Polled by Runs: 304 when the list is the same (a body hash).
        return conditionalJsonAsync(c, () =>
            runsView(user.id, {
                status: filter.data,
                limit,
                own: !isAdmin(user),
            }),
        );
    });
    // Another person's turn is missing, as is a deleted conversation's. An
    // admin's open of a trace from a chat that isn't theirs, from Runs or
    // from Operations → Reliability, is written to the access log (CB-188):
    // only signed-in admins, never a key, and not shown when it can't be
    // written. A member's own traces, and a turn from before traces, aren't.
    // A room's turn (CB-213) is logged with its room, initiator and socio,
    // for a workspace admin who didn't start it: they read rooms only so.
    app.get(
        '/runs/:runId/trace',
        (c, next) => (auditedTrace && isAdmin(c.get('user')) ? auditedTrace(c, next) : next()),
        (c) => {
            const user = c.get('user');
            const found = runTraceView({ id: user.id, admin: isAdmin(user) }, c.req.param('runId'));
            if (!found) {
                return c.json({ error: 'Run not found.' }, 404);
            }
            if (found.view.trace && found.ownerId !== user.id) {
                served.set(c, {
                    subject: { kind: 'run', id: found.view.runId },
                    ...(found.room ? { room: found.room } : {}),
                });
            }
            return c.json(found.view);
        },
    );
    return app;
}
