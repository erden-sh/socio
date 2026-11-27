import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * The cloud connection's tables (CB-382). The identity itself stays one
 * sealed secret setting (`CLOUD_IDENTITY_SETTING`); these hold what the
 * reply reports need. Expand-only.
 *
 * - `cloud_outbox`: what waits to go to a cloud service, one row per item.
 *   Today only `ai-report`, a confirmed reply report: `id` is the report's
 *   own id (a UUIDv7, its idempotency key at the collector), `payload` the
 *   report's body sealed under the settings' data key, snapshotted when it
 *   was made and cleared once it is sent or has failed. The conversation,
 *   message and person never leave: they are here for the unique key (one
 *   report per person and reply) and the reactions' marks. A row is sent
 *   under a lease (`leaseId`, `leaseUntil`), so two runtimes never send it
 *   twice; `withdrawnAt` marks one withdrawn while a send was in flight.
 * - `cloud_settings`: the workspace's cloud settings by key (today
 *   `reply-reports`: sharing, its consent id, since when and by whom).
 */
export const cloudSchema: SchemaSet = {
    id: MODULE_IDS.cloud,
    migrations: [
        {
            version: 1,
            name: 'cloud outbox and settings',
            phase: 'expand',
            compatible: 'Its unique index is on cloud_outbox, a table it creates, which no older build uses (CB-108).',
            up: `
CREATE TABLE cloud_outbox(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN('ai-report')),threadId TEXT NOT NULL,messageId TEXT NOT NULL,userId TEXT NOT NULL,payload TEXT,createdAt INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,nextAt INTEGER NOT NULL,sentAt INTEGER,failedAt INTEGER,lastError TEXT,leaseId TEXT,leaseUntil INTEGER,withdrawnAt INTEGER);
CREATE UNIQUE INDEX cloud_outbox_one_report ON cloud_outbox(threadId,messageId,userId,kind);
CREATE INDEX cloud_outbox_due ON cloud_outbox(nextAt,createdAt) WHERE sentAt IS NULL AND failedAt IS NULL;
CREATE INDEX cloud_outbox_user ON cloud_outbox(userId);
CREATE TABLE cloud_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updatedAt INTEGER NOT NULL);
`,
        },
    ],
};
