import { randomUUID } from 'node:crypto';

import { Hono, type MiddlewareHandler } from 'hono';

import type { AppEnv } from '@socio/foundation/http/app-env';
import { requireAdminPerson } from '@socio/foundation/operations/require-admin-person';
import type { CursorPage } from '@socio/shared/operations/operations';
import {
    ACCESS_LOG_DEDUPE_MS,
    ACCESS_NAMED_FILTERS,
    ACCESS_VIA,
    type AccessNamedFilter,
    type AccessRoomContext,
    type AccessSubjectKind,
    type OpsAccessRow,
} from '@socio/shared/operations/operations-access';

import type { AccessAuditShape, AccessSubject, AuditOptions } from './contract.js';
import type { AccessLogRepository } from './domain/access-log.js';
import { encodeCursor } from './domain/cursor.js';
import { pageOf, PAGE_ERROR } from './paging.js';

/**
 * The access log (CB-188, CB-164).
 * Admins see everything the workspace does, chats included; in exchange,
 * each time one opens a person's activity or a chat's content in
 * Operations, or another person's turn trace (Runs' route, also opened
 * from Reliability), the server writes who, what, when and from where,
 * and every admin can read it in Operations → Access log. No notice goes to the
 * person whose chat was read: the log is the control.
 *
 * Rooms (CB-213): a workspace admin has no room access from
 * the role; they read a room's content only here, through these logged
 * views. An entry about a room keeps the room (`roomContext`) and, for a
 * turn's trace, who started its cycle and the socio that ran it
 * (`ACCESS_ROOM_CONTEXT`), so the log traces a room's turn to them.
 */

/**
 * What an entry about a conversation keeps when it is a room (CB-213):
 * its id, as `filters.room`; nothing for any other chat.
 */
export const roomContext = (thread: { id: string; kind?: string } | undefined): AccessRoomContext =>
    thread?.kind === 'room' ? { room: thread.id } : {};

/** What each named filter's id points at, to name it as a subject is. */
const FILTER_SUBJECTS: Record<AccessNamedFilter, AccessSubjectKind> = {
    socio: 'socio',
    person: 'person',
    space: 'space',
    room: 'chat',
    initiator: 'person',
};

/**
 * A section's wrapper for a list of person-level rows (CB-188), as
 * `operationsRoutes` makes it: about the list's narrowest filter (else the
 * workspace's rows), logged once per viewer, surface and filters in
 * `ACCESS_LOG_DEDUPE_MS`. `params`: the list's own query parameters (an
 * outcome, a category), kept with its range and filters.
 */
export type AuditedList = (surface: string, params?: readonly string[]) => MiddlewareHandler<AppEnv>;

export interface AccessLogDeps {
    log: AccessLogRepository;
    now?: () => number;
    newId?: () => string;
}

/**
 * The route wrapper that writes the log: put it before the handler of
 * every Operations endpoint that answers person-level rows or content.
 * Only signed-in admins pass. A successful answer is logged before it is
 * sent; when the entry can't be written, the answer is refused instead,
 * so nothing is shown that the log doesn't have. Refused requests (a bad
 * filter, a chat that isn't there) are not logged. Each request gets an
 * id, in the entry and in the `X-Request-Id` header.
 */
export function auditor({ log, now = Date.now, newId = randomUUID }: AccessLogDeps): AccessAuditShape['audit'] {
    return (options: AuditOptions): MiddlewareHandler<AppEnv> =>
        async (c, next) => {
            const refused = await requireAdminPerson(c, async () => {});
            if (refused) {
                return refused;
            }
            const requestId = newId();
            c.header('X-Request-Id', requestId);
            await next();
            if (c.res.status < 200 || c.res.status >= 300) {
                return;
            }
            const subject = options.subject(c);
            if (!subject) {
                return;
            }
            const via = c.req.query('via');
            const filters = {
                ...options.filters?.(c),
                ...(via && ACCESS_VIA.test(via) ? { via } : {}),
            };
            const at = now();
            try {
                await log.record(
                    {
                        id: newId(),
                        at,
                        viewerId: c.get('user').id,
                        surface: options.surface,
                        subject,
                        content: options.content,
                        filters,
                        requestId,
                    },
                    options.once === 'list' ? { unlessSince: at - ACCESS_LOG_DEDUPE_MS } : {},
                );
            } catch {
                c.res = c.json(
                    {
                        error: 'This view couldn’t be written to the access log, so it isn’t shown. Try again.',
                    },
                    503,
                );
            }
        };
}

export interface AccessLogNames {
    users(): readonly { id: string; name: string }[];
    dot(id: string): { name: string } | undefined;
    spaces(): readonly { id: string; name: string }[];
    /** A chat by id, deleted or not. */
    withDeletedThread(id: string): { title: string } | undefined;
}

/**
 * `GET /operations/access-log?cursor=&limit=`: every entry, every admin's
 * own included, newest first. Reading the log isn't logged.
 */
export function accessLogRoutes({ log, names }: { log: AccessLogRepository; names: AccessLogNames }) {
    const app = new Hono<AppEnv>();
    app.get('/operations/access-log', requireAdminPerson, async (c) => {
        const page = pageOf(c.req.query('cursor'), c.req.query('limit'));
        if (!page || (page.cursor && typeof page.cursor.key !== 'number')) {
            return c.json({ error: PAGE_ERROR }, 400);
        }
        const answer = await log.page(page);
        const people = new Map(names.users().map((user) => [user.id, user.name]));
        const spaces = new Map(names.spaces().map((space) => [space.id, space.name]));
        const nameOf = ({ kind, id }: AccessSubject): string | null => {
            switch (kind) {
                case 'person':
                    return people.get(id) ?? null;
                case 'socio':
                    return names.dot(id)?.name ?? null;
                case 'space':
                    return spaces.get(id) ?? null;
                case 'chat':
                    return names.withDeletedThread(id)?.title ?? null;
                default:
                    return null;
            }
        };
        return c.json<CursorPage<OpsAccessRow>>({
            items: answer.items.map((entry) => ({
                id: entry.id,
                at: entry.at,
                viewerId: entry.viewerId,
                viewerName: people.get(entry.viewerId) ?? null,
                surface: entry.surface,
                subjectKind: entry.subject.kind,
                subjectId: entry.subject.id,
                subjectName: nameOf(entry.subject),
                content: entry.content,
                filters: entry.filters,
                // A filter's socio, person, Space or room by name, as the
                // subject's; a room's turn's initiator as the person they are.
                filterNames: Object.fromEntries(
                    ACCESS_NAMED_FILTERS.filter((name) => entry.filters[name]).map((name) => [
                        name,
                        nameOf({
                            kind: FILTER_SUBJECTS[name],
                            id: entry.filters[name]!,
                        } as AccessSubject),
                    ]),
                ),
                requestId: entry.requestId,
            })),
            next: answer.next && encodeCursor(answer.next),
        });
    });
    return app;
}
