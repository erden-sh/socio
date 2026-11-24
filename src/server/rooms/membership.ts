import type { UnitOfWork } from '@socio/data/uow';
import { compareText } from '@socio/shared/locale';
import {
    ROOM_DISCLOSURE_TEXT,
    ROOM_DISCLOSURE_VERSION,
    ROOM_INVITE_TTL_MS,
    effectiveRoomLimits,
    inviteUsable,
    leavesNoAdmin,
    memberTransition,
    reservedOwnerId,
    roomEligibleSocio,
    type RoomAction,
    type RoomDenial,
    type RoomEvent,
    type RoomHandoffLimitView,
    type RoomInvite,
    type RoomLimits,
    type RoomLimitsView,
    type RoomPerson,
    type RoomRole,
    type RoomSocioRequest,
    type RoomUsageView,
    type RoomView,
} from '@socio/shared/rooms/rooms';
import { MAX_CHAT_TITLE, type Conversation, type Dot } from '@socio/shared/types';

import type { CycleRoomHooks, WorkCycle } from '../cycles/contract.js';

import type { RoomAccess } from './access.js';
import {
    RoomError,
    type RoomsShape,
    type StoredRoomEvent,
    type StoredRoomMember,
    type StoredRoomSocio,
} from './contract.js';
import type { RoomRepositories } from './domain/repositories.js';
import type { RoomStorage } from './service.js';
import { roomUsage } from './usage.js';

/** What membership reads of the workspace and the platform. */
export interface RoomMembershipOptions {
    uow: UnitOfWork;
    repos: RoomRepositories;
    /** Making and converting rooms (CB-207). */
    storage: RoomStorage;
    workspace: {
        thread(id: string): Conversation | undefined;
        dot(id: string): Dot | undefined;
        roomAccess: RoomAccess;
    };
    people: {
        /** A person who may be in a room: signed in once, active, no service account. */
        invitable(userId: string): boolean;
        name(userId: string): string | undefined;
        /** Not deactivated: a deactivated admin no longer counts as one. */
        active(userId: string): boolean;
        /** Everyone who has signed in, for a room admin's invite list (CB-212). */
        list?(): readonly { id: string; name: string }[];
    };
    /** Settings → General → Rooms in force. */
    enabled: () => boolean;
    limits: {
        /** The workspace's limits in force now. */
        workspace: () => RoomLimits;
        /** A room admin's change, checked (`WorkCycles.checkRoomLimits`). */
        check: (change: Partial<RoomLimits>) => { ok: true } | { ok: false; raised: readonly string[] };
    };
    /**
     * A room's use for its people (CB-218): whether members see it
     * (Settings → Rooms; room admins always do), and its cycles started
     * since a time, with its current one (`WorkCycles.usage`).
     */
    usage?: {
        visible: () => boolean;
        cycles: (roomId: string, since: number) => Promise<{ current?: WorkCycle; recent: WorkCycle[] }>;
    };
    /**
     * Ends work nobody may do any more, at once: the running turn of the
     * person removed or gone (or of anyone, without a person: an archive, a
     * socio withdrawn). Their queued messages are re-checked as they are
     * claimed (`WorkCycles.mayDispatch`), and an approval they asked for as
     * it carries on (approvals/continue.ts).
     */
    revoke?: (roomId: string, userId?: string) => Promise<void>;
    /**
     * Their live streams of the room end (CB-212): the person's, as they
     * leave or are removed, or everyone's, as it is archived. Called first,
     * before the work is revoked.
     */
    ended?: (roomId: string, userId: string | undefined, reason: 'removed' | 'left' | 'archived') => Promise<void>;
    /**
     * A person was invited (CB-216: they hear of it), after the invite is
     * stored. Never awaited, never fails the invite.
     */
    invited?: (roomId: string, by: string, userId: string, at: number) => void;
    now?: () => number;
}

/**
 * Rooms' membership and lifecycle (CB-208): invitations,
 * acceptance with the history disclosure, roles, leaving and removal,
 * renaming, archiving, the room's socios and lead, and its lower limits.
 * Every change is checked against the one rule (`RoomAccess`) and written
 * in one unit of work with its `room_events` line, the check read again
 * inside it, so two changes at once are ordered and the second sees the
 * first (a double accept, an accept beside a removal, the last two admins
 * leaving together). Workspace admins get no room access from their role:
 * they authorize and withdraw company socios, and read the audit.
 */
export class RoomMembership implements RoomsShape {
    private now: () => number;
    constructor(private options: RoomMembershipOptions) {
        this.now = options.now ?? Date.now;
    }

    private get repos() {
        return this.options.repos;
    }

    /**
     * Audits a refusal by the rule (`RoomAccess.denied`) once the work has
     * failed: after a unit of work rolled back, so the line is kept.
     */
    private async audited<T>(work: () => Promise<T>): Promise<T> {
        try {
            return await work();
        } catch (error) {
            if (error instanceof RoomError && error.denial) {
                this.options.workspace.roomAccess.denied(
                    error.denial.roomId,
                    error.denial.userId,
                    error.denial.action,
                    error.reason as RoomDenial,
                );
            }
            throw error;
        }
    }

    /** One unit of work, its refusals audited (`audited`). */
    private run<T>(label: string, work: () => Promise<T>): Promise<T> {
        return this.audited(() => this.options.uow.run(work, { label }));
    }

    private event(
        roomId: string,
        actor: string,
        action: RoomEvent['action'],
        target: Pick<RoomEvent, 'targetKind' | 'targetId'>,
        detail = '',
        at = this.now(),
    ) {
        return this.repos.events.append({
            roomId,
            actor,
            action,
            ...target,
            outcome: 'ok',
            detail,
            at,
        });
    }

    /** The room, if `userId` may do `action` there; else why not. */
    private require(roomId: string, userId: string, action: RoomAction) {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new RoomError('not_found');
        }
        // Audited by `run` once the unit is rolled back, or here outside one.
        const decision = this.options.workspace.roomAccess.decide(thread, userId, action, { audit: false });
        if (!decision.allowed) {
            const error = new RoomError(decision.reason);
            error.denial = { roomId, userId, action };
            throw error;
        }
        return thread;
    }

    /** A live room, for what needs Rooms on and the room unarchived. */
    private live(roomId: string) {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new RoomError('not_found');
        }
        if (!this.options.enabled()) {
            throw new RoomError('rooms_off');
        }
        if (thread.archivedAt) {
            throw new RoomError('archived');
        }
        return thread;
    }

    private name(userId: string | null) {
        return userId ? (this.options.people.name(userId) ?? null) : null;
    }

    // ---- making rooms ---------------------------------------------------------

    /**
     * A new room with `by` as its admin and a company socio as its lead.
     * CB-278: `dotIds` asks for further company socios, `userIds` invites
     * people as members, and `description` is the room's optional purpose;
     * all are written in the same unit of work as the room's row. Each
     * invited person must be invitable (the maker and sentinels are dropped
     * silently), as `invite` checks.
     */
    create(
        by: string,
        input: {
            dotId: string;
            title: string;
            dotIds?: readonly string[];
            userIds?: readonly string[];
            description?: string;
        },
    ) {
        for (const userId of new Set(input.userIds ?? [])) {
            if (userId === by || reservedOwnerId(userId)) {
                continue;
            }
            if (!this.options.people.invitable(userId)) {
                throw new RoomError('not_eligible');
            }
        }
        return this.options.storage.createRoom({ ...input, createdBy: by });
    }

    /**
     * `by`'s own private web chat as a room, once they confirmed that the
     * people they invite will read its whole history (`ROOM_CONVERT_TEXT`).
     */
    convert(id: string, by: string, confirmedHistory: boolean) {
        if (!confirmedHistory) {
            throw new RoomError('disclosure', 'Confirm that everyone you invite will read this chat’s whole history.');
        }
        return this.options.storage.convertToRoom(id, by, this.now());
    }

    // ---- reading ----------------------------------------------------------------

    /** A room's membership rows, ended ones too (internal use, tests). */
    members(roomId: string) {
        return this.repos.members.list(roomId);
    }

    /** The reconcile before Rooms is turned on (CB-207). */
    readiness() {
        return this.options.storage.readiness();
    }

    /** The room for one of its active members. */
    view(roomId: string, by: string): Promise<RoomView> {
        return this.audited(() => this.viewOf(roomId, by));
    }
    private async viewOf(roomId: string, by: string): Promise<RoomView> {
        const thread = this.require(roomId, by, 'read');
        const [members, socios] = await Promise.all([this.repos.members.list(roomId), this.repos.socios.list(roomId)]);
        const room = (await this.repos.conversations.get(roomId))!;
        const you = members.find((member) => member.userId === by)!;
        const now = this.now();
        return {
            id: room.id,
            title: room.title,
            dotId: room.dotId,
            createdAt: room.createdAt,
            createdBy: room.createdBy,
            convertedAt: room.convertedAt,
            archivedAt: thread.archivedAt ?? null,
            role: you.role,
            roomsEnabled: this.options.enabled(),
            usageVisible: !!this.options.usage && (you.role === 'admin' || this.options.usage.visible()),
            members: members
                .filter(
                    (member) =>
                        member.status === 'active' || (member.status === 'invited' && inviteUsable(member, now)),
                )
                .map((member) => ({
                    userId: member.userId,
                    name: this.name(member.userId) ?? 'Someone no longer here',
                    role: member.role,
                    status: member.status as 'active' | 'invited',
                    invitedBy: member.invitedBy,
                    invitedAt: member.invitedAt,
                    inviteExpiresAt: member.inviteExpiresAt,
                    acceptedAt: member.acceptedAt,
                })),
            socios: socios
                .filter((socio) => socio.status === 'active' || socio.status === 'requested')
                .map((socio) => ({
                    dotId: socio.dotId,
                    name: this.options.workspace.dot(socio.dotId)?.name ?? 'A socio',
                    status: socio.status,
                    lead: socio.dotId === room.dotId,
                })),
        };
    }

    /**
     * The person's invites they can still accept: a room's name, who asked
     * and what joining shares, never its history.
     */
    async invites(userId: string): Promise<RoomInvite[]> {
        const now = this.now();
        const pending = (await this.repos.members.forUser(userId, ['invited'])).filter((member) =>
            inviteUsable(member, now),
        );
        const invites: RoomInvite[] = [];
        for (const member of pending) {
            const room = await this.repos.conversations.get(member.roomId);
            if (room?.kind !== 'room' || room.archivedAt) {
                continue;
            }
            const members = await this.repos.members.list(member.roomId);
            invites.push({
                roomId: room.id,
                title: room.title,
                role: member.role,
                invitedBy: member.invitedBy,
                invitedByName: this.name(member.invitedBy),
                invitedAt: member.invitedAt,
                inviteExpiresAt: member.inviteExpiresAt,
                memberCount: members.filter((row) => row.status === 'active').length,
                disclosure: {
                    version: ROOM_DISCLOSURE_VERSION,
                    text: ROOM_DISCLOSURE_TEXT,
                },
            });
        }
        return invites;
    }

    /**
     * The room's audit, newest first: for its admins, and for workspace
     * admins (names and outcomes only, never content).
     */
    async events(roomId: string, viewer: { id: string; admin: boolean }, limit = 100): Promise<StoredRoomEvent[]> {
        const thread = this.options.workspace.thread(roomId);
        if (!thread || thread.kind !== 'room') {
            throw new RoomError('not_found');
        }
        if (!viewer.admin) {
            const member = this.options.workspace.roomAccess.viewer(thread, viewer.id).member;
            if (member?.status !== 'active') {
                throw new RoomError('not_found');
            }
            if (member.role !== 'admin') {
                throw new RoomError('not_admin');
            }
        }
        return this.repos.events.forRoom(roomId, Math.min(Math.max(limit, 1), 500));
    }

    /**
     * A room as Operations shows it to a workspace admin (CB-213): who made
     * it, its people and socios (ended rows too), and its newest audit
     * lines when `events` is more than 0. It asks no rule: only Operations'
     * admin views call it, and they write each view to the access log.
     * Undefined for anything that is no room.
     */
    async oversight(roomId: string, { events = 0 }: { events?: number } = {}) {
        const room = await this.repos.conversations.get(roomId);
        if (room?.kind !== 'room') {
            return undefined;
        }
        const [members, socios, lines] = await Promise.all([
            this.repos.members.list(roomId),
            this.repos.socios.list(roomId),
            events > 0 ? this.repos.events.forRoom(roomId, Math.min(events, 500)) : Promise.resolve([]),
        ]);
        return { room, members, socios, events: lines, now: this.now() };
    }

    // ---- people -----------------------------------------------------------------

    /**
     * A room admin invites a person (again, after they left, declined, were
     * removed or let an invite run out): an invite for `ROOM_INVITE_TTL_MS`
     * that gives nothing until accepted.
     */
    /**
     * Whom a room admin may invite (CB-212): people who may be in a room,
     * not in it already nor invited, by name. A room admin's to read only,
     * while they may change the room; ids and names, nothing else.
     */
    async invitable(roomId: string, by: string): Promise<RoomPerson[]> {
        return this.audited(async () => {
            this.require(roomId, by, 'manage');
            const now = this.now();
            const taken = new Set(
                (await this.repos.members.list(roomId))
                    .filter(
                        (member) =>
                            member.status === 'active' || (member.status === 'invited' && inviteUsable(member, now)),
                    )
                    .map((member) => member.userId),
            );
            return (this.options.people.list?.() ?? [])
                .filter(
                    (person) =>
                        !taken.has(person.id) &&
                        !reservedOwnerId(person.id) &&
                        this.options.people.invitable(person.id),
                )
                .map((person) => ({ userId: person.id, name: person.name }))
                .sort((a, b) => compareText(a.name, b.name) || compareText(a.userId, b.userId));
        });
    }

    /**
     * People a member may invite as they make a room (CB-278): everyone who
     * may be in a room, apart from the maker and sentinels, by name. No room
     * is needed: this is read as the create dialog opens, before one exists.
     */
    async inviteCandidates(by: string): Promise<RoomPerson[]> {
        return this.audited(async () =>
            (this.options.people.list?.() ?? [])
                .filter(
                    (person) =>
                        person.id !== by && !reservedOwnerId(person.id) && this.options.people.invitable(person.id),
                )
                .map((person) => ({ userId: person.id, name: person.name }))
                .sort((a, b) => compareText(a.name, b.name) || compareText(a.userId, b.userId)),
        );
    }

    async invite(roomId: string, by: string, userId: string, role: RoomRole = 'member'): Promise<StoredRoomMember> {
        const member = await this.run('invite to room', async () => {
            // The caller's access first (CB-213): someone who can't see the
            // room is answered as for a room that isn't there, whoever they
            // name, so neither the room nor the person can be probed. Only a
            // room admin learns whether a person can be invited; an unknown id,
            // a sentinel, a deactivated person and a service account all get
            // the same `not_eligible`.
            this.require(roomId, by, 'manage');
            if (reservedOwnerId(userId) || !this.options.people.invitable(userId)) {
                throw new RoomError('not_eligible');
            }
            const now = this.now();
            const current = await this.repos.members.get(roomId, userId);
            // An invite that ran out can be sent again.
            const from = current?.status === 'invited' && !inviteUsable(current, now) ? 'expired' : current?.status;
            if (!memberTransition(from, 'invite')) {
                throw new RoomError(
                    'conflict',
                    current?.status === 'active' ? 'They are in the room already.' : 'They are invited already.',
                );
            }
            const member: StoredRoomMember = {
                roomId,
                userId,
                role,
                status: 'invited',
                invitedBy: by,
                invitedAt: now,
                inviteExpiresAt: now + ROOM_INVITE_TTL_MS,
                acceptedAt: null,
                disclosureVersion: null,
                endedAt: null,
                endedBy: null,
                updatedAt: now,
            };
            await this.repos.members.save(member);
            await this.event(roomId, by, 'invite', { targetKind: 'person', targetId: userId }, role, now);
            return member;
        });
        this.options.invited?.(roomId, by, userId, member.invitedAt);
        return member;
    }

    /**
     * The invited person joins, having been shown `ROOM_DISCLOSURE_TEXT`
     * (`disclosureVersion` must be the current one). An expired invite is
     * marked so and refused; one that was revoked, or accepted already,
     * is not found. Needs Rooms on and the room unarchived.
     */
    async accept(roomId: string, userId: string, disclosureVersion: unknown): Promise<StoredRoomMember> {
        const outcome = await this.run('accept room invite', async () => {
            const now = this.now();
            const current = await this.repos.members.get(roomId, userId);
            const thread = this.options.workspace.thread(roomId);
            if (!thread || thread.kind !== 'room' || current?.status !== 'invited') {
                return { refused: new RoomError('not_found') };
            }
            if (!inviteUsable(current, now)) {
                await this.expireRow(current, now);
                return { refused: new RoomError('expired') };
            }
            if (!this.options.enabled()) {
                return { refused: new RoomError('rooms_off') };
            }
            if (thread.archivedAt) {
                return { refused: new RoomError('archived') };
            }
            if (disclosureVersion !== ROOM_DISCLOSURE_VERSION) {
                return { refused: new RoomError('disclosure') };
            }
            const member: StoredRoomMember = {
                ...current,
                status: 'active',
                acceptedAt: now,
                disclosureVersion: ROOM_DISCLOSURE_VERSION,
                updatedAt: now,
            };
            await this.repos.members.save(member);
            await this.event(
                roomId,
                userId,
                'accept',
                { targetKind: 'person', targetId: userId },
                `disclosure v${ROOM_DISCLOSURE_VERSION}`,
                now,
            );
            return { member };
        });
        if ('refused' in outcome) {
            throw outcome.refused;
        }
        return outcome.member;
    }

    /** The invited person says no. Works whatever the switch or archive. */
    async decline(roomId: string, userId: string) {
        await this.run('decline room invite', async () => {
            const now = this.now();
            const current = await this.repos.members.get(roomId, userId);
            if (current?.status !== 'invited') {
                throw new RoomError('not_found');
            }
            await this.end(current, 'declined', userId, now);
            await this.event(roomId, userId, 'decline', { targetKind: 'person', targetId: userId }, '', now);
        });
    }

    /**
     * Whether a change leaves the room without an admin who can act: a
     * deactivated person's role counts for nothing (`handOver`).
     */
    private leavesNoAdmin(members: readonly StoredRoomMember[], change: Parameters<typeof leavesNoAdmin>[1]) {
        return leavesNoAdmin(
            members.filter((member) => member.userId === change.userId || this.options.people.active(member.userId)),
            change,
        );
    }

    /**
     * An active member leaves, at once (also while the room is archived or
     * Rooms are off). The last admin hands the role on first, archived room
     * or not: a room never ends up without an admin.
     */
    async leave(roomId: string, userId: string) {
        await this.run('leave room', async () => {
            this.require(roomId, userId, 'leave');
            const now = this.now();
            const members = await this.repos.members.list(roomId);
            if (this.leavesNoAdmin(members, { userId, status: 'left' })) {
                throw new RoomError('last_admin');
            }
            const current = members.find((member) => member.userId === userId)!;
            await this.end(current, 'left', userId, now);
            await this.event(roomId, userId, 'leave', { targetKind: 'person', targetId: userId }, '', now);
        });
        await this.streamsEnd(roomId, userId, 'left');
        await this.options.revoke?.(roomId, userId);
    }

    /**
     * A room admin removes a member, or takes back an invite. Their access
     * ends at once: their next request is refused, their running turn is
     * stopped, their queued messages and approvals are not carried on.
     */
    async remove(roomId: string, by: string, userId: string) {
        if (userId === by) {
            throw new RoomError('invalid', 'Leave the room instead.');
        }
        await this.run('remove from room', async () => {
            this.require(roomId, by, 'manage');
            const now = this.now();
            const members = await this.repos.members.list(roomId);
            const current = members.find((member) => member.userId === userId);
            if (!current || !memberTransition(current.status, 'remove')) {
                throw new RoomError('not_found');
            }
            if (this.leavesNoAdmin(members, { userId, status: 'removed' })) {
                throw new RoomError('last_admin');
            }
            await this.end(current, 'removed', by, now);
            await this.event(
                roomId,
                by,
                'remove',
                { targetKind: 'person', targetId: userId },
                current.status === 'invited' ? 'invite' : current.role,
                now,
            );
        });
        await this.streamsEnd(roomId, userId, 'removed');
        await this.options.revoke?.(roomId, userId);
    }

    /**
     * A room admin changes an active member's role: making another admin
     * hands the role on, after which they may step down. Never the last
     * admin to member.
     */
    async setRole(roomId: string, by: string, userId: string, role: RoomRole) {
        return this.run('change room role', async () => {
            this.require(roomId, by, 'manage');
            const now = this.now();
            const members = await this.repos.members.list(roomId);
            const current = members.find((member) => member.userId === userId);
            if (current?.status !== 'active') {
                throw new RoomError('not_found');
            }
            if (current.role === role) {
                return current;
            }
            if (this.leavesNoAdmin(members, { userId, role })) {
                throw new RoomError('last_admin');
            }
            const member = { ...current, role, updatedAt: now };
            await this.repos.members.save(member);
            await this.event(
                roomId,
                by,
                'role',
                { targetKind: 'person', targetId: userId },
                `${current.role} to ${role}`,
                now,
            );
            return member;
        });
    }

    private async end(
        member: StoredRoomMember,
        status: 'declined' | 'expired' | 'left' | 'removed',
        by: string,
        now: number,
    ) {
        await this.repos.members.save({
            ...member,
            status,
            endedAt: now,
            endedBy: by,
            updatedAt: now,
        });
    }

    private async expireRow(member: StoredRoomMember, now: number) {
        await this.end(member, 'expired', 'system', now);
        await this.event(member.roomId, 'system', 'expire', { targetKind: 'person', targetId: member.userId }, '', now);
    }

    /** What `handOver(userId)` would change once they are deactivated (RoomsShape). */
    async handOverPreview(userId: string): Promise<{ handedOver: number; archived: number }> {
        const rooms = (await this.repos.members.forUser(userId, ['active']))
            .filter((member) => member.role === 'admin')
            .map((member) => member.roomId);
        const preview = { handedOver: 0, archived: 0 };
        for (const roomId of new Set(rooms)) {
            const thread = this.options.workspace.thread(roomId);
            if (!thread || thread.kind !== 'room') {
                continue;
            }
            const others = (await this.repos.members.list(roomId)).filter(
                (member) =>
                    member.userId !== userId && member.status === 'active' && this.options.people.active(member.userId),
            );
            if (others.some((member) => member.role === 'admin')) {
                continue;
            }
            if (others.length) {
                preview.handedOver += 1;
            } else if (!thread.archivedAt) {
                preview.archived += 1;
            }
        }
        return preview;
    }

    /** The room events a person caused or was the target of (RoomsShape). */
    async personEvents(userId: string, before: { at: number; id: number } | undefined, limit: number) {
        const events = await this.repos.events.forPerson(userId, before, limit);
        return events.map((event) => ({
            ...event,
            roomTitle: this.options.workspace.thread(event.roomId)?.title ?? null,
        }));
    }

    /**
     * Keeps an admin in every room whose admins are all deactivated: the
     * earliest remaining active member (by when they joined) becomes one,
     * audited as the system's. With no active member left the room is
     * archived, if it wasn't, and kept. For one person's rooms (their
     * deactivation), else every room (the module's tick, which also covers
     * a deactivation made from the auth CLI). How many rooms changed.
     */
    async handOver(userId?: string): Promise<number> {
        const rooms = userId
            ? (await this.repos.members.forUser(userId, ['active']))
                  .filter((member) => member.role === 'admin')
                  .map((member) => member.roomId)
            : await this.repos.members.roomsWithActive();
        let changed = 0;
        for (const roomId of new Set(rooms)) {
            await this.run('hand room admin on', async () => {
                const thread = this.options.workspace.thread(roomId);
                if (!thread || thread.kind !== 'room') {
                    return;
                }
                const now = this.now();
                const active = (await this.repos.members.list(roomId)).filter(
                    (member) => member.status === 'active' && this.options.people.active(member.userId),
                );
                if (active.some((member) => member.role === 'admin')) {
                    return;
                }
                const next = [...active].sort(
                    (a, b) => (a.acceptedAt ?? a.invitedAt) - (b.acceptedAt ?? b.invitedAt),
                )[0];
                if (next) {
                    await this.repos.members.save({
                        ...next,
                        role: 'admin',
                        updatedAt: now,
                    });
                    await this.event(
                        roomId,
                        'system',
                        'role',
                        { targetKind: 'person', targetId: next.userId },
                        'member to admin: no active admin left',
                        now,
                    );
                    changed += 1;
                } else if (!thread.archivedAt && (await this.repos.conversations.setArchived(roomId, now, 'system'))) {
                    await this.event(
                        roomId,
                        'system',
                        'archive',
                        { targetKind: 'room', targetId: roomId },
                        'no active member left',
                        now,
                    );
                    await this.unbindSources(roomId, 'system', 'archived', now);
                    changed += 1;
                }
            });
        }
        return changed;
    }

    /** Marks the invites that ran out (the module's tick). How many. */
    async expireInvites(limit = 200): Promise<number> {
        const now = this.now();
        let count = 0;
        for (const lapsed of await this.repos.members.lapsed(now, limit)) {
            await this.run('expire room invite', async () => {
                const current = await this.repos.members.get(lapsed.roomId, lapsed.userId);
                if (current?.status !== 'invited' || inviteUsable(current, now)) {
                    return;
                }
                await this.expireRow(current, now);
                count += 1;
            });
        }
        return count;
    }

    // ---- the room -----------------------------------------------------------------

    /** A room admin renames the room (marked renamed, as an owner's rename). */
    async rename(roomId: string, by: string, title: string) {
        const trimmed = title.trim();
        if (!trimmed || trimmed.length > MAX_CHAT_TITLE) {
            throw new RoomError('invalid', `Name the room in 1 to ${MAX_CHAT_TITLE} characters.`);
        }
        await this.run('rename room', async () => {
            this.require(roomId, by, 'manage');
            if (!(await this.repos.conversations.rename(roomId, trimmed))) {
                throw new RoomError('not_found');
            }
            await this.event(
                roomId,
                by,
                'rename',
                {
                    targetKind: 'room',
                    targetId: roomId,
                },
                'title',
            );
        });
    }

    /**
     * A room admin archives the room: read-only for its members, no new
     * work, and its running turn stopped; queued messages wait unsent.
     */
    async archive(roomId: string, by: string) {
        await this.run('archive room', async () => {
            this.require(roomId, by, 'archive');
            const now = this.now();
            if (!(await this.repos.conversations.setArchived(roomId, now, by))) {
                throw new RoomError('conflict');
            }
            await this.event(roomId, by, 'archive', { targetKind: 'room', targetId: roomId }, '', now);
            await this.unbindSources(roomId, by, 'archived', now);
        });
        await this.streamsEnd(roomId, undefined, 'archived');
        await this.options.revoke?.(roomId);
    }

    /**
     * Stops the room's active source bindings (CB-214), in the unit of work
     * that archives it: its Telegram topic answers no one from now on, and
     * stays tied to the room (a room admin binds it again after
     * unarchiving, through Telegram, as the first time). Each is audited.
     */
    async unbindSources(roomId: string, by: string, detail: string, now: number) {
        for (const binding of await this.repos.sources.forRoom(roomId)) {
            if (binding.status !== 'active') {
                continue;
            }
            await this.repos.sources.disable(binding.id, now);
            await this.event(
                roomId,
                by,
                'unbind_source',
                { targetKind: 'source', targetId: binding.id },
                `telegram topic: ${detail}`,
                now,
            );
        }
    }

    /** `ended`, never failing the change that already happened. */
    private async streamsEnd(roomId: string, userId: string | undefined, reason: 'removed' | 'left' | 'archived') {
        try {
            await this.options.ended?.(roomId, userId, reason);
        } catch {
            // The streams' periodic re-check still ends them.
        }
    }

    /** A room admin brings an archived room back (Rooms on). */
    async unarchive(roomId: string, by: string) {
        await this.run('unarchive room', async () => {
            this.require(roomId, by, 'unarchive');
            if (!(await this.repos.conversations.setArchived(roomId, null, by))) {
                throw new RoomError('conflict');
            }
            await this.event(roomId, by, 'unarchive', {
                targetKind: 'room',
                targetId: roomId,
            });
        });
    }

    // ---- socios -------------------------------------------------------------------

    private eligible(dotId: string) {
        const dot = this.options.workspace.dot(dotId);
        if (!dot || !roomEligibleSocio(dot)) {
            throw new RoomError('not_eligible', 'Only active company socios can be in rooms.');
        }
        return dot;
    }

    /**
     * A room admin asks for a company socio; a workspace admin authorizes
     * it (`authorizeSocio`) before it may answer there.
     */
    async requestSocio(roomId: string, by: string, dotId: string) {
        this.eligible(dotId);
        return this.run('request room socio', async () => {
            this.require(roomId, by, 'manage');
            const now = this.now();
            const current = await this.repos.socios.get(roomId, dotId);
            if (current?.status === 'active' || current?.status === 'requested') {
                throw new RoomError('conflict', 'That socio is in the room, or asked for.');
            }
            const socio: StoredRoomSocio = {
                roomId,
                dotId,
                status: 'requested',
                requestedBy: by,
                authorizedBy: null,
                authorizedAt: null,
                endedAt: null,
                updatedAt: now,
            };
            await this.repos.socios.save(socio);
            await this.event(roomId, by, 'socio_request', { targetKind: 'socio', targetId: dotId }, '', now);
            return socio;
        });
    }

    /**
     * A workspace admin, who manages company socios, lets a requested one
     * into the room. No room access comes with it.
     */
    async authorizeSocio(roomId: string, adminId: string, dotId: string) {
        this.eligible(dotId);
        return this.run('authorize room socio', async () => {
            this.live(roomId);
            const now = this.now();
            const current = await this.repos.socios.get(roomId, dotId);
            if (current?.status !== 'requested') {
                throw new RoomError('not_found');
            }
            const socio: StoredRoomSocio = {
                ...current,
                status: 'active',
                authorizedBy: adminId,
                authorizedAt: now,
                updatedAt: now,
            };
            await this.repos.socios.save(socio);
            await this.event(roomId, adminId, 'socio_authorize', { targetKind: 'socio', targetId: dotId }, '', now);
            return socio;
        });
    }

    /**
     * The socio's owner (a workspace admin, for a company socio) takes it
     * out of the room, the lead too: it no longer answers there, and its
     * running turn stops. Works whatever the switch or archive.
     */
    async withdrawSocio(roomId: string, adminId: string, dotId: string) {
        let lead = false;
        await this.run('withdraw room socio', async () => {
            const thread = this.options.workspace.thread(roomId);
            if (!thread || thread.kind !== 'room') {
                throw new RoomError('not_found');
            }
            const now = this.now();
            const current = await this.repos.socios.get(roomId, dotId);
            if (current?.status !== 'active' && current?.status !== 'requested') {
                throw new RoomError('not_found');
            }
            lead = thread.dotId === dotId;
            await this.repos.socios.save({
                ...current,
                status: 'withdrawn',
                endedAt: now,
                updatedAt: now,
            });
            await this.event(
                roomId,
                adminId,
                'socio_withdraw',
                { targetKind: 'socio', targetId: dotId },
                'by its owner',
                now,
            );
        });
        if (lead) {
            await this.options.revoke?.(roomId);
        }
    }

    /** A room admin takes a socio out (not the lead: choose another first). */
    async removeSocio(roomId: string, by: string, dotId: string) {
        await this.run('remove room socio', async () => {
            const thread = this.require(roomId, by, 'manage');
            if (thread.dotId === dotId) {
                throw new RoomError('conflict', 'Choose another lead socio before taking this one out.');
            }
            const now = this.now();
            const current = await this.repos.socios.get(roomId, dotId);
            if (current?.status !== 'active' && current?.status !== 'requested') {
                throw new RoomError('not_found');
            }
            await this.repos.socios.save({
                ...current,
                status: 'removed',
                endedAt: now,
                updatedAt: now,
            });
            await this.event(
                roomId,
                by,
                'socio_withdraw',
                { targetKind: 'socio', targetId: dotId },
                'by a room admin',
                now,
            );
        });
    }

    /** A room admin makes an active room socio the lead. */
    async setLead(roomId: string, by: string, dotId: string) {
        this.eligible(dotId);
        await this.run('set room lead', async () => {
            this.require(roomId, by, 'manage');
            const socio = await this.repos.socios.get(roomId, dotId);
            if (socio?.status !== 'active') {
                throw new RoomError('not_eligible', 'Only a socio in the room can lead it.');
            }
            if (!(await this.repos.conversations.setLead(roomId, dotId))) {
                throw new RoomError('not_found');
            }
            await this.event(roomId, by, 'lead', {
                targetKind: 'socio',
                targetId: dotId,
            });
        });
    }

    /** Socios rooms asked for, for workspace admins to authorize. */
    async socioRequests(): Promise<RoomSocioRequest[]> {
        const out: RoomSocioRequest[] = [];
        for (const socio of await this.repos.socios.withStatus('requested')) {
            const room = await this.repos.conversations.get(socio.roomId);
            if (room?.kind !== 'room') {
                continue;
            }
            out.push({
                roomId: room.id,
                roomTitle: room.title,
                dotId: socio.dotId,
                dotName: this.options.workspace.dot(socio.dotId)?.name ?? 'A socio',
                requestedBy: socio.requestedBy,
                requestedByName: this.name(socio.requestedBy),
                requestedAt: socio.updatedAt,
            });
        }
        return out;
    }

    // ---- queue --------------------------------------------------------------------

    /**
     * A room admin cancels someone else's queued message (CB-215): checked
     * as `manage` (the admin role, Rooms on, the room live),
     * removed by `cancel` (the queue's own, atomic: once a turn took it,
     * there is nothing left to cancel), and audited with whose it was, never
     * its text. Whose it was, or undefined when it had gone. An admin can
     * stop others' work, never rewrite what they wrote.
     */
    async cancelQueued(
        roomId: string,
        by: string,
        cancel: () => Promise<string | undefined>,
    ): Promise<string | undefined> {
        return this.run('cancel queued message', async () => {
            this.require(roomId, by, 'manage');
            const author = await cancel();
            if (author) {
                await this.event(roomId, by, 'queue_cancel', {
                    targetKind: 'person',
                    targetId: author,
                });
            }
            return author;
        });
    }

    // ---- limits -------------------------------------------------------------------

    /**
     * Whether `by`, an active member, sees the room's use and limits
     * (CB-218): its admins always; members when Settings → Rooms says so.
     */
    private async usageVisible(roomId: string, by: string) {
        if (this.options.usage?.visible()) {
            return true;
        }
        return (await this.repos.members.get(roomId, by))?.role === 'admin';
    }

    /**
     * The room's limits, for its admins, and its members when they may see
     * them (CB-218; `usage_hidden` otherwise).
     */
    limits(roomId: string, by: string): Promise<RoomLimitsView> {
        return this.audited(() => this.limitsOf(roomId, by));
    }
    private async limitsOf(roomId: string, by: string): Promise<RoomLimitsView> {
        this.require(roomId, by, 'read');
        if (!(await this.usageVisible(roomId, by))) {
            throw new RoomError('usage_hidden');
        }
        const workspace = this.options.limits.workspace();
        const room = (await this.repos.settings.get(roomId))?.limits ?? {};
        return { workspace, room, effective: effectiveRoomLimits(workspace, room) };
    }

    /**
     * How many times one message's work may pass between the room's socios,
     * for every active member: a rule of the room, not its budget, so never
     * `usage_hidden` (the Members panel says it to all).
     */
    handoffLimit(roomId: string, by: string): Promise<RoomHandoffLimitView> {
        return this.audited(async () => {
            this.require(roomId, by, 'read');
            const workspace = this.options.limits.workspace();
            const room = (await this.repos.settings.get(roomId))?.limits ?? {};
            return {
                workspace: workspace.handoffsPerCycle,
                room: room.handoffsPerCycle ?? null,
                effective: effectiveRoomLimits(workspace, room).handoffsPerCycle,
            };
        });
    }

    /**
     * The room's use (CB-218): its limits in force, its running or last
     * work cycle and its last day's cycles in total, for its admins, and its
     * members when they may see it (`usage_hidden` otherwise). Read from
     * the cycles' ledger, not the analytics store, so it answers whatever
     * Operations' state.
     */
    usage(roomId: string, by: string): Promise<RoomUsageView> {
        return this.audited(async () => {
            this.require(roomId, by, 'read');
            if (!this.options.usage || !(await this.usageVisible(roomId, by))) {
                throw new RoomError('usage_hidden');
            }
            const now = this.now();
            const workspace = this.options.limits.workspace();
            const room = (await this.repos.settings.get(roomId))?.limits ?? {};
            const { current, recent } = await this.options.usage.cycles(roomId, now - 86_400_000);
            return roomUsage({
                limits: effectiveRoomLimits(workspace, room),
                current,
                recent,
                viewer: by,
                now,
            });
        });
    }

    /**
     * A room admin lowers the room's limits: a value above
     * the workspace's is refused, naming it; the whole set is saved.
     */
    async setLimits(roomId: string, by: string, limits: Partial<RoomLimits>) {
        await this.run('save room limits', async () => {
            // The caller's access before what they ask for (CB-213).
            this.require(roomId, by, 'manage');
            const checked = this.options.limits.check(limits);
            if (!checked.ok) {
                throw new RoomError(
                    'raised',
                    `A room’s limits can only be lower than the workspace’s: ${checked.raised.join(', ')}.`,
                    checked.raised,
                );
            }
            const now = this.now();
            const prior = await this.repos.settings.get(roomId);
            await this.repos.settings.save({
                roomId,
                limits,
                updatedBy: by,
                updatedAt: now,
                description: prior?.description ?? null,
            });
            await this.event(
                roomId,
                by,
                'limits',
                { targetKind: 'room', targetId: roomId },
                Object.keys(limits).sort().join(', '),
                now,
            );
        });
        return this.limits(roomId, by);
    }

    // ---- work cycles ----------------------------------------------------------------

    /**
     * What the work cycles (CB-211) ask of a room as each step starts and
     * as queued messages are claimed: its lower limits, the sender's
     * membership, the socio's place and the switch.
     */
    cycleHooks(): CycleRoomHooks {
        return {
            limits: async (roomId) => (await this.repos.settings.get(roomId))?.limits ?? {},
            member: async (roomId, userId) => {
                const member = await this.repos.members.get(roomId, userId);
                return member && { role: member.role, status: member.status };
            },
            socio: async (roomId, dotId) => (await this.repos.socios.get(roomId, dotId))?.status,
            enabled: () => this.options.enabled(),
        };
    }
}
