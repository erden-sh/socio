import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * CB-292: one pending name suggestion per chat at a time, plus the message
 * index at which a suggestion was last rejected (the K=30 cooldown) and the
 * state of a settled suggestion for the inline card's review.
 *
 * One row per chat (`threadId`). A suggestion is `pending` until an
 * authorized reviewer accepts, rejects or customizes it; `rejectedAt`
 * records the message index at which a reject happened, so a re-suggest is
 * suppressed for `REJECT_COOLDOWN_MESSAGES`. Accepted/customized rows keep
 * the settled name for the audit card, then are cleared by the next trigger.
 */
export const chatNamesSchema: SchemaSet = {
    id: MODULE_IDS.chatNames,
    migrations: [
        {
            version: 1,
            name: 'chat name suggestions',
            up: `CREATE TABLE chat_name_suggestions(
        threadId TEXT PRIMARY KEY CHECK(length(threadId) > 0),
        suggestedName TEXT NOT NULL CHECK(length(suggestedName) > 0),
        trigger TEXT NOT NULL CHECK(trigger IN ('unnamed','drift')),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','customized')),
        suggestedAtMessageIndex INTEGER NOT NULL CHECK(suggestedAtMessageIndex >= 0),
        rejectedAtMessageIndex INTEGER NOT NULL DEFAULT -1,
        createdAt INTEGER NOT NULL,
        settledAt INTEGER
      );
      CREATE INDEX chat_name_suggestions_status ON chat_name_suggestions(status) WHERE status = 'pending';`,
        },
    ],
};
