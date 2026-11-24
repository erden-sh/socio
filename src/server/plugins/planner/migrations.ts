import type { SchemaSet } from '@socio/data/migrate';

/**
 * The planner's posts, reply queue and voice notes. Not part of the boot
 * schema list: these tables appear when the plugin is installed, and on
 * later boots only if that install row is still there. Uninstalling the
 * plugin does not drop them.
 */
export const plannerSchema: SchemaSet = {
    id: 'social-strategy',
    migrations: [
        {
            version: 1,
            name: 'social planner',
            up: `CREATE TABLE planned_posts(id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('idea','draft','ready','scheduled-for-manual-posting','posted','skipped')), account TEXT NOT NULL, plannedAt INTEGER NOT NULL, topic TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', parts TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE INDEX planned_posts_when ON planned_posts(plannedAt);
CREATE TABLE reply_queue(id TEXT PRIMARY KEY, sourceUrl TEXT NOT NULL, sourceId TEXT NOT NULL, author TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', draft TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('todo','replied','skip')), createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE planner_voice(id TEXT PRIMARY KEY CHECK(id = 'voice'), notes TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL);`,
        },
        {
            version: 2,
            name: 'reply excerpt',
            up: `ALTER TABLE reply_queue ADD COLUMN excerpt TEXT NOT NULL DEFAULT '';`,
        },
    ],
};
