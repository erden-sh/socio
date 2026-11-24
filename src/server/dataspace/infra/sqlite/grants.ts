import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';

import type { DataGrant, GrantRepository, MovedGrant } from '../../domain/repositories.js';

import { SqliteRepository, startsWith } from './base.js';
import { dataGrants } from './schema.js';

/** Hard deletes name the table (tests/hard-deletes.test.ts). */
const g = dataGrants;

/** A user's folder grants on `folder` and its subfolders. */
const foldersUnder = (ownerUserId: string, folder: string) =>
    and(eq(g.ownerUserId, ownerUserId), isNotNull(g.folder), startsWith(g.folder, folder));

/** Grant rows with a folder: what the folder filters return. */
type FolderGrant = DataGrant & { folder: string };

/** Dots' grants on their users' datasets and folders. */
export class SqliteGrants extends SqliteRepository implements GrantRepository {
    setNow(grant: DataGrant) {
        // The target as the unique index `data_grants_target` names it.
        const existing = this.db
            .select({ id: g.id })
            .from(g)
            .where(
                and(
                    eq(g.ownerUserId, grant.ownerUserId),
                    eq(g.dotId, grant.dotId),
                    sql`coalesce(${g.datasetId}, '') = ${grant.datasetId ?? ''}`,
                    sql`coalesce(${g.folder}, '') = ${grant.folder ?? ''}`,
                ),
            )
            .get();
        if (existing) {
            this.db
                .update(g)
                .set({ access: grant.access, createdBy: grant.createdBy })
                .where(eq(g.id, existing.id))
                .run();
            return existing.id;
        }
        this.db.insert(g).values(grant).run();
        return grant.id;
    }

    removeForDatasetNow(datasetId: string): DataGrant[] {
        const ending = this.db.select().from(g).where(eq(g.datasetId, datasetId)).all();
        this.db.delete(dataGrants).where(eq(g.datasetId, datasetId)).run();
        return ending;
    }

    moveDatasetOwnerNow(datasetId: string, to: string) {
        this.db.update(g).set({ ownerUserId: to }).where(eq(g.datasetId, datasetId)).run();
    }

    removeForDotNow(dotId: string) {
        const owners = this.db.selectDistinct({ ownerUserId: g.ownerUserId }).from(g).where(eq(g.dotId, dotId)).all();
        this.db.delete(dataGrants).where(eq(g.dotId, dotId)).run();
        return owners.map((row) => row.ownerUserId);
    }

    remove(ownerUserId: string, id: string) {
        return this.write('revoke grant', async () => {
            const grant = await this.db
                .select()
                .from(g)
                .where(and(eq(g.id, id), eq(g.ownerUserId, ownerUserId)))
                .get();
            if (grant) {
                await this.db.delete(dataGrants).where(eq(g.id, id));
            }
            return grant;
        });
    }

    moveFolders(ownerUserId: string, from: string, to: string) {
        return this.write('move folder grants', async () => {
            const moving = (
                (await this.db
                    .select()
                    .from(g)
                    .where(foldersUnder(ownerUserId, from))
                    .orderBy(asc(g.folder))) as FolderGrant[]
            ).map((grant): MovedGrant => ({
                ...grant,
                to: `${to}${grant.folder.slice(from.length)}`,
            }));
            // Out of the way first: a target can be another moving grant's path.
            for (const grant of moving) {
                await this.db.delete(dataGrants).where(eq(g.id, grant.id));
            }
            for (const grant of moving) {
                const there = await this.db
                    .select({ access: g.access })
                    .from(g)
                    .where(and(eq(g.ownerUserId, ownerUserId), eq(g.dotId, grant.dotId), eq(g.folder, grant.to)))
                    .get();
                if (there) {
                    grant.mergedInto = there.access;
                    continue;
                }
                await this.db.insert(g).values({
                    id: grant.id,
                    ownerUserId,
                    dotId: grant.dotId,
                    datasetId: null,
                    folder: grant.to,
                    access: grant.access,
                    createdBy: grant.createdBy,
                    createdAt: grant.createdAt,
                });
            }
            return moving;
        });
    }

    removeUnder(ownerUserId: string, folder: string) {
        return this.write('end folder grants', async () => {
            const ending = (await this.db
                .select()
                .from(g)
                .where(foldersUnder(ownerUserId, folder))
                .orderBy(asc(g.folder))) as FolderGrant[];
            if (ending.length) {
                await this.db.delete(dataGrants).where(foldersUnder(ownerUserId, folder));
            }
            return ending;
        });
    }
}
