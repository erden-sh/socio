import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DATA_TOKEN_PREFIX } from '@socio/foundation/actors/redact';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import { DATA_API_TOKEN_INFIX } from '@socio/shared/dataspace/api-tokens';

import type { RuntimeOwnershipShape } from '../runtime/contract.js';

import type { DataTokensShape } from './contract.js';
import { SqliteDataTokenStore } from './infra/sqlite/data-tokens.js';

/**
 * The app a data token was issued to (CB-232): a promoted app's
 * `appId`, or a development app's (`session` is `app:<id>` for both, as
 * `AppsService` and `AppPromotions` issue them). Undefined for a computer
 * command's or a job's token. The data API binds a request's `x-cb-obo`
 * to this app, so another app's data token can't use it.
 */
export function dataTokenAppId(scope: Pick<DataTokenScope, 'purpose' | 'appId' | 'session'>): string | undefined {
    if (scope.purpose !== 'app') {
        return undefined;
    }
    if (scope.appId) {
        return scope.appId;
    }
    const id = scope.session.startsWith('app:') ? scope.session.slice(4) : '';
    return id || undefined;
}
/**
 * The token kinds a socio's work holds for its person (`DataTokenScope.userId`).
 * A mini app's token is the app's, re-issued for its owner as the database
 * has it (a deactivation's transfer moves it, CB-360), so it is not here.
 */
const PERSON_PURPOSES: ReadonlySet<DataTokenScope['purpose']> = new Set(['computer', 'job']);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

/** Where tokens live when runtimes share the database (CB-108). */
export interface SharedDataTokensOptions {
    /** This runtime on the connection the tokens are kept on. */
    ownership: RuntimeOwnershipShape;
}

/**
 * Scoped data tokens for code outside the app: a computer command, a job
 * run, a mini app. Only their SHA-256 hashes are kept (a live computer
 * command's token by value too, in this process's memory, to redact it);
 * the tokens themselves are never written to datasets, the database or
 * logs, and are accepted only by `/api/data/*`. Without `shared` they live in this
 * process's memory. With it (CB-108) they are kept in the database, so
 * every runtime on it accepts a token while the runtime that issued it is
 * alive; when that one exits or its lease lapses its tokens die with it,
 * so a restart still revokes them all, and a revocation on any runtime
 * holds on all of them. A computer command gets its own token, which ends
 * with the command (CB-224); on a company socio's computer, which everyone
 * who uses the socio shares, it also reaches only what the socio itself
 * may (`reach`). Computer and job leases, plus development apps' sessions,
 * end when the computer stops. Promoted apps keep running independently
 * and retain their runtime leases.
 */
export class DataTokens implements DataTokensShape {
    private scopes = new Map<string, DataTokenScope>();
    /**
     * Shared mode: tokens issued here whose row is queued behind an open
     * unit of work, accepted here until it lands (a revocation meanwhile
     * drops the row before it is written).
     */
    private pending = new Map<string, DataTokenScope>();
    /**
     * Shared mode: revocations whose delete is queued behind an open unit of
     * work. This runtime refuses what they match at once, as in memory.
     */
    private revoking = new Set<(scope: DataTokenScope, hash: string) => boolean>();
    /** Computer commands' tokens by session, for redaction only. */
    private commands = new Map<string, { dotId: string; token: string }>();
    private store?: SqliteDataTokenStore;
    /** Who hears refused tokens (CB-291: mini apps' self-healing). */
    private refusals = new Set<(token: string) => void>();
    /**
     * Admins' data API tokens (`purpose: 'api'`), kept in the database
     * apart from these runtime tokens: the same path resolves both.
     */
    private api?: { resolve(token: string): DataTokenScope | undefined };
    constructor(
        private ttlMs = 60 * 60_000,
        private shared?: SharedDataTokensOptions,
    ) {
        if (shared) {
            this.store = new SqliteDataTokenStore(shared.ownership.db);
        }
    }
    issue(scope: Omit<DataTokenScope, 'expiresAt'>, ttlMs = this.ttlMs) {
        const token = `${DATA_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
        const hash = digest(token);
        const full = { ...scope, expiresAt: Date.now() + ttlMs };
        if (!this.shared || !this.store) {
            this.scopes.set(hash, full);
            return token;
        }
        const { ownership } = this.shared;
        this.pending.set(hash, full);
        this.store.insert(hash, ownership.session.id, full, () => this.pending.delete(hash));
        // The issuer's heartbeat keeps its tokens alive.
        ownership.session.keepAlive();
        return token;
    }
    /**
     * One computer command's token, for `runMs` (at most `ttlMs`); the
     * caller revokes its `session` when the command returns. `reach`:
     * `person` on a person's own socio, `socio` on a company socio's shared
     * computer (`DataTokenScope.reach`).
     */
    forCommand(userId: string, dotId: string, runMs: number, reach: 'person' | 'socio') {
        const session = `computer:${dotId}:${randomUUID()}`;
        const token = this.issue(
            {
                userId,
                dotId,
                purpose: 'computer',
                session,
                ...(reach === 'socio' ? { reach } : {}),
            },
            Math.min(runMs, this.ttlMs),
        );
        this.commands.set(session, { dotId, token });
        return { token, session };
    }
    /**
     * The live command tokens on a Dot's computer, to redact from what it
     * sends back (CB-224). Kept in this process's memory: only the runtime
     * that ran the command sees its output.
     */
    commandTokens(dotId: string) {
        const live: string[] = [];
        for (const [session, entry] of this.commands) {
            // Live, even if it opens nothing now: still redacted.
            if (!this.resolveRuntime(entry.token)) {
                this.commands.delete(session);
            } else if (entry.dotId === dotId) {
                live.push(entry.token);
            }
        }
        return live;
    }
    refused(token: string) {
        for (const listener of this.refusals) {
            try {
                listener(token);
            } catch {
                // A listener's failure is its own.
            }
        }
    }
    onRefused(listener: (token: string) => void) {
        this.refusals.add(listener);
        return () => void this.refusals.delete(listener);
    }
    /** Whether a person is deactivated (the data space wires the workspace's). */
    private deactivated?: (userId: string) => boolean;
    /**
     * A computer command's or job run's token acts for its person: it
     * opens nothing once they are deactivated (CB-528), on its
     * next request, whether or not the deactivation reached this runtime.
     */
    useDeactivated(deactivated: (userId: string) => boolean) {
        this.deactivated = deactivated;
    }
    /** Where data API tokens resolve (the data space wires its own). */
    useApiTokens(api: { resolve(token: string): DataTokenScope | undefined }) {
        this.api = api;
    }
    /** The token's scope, if it is live: a runtime token, else an admin's data API token. */
    resolve(token: string | undefined): DataTokenScope | undefined {
        if (!token?.startsWith(DATA_TOKEN_PREFIX)) {
            return undefined;
        }
        const scope = this.resolveRuntime(token);
        if (scope && PERSON_PURPOSES.has(scope.purpose) && this.deactivated?.(scope.userId)) {
            return undefined;
        }
        if (scope || !this.api || !token.startsWith(`${DATA_TOKEN_PREFIX}${DATA_API_TOKEN_INFIX}`)) {
            return scope;
        }
        return this.api.resolve(token);
    }
    private resolveRuntime(token: string): DataTokenScope | undefined {
        const hash = digest(token);
        if (this.shared && this.store) {
            const { ownership } = this.shared;
            // Expiry on the wall clock, as in memory; liveness on the runtime's.
            const now = Date.now();
            const row = this.store.get(hash, now);
            if (row) {
                return ownership.instanceAlive(row.issuer) &&
                    ![...this.revoking].some((revoked) => revoked(row.scope, hash))
                    ? row.scope
                    : undefined;
            }
            const queued = this.pending.get(hash);
            return queued && queued.expiresAt > now && ownership.instanceAlive(ownership.session.id)
                ? queued
                : undefined;
        }
        const scope = this.scopes.get(hash);
        if (!scope) {
            return undefined;
        }
        if (scope.expiresAt <= Date.now()) {
            this.scopes.delete(hash);
            return undefined;
        }
        return scope;
    }
    /** Refused here until the shared delete has landed. */
    private tombstone(revoked: (scope: DataTokenScope, hash: string) => boolean) {
        this.revoking.add(revoked);
        return () => void this.revoking.delete(revoked);
    }
    revoke(token: string) {
        const hash = digest(token);
        this.scopes.delete(hash);
        this.pending.delete(hash);
        this.store?.deleteHash(
            hash,
            this.tombstone((_scope, other) => other === hash),
        );
    }
    /** Ends a session or run: every token issued for it, on every runtime. */
    revokeSession(session: string) {
        for (const scopes of [this.scopes, this.pending]) {
            for (const [hash, scope] of scopes) {
                if (scope.session === session) {
                    scopes.delete(hash);
                }
            }
        }
        this.store?.deleteSession(
            session,
            this.tombstone((scope) => scope.session === session),
        );
        this.commands.delete(session);
    }
    /** The Dot's computer stopped, or the Dot is gone: all of its tokens. */
    revokeDot(dotId: string, purposes?: readonly DataTokenScope['purpose'][]) {
        const revoked = (scope: DataTokenScope) =>
            scope.dotId === dotId && (!purposes || purposes.includes(scope.purpose));
        for (const scopes of [this.scopes, this.pending]) {
            for (const [hash, scope] of scopes) {
                if (revoked(scope)) {
                    scopes.delete(hash);
                }
            }
        }
        this.store?.deleteDot(dotId, purposes, this.tombstone(revoked));
        for (const [session, entry] of this.commands) {
            if ((entry.dotId === dotId && (!purposes || purposes.includes('computer'))) || !this.resolve(entry.token)) {
                this.commands.delete(session);
            }
        }
    }
    /** Live tokens (tests, the operator's view); never the tokens themselves. */
    count() {
        const now = Date.now();
        const live = (scopes: Map<string, DataTokenScope>) =>
            [...scopes.values()].filter((scope) => scope.expiresAt > now).length;
        if (!this.shared || !this.store) {
            return live(this.scopes);
        }
        const { ownership } = this.shared;
        let count = ownership.instanceAlive(ownership.session.id) ? live(this.pending) : 0;
        for (const { issuer, count: n } of this.store.unexpiredByIssuer(now)) {
            if (ownership.instanceAlive(issuer)) {
                count += n;
            }
        }
        return count;
    }
}
