import type { SchemaSet } from '@socio/data/migrate';

/**
 * Socio-actor access's tables (CB-232), all new, so this is an
 * expand migration. Nothing here holds a token: credentials are kept by
 * SHA-256 hash, `cbob_` and proofs not at all.
 *
 * - `socio_grants`: a person's approval of one socio for one audience (or
 *   the coding gateways' pair), in one conversation, for a bounded time.
 *   Revocation is a row change every runtime sees.
 * - `actor_credentials`: `cbsa_`, `cbgw_` and continuations by hash, bound
 *   to the work that holds them (a context, a prompt run, the grant), not
 *   to the runtime that issued them.
 * - `actor_contexts`: broker contexts and coding sandboxes, each a
 *   `runtime_work` lease handed over on a drain.
 * - `actor_audit`: append-only by trigger.
 */
export const actorsSchema: SchemaSet = {
    id: 'actors',
    migrations: [
        {
            version: 1,
            name: 'socio grants, credentials, contexts and audit',
            phase: 'expand',
            compatible:
                'The triggers refuse UPDATE and DELETE on actor_audit, a table this same migration creates; no earlier release reads or writes it.',
            up: `CREATE TABLE socio_grants(
        id TEXT PRIMARY KEY,
        personId TEXT NOT NULL CHECK(length(personId) > 0),
        socioId TEXT NOT NULL CHECK(length(socioId) > 0),
        audiences TEXT NOT NULL,
        scopes TEXT NOT NULL,
        resources TEXT,
        conversationId TEXT NOT NULL CHECK(length(conversationId) > 0),
        conversationKind TEXT NOT NULL CHECK(conversationKind IN ('private','room','schedule')),
        task TEXT NOT NULL DEFAULT '' CHECK(length(task) <= 500),
        policyVersion TEXT NOT NULL DEFAULT '',
        approvalId TEXT,
        createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        idleMs INTEGER NOT NULL CHECK(idleMs > 0),
        lastUsedAt INTEGER NOT NULL,
        revokedAt INTEGER,
        revokedBy TEXT,
        revokeReason TEXT,
        replacedBy TEXT,
        CHECK(expiresAt > createdAt),
        CHECK((revokedAt IS NULL) = (revokedBy IS NULL)),
        CHECK((revokedAt IS NULL) = (revokeReason IS NULL)));
      CREATE INDEX socio_grants_person ON socio_grants(personId, createdAt);
      CREATE INDEX socio_grants_socio ON socio_grants(socioId);
      CREATE INDEX socio_grants_conversation ON socio_grants(conversationId);
      CREATE INDEX socio_grants_live ON socio_grants(expiresAt) WHERE revokedAt IS NULL;
      CREATE TABLE actor_credentials(
        hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('cbsa','cbgw','continuation')),
        grantId TEXT NOT NULL,
        audiences TEXT NOT NULL,
        scopes TEXT NOT NULL,
        contextId TEXT NOT NULL,
        holderKind TEXT NOT NULL CHECK(holderKind IN ('context','prompt-run','grant')),
        holderId TEXT NOT NULL,
        issuedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL,
        issuedBy TEXT NOT NULL,
        CHECK(expiresAt > issuedAt));
      CREATE INDEX actor_credentials_grant ON actor_credentials(grantId);
      CREATE INDEX actor_credentials_holder ON actor_credentials(holderKind, holderId);
      CREATE TABLE actor_contexts(
        id TEXT PRIMARY KEY,
        grantId TEXT NOT NULL,
        personId TEXT NOT NULL,
        socioId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('browser','sandbox')),
        audience TEXT NOT NULL,
        worker TEXT,
        openedAt INTEGER NOT NULL,
        closedAt INTEGER,
        closeReason TEXT,
        CHECK((closedAt IS NULL) = (closeReason IS NULL)));
      CREATE INDEX actor_contexts_open ON actor_contexts(kind, closedAt);
      CREATE INDEX actor_contexts_grant ON actor_contexts(grantId);
      CREATE TABLE actor_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        correlationId TEXT NOT NULL CHECK(length(correlationId) BETWEEN 1 AND 64),
        phase TEXT NOT NULL CHECK(phase IN ('grant','credential','decision','approval','outcome','revoke','context','setting')),
        decision TEXT CHECK(decision IN ('allow','deny')),
        reason TEXT CHECK(reason IS NULL OR (length(reason) <= 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
        personId TEXT,
        socioId TEXT,
        grantId TEXT,
        actorBy TEXT,
        audience TEXT,
        action TEXT CHECK(action IS NULL OR length(action) <= 100),
        tier TEXT,
        resourceKind TEXT,
        resourceId TEXT CHECK(resourceId IS NULL OR length(resourceId) <= 200),
        status TEXT CHECK(status IS NULL OR length(status) <= 32),
        digest TEXT CHECK(digest IS NULL OR digest NOT GLOB '*[^0-9a-f]*'),
        detail TEXT CHECK(detail IS NULL OR length(detail) <= 2000));
      CREATE INDEX actor_audit_person ON actor_audit(personId, at);
      CREATE INDEX actor_audit_grant ON actor_audit(grantId, at);
      CREATE INDEX actor_audit_correlation ON actor_audit(correlationId);
      CREATE TRIGGER actor_audit_append_only_update BEFORE UPDATE ON actor_audit
        BEGIN SELECT RAISE(ABORT, 'actor_audit is append-only'); END;
      CREATE TRIGGER actor_audit_append_only_delete BEFORE DELETE ON actor_audit
        BEGIN SELECT RAISE(ABORT, 'actor_audit is append-only'); END;`,
        },
    ],
};
