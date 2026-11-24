import type { DatabaseSync } from 'node:sqlite';

import { writeSoon } from '@socio/data/open';
import type { DataTokenScope } from '@socio/foundation/http/app-env';

/**
 * Data tokens every runtime on the database accepts (CB-108), in
 * `runtime_data_tokens` (runtime/ownership.ts makes it and prunes a dead
 * issuer's rows): by SHA-256 hash only, never the token itself. Writes run
 * at once when the connection is free, else queue behind the open unit of
 * work (`writeSoon`), so the synchronous `DataTokens` calls never fail
 * because one is open.
 */
export class SqliteDataTokenStore {
    constructor(private db: DatabaseSync) {}

    /**
     * Writes the token's row when the connection allows; `claim` says
     * whether it is still wanted then (it was not revoked while queued).
     */
    insert(hash: string, issuer: string, scope: DataTokenScope, claim: () => boolean) {
        writeSoon(this.db, 'issue data token', () => {
            if (!claim()) {
                return;
            }
            this.db
                .prepare(
                    'INSERT INTO runtime_data_tokens(hash, issuer, session, dotId, purpose, scope, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
                )
                .run(hash, issuer, scope.session, scope.dotId, scope.purpose, JSON.stringify(scope), scope.expiresAt);
        });
    }

    /** The token's scope and issuer, unexpired; the caller checks the issuer. */
    get(hash: string, now: number) {
        if (!this.db.isOpen) {
            return undefined;
        }
        const row = this.db
            .prepare('SELECT issuer, scope FROM runtime_data_tokens WHERE hash=? AND expiresAt>?')
            .get(hash, now) as { issuer: string; scope: string } | undefined;
        return row ? { issuer: row.issuer, scope: JSON.parse(row.scope) as DataTokenScope } : undefined;
    }

    /** `done` runs once the row is gone (or the connection closed). */
    deleteHash(hash: string, done: () => void) {
        this.delete('revoke data token', 'hash=?', [hash], done);
    }

    deleteSession(session: string, done: () => void) {
        this.delete('revoke data token session', 'session=?', [session], done);
    }

    deleteDot(dotId: string, purposes: readonly DataTokenScope['purpose'][] | undefined, done: () => void) {
        if (purposes && !purposes.length) {
            return done();
        }
        this.delete(
            'revoke data tokens of a socio',
            purposes ? `dotId=? AND purpose IN (${purposes.map(() => '?').join(', ')})` : 'dotId=?',
            [dotId, ...(purposes ?? [])],
            done,
        );
    }

    /** Unexpired tokens per issuer; the caller counts the live issuers'. */
    unexpiredByIssuer(now: number) {
        if (!this.db.isOpen) {
            return [];
        }
        return this.db
            .prepare('SELECT issuer, COUNT(*) AS n FROM runtime_data_tokens WHERE expiresAt>? GROUP BY issuer')
            .all(now)
            .map((row) => ({ issuer: String(row.issuer), count: Number(row.n) }));
    }

    private delete(label: string, where: string, values: string[], done: () => void) {
        // A closed connection: the process is ending, and its tokens with it.
        if (!this.db.isOpen) {
            return done();
        }
        writeSoon(this.db, label, () => {
            this.db.prepare(`DELETE FROM runtime_data_tokens WHERE ${where}`).run(...values);
            done();
        });
    }
}
