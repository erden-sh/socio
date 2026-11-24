import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { DATA_TOKEN_PREFIX } from '@socio/foundation/actors/redact';
import { DataError } from '@socio/foundation/dataspace/data-error';
import type { DataTokenScope } from '@socio/foundation/http/app-env';
import { WORKSPACE_OWNER_ID } from '@socio/shared/data-types';
import {
    DATA_API_SCOPES,
    DATA_API_TOKEN_DAYS_DEFAULT,
    DATA_API_TOKEN_DAYS_MAX,
    DATA_API_TOKEN_INFIX,
    DATA_API_TOKEN_STATEMENTS_PER_MINUTE,
    dataApiTokenActor,
    type CreatedDataApiToken,
    type DataApiScope,
    type DataApiTokenList,
    type DataApiTokenView,
} from '@socio/shared/dataspace/api-tokens';

import type { DataApiTokenRepository, DataApiTokenRow } from './domain/repositories.js';

const DAY_MS = 86_400_000;
/** How often a token's last use and count are written (not on every request). */
const TOUCH_MS = 60_000;
/** How often a token's use is summed up in the workspace audit, at most. */
export const DATA_API_USE_SUMMARY_MS = 15 * 60_000;
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
/** What a data API token's value starts with. */
export const DATA_API_TOKEN_PREFIX = `${DATA_TOKEN_PREFIX}${DATA_API_TOKEN_INFIX}`;

/** A line of the workspace audit about a token (`workspace_audit`). */
export interface DataApiTokenAuditLine {
    actor: string;
    action: 'create' | 'use' | 'revoke';
    targetKind: 'data_api_token';
    targetId: string;
    detail: string;
}

export interface DataApiTokensDeps {
    /** Whether this person is an admin now, and not deactivated. */
    activeAdmin(userId: string): boolean;
    /**
     * Whether this person was deactivated at or after `at` (the workspace
     * audit's line), so a token made before is dead for good even if they
     * were reactivated before it was used again.
     */
    deactivatedSince(userId: string, at: number): boolean;
    userName(userId: string): string | null;
    /** The workspace audit. */
    audit(line: DataApiTokenAuditLine): void;
    /** The most operations a minute a token may be given: the plugin budget's ceiling. */
    budgetMax: number;
}

/** What one token did since its last summary line. */
interface UseTally {
    requests: number;
    writes: number;
    refused: number;
    since: number;
    /** Requests not yet in its row's count. */
    unsaved: number;
    savedAt: number;
    summedAt: number;
}

/**
 * Admins' data API tokens: made in Settings by a workspace admin, shown
 * once, kept as SHA-256 hashes in `data_api_tokens`. A token resolves to
 * a data token scope (`purpose: 'api'`) on the data API's own token path;
 * every request reads its row, so a revoke or an expiry holds at once on
 * every runtime, and a token whose maker is no longer an active admin is
 * revoked for good. Making, revoking and a summary of each token's use
 * go to the workspace audit; each operation also to the data audit.
 */
export class DataApiTokens {
    private tallies = new Map<string, UseTally>();
    constructor(
        private repo: DataApiTokenRepository,
        private deps: DataApiTokensDeps,
    ) {}

    private view(row: DataApiTokenRow): DataApiTokenView {
        return {
            id: row.id,
            name: row.name,
            hint: row.hint,
            scopes: DATA_API_SCOPES.filter((scope) => row.scopes.includes(scope)),
            statementsPerMinute: row.statementsPerMinute,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
            createdByName: this.deps.userName(row.createdBy),
            expiresAt: row.expiresAt,
            lastUsedAt: row.lastUsedAt,
            uses: row.uses,
            revokedAt: row.revokedAt,
            revokedBy: row.revokedBy,
        };
    }
    private requireAdmin(userId: string) {
        if (!this.deps.activeAdmin(userId)) {
            throw new DataError('Only a workspace admin manages data API tokens.', 403);
        }
    }
    list(userId: string): DataApiTokenList {
        this.requireAdmin(userId);
        return {
            tokens: this.repo.all().map((row) => this.view(row)),
            scopes: DATA_API_SCOPES,
            daysDefault: DATA_API_TOKEN_DAYS_DEFAULT,
            daysMax: DATA_API_TOKEN_DAYS_MAX,
            statementsPerMinuteDefault: Math.min(DATA_API_TOKEN_STATEMENTS_PER_MINUTE, this.deps.budgetMax),
            statementsPerMinuteMax: this.deps.budgetMax,
        };
    }
    create(
        userId: string,
        input: { name: string; scopes: readonly DataApiScope[]; days?: number; statementsPerMinute?: number },
        now = Date.now(),
    ): CreatedDataApiToken {
        this.requireAdmin(userId);
        const name = input.name.trim();
        if (!name || name.length > 60) {
            throw new DataError('Name the token (1 to 60 characters).');
        }
        const scopes = DATA_API_SCOPES.filter((scope) => input.scopes.includes(scope));
        if (!scopes.length) {
            throw new DataError('Give the token at least one scope.');
        }
        const days = input.days ?? DATA_API_TOKEN_DAYS_DEFAULT;
        if (!Number.isInteger(days) || days < 1 || days > DATA_API_TOKEN_DAYS_MAX) {
            throw new DataError(`A token lives 1 to ${DATA_API_TOKEN_DAYS_MAX} days.`);
        }
        const max = this.deps.budgetMax;
        const budget = input.statementsPerMinute ?? Math.min(DATA_API_TOKEN_STATEMENTS_PER_MINUTE, max);
        if (!Number.isInteger(budget) || budget < 1 || budget > max) {
            throw new DataError(`A token’s budget is a whole number of operations a minute, 1 to ${max}.`);
        }
        const secret = randomBytes(32).toString('base64url');
        const token = `${DATA_API_TOKEN_PREFIX}${secret}`;
        const row: DataApiTokenRow = {
            id: randomUUID(),
            name,
            hint: secret.slice(0, 6),
            hash: digest(token),
            scopes: [...scopes],
            statementsPerMinute: budget,
            createdBy: userId,
            createdAt: now,
            expiresAt: now + days * DAY_MS,
            lastUsedAt: null,
            uses: 0,
            revokedAt: null,
            revokedBy: null,
        };
        this.repo.insertNow(row);
        this.deps.audit({
            actor: userId,
            action: 'create',
            targetKind: 'data_api_token',
            targetId: row.id,
            detail: `“${name}”: ${scopes.join(', ')}; ${days} day(s); ${budget} operations a minute`,
        });
        return { apiToken: this.view(row), token };
    }
    revoke(userId: string, id: string, now = Date.now()): DataApiTokenView {
        this.requireAdmin(userId);
        const row = this.repo.byId(id);
        if (!row) {
            throw new DataError('Token not found.', 404);
        }
        if (this.repo.revokeNow(id, now, userId)) {
            this.end(row, userId, 'revoked', now);
        }
        return this.view(this.repo.byId(id)!);
    }
    /** Its use so far, then the revoke, in the workspace audit. */
    private end(row: DataApiTokenRow, by: string, why: string, now: number) {
        this.summarize(row.id, now, true);
        this.tallies.delete(row.id);
        this.deps.audit({
            actor: by,
            action: 'revoke',
            targetKind: 'data_api_token',
            targetId: row.id,
            detail: `“${row.name}” ${why}`,
        });
    }
    /**
     * Revokes every live token a person made, for good: when they are
     * deactivated or stop being an admin. Returns their names.
     */
    revokeMadeBy(userId: string, by: string, why: string, now = Date.now()): string[] {
        return this.repo.revokeMadeByNow(userId, now, by).map((row) => {
            this.end(row, by, `revoked: ${why}`, now);
            return row.name;
        });
    }
    /**
     * Revokes, for good, every live token whose maker is not an active
     * admin now: after a change that can take admin away without a
     * per-person event (the access policy, the admin list at boot).
     */
    revokeWhereMakerInactive(now = Date.now()): string[] {
        const makers = new Set(
            this.repo
                .all()
                .filter((row) => row.revokedAt === null && !this.deps.activeAdmin(row.createdBy))
                .map((row) => row.createdBy),
        );
        return [...makers].flatMap((maker) =>
            this.revokeMadeBy(maker, 'system', 'its maker is no longer an active admin', now),
        );
    }
    /**
     * The data token scope a live token stands for: not revoked, not
     * expired, its maker still an active admin. A token whose maker isn't
     * is revoked for good, by the system, so a later promotion doesn't
     * bring it back.
     */
    resolve(token: string | undefined, now = Date.now()): DataTokenScope | undefined {
        if (!token?.startsWith(DATA_API_TOKEN_PREFIX)) {
            return undefined;
        }
        const row = this.repo.byHash(digest(token));
        if (!row || row.revokedAt !== null || row.expiresAt <= now) {
            return undefined;
        }
        if (!this.deps.activeAdmin(row.createdBy) || this.deps.deactivatedSince(row.createdBy, row.createdAt)) {
            if (this.repo.revokeNow(row.id, now, 'system')) {
                this.end(row, 'system', 'revoked: whoever made it is no longer an active admin', now);
            }
            return undefined;
        }
        return {
            userId: WORKSPACE_OWNER_ID,
            dotId: '',
            purpose: 'api',
            session: `api-token:${row.id}`,
            apiToken: {
                id: row.id,
                createdBy: row.createdBy,
                scopes: DATA_API_SCOPES.filter((scope) => row.scopes.includes(scope)),
                statementsPerMinute: Math.min(row.statementsPerMinute, this.deps.budgetMax),
            },
            expiresAt: row.expiresAt,
        };
    }
    /**
     * Counts one request of a token, once it is answered: its row's count
     * and last use at most once a minute, and a summary line in the
     * workspace audit at most every `DATA_API_USE_SUMMARY_MS` (the first
     * use at once).
     */
    used(id: string, outcome: { write: boolean; status: number }, now = Date.now()) {
        let tally = this.tallies.get(id);
        if (!tally) {
            tally = { requests: 0, writes: 0, refused: 0, since: now, unsaved: 0, savedAt: 0, summedAt: 0 };
            this.tallies.set(id, tally);
        }
        tally.requests++;
        tally.unsaved++;
        if (outcome.status >= 400) {
            tally.refused++;
        } else if (outcome.write) {
            tally.writes++;
        }
        if (tally.savedAt + TOUCH_MS <= now) {
            this.repo.recordUse(id, now, tally.unsaved);
            tally.unsaved = 0;
            tally.savedAt = now;
        }
        if (tally.summedAt + DATA_API_USE_SUMMARY_MS <= now) {
            this.summarize(id, now);
        }
    }
    /** Writes the token's use since its last line, if any; `final`: its last. */
    private summarize(id: string, now: number, final = false) {
        const tally = this.tallies.get(id);
        if (!tally) {
            return;
        }
        if (tally.unsaved) {
            this.repo.recordUse(id, now, tally.unsaved);
            tally.unsaved = 0;
            tally.savedAt = now;
        }
        if (!tally.requests) {
            return;
        }
        const row = this.repo.byId(id);
        this.deps.audit({
            actor: dataApiTokenActor(id),
            action: 'use',
            targetKind: 'data_api_token',
            targetId: id,
            detail: `${row ? `“${row.name}”, made by ${row.createdBy}: ` : ''}${tally.requests} request(s) since ${new Date(tally.since).toISOString()}: ${tally.writes} write(s), ${tally.refused} refused${final ? '; its last' : ''}`,
        });
        Object.assign(tally, { requests: 0, writes: 0, refused: 0, since: now, summedAt: now });
    }
    /** Writes every pending summary (shutdown, tests). */
    flush(now = Date.now()) {
        for (const id of this.tallies.keys()) {
            this.summarize(id, now);
        }
    }
}
