import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/*
 * The Integrations context's migrations (CB-110): one set per module, as
 * they were, moved here unchanged from the modules' former stores so that
 * only this file and the context's repositories (integrations/infra) name
 * its tables. Changes to these tables come here, as new versions.
 */

/**
 * Telegram account links, link codes, group members and conversations,
 * the bot's reply messages, and forum topics' room bindings' codes and
 * unanswered senders (CB-214).
 */
export const telegramSchema: SchemaSet = {
    id: MODULE_IDS.telegram,
    migrations: [
        {
            version: 1,
            name: 'baseline',
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS telegram_link_codes(hash TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt INTEGER NOT NULL, usedAt INTEGER);
      CREATE TABLE IF NOT EXISTS telegram_links(telegramUserId TEXT PRIMARY KEY, userId TEXT NOT NULL UNIQUE, username TEXT, linkedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_members(chatId TEXT NOT NULL, userId TEXT NOT NULL, seenAt INTEGER NOT NULL, PRIMARY KEY (chatId, userId));
      CREATE TABLE IF NOT EXISTS telegram_threads(key TEXT PRIMARY KEY, threadId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, chatId TEXT NOT NULL, topicId TEXT, createdAt INTEGER NOT NULL);`);
            },
        },
        {
            // CB-145: which socio reply each of the bot's Telegram messages in a
            // direct message shows, so a reaction there reaches that reply.
            version: 2,
            name: 'reply messages',
            up: 'CREATE TABLE telegram_replies(chatId TEXT NOT NULL, messageId TEXT NOT NULL, threadId TEXT NOT NULL, replyId TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY (chatId, messageId))',
        },
        {
            // CB-214: forum topics bound to rooms. `telegram_room_codes`: the
            // one-time codes (stored hashed) a room admin, or a reader of a
            // legacy topic converting it, posts in the topic to prove they hold
            // both the room and the Telegram group. `telegram_topic_senders`:
            // who addressed the socio in a bound topic and was not answered (not
            // linked, not in the room, or the topic's room closed), each told
            // once, listed for the room's admins. Expand-only: new tables.
            version: 3,
            name: 'room topics',
            up: `CREATE TABLE telegram_room_codes(hash TEXT PRIMARY KEY, userId TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('bind','convert')), target TEXT NOT NULL CHECK(length(target) > 0), expiresAt INTEGER NOT NULL, usedAt INTEGER, createdAt INTEGER NOT NULL);
      CREATE INDEX telegram_room_codes_user ON telegram_room_codes(userId);
      CREATE TABLE telegram_topic_senders(sourceKey TEXT NOT NULL, roomId TEXT NOT NULL, telegramUserId TEXT NOT NULL, reason TEXT NOT NULL CHECK(reason IN ('unlinked','not_member','closed')), username TEXT, firstSeenAt INTEGER NOT NULL, lastSeenAt INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 1, noticedAt INTEGER, PRIMARY KEY (sourceKey, roomId, telegramUserId, reason));
      CREATE INDEX telegram_topic_senders_room ON telegram_topic_senders(roomId, lastSeenAt);`,
        },
    ],
};

/** Per-Dot web identity and the web-read audit (release 4). */
export const webSchema: SchemaSet = {
    id: 'web',
    migrations: [
        {
            version: 1,
            name: 'web identity and audit',
            up: `CREATE TABLE web_identity(dotId TEXT PRIMARY KEY, identity TEXT NOT NULL CHECK(identity IN ('agent','browser')), updatedAt INTEGER NOT NULL);
      CREATE TABLE web_audit(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, userId TEXT, method TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, status INTEGER, bytes INTEGER NOT NULL, outcome TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX web_audit_dot ON web_audit(dotId, createdAt);`,
        },
    ],
};

/** Per-Dot computer permissions and the audit trail. */
export const computersSchema: SchemaSet = {
    id: 'computers',
    migrations: [
        {
            version: 1,
            name: 'baseline',
            // Recorded before the formatting pass of v0.30.0 (dba875569), which
            // changed only the source's form: same DDL and data.
            formerChecksums: ['630cecf28134f364'],
            baseline: true,
            up: (db) => {
                db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
                // Who acted: the signed-in user, or the conversation owner for agent runs.
                if (
                    !db
                        .prepare('PRAGMA table_info(computer_audit)')
                        .all()
                        .some((field) => field.name === 'userId')
                ) {
                    db.exec('ALTER TABLE computer_audit ADD COLUMN userId TEXT');
                }
            },
        },
        {
            // Every row is kept (it used to keep the newest 1,000 finished ones
            // per Dot), so the Dot's latest page is read through an index
            // instead of a scan and sort.
            version: 2,
            name: 'audit index',
            up: 'CREATE INDEX computer_audit_dot ON computer_audit(dotId, createdAt)',
        },
    ],
};

/**
 * `domain_hosts`: the hostnames this module manages, the base pair and
 * provisioned ones, with the NPM and Cloudflare ids it used and whether it
 * created each (so `remove` deletes only what it created). `domain_ops`:
 * the audit of every operation, its steps and error (redacted).
 */
export const domainsSchema: SchemaSet = {
    id: MODULE_IDS.domains,
    migrations: [
        {
            version: 1,
            name: 'domains',
            up: `CREATE TABLE domain_hosts(hostname TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('base','custom')), dnsRecordId TEXT, dnsContent TEXT, dnsCreated INTEGER NOT NULL DEFAULT 0, certificateId INTEGER, certificateCreated INTEGER NOT NULL DEFAULT 0, proxyHostId INTEGER, proxyHostCreated INTEGER NOT NULL DEFAULT 0, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE domain_ops(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('ensure_base','provision','remove')), hostname TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','ok','failed')), steps TEXT NOT NULL DEFAULT '[]', error TEXT, startedAt INTEGER NOT NULL, finishedAt INTEGER);
      CREATE INDEX domain_ops_started ON domain_ops(startedAt);`,
        },
        {
            // Every operation is kept (it used to keep the newest 500), so a
            // hostname's last one is found through an index.
            version: 2,
            name: 'ops by host',
            up: 'CREATE INDEX domain_ops_host ON domain_ops(hostname, startedAt)',
        },
    ],
};
