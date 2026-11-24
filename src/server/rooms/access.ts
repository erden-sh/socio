import { ACCESS_LOG_DEDUPE_MS } from '@socio/shared/operations/operations-access';
import {
    isTeamOwnerId,
    roomAllows,
    type RoomAction,
    type RoomDecision,
    type RoomDenial,
    type RoomEvent,
    type RoomViewer,
} from '@socio/shared/rooms/rooms';

import type { AccessShape, AccessThread, RoomAccessCheck } from './contract.js';
import type { RoomAccessReader } from './domain/repositories.js';

export interface RoomAccessOptions {
    reader: RoomAccessReader;
    /**
     * A linked person seen in the topic's Telegram group: today's readers of
     * a legacy team topic (`TelegramLinks.teamThreadsForNow`).
     */
    topicReader: (userId: string, threadId: string) => boolean;
    /** Settings → General → Rooms in force; off unless set (`useRooms`). */
    enabled: () => boolean;
    /** Writes a refusal to the room's audit (`room_events`), never content. */
    audit?: (event: RoomEvent) => void;
    now?: () => number;
}

/** How many refusals are remembered for their once-per-window audit. */
const DENIALS_KEPT = 5_000;

/**
 * The one access rule at work (CB-208): `roomAllows` with
 * the viewer's membership and legacy-topic reading loaded, for every
 * route and store method that answers a person about a conversation. A
 * private chat keeps today's rules (its owner, nobody else); a room needs
 * an active membership and, but for reading and leaving, Rooms on. Each
 * refusal in a room is audited once per person, room and action per
 * `ACCESS_LOG_DEDUPE_MS`. Workspace admins are no exception: they read
 * room content only through Operations, which logs it.
 */
export class RoomAccess implements AccessShape {
    private denials = new Map<string, number>();
    private now: () => number;
    constructor(private options: RoomAccessOptions) {
        this.now = options.now ?? Date.now;
    }

    enabled() {
        return this.options.enabled();
    }

    /** The rooms a person is an active member of, with their role. */
    viewerRooms(userId: string) {
        return this.options.reader.activeRooms(userId);
    }

    /**
     * The room's people now (CB-181): active members and invites that still
     * work, whoever the rule would let read today.
     */
    people(roomId: string) {
        return this.options.reader.people(roomId, this.now());
    }

    /** The room's active socios, in the order they were added (CB-206). */
    socios(roomId: string) {
        return this.options.reader.socios(roomId, 'active');
    }

    /** What the rule knows of the person, for this conversation. */
    viewer(thread: AccessThread, userId: string): RoomViewer {
        if (thread.kind !== 'room' && thread.ownerId === userId) {
            return { userId };
        }
        const member = thread.kind === 'room' ? this.options.reader.member(thread.id, userId) : undefined;
        return {
            userId,
            ...(member ? { member } : {}),
            // Only a legacy topic has observed readers (a converted one: CB-214).
            ...(isTeamOwnerId(thread.ownerId) && this.options.topicReader(userId, thread.id)
                ? { topicReader: true }
                : {}),
        };
    }

    /** Whether `userId` may do `action` in the conversation, and why not. */
    decide(thread: AccessThread, userId: string, action: RoomAction, check: RoomAccessCheck = {}): RoomDecision {
        const decision = roomAllows(
            { ...thread, kind: thread.kind ?? 'private' },
            this.viewer(thread, userId),
            action,
            {
                roomsEnabled: this.enabled(),
                ...(check.cycleInitiatorId !== undefined ? { cycleInitiatorId: check.cycleInitiatorId } : {}),
            },
        );
        if (!decision.allowed && thread.kind === 'room' && check.audit !== false) {
            this.denied(thread.id, userId, action, decision.reason);
        }
        return decision;
    }

    /** A refusal in a room, audited once per window. */
    denied(roomId: string, userId: string, action: RoomAction, reason: RoomDenial) {
        if (!this.options.audit) {
            return;
        }
        const now = this.now();
        const key = `${userId}\u0000${roomId}\u0000${action}`;
        const last = this.denials.get(key);
        if (last !== undefined && now - last < ACCESS_LOG_DEDUPE_MS) {
            return;
        }
        if (this.denials.size >= DENIALS_KEPT) {
            for (const [seen, at] of this.denials) {
                if (now - at >= ACCESS_LOG_DEDUPE_MS || this.denials.size >= DENIALS_KEPT) {
                    this.denials.delete(seen);
                } else {
                    break;
                }
            }
        }
        this.denials.set(key, now);
        this.options.audit({
            roomId,
            actor: userId,
            action: 'denied',
            targetKind: 'room',
            targetId: roomId,
            outcome: 'denied',
            detail: `${action}: ${reason}`,
            at: now,
        });
    }
}
