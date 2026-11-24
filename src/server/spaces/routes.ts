import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { SPACE_MEMORY_TEXT_MAX, SPACE_ROLES } from '@socio/shared/space-memory';

import { SpaceMemoryError, type SpaceMemoryShape } from '../memory/contract.js';

import { SpaceAccessError, type SpaceAccessShape } from './contract.js';

const TEXT_ERROR = `An entry is between 1 and ${SPACE_MEMORY_TEXT_MAX.toLocaleString('en')} characters.`;
const text = z.string().trim().min(1).max(SPACE_MEMORY_TEXT_MAX);
const proposed = z.object({ text }).strict();
const approved = z.object({ text: text.optional() }).strict();
const roled = z.object({ role: z.enum(SPACE_ROLES) }).strict();
const opened = z.object({ membersOnly: z.boolean() }).strict();

/**
 * A Space's shared memory and its people (CB-181, docs/MEMORY.md "Space
 * memory"). Every route asks the Space's access first: a Space the person
 * can't read is a 404, so its id can't be probed; what only editors may do
 * is a 403 for its readers.
 */
export function spaceMemoryRoutes(service: SpaceMemoryShape, access: SpaceAccessShape) {
    const app = new Hono<AppEnv>();
    const body = async (c: Context<AppEnv>) => c.req.json().catch(() => null);
    const refused = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof SpaceMemoryError || error instanceof SpaceAccessError) {
            return c.json({ error: error.message }, error.status);
        }
        throw error;
    };
    const answer =
        (work: (c: Context<AppEnv>, user: string, spaceId: string) => unknown) => async (c: Context<AppEnv>) => {
            try {
                const result = await work(c, c.get('user').id, c.req.param('spaceId')!);
                return result instanceof Response ? result : c.json(result);
            } catch (error) {
                return refused(c, error);
            }
        };

    app.get(
        '/spaces/:spaceId/memory',
        answer((_c, user, spaceId) => service.view(spaceId, user)),
    );
    // A reader's proposal waits; an editor's own entry is in use at once.
    app.post(
        '/spaces/:spaceId/memory',
        answer(async (c, user, spaceId) => {
            const parsed = proposed.safeParse(await body(c));
            if (!parsed.success) {
                return c.json({ error: TEXT_ERROR }, 400);
            }
            const made = await service.propose(spaceId, user, parsed.data);
            return c.json(made, 201);
        }),
    );
    app.get(
        '/spaces/:spaceId/memory/entries/:entryId/history',
        answer((c, user, spaceId) => service.history(spaceId, c.req.param('entryId')!, user)),
    );
    // A change: an editor's is a new version in use; a reader's waits.
    app.put(
        '/spaces/:spaceId/memory/entries/:entryId',
        answer(async (c, user, spaceId) => {
            const parsed = proposed.safeParse(await body(c));
            if (!parsed.success) {
                return c.json({ error: TEXT_ERROR }, 400);
            }
            return service.propose(spaceId, user, {
                text: parsed.data.text,
                entryId: c.req.param('entryId'),
            });
        }),
    );
    app.post(
        '/spaces/:spaceId/memory/entries/:entryId/retire',
        answer((c, user, spaceId) => service.retire(spaceId, c.req.param('entryId')!, user)),
    );
    app.delete(
        '/spaces/:spaceId/memory/entries/:entryId',
        answer(async (c, user, spaceId) => ({
            ok: true,
            deleted: await service.remove(spaceId, c.req.param('entryId')!, user),
        })),
    );
    app.post(
        '/spaces/:spaceId/memory/proposals/:id/approve',
        answer(async (c, user, spaceId) => {
            const parsed = approved.safeParse((await body(c)) ?? {});
            if (!parsed.success) {
                return c.json({ error: TEXT_ERROR }, 400);
            }
            return service.approve(spaceId, c.req.param('id')!, user, parsed.data);
        }),
    );
    app.post(
        '/spaces/:spaceId/memory/proposals/:id/reject',
        answer((c, user, spaceId) => service.reject(spaceId, c.req.param('id')!, user)),
    );
    app.post(
        '/spaces/:spaceId/memory/proposals/:id/withdraw',
        answer((c, user, spaceId) => service.withdraw(spaceId, c.req.param('id')!, user)),
    );

    // The Space's people: who reads and approves its memory.
    app.get(
        '/spaces/:spaceId/people',
        answer((_c, user, spaceId) => access.people(spaceId, user)),
    );
    app.put(
        '/spaces/:spaceId/people/:userId',
        answer(async (c, user, spaceId) => {
            const parsed = roled.safeParse(await body(c));
            if (!parsed.success) {
                return c.json({ error: 'Choose editor or member.' }, 400);
            }
            await access.setRole(spaceId, user, c.req.param('userId')!, parsed.data.role);
            return access.people(spaceId, user);
        }),
    );
    app.delete(
        '/spaces/:spaceId/people/:userId',
        answer(async (c, user, spaceId) => {
            await access.remove(spaceId, user, c.req.param('userId')!);
            // Removing oneself from a Space theirs alone leaves them no view.
            return access.canRead(spaceId, user) ? access.people(spaceId, user) : { ok: true };
        }),
    );
    app.put(
        '/spaces/:spaceId/access',
        answer(async (c, user, spaceId) => {
            const parsed = opened.safeParse(await body(c));
            if (!parsed.success) {
                return c.json({ error: 'Say whether it is members only.' }, 400);
            }
            await access.setMembersOnly(spaceId, user, parsed.data.membersOnly);
            return access.canRead(spaceId, user) ? access.people(spaceId, user) : { ok: true };
        }),
    );
    return app;
}
