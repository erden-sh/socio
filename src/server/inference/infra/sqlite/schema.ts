import { primaryKey, sqliteTable } from 'drizzle-orm/sqlite-core';

import { enumText, flag, id, int, json, ms, str } from '@socio/data/columns.sqlite';
import type { BackendTest, InferenceCapabilities, OpenAICompatibleConfig } from '@socio/shared/inference';

/**
 * The Inference context's tables (CB-110), as `inference/migrations.ts`
 * makes them: the typed mirror the repositories query. The migrations stay
 * the source of truth; tests/inference-repositories.test.ts holds these to
 * them. Secrets are sealed text here (`SecretBox`).
 */

export const inferenceBackends = sqliteTable('inference_backends', {
    id: id().primaryKey(),
    kind: str().notNull(),
    label: str().notNull(),
    enabled: flag().notNull(),
    config: json<OpenAICompatibleConfig>().notNull(),
    /** The sealed `{ apiKey }`. */
    secrets: str(),
    capabilities: json<InferenceCapabilities>().notNull(),
    lastTest: json<BackendTest>(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
});

/** Key and value; `envSeed` is sealed. */
export const inferenceSettings = sqliteTable('inference_settings', {
    key: str().primaryKey(),
    value: str().notNull(),
});

export const userInferenceConnections = sqliteTable(
    'user_inference_connections',
    {
        userId: id().notNull(),
        kind: str().notNull(),
        /** Sealed. */
        credentials: str().notNull(),
        meta: json<Record<string, unknown>>().notNull(),
        createdAt: ms().notNull(),
        updatedAt: ms().notNull(),
        /**
         * Cross-runtime refresh lease (per-user providers step 5): the ms
         * timestamp until which another runtime is refreshing this
         * connection's token. 0 when no lease is held. A runtime acquires
         * the lease with a CAS update before refreshing a single-use refresh
         * token, so two runtimes don't both spend it.
         */
        refreshLeasedUntil: int().notNull().default(0),
        /** Which runtime holds the lease (a short id); null when none. */
        refreshLeasedBy: str(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.kind] })],
);

/** Response times per model: numbers only, never content. */
export const inferenceTimings = sqliteTable('inference_timings', {
    key: str().notNull(),
    round: enumText(['first', 'next']).notNull(),
    at: ms().notNull(),
    promptChars: int(),
    promptTokens: int().notNull(),
    uncachedTokens: int().notNull(),
    ttftMs: int().notNull(),
});

/** Every table Inference owns (the drift and boundary tests). */
export const inferenceTables = [
    inferenceBackends,
    inferenceSettings,
    userInferenceConnections,
    inferenceTimings,
] as const;
