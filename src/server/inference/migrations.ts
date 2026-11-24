import type { SchemaSet } from '@socio/data/migrate';

/**
 * Inference backends, the workspace's inference settings (default backend,
 * allowed bring-your-own kinds, the env seed), users' own connections and
 * response times per model (version 2).
 * New in release 3, so version 1 is a plain migration. Secrets are sealed
 * (`SecretBox`): `inference_backends.secrets`,
 * `user_inference_connections.credentials` and the `envSeed` setting.
 */
export const inferenceSchema: SchemaSet = {
    id: 'inference',
    migrations: [
        {
            version: 1,
            name: 'backends, settings and user connections',
            up: `CREATE TABLE inference_backends(id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, secrets TEXT, capabilities TEXT NOT NULL, lastTest TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE inference_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE user_inference_connections(userId TEXT NOT NULL, kind TEXT NOT NULL, credentials TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY(userId, kind));`,
        },
        {
            // Response times per model (InferenceTimings): numbers only.
            version: 2,
            name: 'response times',
            up: `CREATE TABLE inference_timings(key TEXT NOT NULL, round TEXT NOT NULL, at INTEGER NOT NULL, promptChars INTEGER, promptTokens INTEGER NOT NULL, uncachedTokens INTEGER NOT NULL, ttftMs INTEGER NOT NULL);
      CREATE INDEX inference_timings_key ON inference_timings(key, at);`,
        },
        {
            // Cross-runtime refresh lease (per-user providers step 5): a short
            // lease so two gateway runtimes don't both spend a single-use
            // refresh token. The lease is on the connection row itself; a
            // runtime acquires it with a CAS update before refreshing, and
            // clears it (or lets it expire) after.
            version: 3,
            name: 'refresh lease on connections',
            up: `ALTER TABLE user_inference_connections ADD COLUMN refreshLeasedUntil INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE user_inference_connections ADD COLUMN refreshLeasedBy TEXT;`,
        },
    ],
};
