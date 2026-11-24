import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { byDot, LIVE, live, unstamped } from '@socio/data/soft-delete';
import type { DataContext } from '@socio/data/uow';
import { isAdmin } from '@socio/shared/roles';
import type { SpaceAccessLevel, SpaceRole } from '@socio/shared/space-memory';
import { SPACE_NAME_ERROR, spaceNameInput } from '@socio/shared/spaces/create-input';
import type { DeletedSpace, Space } from '@socio/shared/types';

import type { AccessChanges } from './access-changes.js';
import type {
    AuditShape,
    SociosShape,
    PeopleShape,
    SpaceCreateInput,
    SpacesShape,
    SpaceWithStamps,
} from './contract.js';
import type { SqliteSocios } from './socios.js';

/**
 * What the Spaces slice asks of the one Space access rule (`SpaceAccess`,
 * spaces/access.ts, CB-181), which the workspace builds over this slice and
 * hands in.
 */
export interface SpaceRule {
    /** The platform's `space-privacy` contract check; throws 409 when it isn't kept. */
    requirePrivacyEnforced(): void;
    /** A new Space's people and privacy, inside the unit that made it. */
    created(
        spaceId: string,
        by: string,
        options: { private: boolean; people?: ReadonlyArray<{ userId: string; role: SpaceRole }> },
    ): Promise<unknown>;
    /** Throws unless `by` may delete the Space now. */
    requireDeletable(spaceId: string, by: string): void;
    /** The level, or a refusal (404 for a Space `userId` can't read, 403 below `needs`). */
    require(spaceId: string, userId: string, needs?: SpaceAccessLevel): SpaceAccessLevel;
    membersOnly(spaceId: string): boolean;
    canRead(spaceId: string, userId: string): boolean;
    canEdit(spaceId: string, userId: string): boolean;
}

/**
 * The `Spaces` slice: the workspace's Spaces, on its
 * connection. Moved from `WorkspaceStore` as it was. The access rule, the
 * people, the audit and the socios come in prepared; the socios lazily,
 * since a socio's grants name live Spaces in turn.
 */
export class SqliteSpaces implements SpacesShape {
    private spaceListeners = new Set<(spaceId: string) => void>();
    constructor(
        private db: DatabaseSync,
        private deps: {
            uow: DataContext['uow'];
            spaceAccess: SpaceRule;
            people: Pick<PeopleShape, 'users'>;
            audit: Pick<AuditShape, 'audit'>;
            socios: () => Pick<SociosShape, 'dots' | 'canUseDot'> & Pick<SqliteSocios, 'auditDot'>;
            changes: AccessChanges;
            /** The access rule's error (`SpaceAccessError`), with its status. */
            error: (message: string, status: 400 | 404 | 409) => Error;
        },
    ) {}
    /**
     * Called after a Space's people or access change (CB-181; platform.ts:
     * apps shared with it close their open connections, which reopen
     * through the access check).
     */
    onSpaceAccessChange(listener: (spaceId: string) => void) {
        this.spaceListeners.add(listener);
        return () => void this.spaceListeners.delete(listener);
    }
    spaces(): Space[] {
        return this.db
            .prepare(`SELECT * FROM spaces WHERE ${LIVE} ORDER BY createdAt`)
            .all()
            .map(unstamped) as unknown as Space[];
    }
    /**
     * A new Space and its access, in one unit of work (CB-181): a private
     * one never shows, not even for a moment, to people outside it. Who may
     * make which is `createSpaceAs` (spaces/create.ts). `grantTo`: the socio
     * that made it for `by` (CB-271), given the Space in the same unit; it
     * reads it only as `SpaceAccess.reads` allows, like any grant.
     */
    async createSpaceFor(by: string, input: SpaceCreateInput): Promise<Space> {
        if (input.private) {
            this.deps.spaceAccess.requirePrivacyEnforced();
        }
        const space = await this.deps.uow.run(
            async () => {
                const space = this.createSpace(input.name, input.description);
                await this.deps.spaceAccess.created(space.id, by, input);
                if (input.grantTo) {
                    this.db.prepare('INSERT OR IGNORE INTO dot_spaces VALUES (?, ?)').run(input.grantTo, space.id);
                    this.deps.socios().auditDot(input.grantTo, by, 'update', 'Space access');
                }
                return space;
            },
            { label: 'create space' },
        );
        if (input.grantTo) {
            this.deps.changes.emit({ socioId: input.grantTo });
        }
        return space;
    }
    /**
     * Renames a Space (CB-366): its editors may, as they manage its people
     * and who sees it (`SpaceAccess.require`, editor; workspace admins edit
     * every Space); someone who can't read it gets the 404 of one not
     * there. The name follows the create rule (`spaceNameInput`). Only the
     * name changes: the id, which every link to the Space and its pages
     * names, stays, with everything in it. Audited as an update, ids only.
     */
    async renameSpace(
        spaceId: string,
        by: string,
        name: string,
        { dotId, now = Date.now(), guard }: { dotId?: string; now?: number; guard?: (name: string) => void } = {},
    ): Promise<Space> {
        this.deps.spaceAccess.require(spaceId, by, 'editor');
        const parsed = spaceNameInput.safeParse(name);
        if (!parsed.success) {
            throw this.deps.error(SPACE_NAME_ERROR, 400);
        }
        // Checked again under the write lock: a rename queued behind a change
        // of its people (an editor removed, a grant rolled back) answers to
        // what that change left, not to what was there before it.
        return transaction(this.db, 'rename space', () => {
            this.deps.spaceAccess.require(spaceId, by, 'editor');
            guard?.(parsed.data);
            const before = this.spaces().find((space) => space.id === spaceId);
            if (!before) {
                throw this.deps.error('Space not found.', 404);
            }
            if (before.name === parsed.data) {
                return before;
            }
            const changed = this.db
                .prepare(`UPDATE spaces SET name=? WHERE id=? AND ${LIVE}`)
                .run(parsed.data, spaceId).changes;
            if (!changed) {
                throw this.deps.error('Space not found.', 404);
            }
            this.deps.audit.audit(
                {
                    actor: dotId ? byDot(dotId) : by,
                    action: 'update',
                    targetKind: 'space',
                    targetId: spaceId,
                    detail: dotId ? `renamed for ${by}` : 'renamed',
                },
                now,
            );
            return { ...before, name: parsed.data };
        });
    }
    /**
     * Deletes a Space (CB-277), soft: the row is stamped and everything in
     * it is kept as it is (pages, chats, memory, its people, socio grants,
     * shares). Every reader takes Spaces from `spaces()`, which leaves it
     * out, so `SpaceAccess.reads` and `Pages.requireSpace` answer it as one
     * that isn't there, on every path at once. Who may is
     * `SpaceAccess.requireDeletable`; the workspace keeps at least one
     * Space, and none a socio saves new pages to by default.
     */
    async deleteSpace(spaceId: string, by: string, now = Date.now()) {
        const allowed = () => {
            this.deps.spaceAccess.requireDeletable(spaceId, by);
            const blocked = this.spaceDeleteBlocker(spaceId, by);
            if (blocked) {
                throw this.deps.error(blocked, 409);
            }
        };
        allowed();
        // Checked again under the write lock: a delete queued behind a change
        // of its people (an editor removed, a grant rolled back) answers to
        // what that change left, not to what was there before it (as rename).
        await transaction(this.db, 'delete space', () => {
            allowed();
            const membersOnly = this.deps.spaceAccess.membersOnly(spaceId);
            const pages = Number(
                this.db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE spaceId=? AND ${LIVE}`).get(spaceId)?.n ?? 0,
            );
            const changed = this.db
                .prepare(`UPDATE spaces SET deletedAt=?, deletedBy=? WHERE id=? AND ${LIVE}`)
                .run(now, by, spaceId).changes;
            if (!changed) {
                throw this.deps.error('Space not found.', 404);
            }
            this.deps.audit.audit(
                {
                    actor: by,
                    action: 'delete',
                    targetKind: 'space',
                    targetId: spaceId,
                    detail: `${membersOnly ? 'private' : 'whole workspace'}; ${pages} ${pages === 1 ? 'page' : 'pages'}`,
                },
                now,
            );
        });
        this.spaceChanged(spaceId);
    }
    /**
     * Why a Space its editor may delete can't be now (CB-277): it is the
     * workspace's only one, or a socio saves new pages to it by default.
     * The socios are named to an admin, and to anyone else those they use.
     */
    spaceDeleteBlocker(spaceId: string, by: string): string | undefined {
        if (this.spaces().length <= 1) {
            return 'This is the workspace’s only Space. Make another one before deleting it.';
        }
        const dots = this.deps.socios();
        const socios = dots.dots().filter((dot) => dot.spaceId === spaceId);
        if (!socios.length) {
            return undefined;
        }
        const admin = isAdmin(this.deps.people.users().find((user) => user.id === by));
        const named = socios.filter((dot) => admin || dots.canUseDot(by, dot.id)).map((dot) => dot.name);
        const others = socios.length - named.length;
        const who = [...named, ...(others ? [`${others} other ${others === 1 ? 'socio' : 'socios'}`] : [])].join(', ');
        return `${socios.length === 1 ? 'A socio saves' : 'Socios save'} new pages to this Space by default (${who}). Choose another default Space in ${socios.length === 1 ? 'its' : 'their'} settings first.`;
    }
    /**
     * Brings a deleted Space back (CB-277, workspace admins): everything in
     * it reads again as before, for the people who could read it. A private
     * one only while every live runtime keeps private Spaces private.
     */
    async restoreSpace(spaceId: string, by: string, now = Date.now()) {
        const deleted = this.withDeletedSpace(spaceId);
        if (!deleted?.deletedAt) {
            throw this.deps.error('Space not found.', 404);
        }
        if (this.deps.spaceAccess.membersOnly(spaceId)) {
            this.deps.spaceAccess.requirePrivacyEnforced();
        }
        await transaction(this.db, 'restore space', () => {
            this.db
                .prepare('UPDATE spaces SET deletedAt=NULL, deletedBy=NULL WHERE id=? AND deletedAt IS NOT NULL')
                .run(spaceId);
            this.deps.audit.audit(
                {
                    actor: by,
                    action: 'restore',
                    targetKind: 'space',
                    targetId: spaceId,
                    detail: `deleted by ${deleted.deletedBy ?? 'unknown'}`,
                },
                now,
            );
        });
        this.spaceChanged(spaceId);
        return this.spaces().find((space) => space.id === spaceId)!;
    }
    /** A Space, deleted or not, with its stamps (admins' view, tests). */
    withDeletedSpace(spaceId: string): SpaceWithStamps | undefined {
        const row = this.db.prepare('SELECT * FROM spaces WHERE id=?').get(spaceId);
        return row
            ? ({
                  ...row,
                  deletedAt: row.deletedAt === null ? null : Number(row.deletedAt),
                  deletedBy: row.deletedBy === null ? null : String(row.deletedBy),
              } as unknown as SpaceWithStamps)
            : undefined;
    }
    /** The deleted Spaces, newest delete first (Settings → Deleted Spaces). */
    deletedSpaces(): DeletedSpace[] {
        const users = this.deps.people.users();
        return this.db
            .prepare(
                `SELECT s.id, s.name, s.description, s.createdAt, s.deletedAt, s.deletedBy,
           (SELECT COUNT(*) FROM pages p WHERE p.spaceId = s.id AND ${live('p')}) AS pages
         FROM spaces s WHERE s.deletedAt IS NOT NULL ORDER BY s.deletedAt DESC, s.id`,
            )
            .all()
            .map((row) => {
                const deletedBy = row.deletedBy === null ? null : String(row.deletedBy);
                return {
                    id: String(row.id),
                    name: String(row.name),
                    description: String(row.description ?? ''),
                    createdAt: Number(row.createdAt),
                    deletedAt: Number(row.deletedAt),
                    deletedBy,
                    deletedByName: users.find((user) => user.id === deletedBy)?.name ?? null,
                    private: this.deps.spaceAccess.membersOnly(String(row.id)),
                    pages: Number(row.pages),
                };
            });
    }
    /**
     * Tells the Space's listeners its access changed (`onSpaceAccessChange`).
     * Not part of the slice: the access rule calls it after a change.
     */
    spaceChanged(spaceId: string) {
        for (const listener of this.spaceListeners) {
            try {
                listener(spaceId);
            } catch {
                // A listener's failure never undoes the change it hears about.
            }
        }
    }
    createSpace(name: string, description: string): Space {
        const space = {
            id: randomUUID(),
            name,
            description,
            createdAt: Date.now(),
        };
        this.db
            .prepare('INSERT INTO spaces (id, name, description, createdAt) VALUES (?, ?, ?, ?)')
            .run(space.id, name, description, space.createdAt);
        return space;
    }
    /**
     * Whether a person may read a Space, and everything in it, now (CB-181:
     * `SpaceAccess.reads`, the one rule).
     */
    readsSpace(userId: string, spaceId: string) {
        return this.deps.spaceAccess.canRead(spaceId, userId);
    }
    /** Whether a person may edit a Space now (`SpaceAccess.canEdit`). */
    editsSpace(userId: string, spaceId: string) {
        return this.deps.spaceAccess.canEdit(spaceId, userId);
    }
}
