import type { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { transactionSync } from '@socio/data/open';
import {
    normalizePolicy,
    savedAccessPolicySchema,
    type AccessPolicyAuditAction,
    type SavedAccessPolicy,
} from '@socio/shared/access-policy';

import type { StoredPolicy } from './contract.js';

/**
 * The access policy's row and audit (CB-124), in the auth schema
 * (schema.ts, version 4). Plain statements on whatever connection the
 * caller holds: the auth provider reads through its own on every request,
 * the access policy service writes through the workspace's, inside one
 * transaction with its checks.
 */

const NOTHING: StoredPolicy = {
    version: 0,
    saved: {},
    updatedAt: null,
    updatedBy: null,
    unreadable: false,
};

let warned = false;
const readable = z.object(savedAccessPolicySchema.shape);

/**
 * The saved policy. Without the table (a store opened before the auth
 * migrations) nothing is saved. A row that doesn't parse leaves the
 * environment in force, as the ceiling it is, and says so once in the log.
 */
export function readStoredPolicy(db: DatabaseSync): StoredPolicy {
    let row: { version: number; policy: string; updatedAt: number; updatedBy: string } | undefined;
    try {
        row = db
            .prepare('SELECT version, policy, updatedAt, updatedBy FROM access_policy WHERE id = 1')
            .get() as typeof row;
    } catch (error) {
        if (error instanceof Error && /no such table/.test(error.message)) {
            return NOTHING;
        }
        throw error;
    }
    if (!row) {
        return NOTHING;
    }
    let parsed: SavedAccessPolicy | undefined;
    try {
        // Unknown keys (a newer version's, after a rollback) are dropped, so
        // what this version knows of the narrowing still holds.
        const result = readable.safeParse(JSON.parse(row.policy));
        parsed = result.success ? normalizePolicy(result.data) : undefined;
    } catch {
        parsed = undefined;
    }
    if (!parsed && !warned) {
        warned = true;
        console.error(
            'Access policy: the saved policy could not be read; the environment applies until an admin saves it again.',
        );
    }
    return {
        version: Number(row.version),
        saved: parsed ?? {},
        updatedAt: Number(row.updatedAt),
        updatedBy: row.updatedBy,
        unreadable: !parsed,
    };
}

/**
 * Saves the policy when the stored version is still `expected`; the new
 * version, or null when someone saved in between. Call it inside the
 * caller's transaction.
 */
export function writeStoredPolicy(
    db: DatabaseSync,
    expected: number,
    saved: SavedAccessPolicy,
    by: string,
    now = Date.now(),
): number | null {
    const policy = JSON.stringify(normalizePolicy(saved));
    if (expected === 0) {
        const inserted = db
            .prepare(
                'INSERT INTO access_policy(id, version, policy, updatedAt, updatedBy) VALUES (1, 1, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
            )
            .run(policy, now, by);
        return Number(inserted.changes) === 1 ? 1 : null;
    }
    const updated = db
        .prepare(
            'UPDATE access_policy SET version = version + 1, policy = ?, updatedAt = ?, updatedBy = ? WHERE id = 1 AND version = ?',
        )
        .run(policy, now, by, expected);
    return Number(updated.changes) === 1 ? expected + 1 : null;
}

export interface AuditInput {
    actor: string;
    action: AccessPolicyAuditAction;
    stepUp?: string | null;
    detail?: string;
    before?: SavedAccessPolicy;
    after?: SavedAccessPolicy;
    sessionsEnded?: number;
    codeRunsStopped?: number;
}

export function appendPolicyAudit(db: DatabaseSync, entry: AuditInput, now = Date.now()) {
    db.prepare(
        'INSERT INTO access_policy_audit(at, actor, action, stepUp, detail, before, after, sessionsEnded, codeRunsStopped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        now,
        entry.actor,
        entry.action,
        entry.stepUp ?? null,
        entry.detail ?? '',
        entry.before ? JSON.stringify(entry.before) : null,
        entry.after ? JSON.stringify(entry.after) : null,
        entry.sessionsEnded ?? 0,
        entry.codeRunsStopped ?? 0,
    );
}

export interface AuditRow {
    id: number;
    at: number;
    actor: string;
    action: AccessPolicyAuditAction;
    stepUp: string | null;
    detail: string;
    sessionsEnded: number;
    codeRunsStopped: number;
}

/** The newest entries first. */
export function policyAudit(db: DatabaseSync, limit = 50): AuditRow[] {
    return (
        db
            .prepare(
                'SELECT id, at, actor, action, stepUp, detail, sessionsEnded, codeRunsStopped FROM access_policy_audit ORDER BY id DESC LIMIT ?',
            )
            .all(limit) as unknown as AuditRow[]
    ).map((row) => ({
        ...row,
        id: Number(row.id),
        at: Number(row.at),
        sessionsEnded: Number(row.sessionsEnded),
        codeRunsStopped: Number(row.codeRunsStopped),
    }));
}

/** One person's changes, newest first, older than `before` (by time, then id): CB-360's trail. */
export function policyAuditBy(
    db: DatabaseSync,
    actor: string,
    before: { at: number; id: number } | undefined,
    limit: number,
): AuditRow[] {
    return (
        db
            .prepare(
                `SELECT id, at, actor, action, stepUp, detail, sessionsEnded, codeRunsStopped FROM access_policy_audit
         WHERE actor=? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT ?`,
            )
            .all(
                actor,
                before?.at ?? Number.MAX_SAFE_INTEGER,
                before?.id ?? Number.MAX_SAFE_INTEGER,
                limit,
            ) as unknown as AuditRow[]
    ).map((row) => ({
        ...row,
        id: Number(row.id),
        at: Number(row.at),
        sessionsEnded: Number(row.sessionsEnded),
        codeRunsStopped: Number(row.codeRunsStopped),
    }));
}

/**
 * Clears the saved policy (the auth CLI's break glass): the environment
 * applies again. Audited as a reset; returns whether there was one.
 */
export function resetStoredPolicy(db: DatabaseSync, by: string, now = Date.now()) {
    const before = readStoredPolicy(db);
    if (before.version === 0) {
        return false;
    }
    transactionSync(db, 'access policy reset', () => {
        db.prepare(
            "UPDATE access_policy SET version = version + 1, policy = '{}', updatedAt = ?, updatedBy = ? WHERE id = 1",
        ).run(now, by);
        appendPolicyAudit(
            db,
            {
                actor: by,
                action: 'reset',
                stepUp: by,
                detail: 'Saved policy cleared: the environment applies.',
                before: before.saved,
                after: {},
            },
            now,
        );
    });
    return true;
}

/**
 * One line for the boot log (CB-124): what the app narrows and since
 * when, so a restore that brought back an older policy shows.
 */
export function accessPolicyLine(stored: StoredPolicy) {
    if (stored.unreadable) {
        return 'Access policy: the saved policy could not be read; the environment applies.';
    }
    const keys = Object.keys(stored.saved);
    if (!stored.version || !keys.length) {
        return 'Access policy: the environment applies (nothing narrowed in the app).';
    }
    return `Access policy: version ${stored.version}, saved ${new Date(stored.updatedAt!).toISOString()} by ${stored.updatedBy}; narrows ${keys.join(', ')}.`;
}
