import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Approvals: policies per (user, Dot, capability), requests with the
 * payload their handler runs on approval, and an audit of every request,
 * decision and policy change. Migration 2 adds the `auto` policy, the
 * user's standing guidance for it, a record of every auto review and the
 * state a handler keeps to undo an auto-approved action. CB-58 (migration 3)
 * records the turn that asked, how the Dot carried on after the user's
 * decision, and the hidden notes those continuation turns started with.
 * CB-209 (migration 5) records the work cycle each request was asked in.
 * CB-232 (migration 6) adds consumable requests: bound to an intent digest
 * and a grant, used once, and a record of the person opening long details.
 */
export const approvalsSchema: SchemaSet = {
    id: MODULE_IDS.approvals,
    migrations: [
        {
            version: 1,
            name: 'approvals',
            up: `CREATE TABLE approval_policies(userId TEXT NOT NULL, dotId TEXT NOT NULL, capability TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('manual','bypass')), updatedAt INTEGER NOT NULL, PRIMARY KEY(userId, dotId, capability));
      CREATE TABLE approval_requests(id TEXT PRIMARY KEY, userId TEXT NOT NULL, dotId TEXT NOT NULL, capability TEXT NOT NULL, summary TEXT NOT NULL, details TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL, threadId TEXT, status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired','failed')), decidedVia TEXT, outcome TEXT, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL, decidedAt INTEGER);
      CREATE INDEX approval_requests_user ON approval_requests(userId, status, createdAt);
      CREATE TABLE approval_audit(id TEXT PRIMARY KEY, userId TEXT NOT NULL, dotId TEXT NOT NULL, capability TEXT NOT NULL, requestId TEXT, event TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX approval_audit_user ON approval_audit(userId, createdAt);`,
        },
        {
            version: 2,
            name: 'auto approvals',
            up: `CREATE TABLE approval_policies_v2(userId TEXT NOT NULL, dotId TEXT NOT NULL, capability TEXT NOT NULL, policy TEXT NOT NULL CHECK(policy IN ('manual','bypass','auto')), updatedAt INTEGER NOT NULL, PRIMARY KEY(userId, dotId, capability));
      INSERT INTO approval_policies_v2(userId, dotId, capability, policy, updatedAt) SELECT userId, dotId, capability, policy, updatedAt FROM approval_policies;
      DROP TABLE approval_policies;
      ALTER TABLE approval_policies_v2 RENAME TO approval_policies;
      ALTER TABLE approval_requests ADD COLUMN undoData TEXT;
      CREATE TABLE approval_guidance(userId TEXT PRIMARY KEY, guidance TEXT NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE approval_auto_decisions(id TEXT PRIMARY KEY, requestId TEXT NOT NULL, userId TEXT NOT NULL, dotId TEXT NOT NULL, capability TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('approved','denied','escalated')), cause TEXT NOT NULL, modelDecision TEXT, risk TEXT, reason TEXT NOT NULL, model TEXT, backend TEXT, latencyMs INTEGER, inputHash TEXT, undoneAt INTEGER, undoOutcome TEXT, createdAt INTEGER NOT NULL);
      CREATE INDEX approval_auto_request ON approval_auto_decisions(requestId);
      CREATE INDEX approval_auto_dot ON approval_auto_decisions(dotId, verdict, createdAt);
      CREATE INDEX approval_auto_user ON approval_auto_decisions(userId, capability, createdAt);`,
        },
        {
            version: 3,
            name: 'continuations',
            up: `ALTER TABLE approval_requests ADD COLUMN runId TEXT;
      ALTER TABLE approval_requests ADD COLUMN continuation TEXT;
      ALTER TABLE approval_requests ADD COLUMN continuationId TEXT;
      ALTER TABLE approval_requests ADD COLUMN continuationDetail TEXT;
      CREATE INDEX approval_requests_thread ON approval_requests(threadId, status);
      CREATE TABLE approval_notes(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, userId TEXT NOT NULL, content TEXT NOT NULL, createdAt INTEGER NOT NULL);`,
        },
        {
            // A Dot's audit, newest first (the admins' Dots page).
            version: 4,
            name: 'audit by dot',
            up: 'CREATE INDEX approval_audit_dot ON approval_audit(dotId, createdAt)',
        },
        {
            // CB-209: the work cycle a request was asked in, so the socio carries
            // on in it after the decision (its budget, its acting person), and
            // a room's requests can be found by conversation and person.
            version: 5,
            name: 'request cycle',
            up: `ALTER TABLE approval_requests ADD COLUMN cycleId TEXT;
      CREATE INDEX approval_requests_thread_user ON approval_requests(threadId, userId, status);`,
        },
        {
            // CB-232: a consumable request is bound to an intent digest and
            // a binding (a grant), used once through the consume call;
            // `openedAt` records that the person opened its full details.
            // Expand only: nullable columns and a plain index, so the previous
            // release keeps running on it (CB-108).
            version: 6,
            name: 'consumable approvals',
            up: `ALTER TABLE approval_requests ADD COLUMN digest TEXT;
      ALTER TABLE approval_requests ADD COLUMN bindingId TEXT;
      ALTER TABLE approval_requests ADD COLUMN consumedAt INTEGER;
      ALTER TABLE approval_requests ADD COLUMN openedAt INTEGER;
      CREATE INDEX approval_requests_binding ON approval_requests(bindingId, status);`,
        },
    ],
};
