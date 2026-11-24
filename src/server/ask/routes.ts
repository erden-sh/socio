import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { ASK_CONTEXT_KINDS } from '@socio/shared/ask';

import { AskError } from './contexts.js';
import type { AskShape } from './contract.js';

const contextRef = {
    kind: z.enum(ASK_CONTEXT_KINDS),
    id: z.string().max(200).default(''),
};

/**
 * `/api/ask` (CB-26): the "Ask a socio" panel's conversation for the item
 * on screen, and the socio last asked. Signed-in people only: data tokens
 * and service keys never reach these.
 */
export function askRoutes(service: AskShape) {
    const app = new Hono<AppEnv>();
    const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
        if (c.get('serviceKey') || c.get('dataToken')) {
            return c.json({ error: 'Sign in to the app to ask a socio.' }, 403);
        }
        await next();
    };
    app.use('/ask', signedIn);
    app.use('/ask/*', signedIn);

    // The item's conversation with `dotId` (default: the socio last asked),
    // without making one.
    app.get('/ask/conversation', async (c) => {
        const query = z
            .object({ ...contextRef, dotId: z.string().min(1).max(200).optional() })
            .strict()
            .safeParse(c.req.query());
        if (!query.success) {
            return c.json({ error: 'Not found.' }, 404);
        }
        const { dotId, ...ref } = query.data;
        return c.json(await service.lookup(c.get('user').id, ref, dotId));
    });
    // The first message: makes the conversation, or returns the one there is.
    app.post('/ask/conversation', async (c) => {
        const body = z
            .object({ ...contextRef, dotId: z.string().min(1).max(200) })
            .strict()
            .safeParse(await c.req.json());
        if (!body.success) {
            return c.json({ error: 'Choose a socio.' }, 400);
        }
        const { dotId, ...ref } = body.data;
        return c.json(await service.open(c.get('user').id, ref, dotId));
    });
    // The socio picked in the panel, remembered for the next screen.
    app.put('/ask/socio', async (c) => {
        const body = z
            .object({ dotId: z.string().min(1).max(200) })
            .strict()
            .safeParse(await c.req.json());
        if (!body.success) {
            return c.json({ error: 'Choose a socio.' }, 400);
        }
        service.pick(c.get('user').id, body.data.dotId);
        return c.json({ ok: true });
    });
    app.onError((error, c) =>
        error instanceof SyntaxError
            ? c.json({ error: 'Invalid JSON request.' }, 400)
            : error instanceof AskError
              ? c.json({ error: error.message }, error.status)
              : c.json({ error: 'Could not open this conversation. Retry.' }, 503),
    );
    return app;
}
