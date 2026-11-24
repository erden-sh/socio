import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireOperator } from '@socio/foundation/http/guards';
import { reportFailure, safeFailure } from '@socio/foundation/observability/failures';

import { backendInput } from './openai-compatible.js';
import type { InferenceService } from './service.js';
import { ByoError } from './types.js';
import { operatorInferenceView } from './views.js';

const settingsInput = z
    .object({
        defaultBackendId: z.string().min(1).nullable().optional(),
        allowedByoKinds: z.array(z.string().min(1).max(40)).max(20).optional(),
        byoModels: z.record(z.string().min(1).max(40), z.string().min(1).max(80).nullable()).optional(),
    })
    .strict();

/**
 * The audit line a removed backend leaves: a workspace audit entry
 * (`workspace/contract.ts`), named here so inference doesn't import the
 * workspace's contract for one type.
 */
export interface InferenceAuditEntry {
    actor: string;
    action: 'remove';
    targetKind: 'inference_backend';
    targetId: string;
    detail: string;
}

const body = (c: Context<AppEnv>) => c.req.json().catch(() => null);

/** A kind's own failure, or a generic one (never the error's text). */
function failure(c: Context<AppEnv>, error: unknown, operation: string) {
    if (error instanceof ByoError) {
        return c.json({ error: error.message }, error.status);
    }
    reportFailure(operation, [safeFailure(error)]);
    return c.json({ error: 'This connection could not be completed.' }, 502);
}

/**
 * Inference API. `/api/inference/*` is the Operator page: backends,
 * the default backend and the allowed bring-your-own kinds, operators only
 * (403 for admins and members). `/api/me/inference/*` is each user's own
 * connections; a kind's connect flow is `POST /api/me/inference/:kind/connect`.
 * Keys and tokens are write-only: no response carries one.
 */
export function inferenceRoutes(
    inference: InferenceService,
    /** Records a removed backend (CB-64: settings stay hard, audited). */
    audit?: (entry: InferenceAuditEntry) => void,
) {
    const app = new Hono<AppEnv>();
    app.use('/inference', requireOperator);
    app.use('/inference/*', requireOperator);
    app.get('/inference', async (c) => c.json(await operatorInferenceView(inference)));
    app.post('/inference/backends', async (c) => {
        const parsed = backendInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json(
                {
                    error: 'Enter a name, an http(s) base URL and a model; limits are positive whole numbers.',
                },
                400,
            );
        }
        return c.json(await inference.createBackend(parsed.data), 201);
    });
    app.put('/inference/backends/:id', async (c) => {
        const parsed = backendInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json(
                {
                    error: 'Enter a name, an http(s) base URL and a model; limits are positive whole numbers.',
                },
                400,
            );
        }
        const backend = await inference.updateBackend(c.req.param('id'), parsed.data);
        return backend ? c.json(backend) : c.json({ error: 'Backend not found.' }, 404);
    });
    app.delete('/inference/backends/:id', async (c) => {
        const removed = await inference.deleteBackend(c.req.param('id'));
        if (!removed) {
            return c.json({ error: 'Backend not found.' }, 404);
        }
        audit?.({
            actor: c.get('user').id,
            action: 'remove',
            targetKind: 'inference_backend',
            targetId: c.req.param('id'),
            detail: `${removed.label} (${removed.kind})`,
        });
        return c.json({ ok: true });
    });
    app.post('/inference/backends/:id/test', async (c) => {
        const backend = await inference.testBackend(c.req.param('id'));
        return backend ? c.json(backend) : c.json({ error: 'Backend not found.' }, 404);
    });
    app.put('/inference/settings', async (c) => {
        const parsed = settingsInput.safeParse(await body(c));
        if (!parsed.success) {
            return c.json({ error: 'Invalid settings.' }, 400);
        }
        try {
            return c.json(await inference.updateSettings(parsed.data));
        } catch (error) {
            return failure(c, error, 'Inference settings');
        }
    });

    app.get('/me/inference', async (c) => c.json(await inference.userState(c.get('user').id)));
    // The model pickers (a Dot's default, a new chat's model).
    app.get('/me/inference/options', async (c) => c.json(await inference.options(c.get('user').id)));
    app.get('/me/inference/:kind', async (c) => {
        const kind = await inference.userKind(c.get('user').id, c.req.param('kind'));
        return kind ? c.json(kind) : c.json({ error: 'Not found.' }, 404);
    });
    app.post('/me/inference/:kind/connect', async (c) => {
        try {
            return c.json(await inference.connect(c.get('user').id, c.req.param('kind'), await body(c)));
        } catch (error) {
            return failure(c, error, `Inference connect (${c.req.param('kind')})`);
        }
    });
    app.delete('/me/inference/:kind', async (c) =>
        (await inference.disconnect(c.get('user').id, c.req.param('kind')))
            ? c.json({ ok: true })
            : c.json({ error: 'Not connected.' }, 404),
    );
    return app;
}
