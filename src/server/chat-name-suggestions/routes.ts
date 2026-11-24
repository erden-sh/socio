import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { MAX_CHAT_TITLE } from '@socio/shared/types';

import type { ChatNameRoutesDeps } from './contract.js';

const customName = z.string().trim().min(1).max(MAX_CHAT_TITLE);

/**
 * Routes for the inline name-suggestion card (CB-292): read the pending
 * suggestion, and accept, reject or customize it. Authorization is per chat:
 * room admins review shared rooms, the owner reviews single-user chats. No
 * name is applied without explicit approval.
 */
export function chatNameRoutes(deps: ChatNameRoutesDeps) {
    const app = new Hono<AppEnv>();
    const now = deps.now ?? Date.now;
    const user = (c: Context<AppEnv>) => c.get('user').id;
    const reviewGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
        const id = c.req.param('id')!;
        if (!deps.mayReview(id, user(c))) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        await next();
    };

    // The pending suggestion for a chat (the inline card reads this).
    app.get('/chats/:id/name-suggestion', reviewGuard, (c) => {
        const suggestion = deps.repo.pending(c.req.param('id'));
        if (!suggestion) {
            return c.json({ suggestion: null });
        }
        return c.json({ suggestion });
    });

    // Accept the suggested name: applies it and clears the card.
    app.post('/chats/:id/name-suggestion/accept', reviewGuard, (c) => {
        const id = c.req.param('id');
        const suggestion = deps.repo.pending(id);
        if (!suggestion) {
            return c.json({ error: 'No pending suggestion.' }, 404);
        }
        const applied = deps.applyName(id, suggestion.suggestedName, user(c));
        if (!applied) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        deps.repo.settle(id, 'accepted', now());
        return c.json({ ok: true, title: applied });
    });

    // Reject the suggested name: leaves the current name, starts the cooldown.
    app.post('/chats/:id/name-suggestion/reject', reviewGuard, async (c) => {
        const id = c.req.param('id');
        const suggestion = deps.repo.pending(id);
        if (!suggestion) {
            return c.json({ error: 'No pending suggestion.' }, 404);
        }
        const messages = await deps.messageCount(id);
        deps.repo.settle(id, 'rejected', now(), messages);
        return c.json({ ok: true });
    });

    // Customize: the reviewer's own name, applied and cleared.
    app.post('/chats/:id/name-suggestion/customize', reviewGuard, async (c) => {
        const id = c.req.param('id');
        const suggestion = deps.repo.pending(id);
        if (!suggestion) {
            return c.json({ error: 'No pending suggestion.' }, 404);
        }
        const body = z
            .object({ name: customName })
            .strict()
            .safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json({ error: `Enter a name of 1 to ${MAX_CHAT_TITLE} characters.` }, 400);
        }
        const applied = deps.applyName(id, body.data.name, user(c));
        if (!applied) {
            return c.json({ error: 'Conversation not found.' }, 404);
        }
        deps.repo.settle(id, 'customized', now());
        return c.json({ ok: true, title: applied });
    });

    return app;
}
