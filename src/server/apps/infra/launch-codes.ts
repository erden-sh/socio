import type { DatabaseSync } from 'node:sqlite';

import { transactionSync, writeSoon } from '@socio/data/open';

/** What a launch code opens: one app, for one person, at one path. */
export interface LaunchCode {
    appId: string;
    userId: string;
    next: string;
    expiresAt: number;
}

/**
 * Mini apps' one-time launch codes in `app_launch_codes`, by SHA-256
 * hash only (CB-108): made on the main origin, redeemed on the app's,
 * which may be served by another runtime on the same database.
 */
export class SqliteLaunchCodes {
    constructor(private db: DatabaseSync) {}

    /**
     * Keeps a new code, and forgets expired ones. At once when the
     * connection is free, else queued behind the open unit of work: the
     * browser follows the code's URL only after this request has answered.
     */
    add(hash: string, code: LaunchCode, now: number) {
        writeSoon(this.db, 'app launch code', () => {
            this.db.prepare('DELETE FROM app_launch_codes WHERE expiresAt<=?').run(now);
            this.db
                .prepare('INSERT INTO app_launch_codes VALUES (?, ?, ?, ?, ?)')
                .run(hash, code.appId, code.userId, code.next, code.expiresAt);
        });
    }

    /**
     * Takes a code, expired or not: single use on every runtime, since one
     * statement both reads and deletes it.
     */
    take(hash: string): LaunchCode | undefined {
        const row = transactionSync(this.db, 'redeem app launch code', () =>
            this.db
                .prepare('DELETE FROM app_launch_codes WHERE hash=? RETURNING appId, userId, next, expiresAt')
                .get(hash),
        );
        return row
            ? {
                  appId: String(row.appId),
                  userId: String(row.userId),
                  next: String(row.next),
                  expiresAt: Number(row.expiresAt),
              }
            : undefined;
    }

    /** An app's unredeemed codes go (unpublished, unregistered). */
    forgetApp(appId: string) {
        writeSoon(this.db, 'forget app launch codes', () => {
            this.db.prepare('DELETE FROM app_launch_codes WHERE appId=?').run(appId);
        });
    }

    /** A person's unredeemed codes go (deactivated). */
    forgetUser(userId: string) {
        writeSoon(this.db, 'forget app launch codes', () => {
            this.db.prepare('DELETE FROM app_launch_codes WHERE userId=?').run(userId);
        });
    }
}
