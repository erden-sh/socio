import type { ServiceRole, ServiceScope } from '@socio/shared/service-accounts';

/**
 * Service accounts' repositories (CB-110): the accounts and
 * their API keys, taking plain domain types; only `service-accounts/infra`
 * implements them.
 *
 * Methods named `…Now` are synchronous: they run at once on the connection,
 * in the caller's transaction if one is open, exactly as the raw statements
 * they replaced did. `ServiceAccounts` is synchronous for its callers (the
 * routes, a deactivation, the CLI and the auth middleware). A key's last
 * use, which nothing reads back at once, is written soon, as `writeSoon`
 * writes it.
 */

/** A new account: its workspace user and its `service_accounts` row. */
export interface NewServiceAccount {
    userId: string;
    name: string;
    role: ServiceRole;
    description: string;
    createdAt: number;
    createdBy: string;
}

/** What an admin changes on an account. */
export interface ServiceAccountFields {
    name: string;
    role: ServiceRole;
    description: string;
}

export interface ServiceAccountRepository {
    /** Its user and account rows; the caller runs it in one transaction. */
    insertNow(account: NewServiceAccount): void;
    updateNow(userId: string, fields: ServiceAccountFields): void;
    /** Marks a live account disabled; a disabled one keeps its time. */
    disableNow(userId: string, at: number): void;
}

/** A new key, its secret already reduced to a hint and a SHA-256. */
export interface NewServiceKey {
    id: string;
    userId: string;
    name: string;
    hint: string;
    hash: string;
    scopes: ServiceScope[];
    createdAt: number;
    createdBy: string;
    expiresAt: number;
}

export interface ServiceKeyRepository {
    insertNow(key: NewServiceKey): void;
    /** Revokes an account's live keys. */
    revokeAllNow(userId: string, at: number): void;
    /**
     * Revokes one live key, of `userId` when given; whether it was live.
     */
    revokeNow(id: string, at: number, userId?: string): boolean;
    /**
     * Removes one revoked key of `userId` for good (CB-360); whether it did.
     * A live or expired key that was never revoked stays.
     */
    deleteRevokedNow(id: string, userId: string): boolean;
    /** A key's last use and where from, written soon (never awaited). */
    recordUse(id: string, at: number, ip: string | null): void;
}

export interface ServiceAccountRepositories {
    accounts: ServiceAccountRepository;
    keys: ServiceKeyRepository;
}
