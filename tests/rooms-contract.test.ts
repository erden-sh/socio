import { describe, expect, it } from 'vitest';

import {
    ROOM_LIMIT_DEFAULTS,
    conversationShape,
    cycleExhausted,
    effectiveRoomLimits,
    handOff,
    inviteUsable,
    leavesNoAdmin,
    memberTransition,
    raisedRoomLimits,
    reservedOwnerId,
    roomAllows,
    roomEligibleSocio,
    roomOwnerId,
    roomsEnabledFromEnv,
    artifactVisibleTo,
    actorKey,
    startTurn,
    turnContextProblems,
    withinRoomRate,
    type RoomLimits,
    type TurnContext,
} from '@socio/shared/rooms/rooms';

const on = { roomsEnabled: true };
const off = { roomsEnabled: false };
const room = { id: 'r1', kind: 'room' as const, ownerId: roomOwnerId('r1') };
const archivedRoom = { ...room, archivedAt: 1 };
const privateChat = { id: 'p1', kind: 'private' as const, ownerId: 'ana' };
const topic = {
    id: 't1',
    kind: 'private' as const,
    ownerId: 'telegram-team:-100',
};
const admin = { role: 'admin' as const, status: 'active' as const };
const member = { role: 'member' as const, status: 'active' as const };

describe('owners and shapes', () => {
    it('tells private chats, legacy topics and rooms apart', () => {
        expect(conversationShape(privateChat)).toBe('private');
        expect(conversationShape(topic)).toBe('legacy-topic');
        expect(conversationShape(room)).toBe('room');
    });
    it('reserves room and team owner ids from people', () => {
        expect(reservedOwnerId(roomOwnerId('x'))).toBe(true);
        expect(reservedOwnerId('telegram-team:1')).toBe(true);
        expect(reservedOwnerId('ana')).toBe(false);
    });
});

describe('membership lifecycle', () => {
    it('moves only along allowed transitions', () => {
        expect(memberTransition(undefined, 'invite')).toBe('invited');
        expect(memberTransition('invited', 'accept')).toBe('active');
        expect(memberTransition('invited', 'decline')).toBe('declined');
        expect(memberTransition('invited', 'expire')).toBe('expired');
        expect(memberTransition('active', 'leave')).toBe('left');
        expect(memberTransition('active', 'remove')).toBe('removed');
        expect(memberTransition('left', 'invite')).toBe('invited');
        expect(memberTransition('active', 'invite')).toBeNull();
        expect(memberTransition('removed', 'accept')).toBeNull();
        expect(memberTransition('expired', 'accept')).toBeNull();
        expect(memberTransition(undefined, 'leave')).toBeNull();
    });
    it('refuses expired invites', () => {
        const invite = { status: 'invited' as const, inviteExpiresAt: 100 };
        expect(inviteUsable(invite, 99)).toBe(true);
        expect(inviteUsable(invite, 100)).toBe(false);
        expect(inviteUsable({ ...invite, inviteExpiresAt: null }, 1e15)).toBe(true);
        expect(inviteUsable(undefined, 0)).toBe(false);
    });
    it('keeps at least one active admin', () => {
        const members = [
            { userId: 'ana', role: 'admin' as const, status: 'active' as const },
            { userId: 'bo', role: 'member' as const, status: 'active' as const },
        ];
        expect(leavesNoAdmin(members, { userId: 'ana', status: 'left' })).toBe(true);
        expect(leavesNoAdmin(members, { userId: 'ana', role: 'member' })).toBe(true);
        expect(leavesNoAdmin(members, { userId: 'bo', status: 'left' })).toBe(false);
        const handedOn = [...members];
        handedOn[1] = { ...handedOn[1], role: 'admin' };
        expect(leavesNoAdmin(handedOn, { userId: 'ana', status: 'left' })).toBe(false);
    });
    it('lets only live company socios into rooms', () => {
        expect(roomEligibleSocio({ ownerId: null })).toBe(true);
        expect(roomEligibleSocio({ ownerId: 'ana' })).toBe(false);
        expect(roomEligibleSocio({ ownerId: null, archivedAt: 5 })).toBe(false);
    });
});

describe('roomAllows', () => {
    it('keeps private chats owner-only, as today', () => {
        for (const action of ['read', 'send', 'stop', 'manage', 'delete'] as const) {
            expect(roomAllows(privateChat, { userId: 'ana' }, action, off).allowed).toBe(true);
        }
        expect(roomAllows(privateChat, { userId: 'bo' }, 'read', on)).toEqual({
            allowed: false,
            reason: 'not_found',
        });
        expect(roomAllows(privateChat, { userId: 'ana' }, 'convert', off)).toEqual({
            allowed: false,
            reason: 'rooms_off',
        });
        expect(roomAllows(privateChat, { userId: 'ana' }, 'convert', on).allowed).toBe(true);
    });
    it('keeps legacy topics read-only for observed readers', () => {
        const reader = { userId: 'bo', topicReader: true };
        expect(roomAllows(topic, reader, 'read', on).allowed).toBe(true);
        expect(roomAllows(topic, reader, 'send', on)).toEqual({
            allowed: false,
            reason: 'read_only',
        });
        expect(roomAllows(topic, { userId: 'cy' }, 'read', on).allowed).toBe(false);
        expect(
            roomAllows(topic, { ...reader, member: { role: 'member', status: 'removed' } }, 'read', on).allowed,
        ).toBe(false);
    });
    it('gives pending invites and strangers nothing', () => {
        const invited = {
            userId: 'bo',
            member: { role: 'member' as const, status: 'invited' as const },
        };
        for (const action of ['read', 'send', 'leave'] as const) {
            expect(roomAllows(room, invited, action, on)).toEqual({
                allowed: false,
                reason: 'not_found',
            });
            expect(roomAllows(room, { userId: 'zed' }, action, on).allowed).toBe(false);
        }
    });
    it('revokes access at once for ended members', () => {
        for (const status of ['left', 'removed', 'declined', 'expired'] as const) {
            expect(roomAllows(room, { userId: 'bo', member: { role: 'admin', status } }, 'read', on).allowed).toBe(
                false,
            );
        }
    });
    it('lets members read and send, and admins manage', () => {
        const bo = { userId: 'bo', member };
        const ana = { userId: 'ana', member: admin };
        expect(roomAllows(room, bo, 'read', on).allowed).toBe(true);
        expect(roomAllows(room, bo, 'send', on).allowed).toBe(true);
        expect(roomAllows(room, bo, 'manage', on)).toEqual({
            allowed: false,
            reason: 'not_admin',
        });
        expect(roomAllows(room, ana, 'manage', on).allowed).toBe(true);
        expect(roomAllows(room, ana, 'archive', on).allowed).toBe(true);
        expect(roomAllows(room, ana, 'delete', on).allowed).toBe(false);
    });
    it('lets the initiator or an admin stop a cycle, nobody else', () => {
        const bo = { userId: 'bo', member };
        expect(roomAllows(room, bo, 'stop', { ...on, cycleInitiatorId: 'bo' }).allowed).toBe(true);
        expect(roomAllows(room, bo, 'stop', { ...on, cycleInitiatorId: 'cy' })).toEqual({
            allowed: false,
            reason: 'not_initiator',
        });
        expect(
            roomAllows(room, { userId: 'ana', member: admin }, 'stop', {
                ...on,
                cycleInitiatorId: 'cy',
            }).allowed,
        ).toBe(true);
    });
    it('makes archived rooms read-only, and rooms read-only while off', () => {
        const ana = { userId: 'ana', member: admin };
        expect(roomAllows(archivedRoom, ana, 'read', on).allowed).toBe(true);
        expect(roomAllows(archivedRoom, ana, 'send', on)).toEqual({
            allowed: false,
            reason: 'archived',
        });
        expect(roomAllows(archivedRoom, ana, 'unarchive', on).allowed).toBe(true);
        expect(roomAllows(room, ana, 'read', off).allowed).toBe(true);
        expect(roomAllows(room, ana, 'leave', off).allowed).toBe(true);
        for (const action of ['send', 'manage', 'archive', 'unarchive'] as const) {
            expect(roomAllows(room, ana, action, off)).toEqual({
                allowed: false,
                reason: 'rooms_off',
            });
        }
    });
    it('keeps observed Telegram readers of a converted topic read-only', () => {
        const reader = { userId: 'bo', topicReader: true };
        expect(roomAllows(room, reader, 'read', on)).toEqual({
            allowed: true,
            via: 'legacy-topic',
        });
        expect(roomAllows(room, reader, 'send', on).allowed).toBe(false);
        expect(
            roomAllows(room, { ...reader, member: { role: 'member', status: 'declined' } }, 'read', on).allowed,
        ).toBe(false);
    });
});

describe('turn context', () => {
    const company = { dotId: 'd1', ownerId: null, roomStatus: 'active' as const };
    const base = {
        conversation: room,
        senderId: 'bo',
        member,
        socio: company,
        cycleId: 'c1',
        billing: { kind: 'workspace' as const },
        roomsEnabled: true,
    };
    it('acts as the sender in a room', () => {
        const started = startTurn(base);
        expect(started).toEqual({
            ok: true,
            context: {
                conversationId: 'r1',
                kind: 'room',
                cycleId: 'c1',
                initiator: { kind: 'person', id: 'bo' },
                actingUserId: 'bo',
                socio: { dotId: 'd1', ownerId: null },
                billing: { kind: 'workspace' },
                hop: 0,
            },
        });
        if (started.ok) {
            expect(turnContextProblems(started.context)).toEqual([]);
        }
    });
    it('refuses rather than falling back to anyone else', () => {
        expect(startTurn({ ...base, member: undefined })).toEqual({
            ok: false,
            reason: 'not_member',
        });
        expect(startTurn({ ...base, billing: { kind: 'person', userId: 'ana' } })).toEqual({
            ok: false,
            reason: 'billing_not_actor',
        });
        expect(startTurn({ ...base, socio: { ...company, ownerId: 'ana' } })).toEqual({
            ok: false,
            reason: 'personal_socio',
        });
        expect(startTurn({ ...base, socio: { ...company, roomStatus: 'withdrawn' } })).toEqual({
            ok: false,
            reason: 'socio_not_in_room',
        });
        expect(startTurn({ ...base, conversation: archivedRoom })).toEqual({
            ok: false,
            reason: 'archived',
        });
        expect(startTurn({ ...base, roomsEnabled: false })).toEqual({
            ok: false,
            reason: 'rooms_off',
        });
    });
    it('keeps private chats and personal socios as today', () => {
        const own = startTurn({
            ...base,
            conversation: privateChat,
            senderId: 'ana',
            member: undefined,
            socio: { dotId: 'mine', ownerId: 'ana' },
            billing: { kind: 'person', userId: 'ana' },
            roomsEnabled: false,
        });
        expect(own.ok).toBe(true);
        expect(
            startTurn({
                ...base,
                conversation: privateChat,
                senderId: 'bo',
                member: undefined,
            }).ok,
        ).toBe(false);
    });
    it('hands off within the same cycle and envelope, up to the limit', () => {
        const started = startTurn(base);
        if (!started.ok) {
            throw new Error('expected a start');
        }
        let context: TurnContext = started.context;
        for (let hop = 1; hop <= ROOM_LIMIT_DEFAULTS.handoffsPerCycle; hop++) {
            const next = handOff(
                context,
                { dotId: `d${hop + 1}`, ownerId: null, roomStatus: 'active' },
                ROOM_LIMIT_DEFAULTS.handoffsPerCycle,
            );
            if (!next.ok) {
                throw new Error(next.reason);
            }
            expect(next.context).toMatchObject({
                cycleId: 'c1',
                actingUserId: 'bo',
                initiator: { kind: 'person', id: 'bo' },
                billing: { kind: 'workspace' },
                hop,
            });
            context = next.context;
        }
        expect(
            handOff(
                context,
                { dotId: 'd9', ownerId: null, roomStatus: 'active' },
                ROOM_LIMIT_DEFAULTS.handoffsPerCycle,
            ),
        ).toEqual({ ok: false, reason: 'handoff_limit' });
        expect(handOff(started.context, { dotId: 'p', ownerId: 'ana', roomStatus: 'active' }, 4)).toEqual({
            ok: false,
            reason: 'personal_socio',
        });
    });
    it('reports contexts that break the rules', () => {
        const started = startTurn(base);
        if (!started.ok) {
            throw new Error('expected a start');
        }
        const bad: TurnContext = {
            ...started.context,
            actingUserId: 'ana',
            billing: { kind: 'person', userId: 'cy' },
            socio: { dotId: 'p', ownerId: 'ana' },
            hop: -1,
        };
        expect(turnContextProblems(bad)).toEqual([
            'hop must be a whole number from 0',
            'billed to someone other than the acting person',
            'a room turn acts as the person who started it',
            'a personal socio in a room',
        ]);
    });
});

describe('limits', () => {
    const workspace: RoomLimits = {
        cycleTimeMs: 300_000,
        cycleTokens: ROOM_LIMIT_DEFAULTS.cycleTokens,
        messagesPerMinute: ROOM_LIMIT_DEFAULTS.messagesPerMinute,
        maxQueued: 5,
        handoffsPerCycle: ROOM_LIMIT_DEFAULTS.handoffsPerCycle,
        cycleSpendUsd: null,
    };
    it('lets room admins only lower limits', () => {
        expect(
            effectiveRoomLimits(workspace, {
                cycleTokens: 100_000,
                messagesPerMinute: 99,
                maxQueued: 0,
                handoffsPerCycle: 2.5,
                cycleSpendUsd: 1.5,
            }),
        ).toEqual({ ...workspace, cycleTokens: 100_000, cycleSpendUsd: 1.5 });
        expect(raisedRoomLimits(workspace, { cycleTokens: 2_500_000, maxQueued: 3 })).toEqual(['cycleTokens']);
        expect(raisedRoomLimits({ ...workspace, cycleSpendUsd: 2 }, { cycleSpendUsd: null })).toEqual([
            'cycleSpendUsd',
        ]);
        expect(effectiveRoomLimits({ ...workspace, cycleSpendUsd: 2 }, { cycleSpendUsd: 5 }).cycleSpendUsd).toBe(2);
    });
    it('stops a cycle at its first exhausted bound', () => {
        const usage = { startedAt: 0, tokens: 0, handoffs: 0, costUsd: null };
        expect(cycleExhausted(usage, workspace, 1000)).toBeUndefined();
        expect(cycleExhausted(usage, workspace, 300_000)).toBe('deadline');
        expect(cycleExhausted({ ...usage, tokens: 1_999_999 }, workspace, 1)).toBeUndefined();
        expect(cycleExhausted({ ...usage, tokens: 2_000_000 }, workspace, 1)).toBe('tokens');
        expect(cycleExhausted({ ...usage, handoffs: 5 }, workspace, 1)).toBe('handoffs');
    });
    it('enforces spend only when the cost is known', () => {
        const capped = { ...workspace, cycleSpendUsd: 1 };
        const usage = { startedAt: 0, tokens: 0, handoffs: 0 };
        expect(cycleExhausted({ ...usage, costUsd: null }, capped, 1)).toBeUndefined();
        expect(cycleExhausted({ ...usage, costUsd: 1 }, capped, 1)).toBe('spend');
        expect(cycleExhausted({ ...usage, costUsd: 50 }, workspace, 1)).toBeUndefined();
    });
    it('counts the room rate over the last minute', () => {
        const now = 1_000_000;
        const recent = Array.from({ length: 20 }, (_, i) => now - i * 1000);
        expect(withinRoomRate(recent, now, 20)).toBe(false);
        expect(withinRoomRate(recent.slice(1), now, 20)).toBe(true);
        expect(withinRoomRate([now - 61_000], now, 1)).toBe(true);
    });
});

describe('identity, artifacts and settings', () => {
    it('keys actors by kind and id, not name', () => {
        expect(actorKey({ kind: 'person', id: 'u1' })).toBe('person:u1');
        expect(actorKey({ kind: 'socio', id: 'u1' })).not.toBe(actorKey({ kind: 'person', id: 'u1' }));
    });
    it('shows actor-only artifacts to the acting person alone', () => {
        const artifact = { visibility: 'actor' as const, actingUserId: 'bo' };
        expect(artifactVisibleTo(artifact, 'bo')).toBe(true);
        expect(artifactVisibleTo(artifact, 'ana')).toBe(false);
        expect(artifactVisibleTo({ ...artifact, visibility: 'room' }, 'ana')).toBe(true);
    });
    it('keeps Rooms off unless the environment says yes', () => {
        expect(roomsEnabledFromEnv(undefined)).toBe(false);
        expect(roomsEnabledFromEnv('')).toBe(false);
        expect(roomsEnabledFromEnv('false')).toBe(false);
        expect(roomsEnabledFromEnv(' TRUE ')).toBe(true);
        expect(roomsEnabledFromEnv('1')).toBe(true);
    });
});
