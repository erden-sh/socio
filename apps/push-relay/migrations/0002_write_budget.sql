-- The D1 write budget (src/write-budget.ts): one row per UTC minute (Unix minutes) with
-- the billed rows written charged to it, so the budget holds across every Cloudflare location,
-- which the rate-limiting binding can't promise. No address, id or anything else about the caller
-- is kept. `minute` is the rowid, so the counter has no index to write. The daily cron drops rows
-- older than an hour.
CREATE TABLE write_budget (
    minute INTEGER PRIMARY KEY,
    spent INTEGER NOT NULL
);
