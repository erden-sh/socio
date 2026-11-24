import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

import type { Context } from 'hono';

import { sqliteData, transactionSync } from '@socio/data/open';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import type { PersonKey } from '@socio/shared/people';
import {
    SERVICE_SCOPES,
    type KeyMadeBy,
    type ServiceAccountView,
    type ServiceKeyView,
    type ServiceRole,
    type ServiceScope,
} from '@socio/shared/service-accounts';

import {
    SERVICE_KEY_PREFIX,
    ServiceAccountError,
    type ResolvedServiceKey,
    type ServiceAccountsShape,
} from './contract.js';
import type { ServiceAccountRepositories } from './domain/repositories.js';
import { sqliteServiceAccountRepositories } from './infra/sqlite/index.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const DAY_MS = 86_400_000;
/** How often a key's last use is written (not on every request). */
const TOUCH_MS = 60_000;
/** Requests per key and minute. */
const KEY_REQUESTS_PER_MINUTE = 300;

/**
 * What each scope allows: methods and paths under /api. Everything else is
 * refused, `/api/auth/*`, the chat runtime and the admin pages included.
 */
const SCOPE_ROUTES: Record<ServiceScope, [method: string, path: RegExp][]> = {
    'issues:read': [
        ['GET', /^\/api\/issues$/],
        ['GET', /^\/api\/issues\/export\.md$/],
        ['GET', /^\/api\/issues\/[^/]+$/],
        ['GET', /^\/api\/issue-attachments\/[^/]+$/],
    ],
    'issues:write': [
        ['POST', /^\/api\/issues$/],
        ['PATCH', /^\/api\/issues\/[^/]+$/],
        ['POST', /^\/api\/issues\/[^/]+\/comments$/],
        ['PATCH', /^\/api\/issues\/[^/]+\/comments\/[^/]+$/],
        ['POST', /^\/api\/issues\/[^/]+\/attachments$/],
    ],
    'pages:read': [
        ['GET', /^\/api\/pages\/titles$/],
        ['GET', /^\/api\/spaces\/search$/],
        ['GET', /^\/api\/spaces\/[^/]+\/page-tree$/],
        ['GET', /^\/api\/spaces\/[^/]+\/pages$/],
        ['GET', /^\/api\/spaces\/[^/]+\/pages\/[^/]+$/],
        ['GET', /^\/api\/pages\/[^/]+\/location$/],
    ],
};
/** Every key may ask who it is. */
const ALWAYS: [string, RegExp][] = [['GET', /^\/api\/service\/whoami$/]];

/** Whether a key with these scopes may make this request. */
export function scopeAllows(scopes: readonly ServiceScope[], method: string, path: string) {
    const verb = method === 'HEAD' ? 'GET' : method;
    return [...ALWAYS, ...scopes.flatMap((scope) => SCOPE_ROUTES[scope] ?? [])].some(
        ([allowed, pattern]) => allowed === verb && pattern.test(path),
    );
}

/**
 * Where a request came from, for a key's "last used" line: the proxy's
 * last forwarded hop, else the socket. Shown to admins, never trusted.
 */
export function requestIp(c: Context) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',').pop()?.trim();
    if (forwarded) {
        return forwarded;
    }
    return (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket?.remoteAddress;
}

type KeyRow = {
    id: string;
    userId: string;
    name: string;
    hint: string;
    scopes: string;
    createdAt: number;
    createdBy: string | null;
    expiresAt: number;
    lastUsedAt: number | null;
    lastUsedIp: string | null;
    revokedAt: number | null;
    createdByName: string | null;
};

/**
 * Service accounts and their API keys (CB-57). An account is a workspace
 * user (`users`, id `svc_…`, member or admin) listed in `service_accounts`;
 * nobody signs in as it. Keys are `cbk_` and 32 random bytes, shown once
 * and stored as SHA-256 only. A disabled account keeps its user row, so
 * what it filed stays attributed.
 */
export class ServiceAccounts implements ServiceAccountsShape {
    private touched = new Map<string, number>();
    private limits = new RateLimits(KEY_REQUESTS_PER_MINUTE, 60_000);
    /** Its writes (CB-110); the reads stay here. */
    private repos: ServiceAccountRepositories;
    constructor(private db: DatabaseSync) {
        this.repos = sqliteServiceAccountRepositories(sqliteData(db));
    }

    isService(userId: string) {
        return !!this.db.prepare('SELECT 1 FROM service_accounts WHERE userId=?').get(userId);
    }
    /** Ids of every service account (users lists mark them). */
    ids(): Set<string> {
        return new Set(
            (
                this.db.prepare('SELECT userId FROM service_accounts').all() as {
                    userId: string;
                }[]
            ).map((row) => row.userId),
        );
    }

    private keyView(row: KeyRow): ServiceKeyView {
        return {
            id: row.id,
            name: row.name,
            hint: row.hint,
            scopes: JSON.parse(row.scopes) as ServiceScope[],
            createdAt: row.createdAt,
            createdBy: row.createdBy,
            createdByName: row.createdByName,
            expiresAt: row.expiresAt,
            lastUsedAt: row.lastUsedAt,
            lastUsedIp: row.lastUsedIp,
            revokedAt: row.revokedAt,
        };
    }
    list(): ServiceAccountView[] {
        const keys = this.db
            .prepare(
                `SELECT k.*, c.name AS createdByName FROM service_keys k LEFT JOIN users c ON c.id = k.createdBy
         ORDER BY k.createdAt, k.id`,
            )
            .all() as unknown as KeyRow[];
        return (
            this.db
                .prepare(
                    `SELECT u.id, u.name, u.role, s.description, s.createdAt, s.createdBy, c.name AS createdByName, s.disabledAt
           FROM service_accounts s JOIN users u ON u.id = s.userId LEFT JOIN users c ON c.id = s.createdBy
           ORDER BY s.createdAt, u.id`,
                )
                .all() as unknown as Omit<ServiceAccountView, 'keys'>[]
        ).map((account) => ({
            ...account,
            keys: keys.filter((key) => key.userId === account.id).map((key) => this.keyView(key)),
        }));
    }
    get(id: string) {
        const account = this.list().find((entry) => entry.id === id);
        if (!account) {
            throw new ServiceAccountError({ message: 'Service account not found.', status: 404 });
        }
        return account;
    }

    create(input: { name: string; role: ServiceRole; description?: string }, createdBy: string): ServiceAccountView {
        const id = `svc_${randomUUID()}`;
        const now = Date.now();
        transactionSync(this.db, 'create service account', () =>
            this.repos.accounts.insertNow({
                userId: id,
                name: input.name,
                role: input.role,
                description: input.description ?? '',
                createdAt: now,
                createdBy,
            }),
        );
        return this.get(id);
    }
    update(id: string, patch: { name?: string; role?: ServiceRole; description?: string }) {
        const account = this.get(id);
        if (account.disabledAt) {
            throw new ServiceAccountError({ message: 'This service account is disabled.', status: 409 });
        }
        this.repos.accounts.updateNow(id, {
            name: patch.name ?? account.name,
            role: patch.role ?? account.role,
            description: patch.description ?? account.description,
        });
        return this.get(id);
    }
    /** Revokes every key and disables the account; its records stay its own. */
    disable(id: string) {
        this.get(id);
        const now = Date.now();
        this.repos.keys.revokeAllNow(id, now);
        this.repos.accounts.disableNow(id, now);
        return this.get(id);
    }

    createKey(userId: string, input: { name: string; scopes: ServiceScope[]; days: number }, createdBy: string) {
        const account = this.get(userId);
        if (account.disabledAt) {
            throw new ServiceAccountError({ message: 'This service account is disabled.', status: 409 });
        }
        const scopes = SERVICE_SCOPES.filter((scope) => input.scopes.includes(scope));
        if (!scopes.length) {
            throw new ServiceAccountError({ message: 'Give the key at least one scope.', status: 400 });
        }
        const secret = randomBytes(32).toString('base64url');
        const token = `${SERVICE_KEY_PREFIX}${secret}`;
        const now = Date.now();
        const id = randomUUID();
        this.repos.keys.insertNow({
            id,
            userId,
            name: input.name,
            hint: secret.slice(0, 6),
            hash: digest(token),
            scopes,
            createdAt: now,
            createdBy,
            expiresAt: now + input.days * DAY_MS,
        });
        const key = this.get(userId).keys.find((entry) => entry.id === id)!;
        return { key, token };
    }
    /**
     * The live keys this person made, which `revokeKeysMadeBy` would revoke
     * (CB-360's deactivation preview), each with whether it is its
     * account's last live key. Changes nothing.
     */
    keysMadeBy(createdBy: string, now = Date.now()): KeyMadeBy[] {
        const rows = this.db
            .prepare(
                `SELECT k.id AS keyId, k.name, k.hint, k.userId AS accountId, u.name AS account, k.lastUsedAt, k.expiresAt,
           NOT EXISTS(SELECT 1 FROM service_keys o WHERE o.userId = k.userId AND o.revokedAt IS NULL AND o.expiresAt > ?
             AND (o.createdBy IS NULL OR o.createdBy <> ?)) AS lastLiveKey
         FROM service_keys k JOIN users u ON u.id = k.userId
         WHERE k.createdBy=? AND k.revokedAt IS NULL AND k.expiresAt>?
         ORDER BY u.name, k.createdAt, k.id`,
            )
            .all(now, createdBy, createdBy, now) as unknown as (Omit<KeyMadeBy, 'lastLiveKey'> & {
            lastLiveKey: number;
        })[];
        return rows.map((row) => ({ ...row, lastLiveKey: !!row.lastLiveKey }));
    }
    /** Every key this person made, revoked and expired ones too, newest first (CB-360). */
    keysCreatedBy(createdBy: string): PersonKey[] {
        return this.db
            .prepare(
                `SELECT k.id AS keyId, k.name, k.hint, k.userId AS accountId, u.name AS account, k.createdAt, k.expiresAt,
           k.lastUsedAt, k.revokedAt
         FROM service_keys k JOIN users u ON u.id = k.userId
         WHERE k.createdBy=? ORDER BY k.createdAt DESC, k.id`,
            )
            .all(createdBy) as unknown as PersonKey[];
    }
    /**
     * Removes a revoked key for good (CB-360): its row, hash included, is
     * gone; what it did stays the account's. A key that was never revoked,
     * expired or not, is refused (409): revoke it first. Returns its
     * account's and its own name and id, for the audit.
     */
    deleteRevokedKey(userId: string, keyId: string) {
        const account = this.get(userId);
        const key = account.keys.find((entry) => entry.id === keyId);
        if (!key) {
            throw new ServiceAccountError({ message: 'Key not found.', status: 404 });
        }
        if (!key.revokedAt) {
            throw new ServiceAccountError({
                message: 'Revoke this key before deleting it for good.',
                status: 409,
            });
        }
        if (!this.repos.keys.deleteRevokedNow(keyId, userId)) {
            throw new ServiceAccountError({ message: 'Key not found.', status: 404 });
        }
        return { account: { id: account.id, name: account.name }, key: { id: key.id, name: key.name } };
    }
    /**
     * Revokes every live key this person made (they saw its secret once):
     * when they are deactivated (accounts.ts). Returns what was revoked.
     */
    revokeKeysMadeBy(createdBy: string, now = Date.now()) {
        const keys = this.db
            .prepare(
                `SELECT k.id, k.name, u.name AS account FROM service_keys k JOIN users u ON u.id = k.userId
         WHERE k.createdBy=? AND k.revokedAt IS NULL AND k.expiresAt>?`,
            )
            .all(createdBy, now) as { id: string; name: string; account: string }[];
        for (const key of keys) {
            this.repos.keys.revokeNow(key.id, now);
        }
        return keys.map(({ name, account }) => ({ name, account }));
    }
    revokeKey(userId: string, keyId: string) {
        const changed = this.repos.keys.revokeNow(keyId, Date.now(), userId);
        if (!changed) {
            const exists = this.get(userId).keys.some((key) => key.id === keyId);
            if (!exists) {
                throw new ServiceAccountError({ message: 'Key not found.', status: 404 });
            }
        }
        return this.get(userId);
    }

    /**
     * The account and key behind a bearer token: live (not revoked, expired
     * or disabled) or undefined. Records the use, at most once a minute.
     */
    resolve(token: string, ip?: string, now = Date.now()): ResolvedServiceKey | undefined {
        if (!token.startsWith(SERVICE_KEY_PREFIX)) {
            return undefined;
        }
        const row = this.db
            .prepare(
                `SELECT k.id, k.name, k.scopes, k.expiresAt, k.revokedAt, u.id AS userId, u.name AS userName, u.role, s.disabledAt
         FROM service_keys k JOIN service_accounts s ON s.userId = k.userId JOIN users u ON u.id = k.userId
         WHERE k.hash=?`,
            )
            .get(digest(token)) as
            | {
                  id: string;
                  name: string;
                  scopes: string;
                  expiresAt: number;
                  revokedAt: number | null;
                  userId: string;
                  userName: string;
                  role: string;
                  disabledAt: number | null;
              }
            | undefined;
        if (!row || row.revokedAt || row.disabledAt || row.expiresAt <= now) {
            return undefined;
        }
        // Never an operator, whatever the users table says.
        if (row.role !== 'member' && row.role !== 'admin') {
            return undefined;
        }
        if ((this.touched.get(row.id) ?? 0) + TOUCH_MS <= now) {
            this.touched.set(row.id, now);
            this.repos.keys.recordUse(row.id, now, ip?.slice(0, 64) ?? null);
        }
        return {
            user: { id: row.userId, name: row.userName, role: row.role },
            key: {
                keyId: row.id,
                name: row.name,
                scopes: JSON.parse(row.scopes) as ServiceScope[],
            },
        };
    }
    /** Counts one request of a key; false once over its per-minute limit. */
    take(keyId: string, now = Date.now()) {
        return this.limits.take(keyId, now);
    }
}
