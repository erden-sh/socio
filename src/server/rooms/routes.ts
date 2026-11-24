import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdmin } from '@socio/foundation/http/guards';
import type { AuditOptions } from '@socio/foundation/operations/audit-options';
import { isAdmin } from '@socio/shared/roles';
import { ROOM_ROLES } from '@socio/shared/rooms/rooms';
import { MAX_CHAT_TITLE } from '@socio/shared/types';

import { RoomError } from './contract.js';
import { type RoomMembership } from './membership.js';
import { RoomStorageError, type RoomStorageRefusal } from './service.js';

/** How the storage's refusals (CB-207) are answered. */
const STORAGE_STATUS: Record<RoomStorageRefusal, 400 | 404 | 409> = {
    rooms_off: 409,
    not_found: 404,
    archived: 409,
    invalid_title: 400,
    personal_socio: 400,
    not_convertible: 409,
    scheduled_tasks: 409,
};

const created = z
    .object({
        dotId: z.string().min(1),
        title: z.string().trim().min(1).max(MAX_CHAT_TITLE),
        /**
         * More company socios to ask for as the room is made (CB-278): the
         * lead first (`dotId`), then these. Each starts as `requested`, for a
         * workspace admin to let in, as `requestSocio` does.
         */
        dotIds: z.array(z.string().min(1)).optional(),
        /**
         * People to invite as the room is made (CB-278): each gets a member
         * invite (the creator's own membership is implicit, as admin). The
         * server checks each as `invite` does.
         */
        userIds: z.array(z.string().min(1)).optional(),
        /** A short description / purpose, shown to members (optional). */
        description: z.string().trim().max(2_000).optional(),
    })
    .strict();
const converted = z.object({ confirmHistory: z.boolean() }).strict();
const invited = z.object({ userId: z.string().min(1), role: z.enum(ROOM_ROLES).optional() }).strict();
const accepted = z.object({ disclosureVersion: z.number().int() }).strict();
const roled = z.object({ role: z.enum(ROOM_ROLES) }).strict();
const renamed = z.object({ title: z.string().trim().min(1).max(MAX_CHAT_TITLE) }).strict();
const socio = z.object({ dotId: z.string().min(1) }).strict();
const whole = z.number().int().positive();
const limited = z
    .object({
        cycleTimeMs: whole.optional(),
        cycleTokens: whole.optional(),
        messagesPerMinute: whole.optional(),
        maxQueued: whole.optional(),
        handoffsPerCycle: whole.optional(),
        cycleSpendUsd: z.number().positive().finite().nullable().optional(),
    })
    .strict();

export interface RoomRoutesDeps {
    /**
     * The access log's route wrapper (`auditor`, CB-188): a workspace
     * admin's read of a room's audit, when they are not its admin, is
     * written to it (CB-213). None: nothing is logged (tests).
     */
    audit?: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
    /** `userId` is an active admin of the room. */
    roomAdmin?: (roomId: string, userId: string) => boolean;
}

/**
 * Rooms' routes (CB-207, CB-208): making and converting rooms,
 * invitations, acceptance with the history disclosure, roles, leaving,
 * removal, archiving, socios, limits and the room's audit. Each answers
 * by the one rule (`RoomAccess`): a room the person can't see is a 404,
 * as another person's chat is; a workspace admin's role opens no room.
 * Rooms stay behind Settings → General → Rooms, off by default.
 */
export function roomRoutes(rooms: RoomMembership, { audit, roomAdmin }: RoomRoutesDeps = {}) {
    const app = new Hono<AppEnv>();
    const refused = (c: Context<AppEnv>, error: unknown) => {
        if (error instanceof RoomError) {
            return c.json(
                {
                    error: error.message,
                    code: error.reason,
                    ...(error.fields ? { fields: error.fields } : {}),
                },
                error.status as 400,
            );
        }
        if (error instanceof RoomStorageError) {
            return c.json({ error: error.message, code: error.reason }, STORAGE_STATUS[error.reason]);
        }
        throw error;
    };
    const body = async <T>(c: Context<AppEnv>, schema: z.ZodType<T>) => {
        const parsed = schema.safeParse(await c.req.json().catch(() => null));
        return parsed.success ? parsed.data : undefined;
    };
    const invalid = (c: Context<AppEnv>, error: string) => c.json({ error, code: 'invalid' }, 400);
    const attempt = async (c: Context<AppEnv>, work: () => Promise<Response>) => {
        try {
            return await work();
        } catch (error) {
            return refused(c, error);
        }
    };
    const user = (c: Context<AppEnv>) => c.get('user').id;

    app.get('/rooms/readiness', requireAdmin, async (c) => c.json(await rooms.readiness()));
    // Any member makes a room with a company socio, while Rooms are on.
    app.post('/rooms', async (c) => {
        const data = await body(c, created);
        if (!data) {
            return invalid(c, `Choose a company socio and name the room in 1 to ${MAX_CHAT_TITLE} characters.`);
        }
        return attempt(c, async () => c.json(await rooms.create(user(c), data), 201));
    });
    // The person's invites: the room's name and who asked, no history.
    app.get('/rooms/invites', async (c) => c.json(await rooms.invites(user(c))));
    // People the maker may invite as they create a room (CB-278): before
    // any room exists, so the create dialog's people picker can list them.
    app.get('/rooms/people', async (c) => c.json(await rooms.inviteCandidates(user(c))));
    // Socios rooms asked for, waiting for a workspace admin.
    app.get('/rooms/socio-requests', requireAdmin, async (c) => c.json(await rooms.socioRequests()));
    // One's own private web chat as a room, after confirming its history
    // will be read by everyone invited (`ROOM_CONVERT_TEXT`).
    app.post('/rooms/:id/convert', async (c) => {
        const data = await body(c, converted);
        if (!data) {
            return invalid(c, 'Say whether you confirm sharing the history.');
        }
        return attempt(c, async () =>
            c.json(await rooms.convert(c.req.param('id'), user(c), data.confirmHistory), 201),
        );
    });
    app.get('/rooms/:id', (c) => attempt(c, async () => c.json(await rooms.view(c.req.param('id'), user(c)))));
    app.patch('/rooms/:id', async (c) => {
        const data = await body(c, renamed);
        if (!data) {
            return invalid(c, `Name the room in 1 to ${MAX_CHAT_TITLE} characters.`);
        }
        return attempt(c, async () => {
            await rooms.rename(c.req.param('id'), user(c), data.title);
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        });
    });
    app.post('/rooms/:id/archive', (c) =>
        attempt(c, async () => {
            await rooms.archive(c.req.param('id'), user(c));
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        }),
    );
    app.post('/rooms/:id/unarchive', (c) =>
        attempt(c, async () => {
            await rooms.unarchive(c.req.param('id'), user(c));
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        }),
    );

    // ---- people ----
    app.post('/rooms/:id/invites', async (c) => {
        const data = await body(c, invited);
        if (!data) {
            return invalid(c, 'Choose a person to invite.');
        }
        return attempt(c, async () =>
            c.json(await rooms.invite(c.req.param('id'), user(c), data.userId, data.role), 201),
        );
    });
    // Whom a room admin may invite: names and ids, for the invite picker.
    app.get('/rooms/:id/invitable', (c) =>
        attempt(c, async () => c.json(await rooms.invitable(c.req.param('id'), user(c)))),
    );
    app.post('/rooms/:id/accept', async (c) => {
        const data = await body(c, accepted);
        if (!data) {
            return c.json(
                {
                    error: 'Read and accept what joining shares before you join.',
                    code: 'disclosure',
                },
                400,
            );
        }
        return attempt(c, async () => {
            await rooms.accept(c.req.param('id'), user(c), data.disclosureVersion);
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        });
    });
    app.post('/rooms/:id/decline', (c) =>
        attempt(c, async () => {
            await rooms.decline(c.req.param('id'), user(c));
            return c.json({ ok: true });
        }),
    );
    app.post('/rooms/:id/leave', (c) =>
        attempt(c, async () => {
            await rooms.leave(c.req.param('id'), user(c));
            return c.json({ ok: true });
        }),
    );
    app.patch('/rooms/:id/members/:userId', async (c) => {
        const data = await body(c, roled);
        if (!data) {
            return invalid(c, 'Choose admin or member.');
        }
        return attempt(c, async () => {
            await rooms.setRole(c.req.param('id'), user(c), c.req.param('userId'), data.role);
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        });
    });
    app.delete('/rooms/:id/members/:userId', (c) =>
        attempt(c, async () => {
            await rooms.remove(c.req.param('id'), user(c), c.req.param('userId'));
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        }),
    );

    // ---- socios ----
    app.post('/rooms/:id/socios', async (c) => {
        const data = await body(c, socio);
        if (!data) {
            return invalid(c, 'Choose a company socio.');
        }
        return attempt(c, async () => c.json(await rooms.requestSocio(c.req.param('id'), user(c), data.dotId), 201));
    });
    // Company socios are the workspace admins' to let in and take out.
    app.post('/rooms/:id/socios/:dotId/authorize', requireAdmin, (c) =>
        attempt(c, async () => c.json(await rooms.authorizeSocio(c.req.param('id'), user(c), c.req.param('dotId')))),
    );
    app.post('/rooms/:id/socios/:dotId/withdraw', requireAdmin, (c) =>
        attempt(c, async () => {
            await rooms.withdrawSocio(c.req.param('id'), user(c), c.req.param('dotId'));
            return c.json({ ok: true });
        }),
    );
    app.delete('/rooms/:id/socios/:dotId', (c) =>
        attempt(c, async () => {
            await rooms.removeSocio(c.req.param('id'), user(c), c.req.param('dotId'));
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        }),
    );
    app.put('/rooms/:id/lead', async (c) => {
        const data = await body(c, socio);
        if (!data) {
            return invalid(c, 'Choose a socio in the room.');
        }
        return attempt(c, async () => {
            await rooms.setLead(c.req.param('id'), user(c), data.dotId);
            return c.json(await rooms.view(c.req.param('id'), user(c)));
        });
    });

    // ---- limits and audit ----
    app.get('/rooms/:id/limits', (c) => attempt(c, async () => c.json(await rooms.limits(c.req.param('id'), user(c)))));
    // Its handoff limit, for every member: a rule of the room, not its
    // budget (spend, tokens and time stay above, behind `usage_hidden`).
    app.get('/rooms/:id/limits/handoffs', (c) =>
        attempt(c, async () => c.json(await rooms.handoffLimit(c.req.param('id'), user(c)))),
    );
    // The room's use (CB-218): its admins', and members' when Settings →
    // Rooms shows it; ids, counts and times, never content.
    app.get('/rooms/:id/usage', (c) => attempt(c, async () => c.json(await rooms.usage(c.req.param('id'), user(c)))));
    app.put('/rooms/:id/limits', async (c) => {
        const data = await body(c, limited);
        if (!data) {
            return invalid(c, 'Each limit is a positive whole number (spend: dollars).');
        }
        return attempt(c, async () => c.json(await rooms.setLimits(c.req.param('id'), user(c), data)));
    });
    // The room's audit: its admins', and every workspace admin's, which is
    // logged when they are not the room's admin (CB-213): person-level rows
    // of a room they have no access to. Only a signed-in admin, never a key.
    const auditedEvents = audit?.({
        surface: 'room-events',
        subject: (c) => ({ kind: 'chat', id: c.req.param('id')! }),
        content: false,
        once: 'list',
        filters: (c) => ({ room: c.req.param('id')! }),
    });
    app.get(
        '/rooms/:id/events',
        (c, next) =>
            auditedEvents && isAdmin(c.get('user')) && !roomAdmin?.(c.req.param('id'), user(c))
                ? auditedEvents(c, next)
                : next(),
        (c) =>
            attempt(c, async () =>
                c.json(
                    await rooms.events(c.req.param('id'), {
                        id: user(c),
                        admin: isAdmin(c.get('user')),
                    }),
                ),
            ),
    );
    return app;
}
