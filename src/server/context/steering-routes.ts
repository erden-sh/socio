import { Hono, type Context } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { TURN_FAILURE_MESSAGES } from '@socio/foundation/observability/failures';
import { STEERING_MAX_CHARS, type OthersQueuedMessage, type SteeringView } from '@socio/shared/chat/steering';
import { ATTACHMENT_ID, MEDIA_LIMITS, type AttachmentRef } from '@socio/shared/media-types';
import { MENTION_LABEL_MAX, PERSON_MENTIONS_MAX } from '@socio/shared/rooms/room-people-mentions';
import { ROOM_DENIAL_MESSAGES } from '@socio/shared/rooms/rooms';

import { RoomError } from '../rooms/contract.js';

import type { SteeringRouteSources } from './sources.js';
import { steeringQueue } from './steering.js';

/**
 * The people a room message mentions, as the composer's picker chose them
 * (CB-216): by id, with the name it put after `@`. Checked against the
 * text and the room's members as it is queued and again once delivered.
 */
const mentions = z
    .array(
        z.object({
            userId: z.string().min(1).max(200),
            label: z.string().max(MENTION_LABEL_MAX),
        }),
    )
    .max(PERSON_MENTIONS_MAX)
    .optional();
/**
 * A queued message's edit: its text, and (given) the attachments it keeps,
 * by id, of those it has (CB-223); without any, the text may not be empty.
 * Mentions given replace its own; without, those no longer in the text go
 * as it is delivered.
 */
const edited = z.object({
    text: z.string().max(STEERING_MAX_CHARS),
    attachments: z
        .array(z.object({ id: z.string().regex(ATTACHMENT_ID) }))
        .max(MEDIA_LIMITS.perMessage)
        .optional(),
    mentions,
});
/**
 * A new queued message: its text, and the attachments the person uploaded
 * for it (CB-223), by id, as a message sent between turns carries them;
 * with some, the text may be empty.
 */
const queued = z
    .object({
        text: z.string().max(STEERING_MAX_CHARS),
        attachments: z
            .array(z.object({ id: z.string().regex(ATTACHMENT_ID) }))
            .max(MEDIA_LIMITS.perMessage)
            .optional(),
        mentions,
    })
    .refine((value) => !!value.text.trim() || !!value.attachments?.length);

/**
 * A web chat's steering queue (CB-151): what its owner sent while the
 * Dot's turn ran, until a turn takes it. Only the conversation's owner,
 * and never a Telegram conversation's (a team topic's members included):
 * anyone else gets "not found", as for the conversation itself. At most
 * the admin's limit wait (CB-170); the view says how many, and which turn
 * the server started with them. In a room (CB-208) each active member
 * has their own queue there: reading and canceling their own messages
 * while they are a member, queueing and editing while they may send
 * (Rooms on, the room unarchived). Nobody else sees or edits them; a
 * room admin sees everyone's and may cancel any, never edit it, audited
 * (CB-215). An edit or a cancel after a turn took a message finds it
 * gone (`delivered`): a turn's claim removes it in one statement.
 */
export function steeringRoutes(platform: SteeringRouteSources) {
    const app = new Hono<AppEnv>();
    const queue = steeringQueue(platform.workspace.db);
    const owned = (c: Context<AppEnv>, action: 'read' | 'send') => {
        const id = c.req.param('id') ?? '';
        const thread = platform.workspace.thread(id);
        if (thread?.kind === 'room') {
            const { decision } = platform.workspace.access(c.get('user').id, id, action);
            if (decision.allowed) {
                return thread;
            }
            // A member is told why (archived, Rooms off); anyone else finds nothing.
            return decision.reason === 'not_found'
                ? undefined
                : c.json(
                      {
                          error: ROOM_DENIAL_MESSAGES[decision.reason],
                          code: decision.reason,
                      },
                      409,
                  );
        }
        return thread && thread.ownerId === c.get('user').id ? thread : undefined;
    };
    // The admin's limit (`steeringMaxQueued`), lowered in a room by its
    // admins (CB-211).
    const limit = async (threadId: string) => (await platform.cycles.limitsFor(threadId)).maxQueued;
    /**
     * A room admin may cancel anyone's queued message (CB-215): the rule's
     * `manage` (the admin role, Rooms on, the room live). Asked on every
     * read of the queue, so a member's "no" is not audited.
     */
    const admin = (threadId: string, userId: string) =>
        platform.workspace.thread(threadId)?.kind === 'room' &&
        platform.workspace.allows(userId, threadId, 'manage', { audit: false });
    /** Everyone else's waiting messages, as a room admin sees them. */
    const others = async (threadId: string, userId: string): Promise<OthersQueuedMessage[]> => {
        const waiting = await queue.others(threadId, userId);
        if (!waiting.length) {
            return [];
        }
        const names = new Map(platform.workspace.users().map((user) => [user.id, user.name]));
        const sends = new Map<string, boolean>();
        for (const { userId: author } of waiting) {
            if (!sends.has(author)) {
                sends.set(author, await platform.cycles.mayDispatch(threadId, author));
            }
        }
        return waiting.map(({ id, text, attachments, createdAt, updatedAt, userId: author }) => ({
            id,
            text,
            files: attachments?.length ?? 0,
            author: { name: names.get(author) ?? 'Team member' },
            ...(sends.get(author) ? {} : { held: true as const }),
            createdAt,
            updatedAt,
        }));
    };
    const view = async (threadId: string, userId: string): Promise<SteeringView> => {
        const turn = platform.steering.turn(threadId);
        return {
            messages: await queue.list(threadId, userId),
            ...(admin(threadId, userId) && {
                others: await others(threadId, userId),
            }),
            limit: await limit(threadId),
            ...(turn && { turn }),
            ...(platform.runner.activeRunId(threadId) && { running: true }),
        };
    };
    const missing = (c: Context<AppEnv>) => c.json({ error: 'Conversation not found.' }, 404);
    const delivered = (c: Context<AppEnv>) =>
        c.json(
            {
                error: 'That message has gone to your socio already.',
                code: 'delivered',
            },
            409,
        );
    const unreadable = (c: Context<AppEnv>) =>
        c.json(
            {
                error: `Write a message of at most ${STEERING_MAX_CHARS.toLocaleString('en')} characters.`,
            },
            400,
        );
    const gone = (c: Context<AppEnv>) =>
        c.json(
            {
                error: 'One of the attachments is no longer there. Remove it and attach the file again.',
            },
            400,
        );
    /**
     * The references of the attachments a queued message carries: the
     * person's own, uploaded for this chat or not yet for any; undefined if
     * one isn't (deleted, someone else's, another chat's).
     */
    const attachmentsOf = async (
        ids: readonly string[],
        userId: string,
        threadId: string,
    ): Promise<AttachmentRef[] | undefined> => {
        const refs: AttachmentRef[] = [];
        for (const id of new Set(ids)) {
            const row = await platform.media.attachment(id);
            if (!row || row.ownerUserId !== userId || (row.threadId !== null && row.threadId !== threadId)) {
                return undefined;
            }
            refs.push(platform.media.ref(row));
        }
        return refs;
    };

    app.get('/conversations/:id/steering', async (c) => {
        const thread = owned(c, 'read');
        if (thread instanceof Response) {
            return thread;
        }
        if (!thread) {
            return missing(c);
        }
        return c.json(await view(thread.id, c.get('user').id));
    });

    app.post('/conversations/:id/steering', async (c) => {
        const thread = owned(c, 'send');
        if (thread instanceof Response) {
            return thread;
        }
        if (!thread) {
            return missing(c);
        }
        if (await platform.workspace.telegram.threadInfo(thread.id)) {
            return c.json({ error: 'Send messages for this conversation in Telegram.' }, 409);
        }
        const body = queued.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return unreadable(c);
        }
        const userId = c.get('user').id;
        const attachments = await attachmentsOf(
            (body.data.attachments ?? []).map(({ id }) => id),
            userId,
            thread.id,
        );
        if (!attachments) {
            return gone(c);
        }
        const max = await limit(thread.id);
        // The chat's messages a minute (CB-211), queued ones included: counted
        // here, so the turn they start later doesn't count them again.
        if (!(await platform.cycles.submit(thread.id, userId))) {
            return c.json(
                {
                    error: TURN_FAILURE_MESSAGES.cycle_rate,
                    code: 'cycle_rate',
                },
                429,
            );
        }
        const message = await queue.addIfRoom(thread.id, userId, body.data.text, max, Date.now(), attachments);
        // Its files again, now that the queue holds them: the cleanup of unsent
        // ones keeps them from here on, and one it removed in between is gone.
        if (
            message &&
            attachments.length &&
            !(await attachmentsOf(
                attachments.map(({ id }) => id),
                userId,
                thread.id,
            ))
        ) {
            // A turn took it already: it has gone, the file the turn reads as
            // deleted, so it is answered as delivered.
            if (!(await queue.cancel(thread.id, userId, message.id))) {
                return c.json({ message, delivered: true, ...(await view(thread.id, userId)) }, 200);
            }
            return gone(c);
        }
        if (!message) {
            return c.json(
                {
                    error: `Up to ${max} ${max === 1 ? 'message' : 'messages'} can wait for your socio. Send this one once it has read them, or cancel one.`,
                    code: 'queue_full',
                    limit: max,
                },
                429,
            );
        }
        // Whom it mentions (CB-216), before a turn can take it.
        if (thread.kind === 'room' && body.data.mentions?.length) {
            await platform.roomNotices.record(thread.id, userId, message.id, body.data.text, body.data.mentions);
        }
        // No turn to take it (it ended meanwhile): it starts one.
        if (!platform.runner.activeRunId(thread.id)) {
            await platform.steering.consider(thread.id);
        }
        return c.json({ message, ...(await view(thread.id, userId)) }, 201);
    });

    app.patch('/conversations/:id/steering/:messageId', async (c) => {
        const thread = owned(c, 'send');
        if (thread instanceof Response) {
            return thread;
        }
        if (!thread) {
            return missing(c);
        }
        const body = edited.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return unreadable(c);
        }
        const userId = c.get('user').id;
        const id = c.req.param('messageId');
        const current = (await queue.list(thread.id, userId)).find((message) => message.id === id);
        if (!current) {
            return delivered(c);
        }
        // Files can only be taken off: those it keeps are of those it has.
        const has = new Map((current.attachments ?? []).map((ref) => [ref.id, ref]));
        if (body.data.attachments?.some(({ id }) => !has.has(id))) {
            return gone(c);
        }
        const attachments = body.data.attachments && [
            ...new Map(body.data.attachments.map(({ id }) => [id, has.get(id)!])).values(),
        ];
        if (!body.data.text.trim() && !(attachments ?? [...has.values()]).length) {
            return unreadable(c);
        }
        const message = await queue.edit(thread.id, userId, id, body.data.text, Date.now(), attachments);
        if (!message) {
            return delivered(c);
        }
        if (thread.kind === 'room' && body.data.mentions) {
            await platform.roomNotices.record(thread.id, userId, message.id, message.text, body.data.mentions);
        }
        return c.json({ message, ...(await view(thread.id, userId)) });
    });

    app.delete('/conversations/:id/steering/:messageId', async (c) => {
        const thread = owned(c, 'read');
        if (thread instanceof Response) {
            return thread;
        }
        if (!thread) {
            return missing(c);
        }
        const userId = c.get('user').id;
        const id = c.req.param('messageId');
        if (await queue.cancel(thread.id, userId, id)) {
            if (thread.kind === 'room') {
                await platform.roomNotices.forget(thread.id, id);
            }
            return c.json(await view(thread.id, userId));
        }
        // Someone else's, in a room its admin may cancel (CB-215): never
        // edited, and audited. A member who isn't one finds it gone, as a
        // message that went.
        if (thread.kind === 'room' && admin(thread.id, userId)) {
            try {
                const author = await platform.rooms.cancelQueued(thread.id, userId, () =>
                    queue.cancelAny(thread.id, id),
                );
                if (author) {
                    await platform.roomNotices.forget(thread.id, id);
                    return c.json(await view(thread.id, userId));
                }
            } catch (error) {
                if (!(error instanceof RoomError)) {
                    throw error;
                }
                return c.json({ error: error.message, code: error.reason }, error.status as 403);
            }
        }
        return delivered(c);
    });
    return app;
}
