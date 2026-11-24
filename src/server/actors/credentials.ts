import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from '@socio/data/open';
import { deriveKey, sha256Hex } from '@socio/foundation/actors/keys';
import {
    ACTOR_CREDENTIAL_PREFIX,
    GATEWAY_CREDENTIAL_PREFIX,
    OBO_PREFIX,
    REFERENCE_TOKEN,
    isContinuationToken,
} from '@socio/foundation/actors/tokens';
import { closeScopes, parseAudience, type Audience } from '@socio/shared/actor-scopes';

import type { ActorAudit } from './audit.js';
import {
    ActorAccessError,
    type ActorCredentialsShape,
    type CredentialKind,
    type GrantRecord,
    type HolderCheck,
    type HolderChecksShape,
    type HolderKind,
    type IssueCredential,
    type OboClaims,
    type ResolvedCredential,
} from './contract.js';
import { ContextRows, CredentialRows, GrantRows } from './infra/sqlite/rows.js';

/**
 * Socio-actor credentials (CB-232):
 *
 * - `cbsa_` (an app browser context's), `cbgw_` (a coding prompt run's)
 *   and continuations: 32 random bytes, base64url, behind their prefix.
 *   Only their SHA-256 is kept, in `actor_credentials`, bound to the work
 *   that holds them, so either runtime of a deploy accepts what the other
 *   issued and a runtime that drains takes nothing with it.
 * - `cbob_v1.<sealed>`: the on-behalf-of token the apps proxy mints for
 *   every request. Self-contained (AES-256-GCM under a key from the
 *   instance secret), never stored, opaque to the app; verified by opening
 *   it and then reading the grant or app session row it names, so it dies
 *   with that row.
 *
 * A continuation is a `cbob_` reference token: `cbob_` + 43 chars,
 * no dot. Both `cbob_` forms travel in `x-cb-obo`.
 */

const PREFIX: Record<CredentialKind, string> = {
    cbsa: ACTOR_CREDENTIAL_PREFIX,
    cbgw: GATEWAY_CREDENTIAL_PREFIX,
    continuation: OBO_PREFIX,
};
const OBO_SEALED = /^cbob_v1\.([A-Za-z0-9_-]{40,2048})$/;

/** Lifetimes. */
export const CREDENTIAL_TTL_MS = {
    /** `cbsa_`: 15 minutes, renewed by the context's owner at 10. */
    cbsa: 15 * 60_000,
    /** `cbgw_`: the prompt limit (20 minutes) plus 5 minutes (CB-239). */
    cbgw: 25 * 60_000,
    /** Continuations: as asked, never past the grant. */
    continuation: 8 * 60 * 60_000,
};
/** A `cbob_` lives for the proxy's request time limit plus 60 s. */
export const OBO_GRACE_MS = 60_000;

/**
 * Liveness checks for holder kinds other than `context` (its row, read
 * here) and `grant` (the grant itself), by the module that owns that work.
 * A kind with no check registered is refused (fail closed). CB-239's
 * coding sessions register `prompt-run` (a run is live while it runs and
 * its session hasn't ended), so a run that ended can't leave a credential
 * alive until its TTL.
 */
export class HolderChecks implements HolderChecksShape {
    private checks = new Map<HolderKind, HolderCheck>();
    /** Registers `kind`'s check (one per kind); returns its removal. */
    register(kind: Exclude<HolderKind, 'context' | 'grant'>, check: HolderCheck) {
        if (this.checks.has(kind)) {
            throw new Error(`A ${kind} holder check is already registered.`);
        }
        this.checks.set(kind, check);
        return () => {
            if (this.checks.get(kind) === check) {
                this.checks.delete(kind);
            }
        };
    }
    /**
     * Replaces `kind`'s check, whoever registered it, and returns the undo:
     * for tests that drive the gateways with stand-in prompt runs (no
     * `coding_runs` rows). Production code registers, never overrides.
     */
    override(kind: Exclude<HolderKind, 'context' | 'grant'>, check: HolderCheck) {
        const before = this.checks.get(kind);
        this.checks.set(kind, check);
        return () => {
            if (this.checks.get(kind) !== check) {
                return;
            }
            if (before) {
                this.checks.set(kind, before);
            } else {
                this.checks.delete(kind);
            }
        };
    }
    /** Whether `kind`'s holder `id` is live; false when nothing can tell. */
    live(kind: HolderKind, id: string) {
        const check = this.checks.get(kind);
        if (!check) {
            return false;
        }
        try {
            return check(id) === true;
        } catch {
            return false;
        }
    }
}

export interface ActorCredentialsOptions {
    /** The instance secret every runtime holds (SESSION_SECRET). */
    secret: string;
    audit: ActorAudit;
    /** This runtime's id, recorded for diagnosis only (never liveness). */
    runtimeId: string;
    /** Whether every live runtime enforces this contract. */
    issuable: () => boolean;
    now?: () => number;
}

export class ActorCredentials implements ActorCredentialsShape {
    /** Liveness of the work credentials are bound to (`HolderChecks`). */
    readonly holders = new HolderChecks();
    private rows: CredentialRows;
    private grants: GrantRows;
    private contexts: ContextRows;
    private sealKey: Buffer;
    private now: () => number;
    constructor(
        private db: DatabaseSync,
        private options: ActorCredentialsOptions,
    ) {
        this.rows = new CredentialRows(db);
        this.grants = new GrantRows(db);
        this.contexts = new ContextRows(db);
        this.sealKey = deriveKey(options.secret, 'actor-obo-seal');
        this.now = options.now ?? Date.now;
    }

    /**
     * A new credential for live work under a live grant. Its row and its
     * `credential` audit row are one transaction. Refused while a live
     * runtime enforces an older actor-access contract.
     */
    async issue(input: IssueCredential): Promise<{
        token: string;
        hash: string;
        expiresAt: number;
    }> {
        if (!this.options.issuable()) {
            throw new ActorAccessError('contract_outdated', 'Socio access waits until every server runs this version.');
        }
        const { grant, kind } = input;
        const now = this.now();
        if (grant.revokedAt !== null) {
            throw new ActorAccessError('grant_revoked', 'This access was revoked.');
        }
        if (grant.expiresAt <= now) {
            throw new ActorAccessError('grant_expired', 'This access has expired.');
        }
        this.checkAudiences(kind, input.audiences, grant);
        const granted = closeScopes(grant.scopes);
        const scopes = input.scopes ? closeScopes(input.scopes) : granted;
        if (!scopes.length || scopes.some((scope) => !granted.includes(scope))) {
            throw new ActorAccessError('scope_insufficient', 'A credential can’t carry more than its grant.');
        }
        const ttl = Math.min(input.ttlMs ?? CREDENTIAL_TTL_MS[kind], CREDENTIAL_TTL_MS[kind]);
        const expiresAt = Math.min(now + ttl, grant.expiresAt);
        if (expiresAt <= now) {
            throw new ActorAccessError('grant_expired', 'This access has expired.');
        }
        const token = `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`;
        const hash = sha256Hex(token);
        await transaction(this.db, 'issue actor credential', () => {
            const current = this.grants.get(grant.id);
            if (!current || current.revokedAt !== null) {
                throw new ActorAccessError('grant_revoked', 'This access was revoked.');
            }
            if (input.holder.kind === 'context') {
                const context = this.contexts.get(input.holder.id);
                if (!context || context.closedAt !== null || context.grantId !== grant.id) {
                    throw new ActorAccessError('context_closed', 'That context is closed.');
                }
            }
            this.rows.insert({
                hash,
                kind,
                grantId: grant.id,
                audiences: [...input.audiences],
                scopes,
                contextId: input.contextId,
                holderKind: input.holder.kind,
                holderId: input.holder.id,
                issuedAt: now,
                expiresAt,
                issuedBy: this.options.runtimeId,
            });
            this.options.audit.recordIn({
                at: now,
                correlationId: input.correlationId,
                phase: 'credential',
                decision: 'allow',
                personId: grant.personId,
                socioId: grant.socioId,
                grantId: grant.id,
                actorBy: 'system',
                audience: input.audiences.join(' '),
                resourceKind: kind,
                resourceId: input.holder.id,
            });
        });
        return { token, hash, expiresAt };
    }

    private checkAudiences(kind: CredentialKind, audiences: readonly Audience[], grant: GrantRecord) {
        const fits =
            audiences.length > 0 &&
            audiences.every((audience) => grant.audiences.includes(audience)) &&
            (kind === 'cbgw'
                ? audiences.every((audience) => parseAudience(audience)?.kind === 'gateway')
                : audiences.length === 1 && ['app', 'plugin'].includes(parseAudience(audiences[0])?.kind ?? ''));
        if (!fits) {
            throw new ActorAccessError('audience_mismatch', 'That credential can’t be issued for this audience.');
        }
    }

    /**
     * A reference token's row and grant, in order:
     * shape, a hash lookup, expiry, the audience it is presented to, and
     * the work that holds it still being live. Authorization comes after.
     */
    resolve(token: string | undefined, expect: { kind: CredentialKind; audience?: Audience }): ResolvedCredential {
        if (!token || !REFERENCE_TOKEN.test(token) || !token.startsWith(PREFIX[expect.kind])) {
            return { ok: false, reason: 'credential_invalid' };
        }
        const credential = this.rows.get(sha256Hex(token));
        if (!credential || credential.kind !== expect.kind) {
            return { ok: false, reason: 'credential_invalid' };
        }
        if (credential.expiresAt <= this.now()) {
            return { ok: false, reason: 'credential_expired' };
        }
        if (expect.audience && !credential.audiences.includes(expect.audience)) {
            return { ok: false, reason: 'audience_mismatch' };
        }
        if (credential.holderKind === 'context') {
            const context = this.contexts.get(credential.holderId);
            if (!context || context.closedAt !== null) {
                return { ok: false, reason: 'context_closed' };
            }
        } else if (
            credential.holderKind !== 'grant' &&
            // Any other holder (a prompt run) only while its owner says it is
            // live; fail closed without a check.
            !this.holders.live(credential.holderKind, credential.holderId)
        ) {
            return { ok: false, reason: 'context_closed' };
        }
        const grant = this.grants.get(credential.grantId);
        if (!grant) {
            return { ok: false, reason: 'grant_missing' };
        }
        if (grant.revokedAt !== null) {
            return { ok: false, reason: 'grant_revoked' };
        }
        return { ok: true, credential, grant };
    }

    /** Ends one credential (its prompt returned, a renewal replaced it). */
    revokeToken(token: string) {
        if (!REFERENCE_TOKEN.test(token)) {
            return Promise.resolve(0);
        }
        const hash = sha256Hex(token);
        return transaction(this.db, 'revoke actor credential', () => this.rows.deleteHash(hash));
    }

    /** Ends every credential a piece of work holds (a prompt run ended). */
    revokeHolder(kind: HolderKind, id: string) {
        return transaction(this.db, 'revoke actor credentials of work', () => this.rows.deleteHolder(kind, id));
    }

    /** When the newest credential a holder has expires (for renewal). */
    newestExpiry(kind: HolderKind, id: string) {
        return this.rows.newestExpiry(kind, id);
    }

    /** Drops expired rows (the leader's sweep). */
    pruneExpired() {
        return transaction(this.db, 'prune actor credentials', () => this.rows.deleteExpired(this.now()));
    }

    /**
     * A `cbob_` for one proxied request: bound to the app and to the
     * actor (a grant, or a person's app session by its hash), opaque to the
     * app, valid for `ttlMs` (the proxy's request limit) plus 60 s.
     */
    mintObo(input: Omit<OboClaims, 'issuedAt' | 'expiresAt'> & { ttlMs: number }) {
        if (!!input.grantId === !!input.sessionHash) {
            throw new Error('A cbob_ names exactly one of a grant or a session.');
        }
        const issuedAt = this.now();
        const claims = {
            v: 1,
            a: input.appId,
            ...(input.grantId ? { g: input.grantId } : { s: input.sessionHash }),
            r: input.requestId,
            i: issuedAt,
            e: issuedAt + Math.max(0, input.ttlMs) + OBO_GRACE_MS,
        };
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.sealKey, iv);
        cipher.setAAD(Buffer.from('cbob\u0000v1'));
        const body = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
        return `${OBO_PREFIX}v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
    }

    /**
     * A request-bound `cbob_`'s claims, when it opens under this instance's
     * key, is unexpired and is for `appId`. The caller then reads the grant
     * (`authorize`) or app session row it names: the token carries no
     * authority the row doesn't.
     */
    openObo(token: string | undefined, appId: string): OboClaims | undefined {
        const match = OBO_SEALED.exec(token ?? '');
        if (!match) {
            return undefined;
        }
        const raw = Buffer.from(match[1], 'base64url');
        if (raw.length < 12 + 16 + 2) {
            return undefined;
        }
        try {
            const decipher = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, 12));
            decipher.setAAD(Buffer.from('cbob\u0000v1'));
            decipher.setAuthTag(raw.subarray(raw.length - 16));
            const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
                'utf8',
            );
            const claims = JSON.parse(text) as {
                v?: unknown;
                a?: unknown;
                g?: unknown;
                s?: unknown;
                r?: unknown;
                i?: unknown;
                e?: unknown;
            };
            if (
                claims.v !== 1 ||
                claims.a !== appId ||
                typeof claims.r !== 'string' ||
                typeof claims.i !== 'number' ||
                typeof claims.e !== 'number' ||
                claims.e <= this.now() ||
                (typeof claims.g === 'string') === (typeof claims.s === 'string')
            ) {
                return undefined;
            }
            return {
                appId: claims.a,
                ...(typeof claims.g === 'string' ? { grantId: claims.g } : { sessionHash: claims.s as string }),
                requestId: claims.r,
                issuedAt: claims.i,
                expiresAt: claims.e,
            };
        } catch {
            return undefined;
        }
    }

    /** Whether a token is a continuation (a `cbob_` reference token). */
    static isContinuation(token: string | undefined) {
        return isContinuationToken(token);
    }
}
