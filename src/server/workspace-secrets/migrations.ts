import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Socio Secrets: secrets, their sealed versions and their grants to workloads.
 * Expand-only. A secret is soft-deleted (`deletedAt`, CB-64) and its versions
 * stay sealed; grants are access, so they are deleted outright, with an audit
 * line first.
 */
export const workspaceSecretsSchema: SchemaSet = {
    id: MODULE_IDS.workspaceSecrets,
    migrations: [
        {
            version: 1,
            name: 'workspace secrets, sealed versions and grants to workloads',
            phase: 'expand',
            compatible:
                'Its unique index is on workspace_secrets, a table it creates, which no older build uses (CB-108).',
            up: `
CREATE TABLE workspace_secrets(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN('workspace','workload')),workloadKind TEXT,workloadId TEXT,description TEXT NOT NULL DEFAULT '',createdBy TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,lastReadAt INTEGER,lastReadBy TEXT,deletedAt INTEGER,deletedBy TEXT,deletedWith TEXT,CHECK((scope='workspace' AND workloadId IS NULL) OR (scope='workload' AND workloadKind IS NOT NULL AND workloadId IS NOT NULL)));
CREATE UNIQUE INDEX workspace_secrets_live_name ON workspace_secrets(scope,ifnull(workloadKind,''),ifnull(workloadId,''),name) WHERE deletedAt IS NULL;
CREATE INDEX workspace_secrets_workload ON workspace_secrets(workloadKind,workloadId);
CREATE TABLE workspace_secret_versions(secretId TEXT NOT NULL,version INTEGER NOT NULL,sealed TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('current','previous','retired')),retireAt INTEGER,setBy TEXT NOT NULL,setAt INTEGER NOT NULL,lastReadAt INTEGER,PRIMARY KEY(secretId,version));
CREATE TABLE workspace_secret_grants(secretId TEXT NOT NULL,workloadKind TEXT NOT NULL,workloadId TEXT NOT NULL,grantedBy TEXT NOT NULL,grantedAt INTEGER NOT NULL,PRIMARY KEY(secretId,workloadKind,workloadId));
CREATE INDEX workspace_secret_grants_workload ON workspace_secret_grants(workloadKind,workloadId);
`,
        },
        {
            // Read flags for admins, from the audit lines. One open flag per
            // finding (`dedupKey`); dismissing one keeps the row, so the
            // record stays and nothing is deleted.
            version: 2,
            name: 'workspace secret read flags',
            phase: 'expand',
            compatible:
                'Its unique index is on workspace_secret_flags, a table it creates, which no older build uses (CB-108).',
            up: `
CREATE TABLE workspace_secret_flags(id TEXT PRIMARY KEY,rule TEXT NOT NULL,dedupKey TEXT NOT NULL,workloadKind TEXT NOT NULL,workloadId TEXT NOT NULL,secretId TEXT,explanation TEXT NOT NULL,firstSeenAt INTEGER NOT NULL,lastSeenAt INTEGER NOT NULL,notifiedAt INTEGER,dismissedAt INTEGER,dismissedBy TEXT);
CREATE UNIQUE INDEX workspace_secret_flags_open ON workspace_secret_flags(dedupKey) WHERE dismissedAt IS NULL;
CREATE INDEX workspace_secret_flags_secret ON workspace_secret_flags(secretId);
`,
        },
    ],
};
