/**
 * Scheduled tasks at the HTTP edge: a person's research and scheduled requests,
 * which the task `Runner` runs.
 */
import { Context } from 'effect';
import type { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';

import type { AppEdge } from '../../main.js';
import type { Runner } from '../../turns/runner.js';
import { AppStatus } from '../app/status.js';
import { LegacyWorkspace } from '../base.js';
import type { CoreStore } from '../core-store.js';

const interval = z.number().int().min(60).max(31_536_000).nullable();

export function mountTaskRoutes(app: Hono<AppEnv>, store: CoreStore, runner: Runner, edge: AppEdge | undefined) {
    // The setup check and the conversations' owner, none without the app's services.
    const sources = edge && {
        status: Context.get(edge.services, AppStatus),
        workspace: Context.get(edge.services, LegacyWorkspace),
    };
    app.post('/api/tasks', async (c) => {
        const parsed = z
            .object({
                prompt: z.string().trim().min(3).max(4000),
                intervalSeconds: interval.optional(),
                threadId: z.string().optional(),
            })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json(
                {
                    error: 'Enter a request between 3 and 4,000 characters; repeat intervals must be at least 60 seconds.',
                },
                400,
            );
        }
        if (!store.slices.settings.settings().researchAllowed) {
            return c.json({ error: 'Research is disabled in Settings.' }, 403);
        }
        if (sources) {
            const { missing } = await sources.status.setup();
            if (missing.length) {
                return c.json({ error: `Setup required: ${missing.join(', ')}.` }, 503);
            }
            if (!parsed.data.threadId) {
                return c.json({ error: 'Select a conversation for this scheduled task.' }, 400);
            }
            try {
                sources.workspace.requireOwnedThread(c.get('user').id, parsed.data.threadId);
            } catch {
                return c.json({ error: 'Conversation is not owned by this workspace.' }, 403);
            }
        }
        const task = await store.scheduled.create(
            parsed.data.prompt,
            parsed.data.intervalSeconds ?? null,
            c.get('user').id,
        );
        if (sources && parsed.data.threadId) {
            await sources.workspace.bindTask(task.id, parsed.data.threadId);
        }
        return c.json(task, 201);
    });
    // Another user's task is reported as missing.
    app.use('/api/tasks/:id/*', async (c, next) =>
        (await store.scheduled.owned(c.req.param('id'), c.get('user').id))
            ? next()
            : c.json({ error: 'Task not found.' }, 404),
    );
    app.get('/api/tasks/:id', async (c) => {
        if (!(await store.scheduled.owned(c.req.param('id'), c.get('user').id))) {
            return c.json({ error: 'Task not found.' }, 404);
        }
        const detail = await store.scheduled.detail(c.req.param('id'));
        return detail ? c.json(detail) : c.json({ error: 'Task not found.' }, 404);
    });
    app.post('/api/tasks/:id/actions', async (c) => {
        const parsed = z
            .object({ action: z.enum(['run', 'pause', 'cancel']) })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Unknown task action.' }, 400);
        }
        if (parsed.data.action === 'run' && !store.slices.settings.settings().researchAllowed) {
            return c.json({ error: 'Research is disabled in Settings.' }, 403);
        }
        const task = await store.scheduled.action(c.req.param('id'), parsed.data.action);
        if (parsed.data.action !== 'run') {
            runner.abort(c.req.param('id'));
        }
        return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
    });
    app.put('/api/tasks/:id/schedule', async (c) => {
        const parsed = z
            .object({ intervalSeconds: interval })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
            return c.json({ error: 'Repeat interval must be 60 seconds to one year, or null.' }, 400);
        }
        const task = await store.scheduled.schedule(c.req.param('id'), parsed.data.intervalSeconds);
        return task ? c.json(task) : c.json({ error: 'Task not found.' }, 404);
    });
}

/** Turns' step, as index.ts mounts it: the task routes. */
export const turnsRoutes = { routes: mountTaskRoutes };
