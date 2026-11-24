/**
 * The facts Activity and Value read besides turns and messages (CB-190):
 * approvals, reactions, Space writes and kept memories, copied from their
 * modules' tables. Sessions and their outcomes are not stored: they are
 * derived from these and `f_message` when asked, so a new session gap or
 * time zone needs no rebuild. A change here needs `ETL_VERSION` bumped.
 */

/** One row per approval event (`approval_audit`), with its request's chat. */
export const APPROVAL_DDL = `CREATE TABLE f_approval (
  id VARCHAR NOT NULL,
  happened_at BIGINT NOT NULL,
  request_id VARCHAR,
  thread_id VARCHAR,
  socio_id VARCHAR NOT NULL,
  person_id VARCHAR NOT NULL,
  capability VARCHAR NOT NULL,
  event VARCHAR NOT NULL
)`;

/** People's reactions to messages (`message_reactions`), read whole. */
export const REACTION_DDL = `CREATE TABLE f_reaction (
  thread_id VARCHAR NOT NULL,
  message_id VARCHAR NOT NULL,
  person_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  reacted_at BIGINT NOT NULL
)`;

/**
 * Writes to Spaces' pages: a page made (`pages`) or an edit (each kept
 * revision, `page_revisions`). `author_kind` is person or socio. A page
 * made from a chat has that chat: one its socio wrote (create_space_page,
 * or an approved draft), or a person's "Save as page".
 */
export const SPACE_WRITE_DDL = `CREATE TABLE f_space_write (
  kind VARCHAR NOT NULL,
  ref VARCHAR NOT NULL,
  written_at BIGINT NOT NULL,
  space_id VARCHAR NOT NULL,
  page_id VARCHAR NOT NULL,
  author_kind VARCHAR,
  author_id VARCHAR,
  thread_id VARCHAR
)`;

/** Memories made in a chat (`memories` with a thread), read whole. */
export const MEMORY_DDL = `CREATE TABLE f_memory (
  id VARCHAR NOT NULL,
  thread_id VARCHAR NOT NULL,
  person_id VARCHAR,
  status VARCHAR NOT NULL,
  kept_at BIGINT NOT NULL,
  deleted_at BIGINT
)`;
