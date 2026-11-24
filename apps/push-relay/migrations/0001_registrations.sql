-- The registrations: one row per phone and workspace.
-- Nothing else about a phone is kept, and nothing is written per push. `refreshed_on` is a UTC date, not a time,
-- so the table holds no push or refresh timing; rows not refreshed in 60 days are dropped.
-- No index but the primary key's: each index is a billed write per row written, and the daily
-- cron scans the table instead (src/write-budget.ts).
CREATE TABLE registrations (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    native_token TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    apns_env TEXT CHECK (apns_env IN ('sandbox', 'production')),
    vapid_key TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    refreshed_on TEXT NOT NULL
);
