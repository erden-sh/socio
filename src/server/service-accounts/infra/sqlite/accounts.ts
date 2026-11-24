import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import type {
    NewServiceAccount,
    NewServiceKey,
    ServiceAccountFields,
    ServiceAccountRepository,
    ServiceKeyRepository,
} from '../../domain/repositories.js';

import { SqliteRepository } from './base.js';
import { serviceAccounts as a, serviceKeys as k, serviceKeys, users as u } from './schema.js';

/** Accounts: a workspace user each, kept when disabled (CB-57). */
export class SqliteServiceAccounts extends SqliteRepository implements ServiceAccountRepository {
    insertNow(account: NewServiceAccount) {
        const { userId, name, role, description, createdAt, createdBy } = account;
        this.db.insert(u).values({ id: userId, name, role, createdAt, lastSeenAt: createdAt }).run();
        this.db.insert(a).values({ userId, description, createdAt, createdBy }).run();
    }

    updateNow(userId: string, fields: ServiceAccountFields) {
        this.db.update(u).set({ name: fields.name, role: fields.role }).where(eq(u.id, userId)).run();
        this.db.update(a).set({ description: fields.description }).where(eq(a.userId, userId)).run();
    }

    disableNow(userId: string, at: number) {
        this.db
            .update(a)
            .set({ disabledAt: at })
            .where(and(eq(a.userId, userId), isNull(a.disabledAt)))
            .run();
    }
}

/** API keys, stored as SHA-256 only; revoked ones stay listed. */
export class SqliteServiceKeys extends SqliteRepository implements ServiceKeyRepository {
    insertNow(key: NewServiceKey) {
        this.db.insert(k).values(key).run();
    }

    revokeAllNow(userId: string, at: number) {
        this.db
            .update(k)
            .set({ revokedAt: at })
            .where(and(eq(k.userId, userId), isNull(k.revokedAt)))
            .run();
    }

    revokeNow(id: string, at: number, userId?: string) {
        const { changes } = this.db
            .update(k)
            .set({ revokedAt: at })
            .where(and(eq(k.id, id), userId === undefined ? undefined : eq(k.userId, userId), isNull(k.revokedAt)))
            .run();
        return Number(changes) > 0;
    }

    deleteRevokedNow(id: string, userId: string) {
        const { changes } = this.db
            .delete(serviceKeys)
            .where(and(eq(k.id, id), eq(k.userId, userId), isNotNull(k.revokedAt)))
            .run();
        return Number(changes) > 0;
    }

    recordUse(id: string, at: number, ip: string | null) {
        this.soon('service key use', () => {
            this.db.update(k).set({ lastUsedAt: at, lastUsedIp: ip }).where(eq(k.id, id)).run();
        });
    }
}
