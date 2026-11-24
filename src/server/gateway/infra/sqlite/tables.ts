import type { Migration } from '@socio/data/migrate';

/**
 * The model gateway's tables (CB-239), all new, so this is an
 * expand migration. Nothing here holds a prompt, a completion, a tool
 * argument or a token: usage is counts and metadata only.
 *
 * - `gateway_models`: Settings → Coding → Models, the only names the
 *   gateway serves. `outsideProvider` NULL follows the backend's address.
 * - `gateway_model_repositories`: the repositories an admin allowed an
 *   outside-provider model for.
 * - `gateway_limits`: an admin's limits over the env defaults.
 * - `gateway_reservations`: what a request in flight holds against every
 *   budget at once, naming the runtime that serves it, so in-flight caps
 *   hold across runtimes and a dead runtime's are settled.
 * - `gateway_usage`: one row per settled request.
 * - `gateway_dropped_fields`: request field names the gateway dropped, per
 *   session, for its diagnostics; never values.
 */
export const gatewayModelMigrations: readonly Migration[] = [
    {
        version: 1,
        name: 'coding models, limits, reservations and usage',
        phase: 'expand',
        up: `CREATE TABLE gateway_models(
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
        backendId TEXT NOT NULL,
        upstreamModel TEXT NOT NULL CHECK(length(upstreamModel) BETWEEN 1 AND 200),
        maxOutputTokens INTEGER NOT NULL CHECK(maxOutputTokens > 0),
        contextWindow INTEGER,
        acceptsImages INTEGER NOT NULL DEFAULT 0,
        outsideProvider INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL);
      CREATE TABLE gateway_model_repositories(
        modelId TEXT NOT NULL,
        repository TEXT NOT NULL,
        allowedBy TEXT NOT NULL,
        allowedAt INTEGER NOT NULL,
        PRIMARY KEY(modelId, repository));
      CREATE TABLE gateway_limits(
        key TEXT PRIMARY KEY,
        value INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        updatedBy TEXT NOT NULL);
      CREATE TABLE gateway_reservations(
        id TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        personId TEXT NOT NULL,
        socioId TEXT NOT NULL,
        grantId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        backendId TEXT NOT NULL,
        runtimeId TEXT NOT NULL,
        promptTokens INTEGER NOT NULL CHECK(promptTokens >= 0),
        completionTokens INTEGER NOT NULL CHECK(completionTokens >= 0),
        createdAt INTEGER NOT NULL);
      CREATE INDEX gateway_reservations_session ON gateway_reservations(sessionId);
      CREATE INDEX gateway_reservations_person ON gateway_reservations(personId);
      CREATE INDEX gateway_reservations_socio ON gateway_reservations(socioId);
      CREATE INDEX gateway_reservations_runtime ON gateway_reservations(runtimeId);
      CREATE TABLE gateway_usage(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        sessionId TEXT NOT NULL,
        personId TEXT NOT NULL,
        socioId TEXT NOT NULL,
        grantId TEXT NOT NULL,
        modelId TEXT NOT NULL,
        backendId TEXT NOT NULL,
        promptTokens INTEGER NOT NULL CHECK(promptTokens >= 0),
        completionTokens INTEGER NOT NULL CHECK(completionTokens >= 0),
        cachedTokens INTEGER NOT NULL DEFAULT 0 CHECK(cachedTokens >= 0),
        estimated INTEGER NOT NULL DEFAULT 0,
        latencyMs INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(length(status) <= 32));
      CREATE INDEX gateway_usage_session ON gateway_usage(sessionId);
      CREATE INDEX gateway_usage_person ON gateway_usage(personId, at);
      CREATE INDEX gateway_usage_socio ON gateway_usage(socioId, at);
      CREATE INDEX gateway_usage_at ON gateway_usage(at);
      CREATE TABLE gateway_dropped_fields(
        sessionId TEXT NOT NULL,
        field TEXT NOT NULL CHECK(length(field) <= 64),
        count INTEGER NOT NULL,
        lastAt INTEGER NOT NULL,
        PRIMARY KEY(sessionId, field));`,
    },
];
