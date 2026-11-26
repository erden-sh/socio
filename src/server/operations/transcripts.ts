import { Hono, type Context, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { teamOwner } from '@socio/foundation/telegram/team-owner';
import type { HistoryRun } from '@socio/shared/chat/chat-history';
import type {
    OpsChatHistoryPage,
    OpsChatView,
    OpsRoomAudit,
    OpsRoomEvent,
    OpsRoomHeading,
    OpsTranscriptRun,
} from '@socio/shared/operations/operations-access';
import type { OpsChatGrounding } from '@socio/shared/operations/operations-grounding';
import { inviteUsable } from '@socio/shared/rooms/rooms';
import { withSocioFields } from '@socio/shared/runs/socio-fields';
import { SENDER_METADATA, SENDER_NAME_METADATA, type Conversation, type MessageAuthor } from '@socio/shared/types';

import type { RoomsShape } from '../rooms/contract.js';
import type { ChatHistoryShape } from '../workspace/contract.js';

import { roomContext } from './access-log.js';
import type { AuditOptions, AccessSubject } from './contract.js';
import { encodeCursor } from './domain/cursor.js';
import { pageOf, PAGE_ERROR } from './paging.js';

export interface TranscriptDeps {
    /** The access log's route wrapper (`auditor`): both routes are content. */
    audit: (options: AuditOptions) => MiddlewareHandler<AppEnv>;
    workspace: {
        /** A live chat by id, whoever owns it (archived ones too). */
        thread(id: string): Conversation | undefined;
        users(): readonly { id: string; name: string }[];
        dot(id: string): { name: string } | undefined;
    };
    /** Chats' stored turns, a page at a time, as the browser reads them (`ChatHistory`). */
    history: Pick<ChatHistoryShape, 'historyPage'>;
    /**
     * What the chat's turns read (CB-194, the analytics store's); null
     * while it can't answer. None: the route answers nothing read.
     */
    grounding?: (threadId: string) => Promise<OpsChatGrounding | null>;
    /**
     * Rooms' people and audit (CB-213), for a room's heading and its audit
     * view. None: a room is headed as any chat, and has no audit view.
     */
    rooms?: Pick<RoomsShape, 'oversight'>;
}

/** A shared Telegram topic's owner (`teamOwner`): several people write in it. */
const isTeam = (ownerId: string) => ownerId.startsWith(teamOwner(''));

/**
 * A turn's messages with each person's own author (CB-66's sender, kept
 * in the message's metadata by the Telegram channel), named as the
 * workspace names them now, else as they were named when they wrote;
 * their ids are left out. A message without one is the chat's owner's,
 * or in a team topic someone on the team (stored before CB-66). The
 * reader never wrote them: none is "you".
 */
function withAuthors(run: HistoryRun, names: ReadonlyMap<string, string>, owner: string): OpsTranscriptRun {
    return {
        ...run,
        messages: run.messages.map((message) => {
            if (message.role !== 'user') {
                return message;
            }
            const {
                [SENDER_METADATA]: sender,
                [SENDER_NAME_METADATA]: senderName,
                ...metadata
            } = (message.metadata ?? {}) as Record<string, unknown>;
            const author: MessageAuthor = {
                name:
                    typeof sender === 'string'
                        ? (names.get(sender) ?? (typeof senderName === 'string' ? senderName : 'Team member'))
                        : owner,
                you: false,
            };
            const { metadata: _given, ...rest } = message;
            // Its author in `metadata`, which AG-UI 1.0 keeps, and for now at
            // the top level too (`withSocioFields`).
            return withSocioFields({ ...rest, ...(Object.keys(metadata).length ? { metadata } : {}) }, { author });
        }),
    };
}

/** The chat a request opens, by its address. */
const chatOf = (c: Context<AppEnv>): AccessSubject | undefined => {
    const id = c.req.param('threadId');
    return id ? { kind: 'chat', id } : undefined;
};

/** How many of a room's audit lines its view answers, newest first. */
const ROOM_EVENTS_SHOWN = 200;

/**
 * The admin transcript view (CB-188): any chat, read-only, for admins
 * only. It bypasses `readableThread` (owners and team members): in
 * company mode the workspace owns every chat, and the access log is the
 * control. Both routes are audited as content:
 * - `GET /operations/chats/:threadId`: the chat's heading. Opening the
 *   transcript, so every request is an entry.
 * - `GET /operations/chats/:threadId/history?cursor=&limit=`: its
 *   finished turns, newest first, a page at a time (as the chat's own
 *   history pages them: up to 20 turns or about 300,000 characters; the
 *   limit is checked but no page is longer). Logged once per viewer and
 *   chat in 15 minutes, so the next pages of an open transcript add
 *   nothing, and a client that skips the heading is still on the record.
 * - `GET /operations/chats/:threadId/grounding`: what its turns read
 *   (CB-194), logged as the history is.
 * - `GET /operations/chats/:threadId/room-events`: a room's audit
 *   (CB-213), by name, logged as the history is (not as content).
 * A deleted chat isn't there (404), and neither is a turn still running.
 * A room (CB-213) is headed with its people and socios, and every entry
 * about it keeps the room (`roomContext`): a workspace admin reads a room
 * only through these views.
 */
export function transcriptRoutes({ audit, workspace, history, grounding, rooms }: TranscriptDeps) {
    const app = new Hono<AppEnv>();
    const notFound = { error: 'There is no such chat.' };
    // A room's views keep the room with the entry (CB-213).
    const inRoom = (c: Context<AppEnv>) => roomContext(workspace.thread(c.req.param('threadId') ?? ''));
    const peopleNames = () => new Map(workspace.users().map((user) => [user.id, user.name]));

    /** A room's people and socios now, by name (CB-213). */
    const roomHeading = async (roomId: string): Promise<OpsRoomHeading | null> => {
        const found = await rooms?.oversight(roomId);
        if (!found) {
            return null;
        }
        const names = peopleNames();
        const order = { admin: 0, member: 1 } as const;
        return {
            members: found.members
                .filter(
                    (member) =>
                        member.status === 'active' || (member.status === 'invited' && inviteUsable(member, found.now)),
                )
                .sort(
                    (a, b) =>
                        Number(a.status !== 'active') - Number(b.status !== 'active') ||
                        order[a.role] - order[b.role] ||
                        (a.acceptedAt ?? a.invitedAt) - (b.acceptedAt ?? b.invitedAt),
                )
                .map((member) => ({
                    name: names.get(member.userId) ?? 'Someone no longer here',
                    role: member.role,
                    status: member.status as 'active' | 'invited',
                })),
            socios: found.socios
                .filter((socio) => socio.status === 'active')
                .map((socio) => ({
                    name: workspace.dot(socio.dotId)?.name ?? 'A removed socio',
                    lead: socio.dotId === found.room.dotId,
                }))
                .sort((a, b) => Number(b.lead) - Number(a.lead)),
            createdByName: found.room.createdBy ? (names.get(found.room.createdBy) ?? 'Someone no longer here') : null,
            convertedAt: found.room.convertedAt,
        };
    };

    app.get(
        '/operations/chats/:threadId',
        audit({
            surface: 'chat',
            subject: chatOf,
            content: true,
            once: 'always',
            filters: inRoom,
        }),
        async (c) => {
            const thread = workspace.thread(c.req.param('threadId'));
            if (!thread) {
                return c.json(notFound, 404);
            }
            const owner = workspace.users().find((user) => user.id === thread.ownerId);
            const team = isTeam(thread.ownerId);
            return c.json<OpsChatView>({
                id: thread.id,
                title: thread.title,
                socioId: thread.dotId,
                socioName: workspace.dot(thread.dotId)?.name ?? null,
                ownerId: thread.ownerId,
                // A room's owner is its sentinel, no person.
                ownerName: owner?.name ?? (team ? 'Telegram team' : null),
                createdAt: thread.createdAt,
                archivedAt: thread.archivedAt ?? null,
                team,
                room: thread.kind === 'room' ? await roomHeading(thread.id) : null,
            });
        },
    );

    app.get(
        '/operations/chats/:threadId/history',
        audit({
            surface: 'chat',
            subject: chatOf,
            content: true,
            once: 'list',
            filters: inRoom,
        }),
        async (c) => {
            const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
            if (!page || (page.cursor && typeof page.cursor.key !== 'number')) {
                return c.json({ error: PAGE_ERROR }, 400);
            }
            const thread = workspace.thread(c.req.param('threadId'));
            if (!thread) {
                return c.json(notFound, 404);
            }
            const { runs } = await history.historyPage(thread.id, {
                before: page.cursor ? Number(page.cursor.key) : undefined,
            });
            const names = peopleNames();
            const owner =
                thread.kind === 'room'
                    ? await roomFallback(thread.id, names)
                    : isTeam(thread.ownerId)
                      ? 'Team member'
                      : (names.get(thread.ownerId) ?? 'Someone no longer here');
            const oldest = runs[0];
            return c.json<OpsChatHistoryPage>({
                items: [...runs].reverse().map((run) => withAuthors(run, names, owner)),
                next: oldest && oldest.prev !== null ? encodeCursor({ key: oldest.seq, id: oldest.runId }) : null,
            });
        },
    );

    /**
     * Who wrote a room's person message that names no sender (stored before
     * CB-66): in a private chat converted into the room, its one owner, who
     * converted it; else nobody the server knows. Never the
     * room's sentinel owner.
     */
    async function roomFallback(roomId: string, names: Map<string, string>) {
        const room = (await rooms?.oversight(roomId))?.room;
        return room?.convertedAt && room.createdBy
            ? (names.get(room.createdBy) ?? 'Someone no longer here')
            : 'Unattributed';
    }

    // What the chat's turns read (CB-194): pages, datasets and recalls by
    // id with their titles and names, never their content. Logged once per
    // viewer and chat in 15 minutes, as the transcript's pages are.
    app.get(
        '/operations/chats/:threadId/grounding',
        audit({
            surface: 'chat-grounding',
            subject: chatOf,
            content: false,
            once: 'list',
            filters: inRoom,
        }),
        async (c) => {
            const thread = workspace.thread(c.req.param('threadId'));
            if (!thread) {
                return c.json(notFound, 404);
            }
            return c.json<OpsChatGrounding | null>(grounding ? await grounding(thread.id) : { refs: [], more: false });
        },
    );

    // A room's own audit (CB-213, `room_events`): who made, joined, left,
    // was invited, removed or refused, and its socios and limits, by name,
    // newest first; never content. Person-level rows, so logged once per
    // viewer and room in 15 minutes, as a list is. A chat that is no room
    // has none (404).
    app.get(
        '/operations/chats/:threadId/room-events',
        audit({
            surface: 'room-events',
            subject: chatOf,
            content: false,
            once: 'list',
            filters: inRoom,
        }),
        async (c) => {
            const thread = workspace.thread(c.req.param('threadId'));
            const found =
                thread?.kind === 'room' ? await rooms?.oversight(thread.id, { events: ROOM_EVENTS_SHOWN }) : undefined;
            if (!found) {
                return c.json({ error: 'There is no such room.' }, 404);
            }
            const names = peopleNames();
            const nameOf = (id: string | null, kind: string): string | null => {
                if (!id) {
                    return null;
                }
                if (kind === 'socio' || id.startsWith('dot:')) {
                    return workspace.dot(id.replace(/^dot:/, ''))?.name ?? null;
                }
                if (kind === 'room') {
                    return found.room.title;
                }
                if (kind === 'source') {
                    return 'Telegram topic';
                }
                return names.get(id) ?? null;
            };
            return c.json<OpsRoomAudit>({
                events: found.events.map((event): OpsRoomEvent => ({
                    id: event.id,
                    at: event.at,
                    actorName:
                        event.actor === 'system'
                            ? 'Socio'
                            : (nameOf(event.actor, 'person') ?? 'Someone no longer here'),
                    action: event.action,
                    targetKind: event.targetKind,
                    targetName: nameOf(event.targetId, event.targetKind),
                    outcome: event.outcome,
                    detail: event.detail,
                })),
            });
        },
    );
    return app;
}
