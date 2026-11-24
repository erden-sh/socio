import { and, asc, count, eq, sql } from 'drizzle-orm';

import type { BackendPatch, InferenceBackendRepository, StoredBackend } from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { inferenceBackends } from './schema.js';

/** The operator's shared backends, keys sealed. */
export class SqliteInferenceBackends extends SqliteRepository implements InferenceBackendRepository {
    /** Turns read the default backend, and setup and the picker all of them: prepared once. */
    private statements = (() => {
        const db = this.data.uow.executor();
        return {
            all: db
                .select()
                .from(inferenceBackends)
                .orderBy(asc(inferenceBackends.createdAt), asc(inferenceBackends.id))
                .prepare(),
            any: db.select({ n: count() }).from(inferenceBackends).prepare(),
            byId: db
                .select()
                .from(inferenceBackends)
                .where(eq(inferenceBackends.id, sql.placeholder('id')))
                .prepare(),
        };
    })();

    async all(): Promise<StoredBackend[]> {
        this.data.uow.executor();
        return this.statements.all.all();
    }

    async any() {
        this.data.uow.executor();
        return ((await this.statements.any.get())?.n ?? 0) > 0;
    }

    async byId(id: string): Promise<StoredBackend | undefined> {
        this.data.uow.executor();
        return this.statements.byId.get({ id });
    }

    insert(backend: StoredBackend) {
        return this.write('add inference backend', async () => {
            await this.db.insert(inferenceBackends).values(backend);
        });
    }

    update(id: string, patch: BackendPatch) {
        return this.write('change inference backend', async () => {
            const set = Object.fromEntries(
                Object.entries(patch).filter(([, value]) => value !== undefined),
            ) as BackendPatch;
            if (!Object.keys(set).length) {
                return !!(await this.byId(id));
            }
            const changed = await this.db
                .update(inferenceBackends)
                .set(set)
                .where(eq(inferenceBackends.id, id))
                .returning({ id: inferenceBackends.id });
            return changed.length > 0;
        });
    }

    remove(id: string) {
        return this.write('remove inference backend', async () => {
            const removed = await this.db
                .delete(inferenceBackends)
                .where(eq(inferenceBackends.id, id))
                .returning({ id: inferenceBackends.id });
            return removed.length > 0;
        });
    }

    replaceSecrets(id: string, current: string, next: string) {
        return this.write('re-seal inference backend', async () => {
            const changed = await this.db
                .update(inferenceBackends)
                .set({ secrets: next })
                .where(and(eq(inferenceBackends.id, id), eq(inferenceBackends.secrets, current)))
                .returning({ id: inferenceBackends.id });
            return changed.length > 0;
        });
    }
}
