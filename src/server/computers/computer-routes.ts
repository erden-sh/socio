import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { ComputerAction } from '@socio/shared/computers/computer-types';

import type { SociosShape } from '../workspace/contract.js';

import type { ComputersShape } from './contract.js';

/**
 * The computer routes over the `Computers` slice. Handlers stay
 * promise-based: the service's methods return promises, and their
 * rejections reach this router's `onError` as before.
 */
export function computerRoutes(computers: ComputersShape, workspace?: SociosShape) {
    const app = new Hono<AppEnv>();
    // Another person's own Dot, and so its computer, is missing to everyone else.
    app.use('/dots/:id/computer/*', async (c, next) => {
        const dot = workspace?.dot(c.req.param('id'));
        if (dot?.ownerId && dot.ownerId !== c.get('user').id) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        // An archived Dot's computer can be looked at, not used.
        if (dot?.archivedAt && c.req.method !== 'GET') {
            return c.json({ error: 'This socio is archived.' }, 409);
        }
        await next();
    });
    app.use('/dots/:id/computer', async (c, next) => {
        const dot = workspace?.dot(c.req.param('id'));
        if (dot?.ownerId && dot.ownerId !== c.get('user').id) {
            return c.json({ error: 'Socio not found.' }, 404);
        }
        // An archived Dot's computer can be looked at, not used.
        if (dot?.archivedAt && c.req.method !== 'GET') {
            return c.json({ error: 'This socio is archived.' }, 409);
        }
        await next();
    });
    app.onError((error, c) =>
        c.json(
            {
                error: error instanceof z.ZodError ? 'Invalid computer request.' : error.message,
            },
            400,
        ),
    );
    app.get('/dots/:id/computer', async (c) => c.json(await computers.status(c.req.param('id'))));
    // Members use a Dot's computer within the permissions an admin grants.
    app.patch('/dots/:id/computer/permissions', requireAdmin, async (c) =>
        c.json(await computers.permissions(c.req.param('id'), await c.req.json(), c.get('user').id)),
    );
    app.post('/dots/:id/computer/start', async (c) =>
        c.json(await computers.start(c.req.param('id'), c.get('user').id)),
    );
    app.post('/dots/:id/computer/stop', async (c) => c.json(await computers.stop(c.req.param('id'), c.get('user').id)));
    app.post('/dots/:id/computer/take', async (c) =>
        c.json(await computers.control(c.req.param('id'), 'take', c.get('user').id)),
    );
    app.post('/dots/:id/computer/release', async (c) =>
        c.json(await computers.control(c.req.param('id'), 'release', c.get('user').id)),
    );
    app.post('/dots/:id/computer/actions', async (c) => {
        const body = z
            .object({ action: z.string(), input: z.unknown() })
            .strict()
            .parse(await c.req.json());
        return c.json(
            await computers.action(
                c.req.param('id'),
                body.action as ComputerAction,
                body.input,
                'owner',
                c.req.raw.signal,
                c.get('user').id,
            ),
        );
    });
    return app;
}
