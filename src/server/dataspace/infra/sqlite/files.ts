import { and, asc, eq, isNull } from 'drizzle-orm';

import type { StorageDriver } from '@socio/data/object-store';

import type { DataFile, DeletedStamp, FileContent, FileRepository } from '../../contract.js';

import { SqliteRepository, startsWith } from './base.js';
import { dataFiles as f } from './schema.js';

const live = isNull(f.deletedAt);

/** File metadata, hidden and kept once deleted (CB-64). */
export class SqliteFiles extends SqliteRepository implements FileRepository {
    async at(ownerUserId: string, path: string): Promise<DataFile | undefined> {
        return this.db
            .select()
            .from(f)
            .where(and(eq(f.ownerUserId, ownerUserId), eq(f.path, path), live))
            .get();
    }

    async byId(id: string): Promise<DataFile | undefined> {
        return this.db
            .select()
            .from(f)
            .where(and(eq(f.id, id), live))
            .get();
    }

    async withDeleted(id: string): Promise<DataFile | undefined> {
        return this.db.select().from(f).where(eq(f.id, id)).get();
    }

    async under(ownerUserId: string, folder: string) {
        return this.db
            .select({ id: f.id, path: f.path })
            .from(f)
            .where(and(eq(f.ownerUserId, ownerUserId), startsWith(f.path, folder), live))
            .orderBy(asc(f.path));
    }

    insert(file: DataFile) {
        return this.write('add file', async () => {
            await this.db.insert(f).values(file);
        });
    }

    replaceContent(id: string, content: FileContent, name: string | null, at: number) {
        return this.write('replace file', async () => {
            await this.db
                .update(f)
                .set({ ...content, updatedAt: at, ...(name === null ? {} : { name }) })
                .where(eq(f.id, id));
        });
    }

    retype(id: string, mediaType: string, name: string | null, at: number) {
        return this.write('retype file', async () => {
            await this.db
                .update(f)
                .set({ mediaType, updatedAt: at, ...(name === null ? {} : { name }) })
                .where(eq(f.id, id));
        });
    }

    move(id: string, path: string, at: number, dropName: boolean) {
        return this.write('move file', async () => {
            await this.db
                .update(f)
                .set({ path, updatedAt: at, ...(dropName ? { name: null } : {}) })
                .where(eq(f.id, id));
        });
    }

    moveLive(moves: ReadonlyArray<{ id: string; path: string }>, at: number) {
        return this.write('move files', async () => {
            for (const { id, path } of moves) {
                await this.db
                    .update(f)
                    .set({ path, updatedAt: at })
                    .where(and(eq(f.id, id), live));
            }
        });
    }

    markDeleted(id: string, stamp: DeletedStamp) {
        return this.write('delete file', async () => {
            await this.db
                .update(f)
                .set({
                    deletedAt: stamp.at,
                    deletedBy: stamp.by,
                    deletedWith: stamp.with,
                })
                .where(and(eq(f.id, id), live));
        });
    }

    markMoved(id: string, to: StorageDriver) {
        return this.write('move file to storage', async () => {
            await this.db
                .update(f)
                .set({ storage: to })
                .where(and(eq(f.id, id), eq(f.storage, 'local')));
        });
    }

    recordSeal(id: string, sealKey: string, storedSize: number) {
        return this.write('reseal file', async () => {
            await this.db.update(f).set({ sealKey, storedSize }).where(eq(f.id, id));
        });
    }
}
