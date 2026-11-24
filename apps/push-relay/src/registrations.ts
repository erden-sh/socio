// The registrations table (migrations/0001_registrations.sql) over D1. Every call that fails
// becomes a StoreDown, which the relay answers with 503: never 404 or 410, since a Socio server
// deletes its subscription on either.

import type { ApnsEnv, Platform } from './providers';

/** The part of D1's API the relay uses; D1Database fits it, and so does the tests' node:sqlite fake. */
export interface Database {
    prepare(query: string): {
        bind(...values: unknown[]): {
            first<T = Record<string, unknown>>(): Promise<T | null>;
            run(): Promise<{ meta: { changes: number } }>;
        };
    };
}

export interface Registration {
    id: string;
    platform: Platform;
    native_token: string;
    bundle_id: string;
    apns_env: ApnsEnv | null;
    vapid_key: string;
    secret_hash: string;
    /** Unix seconds. */
    created_at: number;
    /** A UTC date (YYYY-MM-DD), never a time. */
    refreshed_on: string;
}

export class StoreDown extends Error {
    override name = 'StoreDown';
}

/** A UTC date, YYYY-MM-DD. */
export const dateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Registrations not refreshed by `PUT` for this long are dropped. */
export const EXPIRE_DAYS = 60;

async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        throw new StoreDown('The registrations store failed.', { cause: error });
    }
}

export function registrationStore(db: Database) {
    return {
        get: (id: string) =>
            guarded(() => db.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first<Registration>()),

        /** False when the id was taken in the meantime (a concurrent retry). */
        insert: (row: Registration) =>
            guarded(async () => {
                const result = await db
                    .prepare(
                        'INSERT INTO registrations (id, platform, native_token, bundle_id, apns_env, vapid_key, secret_hash, created_at, refreshed_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
                    )
                    .bind(
                        row.id,
                        row.platform,
                        row.native_token,
                        row.bundle_id,
                        row.apns_env,
                        row.vapid_key,
                        row.secret_hash,
                        row.created_at,
                        row.refreshed_on,
                    )
                    .run();
                return result.meta.changes === 1;
            }),

        /** The daily refresh without a new token: the date only, so it can't undo a rotation that raced it. */
        touch: (id: string, refreshedOn: string) =>
            guarded(() =>
                db.prepare('UPDATE registrations SET refreshed_on = ? WHERE id = ?').bind(refreshedOn, id).run(),
            ),

        /**
         * Charges `cost` billed writes to `minute` (Unix minutes) if that keeps it within `budget`;
         * false otherwise. Past the budget neither the insert (a cost over the budget) nor the
         * update's WHERE matches, so a refused charge writes nothing (src/write-budget.ts).
         */
        charge: (minute: number, cost: number, budget: number) =>
            guarded(async () => {
                const row = await db
                    .prepare(
                        'INSERT INTO write_budget (minute, spent) SELECT ?1, ?2 WHERE ?2 <= ?3 ON CONFLICT (minute) DO UPDATE SET spent = spent + excluded.spent WHERE spent + excluded.spent <= ?3 RETURNING spent',
                    )
                    .bind(minute, cost, budget)
                    .first<{ spent: number }>();
                return row !== null;
            }),

        /** Drops the budget's counts for minutes before `minute`; returns how many. */
        dropBudgetBefore: (minute: number) =>
            guarded(async () => {
                const result = await db.prepare('DELETE FROM write_budget WHERE minute < ?').bind(minute).run();
                return result.meta.changes;
            }),

        /**
         * Clears a native token a provider reported gone, only if the registration still holds it:
         * one statement, so a rotation that landed while the push was out is never undone. False
         * when the token had already changed (or the row is gone).
         */
        clearToken: (id: string, nativeToken: string) =>
            guarded(async () => {
                const result = await db
                    .prepare("UPDATE registrations SET native_token = '' WHERE id = ? AND native_token = ?")
                    .bind(id, nativeToken)
                    .run();
                return result.meta.changes === 1;
            }),

        refresh: (id: string, nativeToken: string, refreshedOn: string) =>
            guarded(() =>
                db
                    .prepare('UPDATE registrations SET native_token = ?, refreshed_on = ? WHERE id = ?')
                    .bind(nativeToken, refreshedOn, id)
                    .run(),
            ),

        remove: (id: string) => guarded(() => db.prepare('DELETE FROM registrations WHERE id = ?').bind(id).run()),

        /** Drops every registration last refreshed before `cutoff` (a date); returns how many. */
        expire: (cutoff: string) =>
            guarded(async () => {
                const result = await db.prepare('DELETE FROM registrations WHERE refreshed_on < ?').bind(cutoff).run();
                return result.meta.changes;
            }),
    };
}

export type RegistrationStore = ReturnType<typeof registrationStore>;
