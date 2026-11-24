/**
 * The analytics store's Knowledge, storage and capability tables
 * (CB-191), beside CB-187's (`schema.ts`). Times are ms since the epoch;
 * no page text, revision body, search query or request wording is copied:
 * titles, lengths and counts only. A change here needs `ETL_VERSION`
 * bumped (`analytics/steps.ts`).
 */

/**
 * Live pages now, by SQLite's row key (what the covering index lists),
 * with their use: replaced row by row as pages change.
 */
export const PAGE_DDL = [
    `CREATE TABLE d_page (row_key BIGINT NOT NULL, page_id VARCHAR NOT NULL, space_id VARCHAR NOT NULL, title VARCHAR NOT NULL, chars BIGINT NOT NULL, revision INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, created_by VARCHAR)`,
    `CREATE TABLE d_page_use (page_id VARCHAR NOT NULL, used_at BIGINT NOT NULL)`,
    // Search timings per UTC day, and each day's histogram (bucket → count).
    `CREATE TABLE f_search_day (day_at BIGINT NOT NULL, queries INTEGER NOT NULL, empty INTEGER NOT NULL, corrected INTEGER NOT NULL, trigram INTEGER NOT NULL, max_us BIGINT NOT NULL)`,
    `CREATE TABLE f_search_latency (day_at BIGINT NOT NULL, bucket INTEGER NOT NULL, n BIGINT NOT NULL)`,
];

/** One row per kept page revision: an edit, by a person or a socio. */
export const PAGE_EDIT_DDL = [
    `CREATE TABLE f_page_edit (revision_id BIGINT NOT NULL, page_id VARCHAR NOT NULL, space_id VARCHAR NOT NULL, author_kind VARCHAR NOT NULL, author_id VARCHAR, edited_at BIGINT NOT NULL)`,
];

/**
 * One row per dataset access (`data_audit`), without target or detail;
 * `thread_id`: the chat a socio's tool acted in (CB-194).
 */
export const DATA_ACCESS_DDL = [
    `CREATE TABLE f_data_access (id VARCHAR NOT NULL, accessed_at BIGINT NOT NULL, owner_id VARCHAR NOT NULL, actor_kind VARCHAR NOT NULL, actor_id VARCHAR, socio_id VARCHAR, dataset_id VARCHAR, action VARCHAR NOT NULL, outcome VARCHAR NOT NULL, thread_id VARCHAR)`,
];

/** Each dataset's sizes per UTC day (`data_dataset_days`). */
export const DATASET_DAY_DDL = [
    `CREATE TABLE f_dataset_day (dataset_id VARCHAR NOT NULL, day_at BIGINT NOT NULL, size_bytes BIGINT NOT NULL, history_bytes BIGINT NOT NULL, tables INTEGER NOT NULL, measured_at BIGINT NOT NULL)`,
];

/**
 * What is stored: datasets now, every kind's items by the hours they were
 * made and deleted, each person's live files and the database file.
 */
export const STORAGE_DDL = [
    `CREATE TABLE d_dataset (id VARCHAR PRIMARY KEY, owner_id VARCHAR NOT NULL, name VARCHAR NOT NULL, scratch BOOLEAN NOT NULL, size_bytes BIGINT NOT NULL, history_bytes BIGINT NOT NULL, tables INTEGER NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, deleted_at BIGINT)`,
    `CREATE TABLE s_lifetime (kind VARCHAR NOT NULL, created_at BIGINT NOT NULL, deleted_at BIGINT, items BIGINT NOT NULL, bytes BIGINT NOT NULL)`,
    `CREATE TABLE s_owner_files (owner_id VARCHAR NOT NULL, files BIGINT NOT NULL, bytes BIGINT NOT NULL, largest BIGINT NOT NULL)`,
    `CREATE TABLE s_database (bytes BIGINT NOT NULL, free_bytes BIGINT NOT NULL, agent_runs_bytes BIGINT, measured_at BIGINT NOT NULL, agent_runs_at BIGINT)`,
];

/** Capability requests, one row per request with its askers counted. */
export const REQUEST_DDL = [
    `CREATE TABLE f_request (issue_id VARCHAR NOT NULL, number INTEGER, title VARCHAR, status VARCHAR, capability VARCHAR NOT NULL, created_at BIGINT NOT NULL, requesters INTEGER NOT NULL, socios INTEGER NOT NULL, people INTEGER NOT NULL, last_at BIGINT NOT NULL)`,
];
