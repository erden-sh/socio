import type { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import { z } from 'zod';

import { sqliteData } from '@socio/data/open';
import type { AppEnv } from '@socio/foundation/http/app-env';
import { roomDenialStatus } from '@socio/foundation/rooms/denial-status';
import { ROOM_DENIAL_MESSAGES, ROOM_UNREAD_CAP, type RoomReadState } from '@socio/shared/rooms/rooms';
import type { Conversation } from '@socio/shared/types';

import type { RunnerShape } from '../turns/contract.js';

import type { ReadsShape } from './contract.js';
import type { RoomReadStateRepository } from './domain/repositories.js';
import { sqliteRoomRepositories } from './infra/sqlite/repositories.js';
import type { RoomsPlatform } from './services.js';

/**
 * Each member's unread state in their rooms (CB-215): a read
 * cursor per member and room (`room_read_state`), the room's last finished
 * turn (`agent_runs.seq`) they have seen. Unread is the turns after it
 * that someone else started since they joined (`unreadRuns`): their own
 * are never new to them, and only turns are counted, never anyone's
 * private tool results. The cursor only moves forward, so two devices
 * agree; it moves as the room is viewed (`markRead`).
 *
 * Live updates: a moved cursor bumps the person's own `threads:<userId>`
 * (change-counters.ts), and the shell's version holds each room's count
 * (`version`), so a turn that ends shows on every member's list at their
 * next poll.
 */
export class RoomReads implements ReadsShape {
    constructor(
        private reads: RoomReadStateRepository,
        private runner: Pick<RunnerShape, 'lastFinished' | 'unreadRuns'>,
        private now: () => number = Date.now,
    ) {}

    /** Unread turns per room the person is an active member of; none left out. */
    async unread(userId: string): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        for (const place of await this.reads.places(userId)) {
            counts.set(
                place.roomId,
                this.runner.unreadRuns(place.roomId, {
                    after: place.lastSeq,
                    since: place.joinedAt,
                    reader: userId,
                    cap: ROOM_UNREAD_CAP,
                }),
            );
        }
        return counts;
    }

    /** The chat list with each room's unread count, where it has some. */
    async withUnread(userId: string, conversations: Conversation[]): Promise<Conversation[]> {
        if (!conversations.some((chat) => chat.kind === 'room')) {
            return conversations;
        }
        const counts = await this.unread(userId);
        return conversations.map((chat) => {
            const unread = chat.kind === 'room' ? counts.get(chat.id) : undefined;
            return unread ? { ...chat, unread } : chat;
        });
    }

    /**
     * What the shell's version needs of it: every count, so a poll answers
     * 304 only while none changed.
     */
    async version(userId: string): Promise<string> {
        const counts = await this.unread(userId);
        return JSON.stringify([...counts].filter(([, unread]) => unread > 0).sort());
    }

    /**
     * The person has seen the room up to `seq`, or (none given) up to its
     * last finished turn; never past that, never back. Undefined when they
     * are no active member there.
     */
    async markRead(roomId: string, userId: string, seq?: number): Promise<RoomReadState | undefined> {
        const place = await this.reads.place(roomId, userId);
        if (!place) {
            return undefined;
        }
        const last = this.runner.lastFinished(roomId);
        const target = Math.min(seq ?? last, last);
        const lastSeq =
            target > place.lastSeq ? await this.reads.advance(roomId, userId, target, this.now()) : place.lastSeq;
        return {
            lastSeq,
            unread: this.runner.unreadRuns(roomId, {
                after: lastSeq,
                since: place.joinedAt,
                reader: userId,
                cap: ROOM_UNREAD_CAP,
            }),
        };
    }
}

/** What the read state is made of: the workspace's connection and the runner. */
export interface ReadsSources {
    readonly workspace: { readonly db: DatabaseSync };
    readonly runner: Pick<RunnerShape, 'lastFinished' | 'unreadRuns'>;
}

const cache = new WeakMap<ReadsSources, RoomReads>();
/** The read state over `sources`, on the workspace's connection: one per set of sources. */
export function roomReads(sources: ReadsSources): RoomReads {
    let reads = cache.get(sources);
    if (!reads) {
        const { db } = sources.workspace;
        reads = new RoomReads(sqliteRoomRepositories(sqliteData(db)).reads, sources.runner);
        cache.set(sources, reads);
    }
    return reads;
}

const read = z.object({ seq: z.number().int().nonnegative().optional() }).strict();

/**
 * `POST /rooms/:id/read` (CB-215): the reader saw the room, so its unread
 * count clears for them, on every device. A member may, as they may read
 * it: also when it is archived or Rooms are off. Anyone else finds
 * nothing, as for the room itself.
 */
export function roomReadRoutes(platform: RoomsPlatform) {
    const app = new Hono<AppEnv>();
    app.post('/rooms/:id/read', async (c) => {
        const userId = c.get('user').id;
        const id = c.req.param('id');
        const { thread, decision } = platform.workspace.access(userId, id, 'read');
        if (thread?.kind !== 'room' || !decision.allowed) {
            const reason = decision.allowed ? 'not_found' : decision.reason;
            return c.json({ error: ROOM_DENIAL_MESSAGES[reason], code: reason }, roomDenialStatus(reason));
        }
        const body = read.safeParse(await c.req.json().catch(() => ({}) as unknown));
        if (!body.success) {
            return c.json({ error: 'Give a turn number, or none.' }, 400);
        }
        const state = await roomReads(platform).markRead(id, userId, body.data.seq);
        if (!state) {
            return c.json({ error: ROOM_DENIAL_MESSAGES.not_found, code: 'not_found' }, 404);
        }
        return c.json(state satisfies RoomReadState);
    });
    return app;
}
