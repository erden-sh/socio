import type { DatabaseSync } from 'node:sqlite';

import { transactionSync } from '@socio/data/open';
import { nonPersonOwnerId } from '@socio/shared/data-types';
import { mergeOnboarding } from '@socio/shared/onboarding';
import { reservedOwnerId } from '@socio/shared/rooms/rooms';
import type { User } from '@socio/shared/types';
import { compareVersions, type ReleaseView } from '@socio/shared/updates/release-seen';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@socio/shared/voice/dictation';

import type { AccessChanges } from './access-changes.js';
import type { PeopleShape } from './contract.js';

/**
 * The `People` slice: the people who use the workspace (`users`), their
 * preferences and the releases they have seen, on the workspace's connection.
 * Moved from `WorkspaceStore` as it was.
 */
export class SqlitePeople implements PeopleShape {
    /** The auth provider's deactivated people (`useDeactivated`); none until set. */
    private deactivatedIds: () => readonly string[] = () => [];
    constructor(
        private db: DatabaseSync,
        private changes: AccessChanges,
    ) {}
    /** Records a user seen through the auth provider, which owns name and role. */
    recordUser(user: User) {
        // A socio's shared area owns data as `socio:<id>` (CB-224), a service
        // plugin as `plugin:<id>`; a room and a Telegram team topic are owned
        // by `room:<id>` and `telegram-team:<id>` (CB-207), which no person
        // may ever be.
        if (nonPersonOwnerId(user.id) || reservedOwnerId(user.id)) {
            throw new Error('User ids may not start with "socio:", "plugin:", "room:" or "telegram-team:".');
        }
        const now = Date.now();
        const before = this.changes.listened
            ? (this.db.prepare('SELECT role FROM users WHERE id=?').get(user.id) as { role: string } | undefined)
            : undefined;
        this.db
            .prepare(
                'INSERT INTO users (id, name, role, createdAt, lastSeenAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, role=excluded.role, lastSeenAt=excluded.lastSeenAt',
            )
            .run(user.id, user.name, user.role, now, now);
        if (before && before.role !== user.role) {
            this.changes.emit({ personId: user.id });
        }
    }
    /**
     * Everyone who has used the workspace, deactivated people included:
     * content keeps their name.
     */
    users(): User[] {
        return this.db.prepare('SELECT id, name, role FROM users ORDER BY createdAt, id').all() as unknown as User[];
    }
    /**
     * Who is deactivated, as the auth provider says (createApp wires it):
     * the users table keeps them, so names stay, and this keeps new work
     * from them (issue assignments, job runs).
     */
    useDeactivated(ids: () => readonly string[]) {
        this.deactivatedIds = ids;
    }
    /** App user ids of deactivated people (`useDeactivated`). */
    deactivatedUsers(): Set<string> {
        return new Set(this.deactivatedIds());
    }
    isDeactivated(userId: string) {
        return this.deactivatedIds().includes(userId);
    }
    /**
     * Moves single-owner data (from before user accounts) to a real user.
     * Idempotent: once moved, nothing references the legacy owner id.
     */
    migrateLegacyOwner(legacyOwnerId: string, userId: string): number {
        if (legacyOwnerId === userId) {
            return 0;
        }
        this.db.prepare('UPDATE page_threads SET userId=? WHERE userId=?').run(userId, legacyOwnerId);
        return Number(
            this.db.prepare('UPDATE thread_bindings SET ownerId=? WHERE ownerId=?').run(userId, legacyOwnerId).changes,
        );
    }
    /** Fails loudly while another context's unit of work is open (CB-110). */
    private inTransaction(fn: () => void) {
        transactionSync(this.db, 'socio change', fn);
    }
    /** The person's own preferences, with defaults for what they never set. */
    preferences(userId: string): UserPreferences {
        const row = this.db.prepare('SELECT value FROM user_preferences WHERE userId=?').get(userId) as
            | { value: string }
            | undefined;
        return { ...DEFAULT_PREFERENCES, ...(row ? JSON.parse(row.value) : {}) };
    }
    /** Saves the preferences given over the stored ones; returns them all. */
    setPreferences(userId: string, patch: Partial<UserPreferences>): UserPreferences {
        const current = this.preferences(userId);
        const next = {
            ...current,
            ...patch,
            ...(patch.onboarding ? { onboarding: mergeOnboarding(current.onboarding, patch.onboarding) } : {}),
        };
        this.db
            .prepare(
                'INSERT INTO user_preferences VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt',
            )
            .run(userId, JSON.stringify(next), Date.now());
        return next;
    }
    /** The newest release the person has seen in What's new (CB-166). */
    lastSeenRelease(userId: string): string | null {
        const row = this.db.prepare('SELECT version FROM release_seen WHERE userId=?').get(userId) as
            | { version: string }
            | undefined;
        return row?.version ?? null;
    }
    /**
     * Records that the person has seen `version` (a release version), unless
     * they had already seen a newer one; returns what is kept.
     */
    markReleaseSeen(userId: string, version: string): string {
        // Read and write in one transaction: another process can't move it
        // in between, and back.
        let kept = version;
        this.inTransaction(() => {
            const before = this.lastSeenRelease(userId);
            if (before && compareVersions(version, before) <= 0) {
                kept = before;
                return;
            }
            this.db
                .prepare(
                    'INSERT INTO release_seen VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET version=excluded.version, seenAt=excluded.seenAt',
                )
                .run(userId, version, Date.now());
        });
        return kept;
    }
    /**
     * Records that the person was shown these releases' cards (CB-166), the
     * first time only: showing one again keeps its first time.
     */
    recordReleaseViews(userId: string, versions: readonly string[], now = Date.now()) {
        const insert = this.db.prepare(
            'INSERT INTO release_views (userId, version, firstSeenAt) VALUES (?, ?, ?) ON CONFLICT(userId, version) DO NOTHING',
        );
        this.inTransaction(() => {
            for (const version of versions) {
                insert.run(userId, version, now);
            }
        });
    }
    /** The releases the person was shown, newest release first (CB-166). */
    releaseViews(userId: string): ReleaseView[] {
        const rows = this.db
            .prepare('SELECT version, firstSeenAt FROM release_views WHERE userId=?')
            .all(userId) as unknown as ReleaseView[];
        return rows
            .map(({ version, firstSeenAt }) => ({ version, firstSeenAt }))
            .sort((a, b) => compareVersions(b.version, a.version));
    }
    /** Whether anyone with this id has used the workspace. */
    hasUser(userId: string) {
        return !!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(userId);
    }
}
