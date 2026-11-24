import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
    INSTALL_HEADER,
    installIdSchema,
    type AppVariant,
    type DevicePlatform,
    type DeviceState,
} from '@socio/shared/device-sign-in';

/**
 * The app's devices (CB-352): one
 * row per install of the app, per workspace and per person, found by the
 * SHA-256 of the install id the app sends in `X-Socio-Install`. The id
 * itself is never stored, logged or sent back. A session made with it
 * (any sign-in, a password one included) belongs to the device and lasts
 * 30 days, sliding to 30 again at most once a day; web sessions keep 7.
 */

/** A device session's life, and how often its sliding renewal may write. */
export const DEVICE_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const DEVICE_SLIDE_SECONDS = 24 * 60 * 60;
/** How often a device's `lastSeenAt` is written. */
const LAST_SEEN_MS = 60 * 60_000;

export interface DeviceRow {
    id: string;
    installIdHash: string | null;
    userId: string;
    label: string;
    platform: DevicePlatform | null;
    variant: AppVariant | null;
    state: DeviceState;
    pushEndpoint: string | null;
    createdAt: number;
    lastSeenAt: number | null;
    endedAt: number | null;
    /** When its latest session runs out (ms), kept after the session row is gone. */
    sessionExpiresAt: number | null;
}

/** What the device says about itself when it signs in. */
export interface DeviceFacts {
    label: string;
    platform: DevicePlatform | null;
    variant: AppVariant | null;
}

/** The install id's stored form. */
export const installIdHash = (installId: string) => createHash('sha256').update(installId).digest('base64url');

/** The request's install id when it carries a well-formed one; anything else is no install id. */
export function readInstallId(headers: Headers | undefined | null): string | null {
    const value = headers?.get(INSTALL_HEADER);
    return value && installIdSchema.safeParse(value).success ? value : null;
}

/**
 * What a password sign-in's device is called, from the app's User-Agent
 * (`Socio/<version> (<iPhone|iPad|Android>; …)`, apps/mobile/src/net/user-agent.ts),
 * which names no person and no model. The device endpoints send a label of their own.
 */
export function deviceFromUserAgent(userAgent: string | null | undefined): DeviceFacts {
    const kind = /^Socio\/[\d.]+ \((iPhone|iPad|Android);/.exec(userAgent ?? '')?.[1];
    if (!kind) {
        return { label: 'Socio app', platform: null, variant: null };
    }
    return { label: kind, platform: kind === 'Android' ? 'android' : 'ios', variant: null };
}

/** Runs `work` atomically, inside Better Auth's transaction when one is open (as groups.ts does). */
function atomically<T>(db: DatabaseSync, work: () => T): T {
    db.exec('SAVEPOINT socio_devices');
    try {
        const result = work();
        db.exec('RELEASE socio_devices');
        return result;
    } catch (error) {
        db.exec('ROLLBACK TO socio_devices');
        db.exec('RELEASE socio_devices');
        throw error;
    }
}

export class Devices {
    /** When each device's `lastSeenAt` was last written, per process. */
    private seen = new Map<string, number>();

    constructor(private db: () => DatabaseSync) {}

    byId(id: string): DeviceRow | undefined {
        return this.db().prepare('SELECT * FROM auth_device WHERE id = ?').get(id) as DeviceRow | undefined;
    }

    byInstallId(installId: string): DeviceRow | undefined {
        return this.db().prepare('SELECT * FROM auth_device WHERE installIdHash = ?').get(installIdHash(installId)) as
            | DeviceRow
            | undefined;
    }

    /**
     * The device a new session of `userId` made with this install id belongs
     * to, made only when a session is (a sign-in). A row is reused only while
     * it is that person's and active. A row never moves between people:
     * another person's sign-in with the same install id gets a row of its
     * own and the id, and the previous person's row and sessions are left as
     * they are. A device signed out (`revoked`, or erased) gets a new row
     * when its person signs in again on it. Synchronous and
     * in one SAVEPOINT, so two sign-ins with one install id can't interleave
     * in this process, and a failure leaves nothing half done.
     */
    attach(installId: string, userId: string, facts: DeviceFacts, now = Date.now()): string {
        const db = this.db();
        return atomically(db, () => this.attachIn(db, installId, userId, facts, now));
    }

    private attachIn(db: DatabaseSync, installId: string, userId: string, facts: DeviceFacts, now: number): string {
        const hash = installIdHash(installId);
        const current = this.byInstallId(installId);
        if (current && current.userId === userId && current.state === 'active') {
            db.prepare(
                `UPDATE auth_device SET label = ?, platform = coalesce(?, platform), variant = coalesce(?, variant), lastSeenAt = ?, sessionExpiresAt = ? WHERE id = ?`,
            ).run(facts.label, facts.platform, facts.variant, now, now + DEVICE_SESSION_SECONDS * 1000, current.id);
            this.seen.set(current.id, now);
            return current.id;
        }
        if (current) {
            // Only the id moves to the new row. Another person's sessions on the
            // old one are left as they are: a sign-in the app then cancels, or
            // one by someone else entirely, never signs the first person out
            // (the app makes a new install id for another person anyway).
            db.prepare('UPDATE auth_device SET installIdHash = NULL WHERE id = ?').run(current.id);
        }
        const id = `d_${randomBytes(16).toString('hex')}`;
        db.prepare(
            `INSERT INTO auth_device(id, installIdHash, userId, label, platform, variant, state, createdAt, lastSeenAt, sessionExpiresAt) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
            id,
            hash,
            userId,
            facts.label,
            facts.platform,
            facts.variant,
            now,
            now,
            now + DEVICE_SESSION_SECONDS * 1000,
        );
        this.seen.set(id, now);
        return id;
    }

    /** Its session was renewed to run out at `expiresAt` (ms). */
    renewed(deviceId: string, expiresAt: number) {
        this.db()
            .prepare('UPDATE auth_device SET sessionExpiresAt = max(coalesce(sessionExpiresAt, 0), ?) WHERE id = ?')
            .run(expiresAt, deviceId);
    }

    /**
     * Why this device has no session now: its latest one ran out, or it was
     * ended (signed out everywhere, by an admin, by the access policy).
     */
    endedHow(device: DeviceRow, now = Date.now()): 'session_expired' | 'session_ended' {
        return device.sessionExpiresAt !== null && device.sessionExpiresAt <= now ? 'session_expired' : 'session_ended';
    }

    /** Notes that the device made a signed-in request, at most once an hour. */
    touch(deviceId: string, now = Date.now()) {
        if ((this.seen.get(deviceId) ?? 0) + LAST_SEEN_MS > now) {
            return;
        }
        this.seen.set(deviceId, now);
        this.db()
            .prepare('UPDATE auth_device SET lastSeenAt = ? WHERE id = ? AND coalesce(lastSeenAt, 0) < ?')
            .run(now, deviceId, now - LAST_SEEN_MS);
    }

    /** A person's devices, newest first. */
    listFor(userId: string): DeviceRow[] {
        return this.db()
            .prepare('SELECT * FROM auth_device WHERE userId = ? ORDER BY createdAt DESC')
            .all(userId) as unknown as DeviceRow[];
    }

    /** The method of the device's live session, if it has one. */
    /** Whether the device has a live session other than this one. */
    liveBesides(deviceId: string, sessionId: string, now = Date.now()): boolean {
        const rows = this.db()
            .prepare('SELECT expiresAt FROM auth_session WHERE deviceId = ? AND id <> ?')
            .all(deviceId, sessionId) as { expiresAt: unknown }[];
        return rows.some((row) => toMs(row.expiresAt) > now);
    }

    sessionMethod(deviceId: string, now = Date.now()): string | null {
        const rows = this.db()
            .prepare('SELECT signInMethod, expiresAt FROM auth_session WHERE deviceId = ? ORDER BY createdAt DESC')
            .all(deviceId) as { signInMethod: string | null; expiresAt: unknown }[];
        const live = rows.find((row) => toMs(row.expiresAt) > now);
        return live?.signInMethod ?? null;
    }

    /**
     * Ends these devices of a person, in one transaction: their sessions go,
     * and with a `state` (signed out, or
     * signed out and erase) they stay out until signed in again. The rows as
     * they were, for the push cleanup, which clears each endpoint once its
     * subscription is gone (`clearPush`), so a failed one is tried again.
     */
    end(
        userId: string,
        ids: readonly string[],
        state: Exclude<DeviceState, 'active'> | null,
        now = Date.now(),
    ): DeviceRow[] {
        if (!ids.length) {
            return [];
        }
        const db = this.db();
        const marks = ids.map(() => '?').join(', ');
        db.exec('BEGIN IMMEDIATE');
        try {
            const rows = db
                .prepare(`SELECT * FROM auth_device WHERE userId = ? AND id IN (${marks})`)
                .all(userId, ...ids) as unknown as DeviceRow[];
            const found = rows.map((row) => row.id);
            if (found.length) {
                const these = found.map(() => '?').join(', ');
                if (state) {
                    // An erase already asked for is never taken back by a plain sign-out.
                    db.prepare(
                        `UPDATE auth_device SET state = CASE WHEN state = 'revoked_and_erase' THEN state ELSE ? END, endedAt = coalesce(endedAt, ?) WHERE id IN (${these})`,
                    ).run(state, now, ...found);
                }
                db.prepare(`DELETE FROM auth_session WHERE deviceId IN (${these})`).run(...found);
            }
            db.exec('COMMIT');
            return rows;
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    }

    /** The people with a device that holds a push endpoint. */
    withPush(): string[] {
        return (
            this.db()
                .prepare(
                    'SELECT userId FROM auth_device WHERE pushEndpoint IS NOT NULL UNION SELECT userId FROM auth_device_push_leftover',
                )
                .all() as {
                userId: string;
            }[]
        ).map((row) => row.userId);
    }

    /** Forgets an ended device's push endpoint once its subscription is gone (unless a new one came since). */
    clearPush(deviceId: string, endpoint: string) {
        this.db()
            .prepare('UPDATE auth_device SET pushEndpoint = NULL WHERE id = ? AND pushEndpoint = ?')
            .run(deviceId, endpoint);
    }

    /**
     * This device's push subscription; no other device of the person keeps
     * the same endpoint. The one it replaces is kept to clean up.
     */
    setPush(deviceId: string, endpoint: string, now = Date.now()) {
        const db = this.db();
        atomically(db, () => {
            const device = this.byId(deviceId);
            if (!device) {
                return;
            }
            if (device.pushEndpoint && device.pushEndpoint !== endpoint) {
                this.leaveForCleanup(device.userId, device.pushEndpoint, now);
            }
            db.prepare('DELETE FROM auth_device_push_leftover WHERE userId = ? AND endpoint = ?').run(
                device.userId,
                endpoint,
            );
            db.prepare(
                'UPDATE auth_device SET pushEndpoint = NULL WHERE userId = ? AND pushEndpoint = ? AND id <> ?',
            ).run(device.userId, endpoint, deviceId);
            db.prepare('UPDATE auth_device SET pushEndpoint = ? WHERE id = ?').run(endpoint, deviceId);
        });
    }

    /** A push endpoint no device holds whose subscription is still to go. */
    leaveForCleanup(userId: string, endpoint: string, now = Date.now()) {
        this.db()
            .prepare('INSERT OR IGNORE INTO auth_device_push_leftover(userId, endpoint, createdAt) VALUES (?, ?, ?)')
            .run(userId, endpoint, now);
    }

    /** The person's push endpoints still to clean up. */
    leftovers(userId: string): string[] {
        return (
            this.db().prepare('SELECT endpoint FROM auth_device_push_leftover WHERE userId = ?').all(userId) as {
                endpoint: string;
            }[]
        ).map((row) => row.endpoint);
    }

    /** One cleaned up. */
    cleaned(userId: string, endpoint: string) {
        this.db()
            .prepare('DELETE FROM auth_device_push_leftover WHERE userId = ? AND endpoint = ?')
            .run(userId, endpoint);
    }

    /** The workspace's id (auth migration 8): random, made once, never changed. */
    workspaceId(): string {
        const row = this.db().prepare('SELECT id FROM auth_workspace LIMIT 1').get() as { id: string } | undefined;
        if (!row) {
            throw new Error('The auth database has no workspace id: migration 8 has not run.');
        }
        return row.id;
    }
}

function toMs(value: unknown): number {
    if (typeof value === 'number') {
        return value;
    }
    if (value instanceof Date) {
        return value.getTime();
    }
    const parsed = typeof value === 'string' ? (/^\d+$/.test(value) ? Number(value) : Date.parse(value)) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}
