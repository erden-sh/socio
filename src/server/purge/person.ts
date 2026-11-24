// Operators' "Remove permanently" (CB-360): the purge of one person, from
// the web, with the planner, backup, checks and audit `pnpm run purge`
// uses (run.ts). It works on a connection of its own to the app's
// database, as the CLI would beside the running server.
//
// It never cascades: a person who still owns anything a transfer moves
// (apps, schedules, personal socios, a Space only they edit, their data
// space, conversations, memories) is refused until an admin transfers it
// (`POST /api/accounts/:id/transfer`). Without that, their data space,
// goals and memories would go with them unlisted (`owns` rows), and the
// planner would refuse on their socios, apps, datasets, jobs, schedules and
// conversations anyway (it leaves those rows to this refusal, so the dry
// run lists them once, by the kind a transfer moves them with). Refusing
// names each kind, so nothing the company owns is removed by accident;
// what does go is theirs alone (sign-in, preferences, notices,
// memberships) and history stays.
import { DatabaseSync } from 'node:sqlite';

import { applyConnectionPragmas } from '@socio/data/sqlite-pragmas';
import type { AssetKind } from '@socio/shared/auth';

import type { PersonPurge } from '../auth/contract.js';

import { OWNERSHIP } from './ownership.js';
import type { PurgeOptions, PurgePlan } from './purge.js';
import { REFERENCES } from './references.js';
import { applyPlannedPurge, cleanUp, planOnce, type PurgeStore } from './run.js';
import { planComputers, type PurgeSupervisor } from './supervisor.js';

export interface PersonPurgeSettings {
    /** The app's database file (`DATABASE_PATH`). */
    database: string;
    /** USER_DATA_DIR and the storage tenant, as the data space uses them. */
    userDataDir: string;
    tenantId: string;
    /** BACKUP_DIR, as the CLI reads it. */
    backupDir: string;
    /** The object store, when files are in S3. */
    store?: PurgeStore;
    /** The computer supervisor, read when a purge is planned (it refuses a half-set configuration). */
    supervisor?: () => PurgeSupervisor | undefined;
    /** What the person still owns, by kind (a Space counts only where they are its only editor). */
    owned(userId: string): Partial<Record<AssetKind, number>>;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/**
 * The columns naming a person that the planner would refuse on and a
 * transfer moves (`tasks.userId` blocks, `dots.ownerId` is a child...), by
 * the kind a transfer moves them with. Where `owned` names that kind, its
 * one line is the refusal: the planner doesn't list their rows again.
 */
const TRANSFERRED = new Map(
    REFERENCES.filter((ref) => (ref.how === 'blocks' || ref.how === 'child') && ['users', 'owners'].includes(ref.ids))
        .map((ref) => `${ref.table}.${ref.column}`)
        .flatMap((column) => {
            const decision = OWNERSHIP[column];
            return decision?.as === 'transferred' ? [[column, decision.kind] as const] : [];
        }),
);

export function personPurge(settings: PersonPurgeSettings): PersonPurge {
    const options = (owned: ReadonlySet<AssetKind>): PurgeOptions => ({
        userDataDir: settings.userDataDir,
        tenantId: settings.tenantId,
        ownedElsewhere: new Set([...TRANSFERRED].filter(([, kind]) => owned.has(kind)).map(([column]) => column)),
    });
    const open = () => {
        const db = new DatabaseSync(settings.database);
        applyConnectionPragmas(db, {});
        return db;
    };
    const plan = async (db: DatabaseSync, userId: string) => {
        const list = { users: [userId] };
        const owned = Object.entries(settings.owned(userId)).filter(([, n]) => n) as [AssetKind, number][];
        const purgeOptions = options(new Set(owned.map(([kind]) => kind)));
        const planned: PurgePlan = planOnce(db, list, purgeOptions);
        if (owned.length) {
            planned.refusals.unshift(
                `They still own ${owned.map(([kind, n]) => `${kind} ${n}`).join(', ')}: transfer it to someone first.`,
            );
        }
        let supervisor: PurgeSupervisor | undefined;
        try {
            supervisor = settings.supervisor?.();
        } catch (error) {
            planned.refusals.push(error instanceof Error ? error.message : String(error));
        }
        const computers = await planComputers(supervisor, planned.targets.socios);
        if (computers.refusal) {
            planned.refusals.push(computers.refusal);
        }
        return { list, planned, computers, supervisor, purgeOptions };
    };
    return {
        async plan(userId) {
            const db = open();
            try {
                const { planned } = await plan(db, userId);
                return {
                    refusals: planned.refusals,
                    targets: Object.fromEntries(
                        Object.entries(planned.targets).map(([kind, ids]) => [kind, ids.length]),
                    ),
                    tables: planned.tables,
                    kept: planned.kept,
                    files: { count: planned.files.length, bytes: sum(planned.files.map((file) => file.bytes)) },
                    objects: {
                        count: planned.objects.length,
                        bytes: sum(planned.objects.map((object) => object.bytes)),
                    },
                };
            } finally {
                db.close();
            }
        },
        async apply(userId, actor, confirmed) {
            const db = open();
            try {
                const { list, planned, computers, supervisor, purgeOptions } = await plan(db, userId);
                if (planned.refusals.length) {
                    throw new Error(planned.refusals.join(' '));
                }
                const { deleted, backupRoot, manifest } = await applyPlannedPurge({
                    db,
                    database: settings.database,
                    list,
                    options: purgeOptions,
                    plan: planned,
                    computers: computers.destroy,
                    store: settings.store,
                    backupDir: settings.backupDir,
                    actor,
                    // Under the write lock: still deactivated, under the name the operator typed.
                    check: (locked) => {
                        const row = locked
                            .prepare('SELECT name, banned FROM auth_user WHERE appUserId=?')
                            .get(userId) as { name: string; banned: number | null } | undefined;
                        if (!row || !row.banned || row.name !== confirmed.name) {
                            throw new Error(
                                'They are no longer deactivated under the name you confirmed: nothing was removed.',
                            );
                        }
                    },
                });
                const cleanup = await cleanUp(manifest, settings.store, supervisor).then(
                    (done) => ({ files: done.files, bytes: done.bytes, objects: done.objects }),
                    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
                );
                return { rows: sum(deleted.map((entry) => entry.rows)), tables: deleted, backup: backupRoot, cleanup };
            } finally {
                db.close();
            }
        },
    };
}
