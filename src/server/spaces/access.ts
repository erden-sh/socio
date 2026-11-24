import { compareText } from '@socio/shared/locale';
import { isAdmin } from '@socio/shared/roles';
import {
    spaceAccessLevel,
    type SpaceAccessLevel,
    type SpacePeopleView,
    type SpaceRole,
} from '@socio/shared/space-memory';
import type { Space, User } from '@socio/shared/types';

import {
    SPACE_NOT_FOUND,
    SpaceAccessError,
    type SpaceAccessRepository,
    type SpaceAccessShape,
    type SpaceReader,
} from './contract.js';

export interface SpaceAccessOptions {
    repository: SpaceAccessRepository;
    /** Whether a socio has the Space (`dot_spaces`): a socio reads only those. */
    socioHas?: (dotId: string, spaceId: string) => boolean;
    /**
     * Whether every live runtime keeps private Spaces private (the
     * `space-privacy` contract, CB-108): a Space is made private only then.
     */
    privacyEnforced?: () => boolean;
    /**
     * Whether every live runtime answers a deleted Space as missing on
     * every read path (the `space-delete` contract, CB-277): a Space is
     * deleted only then.
     */
    deleteEnforced?: () => boolean;

    /** The workspace's people, deactivated ones too. */
    users: () => User[];
    isDeactivated: (userId: string) => boolean;
    /** The live Spaces. */
    spaces: () => Space[];
    /**
     * A Space's people or access changed (CB-181): what holds access opened
     * before (an app's open WebSockets) is checked again.
     */
    changed?: (spaceId: string) => void;
    /** A change of people or access, for the workspace audit: ids, never content. */
    audit?: (entry: {
        actor: string;
        action: 'create' | 'update' | 'remove';
        targetId: string;
        detail: string;
    }) => void;
}

const NOT_FOUND = SPACE_NOT_FOUND;

/**
 * Space access (CB-181): the one place that answers who reads a Space,
 * everything in it (its pages and their revisions, page chats, page
 * search, apps and datasets shared with it, its files and its memory),
 * and who edits it: `spaceAccessLevel` with the rows loaded, asked afresh
 * every time. `reads` is the one read check, for a person and for a
 * socio (the Space granted to it, and every person reading its chat able
 * to read it); `readable` lists what a reader may see. A Space someone
 * may not read is answered as one that doesn't exist (`require`, 404).
 * Its reads are synchronous (docs/MEMORY.md "Space access").
 */
export class SpaceAccess implements SpaceAccessShape {
    constructor(private options: SpaceAccessOptions) {}

    /** The platform's `space-privacy` contract check (`privacyEnforced`). */
    usePrivacyContract(enforced: () => boolean) {
        this.options.privacyEnforced = enforced;
    }

    /** The platform's `space-delete` contract check (`deleteEnforced`). */
    useDeleteContract(enforced: () => boolean) {
        this.options.deleteEnforced = enforced;
    }

    private space(spaceId: string) {
        return this.options.spaces().find((space) => space.id === spaceId);
    }

    /** The person's level in the Space, or null when they can't read it. */
    level(
        spaceId: string,
        userId: string,
        // Loaded once by a caller that asks for many.
        loaded?: { users: User[]; spaces: Space[] },
    ): SpaceAccessLevel | null {
        const user = (loaded?.users ?? this.options.users()).find((entry) => entry.id === userId);
        const space = loaded ? loaded.spaces.find((entry) => entry.id === spaceId) : this.space(spaceId);
        return spaceAccessLevel({
            person: user && {
                role: user.role,
                deactivated: this.options.isDeactivated(userId),
            },
            space: space && {
                membersOnly: this.options.repository.membersOnly(spaceId),
            },
            member: space ? this.options.repository.member(spaceId, userId) : undefined,
        });
    }

    /** `reads` for a person: the one read check. */
    canRead(spaceId: string, userId: string) {
        return this.reads(spaceId, { userId });
    }

    canEdit(spaceId: string, userId: string) {
        return this.level(spaceId, userId) === 'editor';
    }

    /**
     * The one read check: whether `reader` may read the Space and anything
     * in it now. A person by the rule; a socio only in a Space granted to
     * it that every person reading its chat may read (none for no one), or,
     * where they can't all be named, a Space open to the whole workspace.
     */
    reads(spaceId: string, reader: SpaceReader, loaded?: { users: User[]; spaces: Space[] }): boolean {
        if ('userId' in reader) {
            return this.level(spaceId, reader.userId, loaded) !== null;
        }
        if (!(this.options.socioHas?.(reader.dotId, spaceId) ?? false)) {
            return false;
        }
        if (reader.people === null) {
            const spaces = loaded?.spaces ?? this.options.spaces();
            return spaces.some((space) => space.id === spaceId) && !this.options.repository.membersOnly(spaceId);
        }
        if (!reader.people.length) {
            return false;
        }
        const all = loaded ?? {
            users: this.options.users(),
            spaces: this.options.spaces(),
        };
        return reader.people.every((userId) => this.reads(spaceId, { userId }, all));
    }

    /**
     * What a list of Spaces is decided from, read once (CB-374): the people,
     * the live Spaces and which of them are members-only. `levels` then
     * answers for a person from one more read, their memberships, instead
     * of `level`'s reads once per Space.
     */
    private snapshot() {
        const levels = new Map<string, Map<string, SpaceAccessLevel>>();
        const snapshot = {
            users: this.options.users(),
            spaces: this.options.spaces(),
            membersOnly: this.options.repository.membersOnlyIds(),
            /** The person's level in each live Space they may read: the one rule, as `level`. */
            levels: (userId: string) => {
                let found = levels.get(userId);
                if (!found) {
                    found = this.levelsOf(userId, snapshot);
                    levels.set(userId, found);
                }
                return found;
            },
        };
        return snapshot;
    }

    private levelsOf(userId: string, loaded: { users: User[]; spaces: Space[]; membersOnly: Set<string> }) {
        const user = loaded.users.find((entry) => entry.id === userId);
        const levels = new Map<string, SpaceAccessLevel>();
        if (!user) {
            return levels;
        }
        const person = { role: user.role, deactivated: this.options.isDeactivated(userId) };
        const rows = new Map(this.options.repository.memberships(userId).map((row) => [row.spaceId, row]));
        for (const space of loaded.spaces) {
            const level = spaceAccessLevel({
                person,
                space: { membersOnly: loaded.membersOnly.has(space.id) },
                member: rows.get(space.id),
            });
            if (level) {
                levels.set(space.id, level);
            }
        }
        return levels;
    }

    /** The live Spaces `reader` may read, in the workspace's order. */
    readable(reader: SpaceReader): Space[] {
        const snapshot = this.snapshot();
        if ('userId' in reader) {
            const levels = snapshot.levels(reader.userId);
            return snapshot.spaces.filter((space) => levels.has(space.id));
        }
        // A socio: `reads`' rule, over the one snapshot.
        const { people } = reader;
        return snapshot.spaces.filter((space) => {
            if (!(this.options.socioHas?.(reader.dotId, space.id) ?? false)) {
                return false;
            }
            if (people === null) {
                return !snapshot.membersOnly.has(space.id);
            }
            return people.length > 0 && people.every((userId) => snapshot.levels(userId).has(space.id));
        });
    }

    /** The ids of `readable`, for filtering many rows. */
    readableIds(reader: SpaceReader): Set<string> {
        return new Set(this.readable(reader).map((space) => space.id));
    }

    /**
     * The Spaces `userId` may read, each with whether it is private and
     * their level: the sidebar's and every Space list's.
     */
    spacesFor(userId: string): Space[] {
        const snapshot = this.snapshot();
        const levels = snapshot.levels(userId);
        return snapshot.spaces.flatMap((space) => {
            const access = levels.get(space.id);
            return access
                ? [
                      {
                          ...space,
                          private: snapshot.membersOnly.has(space.id),
                          access,
                      },
                  ]
                : [];
        });
    }

    /**
     * Of `spaceIds`, the Spaces every one of `userIds` can read now; none
     * for no one. The rule for a chat with other people in it: what one
     * of them may not read reaches none of them.
     */
    readableByAll(spaceIds: readonly string[], userIds: readonly string[]) {
        if (!userIds.length) {
            return [];
        }
        const snapshot = this.snapshot();
        return spaceIds.filter((spaceId) => userIds.every((userId) => snapshot.levels(userId).has(spaceId)));
    }

    /** The level, or a refusal that never says a hidden Space is there. */
    require(spaceId: string, userId: string, needs: SpaceAccessLevel = 'reader'): SpaceAccessLevel {
        // For a person, `reads` is `level` not null: one check, not two.
        const level = this.level(spaceId, userId);
        if (!level) {
            throw new SpaceAccessError(NOT_FOUND, 404);
        }
        if (needs === 'editor' && level !== 'editor') {
            throw new SpaceAccessError('Only this Space’s editors can do that.', 403);
        }
        return level;
    }

    /** `GET /api/spaces/:id/people`. */
    people(spaceId: string, viewer: string): SpacePeopleView {
        const access = this.require(spaceId, viewer);
        const users = this.options.users();
        const name = (id: string) => users.find((user) => user.id === id)?.name ?? 'Former member';
        const people = this.options.repository
            .members(spaceId)
            .map((member) => ({ ...member, name: name(member.userId) }));
        return {
            spaceId,
            membersOnly: this.options.repository.membersOnly(spaceId),
            people,
            access,
            candidates:
                access === 'editor'
                    ? users
                          .filter(
                              (user) =>
                                  !this.options.isDeactivated(user.id) &&
                                  !people.some((person) => person.userId === user.id),
                          )
                          .map(({ id, name }) => ({ id, name }))
                          .sort((a, b) => compareText(a.name, b.name))
                    : [],
        };
    }

    /** Adds a person to the Space, or changes their role (editors). */
    async setRole(spaceId: string, by: string, userId: string, role: SpaceRole) {
        this.require(spaceId, by, 'editor');
        const user = this.options.users().find((entry) => entry.id === userId);
        if (!user || this.options.isDeactivated(userId)) {
            throw new SpaceAccessError('That person is not in the workspace.', 400);
        }
        const before = this.options.repository.member(spaceId, userId);
        await this.options.repository.setMember({
            spaceId,
            userId,
            role,
            addedBy: by,
        });
        if (before?.role !== role) {
            this.options.changed?.(spaceId);
        }
        if (before?.role !== role) {
            this.options.audit?.({
                actor: by,
                action: before ? 'update' : 'create',
                targetId: `${spaceId}:${userId}`,
                detail: before ? `role ${before.role} -> ${role}` : `role ${role}`,
            });
        }
    }

    /**
     * Removes a person from the Space (editors): from now on they read its
     * memory only if it is open to the workspace, and approve nothing.
     */
    async remove(spaceId: string, by: string, userId: string) {
        this.require(spaceId, by, 'editor');
        const removed = await this.options.repository.removeMember(spaceId, userId);
        if (!removed) {
            throw new SpaceAccessError('That person is not in this Space.', 404);
        }
        this.options.changed?.(spaceId);
        this.options.audit?.({
            actor: by,
            action: 'remove',
            targetId: `${spaceId}:${userId}`,
            detail: 'removed',
        });
    }

    /**
     * Makes the Space private to its people (any editor), or opens it to the
     * whole workspace (workspace admins only: an open Space is everyone's,
     * as the Spaces admins make are). A Space is made private only once
     * every live runtime keeps private Spaces private (`privacyEnforced`):
     * during a deploy the release before this one would still show it.
     */
    async setMembersOnly(spaceId: string, by: string, membersOnly: boolean) {
        this.require(spaceId, by, 'editor');
        if (this.options.repository.membersOnly(spaceId) === membersOnly) {
            return;
        }
        if (!membersOnly && !this.isAdmin(by)) {
            throw new SpaceAccessError('Only workspace admins open a Space to the whole workspace.', 403);
        }
        if (membersOnly) {
            this.requirePrivacyEnforced();
        }
        await this.options.repository.setMembersOnly(spaceId, membersOnly, by);
        this.options.changed?.(spaceId);
        this.options.audit?.({
            actor: by,
            action: 'update',
            targetId: spaceId,
            detail: membersOnly ? 'members only' : 'open to the workspace',
        });
    }

    /** Refuses (409) while a live runtime would still show a private Space. */
    requirePrivacyEnforced() {
        if (!(this.options.privacyEnforced?.() ?? true)) {
            throw new SpaceAccessError(
                'Socio is being updated: try making the Space private again in a few minutes.',
                409,
            );
        }
    }

    /**
     * Whether `by` may delete the Space (CB-277), or the refusal: a private
     * Space by its editors, one for the whole workspace by workspace admins
     * only (admins edit every Space). Someone who can't read it gets the
     * 404 of one that isn't there. Refused (409) while a live runtime would
     * still show it once deleted (`deleteEnforced`), as `setMembersOnly`.
     */
    requireDeletable(spaceId: string, by: string) {
        this.require(spaceId, by, 'editor');
        if (!this.options.repository.membersOnly(spaceId) && !this.isAdmin(by)) {
            throw new SpaceAccessError('Only workspace admins delete a Space for the whole workspace.', 403);
        }
        if (!(this.options.deleteEnforced?.() ?? true)) {
            throw new SpaceAccessError('Socio is being updated: try deleting the Space again in a few minutes.', 409);
        }
    }

    /** Whether the Space is private to its people (`space_settings`). */
    membersOnly(spaceId: string) {
        return this.options.repository.membersOnly(spaceId);
    }

    /** The person's row in the Space, if they have one (CB-360's person page). */
    memberRole(spaceId: string, userId: string) {
        return this.options.repository.member(spaceId, userId)?.role;
    }

    private isAdmin(userId: string) {
        const user = this.options.users().find((entry) => entry.id === userId);
        return !!user && !this.options.isDeactivated(userId) && isAdmin({ role: user.role });
    }

    /**
     * A new Space's access (`POST /api/spaces`): private ones get their
     * creator as editor (unless a workspace admin, an editor of every Space
     * already) and the people chosen, open ones nothing. Who may create
     * which is the route's: a workspace admin either, anyone else a private
     * one.
     */
    async created(
        spaceId: string,
        by: string,
        options: {
            private: boolean;
            people?: ReadonlyArray<{ userId: string; role: SpaceRole }>;
        },
    ) {
        if (!options.private) {
            return;
        }
        await this.options.repository.setMembersOnly(spaceId, true, by);
        this.options.audit?.({
            actor: by,
            action: 'create',
            targetId: spaceId,
            detail: 'members only',
        });
        const people = new Map<string, SpaceRole>();
        if (!this.isAdmin(by)) {
            people.set(by, 'editor');
        }
        for (const person of options.people ?? []) {
            if (person.userId !== by || !people.has(by)) {
                people.set(person.userId, person.role);
            }
        }
        for (const [userId, role] of people) {
            const user = this.options.users().find((entry) => entry.id === userId);
            if (!user || this.options.isDeactivated(userId)) {
                continue;
            }
            await this.options.repository.setMember({
                spaceId,
                userId,
                role,
                addedBy: by,
            });
            this.options.audit?.({
                actor: by,
                action: 'create',
                targetId: `${spaceId}:${userId}`,
                detail: `role ${role}`,
            });
        }
    }
}
