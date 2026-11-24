import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { SchemaSet } from '@socio/data/migrate';
import { transactionSync } from '@socio/data/open';
import type { AgentActor } from '@socio/foundation/agents/actor';
import { clientHost } from '@socio/foundation/agents/clients';
import { RateLimits } from '@socio/foundation/http/rate-limits';
import type { AgentGrantAdminView, AgentGrantView } from '@socio/shared/agent-grants';
import { AGENT_SCOPES, isGrantableScope } from '@socio/shared/agents/scopes';

import { AgentGrantError, type AgentTokenResolver, type GrantsShape, type NewGrant } from './contract.js';

/**
 * Grants (CB-90): one person's approval of one external agent, made on the
 * consent screen. The OAuth provider's tokens carry the grant's id (their
 * `referenceId`); revoking the grant deletes them at once. Effective access
 * is the grant's scopes, and then the person's role, applied by the MCP
 * side.
 */
export const agentGrantsSchema: SchemaSet = {
    id: 'agent-grants',
    migrations: [
        {
            version: 1,
            name: 'grants',
            up: `CREATE TABLE agent_grants(grantId TEXT PRIMARY KEY, userId TEXT NOT NULL CHECK(length(userId) > 0), authUserId TEXT NOT NULL CHECK(length(authUserId) > 0), clientId TEXT NOT NULL CHECK(length(clientId) > 0), clientName TEXT NOT NULL CHECK(length(clientName) > 0), clientDomain TEXT, localApp INTEGER NOT NULL CHECK(localApp IN (0, 1)), label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80), scopes TEXT NOT NULL, resource TEXT NOT NULL, redirectUri TEXT NOT NULL, createdAt INTEGER NOT NULL, lastUsedAt INTEGER, expiresAt INTEGER, revokedAt INTEGER, revokedBy TEXT,
        CHECK((localApp = 1) = (clientDomain IS NULL)),
        CHECK((revokedAt IS NULL) = (revokedBy IS NULL)));
      CREATE INDEX agent_grants_user ON agent_grants(userId, createdAt);
      CREATE TABLE agent_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
        },
    ],
};

/** Prefixes of agents' tokens, so scanners and logs can tell them apart. */
export const AGENT_ACCESS_TOKEN_PREFIX = 'cbat_';
export const AGENT_REFRESH_TOKEN_PREFIX = 'cbrt_';
/** How the provider stores tokens (`storeTokens`): SHA-256, by type. */
export const hashAgentToken = (token: string, type: string) =>
    createHash('sha256').update(`${type}:${token}`).digest('base64url');
/** How often a grant's last use is written (not on every request). */
const TOUCH_MS = 60_000;
/** Requests per grant and minute. */
const GRANT_REQUESTS_PER_MINUTE = 300;
const ALLOWED_DOMAINS = 'allowedClientDomains';

type GrantRow = {
    grantId: string;
    userId: string;
    authUserId: string;
    clientId: string;
    clientName: string;
    clientDomain: string | null;
    localApp: number;
    label: string;
    scopes: string;
    resource: string;
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number | null;
    revokedAt: number | null;
    revokedBy: string | null;
};

/** Better Auth stores dates as ISO text in SQLite, and arrays as JSON. */
const time = (value: unknown) => (typeof value === 'number' ? value : Date.parse(String(value ?? '')));
const list = (value: unknown): string[] => {
    if (Array.isArray(value)) {
        return value.map(String);
    }
    if (typeof value !== 'string' || !value) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
            return parsed.map(String);
        }
    } catch {
        // Not JSON: a comma list.
    }
    return value.split(',').filter(Boolean);
};
const normalizeDomain = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, '');

export class AgentGrants implements GrantsShape {
    private touched = new Map<string, number>();
    private limits = new RateLimits(GRANT_REQUESTS_PER_MINUTE, 60_000);
    constructor(private db: DatabaseSync) {}

    private view(row: GrantRow): AgentGrantView {
        return {
            grantId: row.grantId,
            userId: row.userId,
            clientId: row.clientId,
            clientName: row.clientName,
            clientDomain: row.clientDomain,
            localApp: !!row.localApp,
            label: row.label,
            scopes: JSON.parse(row.scopes) as string[],
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt,
            revokedAt: row.revokedAt,
            revokedBy: row.revokedBy,
        };
    }

    /** Records an approval; its tokens follow from the consent. */
    create(input: NewGrant, now = Date.now()): AgentGrantView {
        const grantId = randomUUID();
        const scopes = [
            ...AGENT_SCOPES.filter((scope) => input.scopes.includes(scope)),
            ...input.scopes.filter(
                (scope) => !(AGENT_SCOPES as readonly string[]).includes(scope) && isGrantableScope(scope),
            ),
        ];
        this.db
            .prepare(
                'INSERT INTO agent_grants (grantId, userId, authUserId, clientId, clientName, clientDomain, localApp, label, scopes, resource, redirectUri, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
                grantId,
                input.userId,
                input.authUserId,
                input.clientId,
                input.clientName.slice(0, 100),
                input.clientDomain,
                input.clientDomain === null ? 1 : 0,
                input.label.trim().slice(0, 80) || input.clientName.slice(0, 80),
                JSON.stringify(scopes),
                input.resource,
                input.redirectUri,
                now,
            );
        return this.get(grantId)!;
    }
    /** Drops a grant whose consent did not go through (no tokens exist). */
    discard(grantId: string) {
        this.db.prepare('DELETE FROM agent_grants WHERE grantId=?').run(grantId);
    }

    get(grantId: string): AgentGrantView | undefined {
        const row = this.db.prepare('SELECT * FROM agent_grants WHERE grantId=?').get(grantId) as GrantRow | undefined;
        return row && this.view(row);
    }
    /** A person's live grants, newest first. */
    list(userId: string, now = Date.now()): AgentGrantView[] {
        return (
            this.db
                .prepare(
                    'SELECT * FROM agent_grants WHERE userId=? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt>?) ORDER BY createdAt DESC, grantId',
                )
                .all(userId, now) as unknown as GrantRow[]
        ).map((row) => this.view(row));
    }
    /** Everyone's live grants, for admins, newest first. */
    listAll(now = Date.now()): AgentGrantAdminView[] {
        return (
            this.db
                .prepare(
                    `SELECT g.*, coalesce(u.name, g.userId) AS personName FROM agent_grants g LEFT JOIN users u ON u.id = g.userId
           WHERE g.revokedAt IS NULL AND (g.expiresAt IS NULL OR g.expiresAt>?) ORDER BY g.createdAt DESC, g.grantId`,
                )
                .all(now) as unknown as (GrantRow & { personName: string })[]
        ).map((row) => ({ ...this.view(row), personName: row.personName }));
    }

    /**
     * Revokes a grant (`owner`: only if it is theirs) and deletes its access
     * and refresh tokens and its stored consent, so nothing it was given
     * works from now on. Deleting rather than marking them keeps the plugin's
     * reuse detection, which ends every token of the client and person, from
     * reaching the person's other grants. `by` is the app user who revoked.
     */
    revoke(grantId: string, by: string, owner?: string, now = Date.now()): AgentGrantView {
        const grant = this.get(grantId);
        if (!grant || (owner !== undefined && grant.userId !== owner)) {
            throw new AgentGrantError('Connected agent not found.', 404);
        }
        transactionSync(this.db, 'revoke agent grant', () => {
            this.db
                .prepare('UPDATE agent_grants SET revokedAt=?, revokedBy=? WHERE grantId=? AND revokedAt IS NULL')
                .run(now, by, grantId);
            this.deleteTokens(grantId);
        });
        return this.get(grantId)!;
    }
    private deleteTokens(grantId: string) {
        for (const sql of [
            'DELETE FROM auth_oauth_access_token WHERE referenceId=?',
            'DELETE FROM auth_oauth_refresh_token WHERE referenceId=?',
            'DELETE FROM auth_oauth_consent WHERE referenceId=?',
        ]) {
            this.db.prepare(sql).run(grantId);
        }
    }
    /** How many grants `revokeAllOf` would revoke now (a deactivation preview). */
    countOf(userId: string, now = Date.now()) {
        return this.list(userId, now).length;
    }
    /** Revokes all of a person's grants (a deactivation). Returns how many. */
    revokeAllOf(userId: string, by: string, now = Date.now()) {
        const grants = this.list(userId, now);
        for (const grant of grants) {
            this.revoke(grant.grantId, by, userId, now);
        }
        return grants.length;
    }

    /** The allowlist of client domains; null when off (any domain). */
    allowedDomains(): string[] | null {
        const row = this.db.prepare('SELECT value FROM agent_settings WHERE key=?').get(ALLOWED_DOMAINS) as
            | { value: string }
            | undefined;
        return row ? (JSON.parse(row.value) as string[]) : null;
    }
    setAllowedDomains(domains: readonly string[] | null) {
        if (domains === null) {
            this.db.prepare('DELETE FROM agent_settings WHERE key=?').run(ALLOWED_DOMAINS);
            return null;
        }
        const clean = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
        if (clean.some((domain) => !/^[a-z0-9.-]+$/.test(domain))) {
            throw new AgentGrantError('Enter domains such as claude.ai.');
        }
        this.db
            .prepare(
                'INSERT INTO agent_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            )
            .run(ALLOWED_DOMAINS, JSON.stringify(clean));
        return clean;
    }
    /**
     * Whether a client may connect: with an allowlist, its metadata
     * document's host (or a subdomain of it) must be on it. For a local app
     * that host is only what it claims.
     */
    clientAllowed(clientId: string) {
        const allowed = this.allowedDomains();
        if (!allowed) {
            return true;
        }
        const host = clientHost(clientId);
        return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
    }

    /**
     * The agent and person behind an access token for `resource`, or null:
     * the token must be live and for that resource, its grant live and for
     * its client, and its person active (not deactivated). Records the
     * grant's use, at most once a minute.
     */
    resolve: AgentTokenResolver = async (token, resource) => this.resolveNow(token, resource);

    resolveNow(token: string, resource: string, now = Date.now()): AgentActor | null {
        if (!token.startsWith(AGENT_ACCESS_TOKEN_PREFIX)) {
            return null;
        }
        const row = this.db
            .prepare(
                `SELECT t.clientId AS tokenClient, t.userId AS tokenUser, t.resources AS tokenResources, t.scopes AS tokenScopes,
           t.expiresAt AS tokenExpires, t.revoked AS tokenRevoked, g.*, u.appUserId, coalesce(u.banned, 0) AS banned
         FROM auth_oauth_access_token t
         JOIN agent_grants g ON g.grantId = t.referenceId
         JOIN auth_user u ON u.id = t.userId
         WHERE t.token=?`,
            )
            .get(hashAgentToken(token.slice(AGENT_ACCESS_TOKEN_PREFIX.length), 'access_token')) as
            | (GrantRow & {
                  tokenClient: string;
                  tokenUser: string;
                  tokenResources: string | null;
                  tokenScopes: string;
                  tokenExpires: string | number;
                  tokenRevoked: string | null;
                  appUserId: string | null;
                  banned: number;
              })
            | undefined;
        if (
            !row ||
            row.tokenRevoked ||
            !(time(row.tokenExpires) > now) ||
            row.revokedAt !== null ||
            (row.expiresAt !== null && row.expiresAt <= now) ||
            row.tokenClient !== row.clientId ||
            row.tokenUser !== row.authUserId ||
            row.appUserId !== row.userId ||
            row.banned ||
            row.resource !== resource ||
            !list(row.tokenResources).includes(resource) ||
            !this.clientAllowed(row.clientId)
        ) {
            return null;
        }
        const granted = JSON.parse(row.scopes) as string[];
        const issued = list(row.tokenScopes);
        const scopes = granted.filter((scope) => isGrantableScope(scope) && issued.includes(scope));
        if (!scopes.length) {
            return null;
        }
        if ((this.touched.get(row.grantId) ?? 0) + TOUCH_MS <= now) {
            this.touched.set(row.grantId, now);
            this.db.prepare('UPDATE agent_grants SET lastUsedAt=? WHERE grantId=?').run(now, row.grantId);
        }
        return {
            grantId: row.grantId,
            clientId: row.clientId,
            clientName: row.clientName,
            clientDomain: row.clientDomain,
            label: row.label,
            userId: row.userId,
            scopes,
        };
    }

    /** Counts one request of a grant; false once over its per-minute limit. */
    take(grantId: string, now = Date.now()) {
        return this.limits.take(grantId, now);
    }
}

/** A resolver over this database (the MCP endpoint's). */
export const agentTokenResolver = (db: DatabaseSync): AgentTokenResolver => new AgentGrants(db).resolve;
