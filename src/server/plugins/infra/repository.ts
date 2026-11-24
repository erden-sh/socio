import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { eq, lt } from 'drizzle-orm';

import { transaction, type SqliteData } from '@socio/data/open';

import { pluginAccessGeneration, pluginCodes, pluginInstalls, pluginSessions } from './schema.js';

export const pluginHash = (value: string) => createHash('sha256').update(value).digest('hex');

type InstallInsert = typeof pluginInstalls.$inferInsert;
type CodeRow = typeof pluginCodes.$inferSelect;
type SessionRow = typeof pluginSessions.$inferSelect;

/** Writes for plugin installs, one-time codes and sessions. */
export class SqlitePlugins {
    constructor(private data: SqliteData) {}

    private get db() {
        return this.data.uow.executor();
    }

    private write<T>(label: string, work: () => Promise<T>) {
        return this.data.uow.run(work, { label });
    }

    list() {
        return this.db.select().from(pluginInstalls).all();
    }

    get(id: string) {
        return this.db.select().from(pluginInstalls).where(eq(pluginInstalls.id, id)).get();
    }

    insert(row: InstallInsert) {
        return this.write('install plugin', async () => {
            await this.db.insert(pluginInstalls).values(row);
        });
    }

    update(
        id: string,
        patch: Partial<
            Pick<
                InstallInsert,
                | 'enabled'
                | 'config'
                | 'replicas'
                | 'audience'
                | 'updatedAt'
                | 'version'
                | 'display'
                | 'permissions'
                | 'manifest'
            >
        >,
    ) {
        return this.write('update plugin', async () => {
            await this.db.update(pluginInstalls).set(patch).where(eq(pluginInstalls.id, id));
        });
    }

    delete(id: string) {
        return this.write('uninstall plugin', async () => {
            await this.db.delete(pluginCodes).where(eq(pluginCodes.pluginId, id));
            await this.db.delete(pluginSessions).where(eq(pluginSessions.pluginId, id));
            await this.db.delete(pluginInstalls).where(eq(pluginInstalls.id, id));
        });
    }

    putCode(row: typeof pluginCodes.$inferInsert) {
        return this.write('plugin launch code', async () => {
            await this.db.delete(pluginCodes).where(lt(pluginCodes.expiresAt, Date.now()));
            await this.db.insert(pluginCodes).values(row);
        });
    }

    /**
     * One transaction: the code is deleted, and a session is inserted only
     * when `accept` still says this person may sign in. The session is
     * stamped with that person's current access generation.
     */
    redeemSession(input: {
        codeHash: string;
        pluginId: string;
        now: number;
        accept: (row: CodeRow) => boolean;
        session: { hash: string; createdAt: number; expiresAt: number };
    }): Promise<{ next: string } | undefined> {
        return this.write('redeem plugin code', async () => {
            const row = await this.db.select().from(pluginCodes).where(eq(pluginCodes.hash, input.codeHash)).get();
            if (!row) {
                return undefined;
            }
            const ok = row.pluginId === input.pluginId && row.expiresAt > input.now && input.accept(row);
            await this.db.delete(pluginCodes).where(eq(pluginCodes.hash, input.codeHash));
            if (!ok) {
                return undefined;
            }
            const current = await this.db
                .select()
                .from(pluginAccessGeneration)
                .where(eq(pluginAccessGeneration.userId, row.userId))
                .get();
            await this.db.delete(pluginSessions).where(lt(pluginSessions.expiresAt, input.now));
            await this.db.insert(pluginSessions).values({
                hash: input.session.hash,
                pluginId: input.pluginId,
                userId: row.userId,
                createdAt: input.session.createdAt,
                expiresAt: input.session.expiresAt,
                generation: current?.generation ?? 0,
            });
            return { next: row.next };
        });
    }

    /** The session and the person's current generation, read together. */
    sessionState(hash: string): Promise<{ row: SessionRow; generation: number } | undefined> {
        return this.write('read plugin session', async () => {
            const row = await this.db.select().from(pluginSessions).where(eq(pluginSessions.hash, hash)).get();
            if (!row) {
                return undefined;
            }
            const current = await this.db
                .select()
                .from(pluginAccessGeneration)
                .where(eq(pluginAccessGeneration.userId, row.userId))
                .get();
            return { row, generation: current?.generation ?? 0 };
        });
    }

    deleteSession(hash: string) {
        return this.write('end plugin session', async () => {
            await this.db.delete(pluginSessions).where(eq(pluginSessions.hash, hash));
        });
    }
}

/**
 * Deletes a person's plugin sessions and unused launch codes. The database
 * part of deactivation and demotion (accounts.ts, the auth CLI). Returns
 * how many rows ended.
 */
/** How many plugin sessions and launch codes `deletePluginAccessOf` would delete. */
export function countPluginAccessOf(db: DatabaseSync, userId: string) {
    const count = (sql: string) => Number((db.prepare(sql).get(userId) as { n: number }).n);
    return (
        count('SELECT COUNT(*) AS n FROM plugin_sessions WHERE userId=?') +
        count('SELECT COUNT(*) AS n FROM plugin_codes WHERE userId=?')
    );
}

/**
 * Adopts a new manifest for an install in one transaction (CB-370): the
 * settings kept are the ones in the row now, filtered by `keepConfig`, so a
 * settings change another runtime made meanwhile stays. Answers the config
 * written, or undefined when the install is gone.
 */
export function adoptPluginManifest(
    db: DatabaseSync,
    id: string,
    patch: { version: string; display: string; permissions: string[]; manifest: unknown; updatedAt: number },
    keepConfig: (config: Record<string, string>) => Record<string, string>,
    /**
     * Whether the stored manifest (as stored, JSON) may be replaced, given the
     * stored settings; otherwise `'changed'` and nothing is written.
     */
    over: (stored: string, config: Record<string, string>) => boolean = () => true,
) {
    return transaction(db, 'update plugin from catalog', (): Record<string, string> | 'changed' | undefined => {
        const row = db.prepare('SELECT config, manifest FROM plugin_installs WHERE id=?').get(id) as
            | { config: string; manifest: string }
            | undefined;
        if (!row) {
            return undefined;
        }
        let current: Record<string, string> = {};
        try {
            current = JSON.parse(row.config || '{}') as Record<string, string>;
        } catch {
            current = {};
        }
        if (!over(row.manifest, current)) {
            return 'changed';
        }
        const config = keepConfig(current);
        db.prepare(
            'UPDATE plugin_installs SET version=?, display=?, permissions=?, manifest=?, config=?, updatedAt=? WHERE id=?',
        ).run(
            patch.version,
            patch.display,
            JSON.stringify(patch.permissions),
            JSON.stringify(patch.manifest),
            JSON.stringify(config),
            patch.updatedAt,
            id,
        );
        return config;
    });
}

/**
 * Moves an install's service image to the same digest at another location
 * (a registry move the catalog made), in one transaction: only while the row
 * still runs `from`, so an update another runtime committed meanwhile stays.
 * Nothing else in the row changes. Answers whether it was written.
 */
export function relocatePluginImage(db: DatabaseSync, id: string, from: string, to: string, updatedAt: number) {
    return transaction(db, 'move plugin image', () => {
        const row = db.prepare('SELECT manifest FROM plugin_installs WHERE id=?').get(id) as
            | { manifest: string }
            | undefined;
        if (!row) {
            return false;
        }
        let manifest: { service?: { image?: unknown } };
        try {
            manifest = JSON.parse(row.manifest) as typeof manifest;
        } catch {
            return false;
        }
        if (!manifest.service || manifest.service.image !== from) {
            return false;
        }
        manifest.service.image = to;
        db.prepare('UPDATE plugin_installs SET manifest=?, updatedAt=? WHERE id=?').run(
            JSON.stringify(manifest),
            updatedAt,
            id,
        );
        return true;
    });
}

/**
 * Saves an install's settings in one transaction (CB-370), keeping only
 * those the manifest in the row now declares: an update another runtime
 * committed while this save provisioned, which dropped a setting, isn't
 * undone. Answers the config written, or undefined when the install is gone.
 */
export function savePluginConfig(db: DatabaseSync, id: string, config: Record<string, string>, updatedAt: number) {
    return transaction(db, 'save plugin settings', () => {
        const row = db.prepare('SELECT manifest FROM plugin_installs WHERE id=?').get(id) as
            | { manifest: string }
            | undefined;
        if (!row) {
            return undefined;
        }
        let fields: Record<string, unknown> = {};
        try {
            fields = (JSON.parse(row.manifest) as { config?: Record<string, unknown> }).config ?? {};
        } catch {
            fields = {};
        }
        const kept = Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(fields, key)));
        db.prepare('UPDATE plugin_installs SET config=?, updatedAt=? WHERE id=?').run(
            JSON.stringify(kept),
            updatedAt,
            id,
        );
        return kept;
    });
}

export function deletePluginAccessOf(db: DatabaseSync, userId: string) {
    return transaction(db, 'revoke plugin access', () => {
        db.prepare(
            `INSERT INTO plugin_access_generation(userId, generation) VALUES (?, 1)
       ON CONFLICT(userId) DO UPDATE SET generation = generation + 1`,
        ).run(userId);
        const sessions = Number(db.prepare('DELETE FROM plugin_sessions WHERE userId=?').run(userId).changes);
        const codes = Number(db.prepare('DELETE FROM plugin_codes WHERE userId=?').run(userId).changes);
        return sessions + codes;
    });
}
