import type { DatabaseSync } from 'node:sqlite';

export type IdentityState = 'current' | 'previous' | 'retired';

export interface IdentityRow {
    pluginId: string;
    version: number;
    state: IdentityState;
    retireAt: number | null;
}

/**
 * `plugin_identities` (plugins migration 4): each plugin's identity token
 * versions, by hash. The writes run inside the caller's `transaction()`
 * (`PluginIdentities`, identity.ts); rows are never deleted.
 */
export class SqlitePluginIdentities {
    constructor(private db: DatabaseSync) {}

    exists() {
        return !!this.db
            .prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='plugin_identities'")
            .get();
    }

    // ---- reads -----------------------------------------------------------
    current(pluginId: string): number | undefined {
        const row = this.db
            .prepare("SELECT version FROM plugin_identities WHERE pluginId=? AND state='current'")
            .get(pluginId) as { version: number } | undefined;
        return row?.version;
    }
    currentIssue(pluginId: string): { version: number; issuedAt: number } | undefined {
        const row = this.db
            .prepare("SELECT version, createdAt FROM plugin_identities WHERE pluginId=? AND state='current'")
            .get(pluginId) as { version: number; createdAt: number } | undefined;
        return row ? { version: Number(row.version), issuedAt: Number(row.createdAt) } : undefined;
    }
    topVersion(pluginId: string): number {
        const row = this.db
            .prepare('SELECT max(version) AS v FROM plugin_identities WHERE pluginId=?')
            .get(pluginId) as {
            v: number | null;
        };
        return row.v ?? 0;
    }
    stateOf(pluginId: string, version: number): IdentityState | undefined {
        const row = this.db
            .prepare('SELECT state FROM plugin_identities WHERE pluginId=? AND version=?')
            .get(pluginId, version) as { state: IdentityState } | undefined;
        return row?.state;
    }
    /** One version's state and when it retires (a previous one's window). */
    versionOf(pluginId: string, version: number): { state: IdentityState; retireAt: number | null } | undefined {
        return this.db
            .prepare('SELECT state, retireAt FROM plugin_identities WHERE pluginId=? AND version=?')
            .get(pluginId, version) as { state: IdentityState; retireAt: number | null } | undefined;
    }
    latestPrevious(pluginId: string): number | undefined {
        const row = this.db
            .prepare(
                "SELECT version FROM plugin_identities WHERE pluginId=? AND state='previous' ORDER BY version DESC LIMIT 1",
            )
            .get(pluginId) as { version: number } | undefined;
        return row?.version;
    }
    byHash(hash: string): IdentityRow | undefined {
        const row = this.db
            .prepare('SELECT pluginId, version, state, retireAt FROM plugin_identities WHERE hash=?')
            .get(hash) as IdentityRow | undefined;
        return row ? { ...row } : undefined;
    }

    // ---- writes (inside `transaction()`) ----------------------------------
    /** A rotation: any `previous` retires, `current` becomes `previous` until `retireAt`, the new one is current. */
    rotate(pluginId: string, version: number, hash: string, now: number, retireAt: number) {
        this.db
            .prepare("UPDATE plugin_identities SET state='retired', retireAt=? WHERE pluginId=? AND state='previous'")
            .run(now, pluginId);
        this.db
            .prepare("UPDATE plugin_identities SET state='previous', retireAt=? WHERE pluginId=? AND state='current'")
            .run(retireAt, pluginId);
        this.db
            .prepare(
                "INSERT INTO plugin_identities(pluginId, version, hash, state, createdAt, retireAt) VALUES(?,?,?,'current',?,NULL)",
            )
            .run(pluginId, version, hash, now);
    }
    retire(pluginId: string, version: number, now: number) {
        this.db
            .prepare("UPDATE plugin_identities SET state='retired', retireAt=? WHERE pluginId=? AND version=?")
            .run(now, pluginId, version);
    }
    promote(pluginId: string, version: number) {
        this.db
            .prepare("UPDATE plugin_identities SET state='current', retireAt=NULL WHERE pluginId=? AND version=?")
            .run(pluginId, version);
    }
    retireAll(pluginId: string, now: number) {
        this.db
            .prepare("UPDATE plugin_identities SET state='retired', retireAt=? WHERE pluginId=? AND state<>'retired'")
            .run(now, pluginId);
    }
}
