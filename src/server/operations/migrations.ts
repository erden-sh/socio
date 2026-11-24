import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Operations (CB-164). Its numbers live in the analytics store; SQLite
 * keeps only what has no other source.
 * Version 1 (CB-188): `access_log`, each time an admin opened a person's
 * activity or a chat's content in Operations: who (`viewerId`), when,
 * from where (`surface`, the endpoint), about what (`subjectKind`,
 * `subjectId`: none for the whole workspace's rows), whether it showed
 * content, the range and filters as JSON, and the request's id. It is
 * append-only: triggers refuse every UPDATE and DELETE, so no code path
 * can edit the record.
 * Version 4 (CB-195, CB-196): `model_prices`, effective-dated prices per
 * provider and model, from the daily price sync (`sync:<source>`,
 * `catalog:<source>`) or an admin (`admin`), US dollars per million
 * tokens; `price_sync_runs`, each source's last run; `cost_pools` and
 * their `cost_meter_readings`, what self-hosted backends and
 * subscriptions cost, spread over their turns by the ETL; and
 * `cost_backends`, the app's copy of each backend's provider and model
 * (inference keeps its own tables), kept with `removedAt` after a backend
 * goes so its old turns stay priced.
 */
export const operationsSchema: SchemaSet = {
    id: MODULE_IDS.operations,
    migrations: [
        {
            version: 1,
            name: 'access log',
            up: `CREATE TABLE access_log(id TEXT PRIMARY KEY, at INTEGER NOT NULL, viewerId TEXT NOT NULL, surface TEXT NOT NULL CHECK(surface IS NOT NULL AND length(surface) BETWEEN 1 AND 64), subjectKind TEXT NOT NULL CHECK(subjectKind IS NOT NULL AND subjectKind IN ('person','chat','socio','run','space','workspace')), subjectId TEXT, content INTEGER NOT NULL CHECK(content IS NOT NULL AND content IN (0,1)), filters TEXT NOT NULL DEFAULT '{}', requestId TEXT NOT NULL, CHECK((subjectKind = 'workspace') = (subjectId IS NULL)));
      CREATE INDEX access_log_time ON access_log(at, id);
      CREATE INDEX access_log_viewer ON access_log(viewerId, surface, at);
      CREATE TRIGGER access_log_no_update BEFORE UPDATE ON access_log BEGIN SELECT RAISE(ABORT, 'The access log is append-only.'); END;
      CREATE TRIGGER access_log_no_delete BEFORE DELETE ON access_log BEGIN SELECT RAISE(ABORT, 'The access log is append-only.'); END;`,
        },
        {
            version: 2,
            name: 'resource samples and hourly rollups',
            up: `CREATE TABLE ops_samples(at INTEGER PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
      CREATE TABLE ops_samples_hourly(at INTEGER PRIMARY KEY, samples INTEGER NOT NULL CHECK(samples > 0), data TEXT NOT NULL CHECK(json_valid(data)), observedAt TEXT NOT NULL CHECK(json_valid(observedAt)));`,
        },
        {
            version: 3,
            name: 'resource scopes for computers',
            up: `ALTER TABLE ops_samples RENAME TO ops_samples_v2;
        CREATE TABLE ops_samples(scopeId TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(scopeId, at));
        INSERT INTO ops_samples(scopeId, at, data) SELECT '', at, data FROM ops_samples_v2;
        DROP TABLE ops_samples_v2;
        ALTER TABLE ops_samples_hourly RENAME TO ops_samples_hourly_v2;
        CREATE TABLE ops_samples_hourly(scopeId TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, samples INTEGER NOT NULL CHECK(samples > 0), data TEXT NOT NULL CHECK(json_valid(data)), observedAt TEXT NOT NULL CHECK(json_valid(observedAt)), PRIMARY KEY(scopeId, at));
        INSERT INTO ops_samples_hourly(scopeId, at, samples, data, observedAt) SELECT '', at, samples, data, observedAt FROM ops_samples_hourly_v2;
        DROP TABLE ops_samples_hourly_v2;
        CREATE INDEX ops_samples_time ON ops_samples(at);
        CREATE INDEX ops_samples_hourly_time ON ops_samples_hourly(at);`,
        },
        {
            version: 4,
            name: 'model prices and cost pools',
            compatible: 'Its unique index is on model_prices, a table it creates, which no older build uses (CB-108).',
            up: `CREATE TABLE model_prices(id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IS NOT NULL AND length(provider) BETWEEN 1 AND 64), model TEXT NOT NULL CHECK(model IS NOT NULL AND length(model) BETWEEN 1 AND 200), modelKey TEXT NOT NULL, inputPerM REAL NOT NULL CHECK(inputPerM IS NOT NULL AND inputPerM >= 0), cachedInputPerM REAL CHECK(cachedInputPerM IS NULL OR cachedInputPerM >= 0), outputPerM REAL NOT NULL CHECK(outputPerM IS NOT NULL AND outputPerM >= 0), reasoningPerM REAL CHECK(reasoningPerM IS NULL OR reasoningPerM >= 0), currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IS NOT NULL AND currency = 'USD'), effectiveFrom INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IS NOT NULL AND (source = 'admin' OR source LIKE 'sync:%' OR source LIKE 'catalog:%')), fetchedAt INTEGER NOT NULL);
      CREATE UNIQUE INDEX model_prices_entry ON model_prices(provider, model, source, effectiveFrom);
      CREATE INDEX model_prices_key ON model_prices(modelKey, effectiveFrom);
      CREATE TABLE price_sync_runs(source TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL CHECK(ok IS NOT NULL AND ok IN (0,1)), fetched INTEGER NOT NULL, matched INTEGER NOT NULL, stored INTEGER NOT NULL, error TEXT);
      CREATE TABLE cost_pools(id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(name IS NOT NULL AND length(name) BETWEEN 1 AND 120), kind TEXT NOT NULL CHECK(kind IS NOT NULL AND kind IN ('fixed','variable')), category TEXT NOT NULL CHECK(category IS NOT NULL AND category IN ('hardware','power','hosting','subscription','other')), amount REAL NOT NULL CHECK(amount IS NOT NULL AND amount >= 0), currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IS NOT NULL AND currency = 'USD'), period TEXT NOT NULL CHECK(period IS NOT NULL AND period IN ('hour','day','month','year')), depreciationMonths INTEGER CHECK(depreciationMonths IS NULL OR depreciationMonths > 0), startsAt INTEGER NOT NULL, endsAt INTEGER CHECK(endsAt IS NULL OR endsAt > startsAt), backendIds TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(backendIds)), allocation TEXT NOT NULL DEFAULT 'tokens' CHECK(allocation IS NOT NULL AND allocation IN ('tokens','gpu_seconds')), weights TEXT NOT NULL CHECK(json_valid(weights)), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE cost_meter_readings(id TEXT PRIMARY KEY, poolId TEXT NOT NULL, at INTEGER NOT NULL, quantity REAL NOT NULL CHECK(quantity IS NOT NULL AND quantity >= 0), unit TEXT NOT NULL CHECK(unit IS NOT NULL AND length(unit) BETWEEN 1 AND 32), unitPrice REAL CHECK(unitPrice IS NULL OR unitPrice >= 0));
      CREATE INDEX cost_meter_readings_pool ON cost_meter_readings(poolId, at);
      CREATE TABLE cost_backends(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IS NOT NULL AND kind IN ('shared','byo')), label TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, removedAt INTEGER, updatedAt INTEGER NOT NULL);`,
        },
    ],
};
