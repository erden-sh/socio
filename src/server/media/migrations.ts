import type { SchemaSet } from '@socio/data/migrate';
import { MODULE_IDS } from '@socio/shared/modules';

/**
 * Chat attachments (CB-54): each links a data space file to the
 * conversation it was attached in. `threadId` is null while it waits in
 * the new-chat composer; `boundAt` is set when a message first carries it
 * to the model, after which it belongs to that thread for good.
 */
export const mediaSchema: SchemaSet = {
    id: MODULE_IDS.media,
    migrations: [
        {
            version: 1,
            name: 'attachments',
            up: `CREATE TABLE media_attachments(id TEXT PRIMARY KEY, fileId TEXT NOT NULL, ownerUserId TEXT NOT NULL, threadId TEXT, dotId TEXT, messageId TEXT, name TEXT NOT NULL, mediaType TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','text','file')), size INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('web','telegram')), createdAt INTEGER NOT NULL, boundAt INTEGER);
      CREATE INDEX media_attachments_thread ON media_attachments(threadId);
      CREATE INDEX media_attachments_owner ON media_attachments(ownerUserId, createdAt);
      CREATE INDEX media_attachments_file ON media_attachments(fileId);
      CREATE INDEX media_attachments_pending ON media_attachments(createdAt) WHERE threadId IS NULL;`,
        },
        {
            // The Media page's empty folders (CB-54 step 3); other folders are
            // implied by the files' paths.
            version: 2,
            name: 'folders',
            up: 'CREATE TABLE media_folders(ownerUserId TEXT NOT NULL, path TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(ownerUserId, path));',
        },
        {
            // CB-64 pass 2: an attachment whose file was deleted, or that was
            // removed before it was sent, is hidden and kept.
            version: 3,
            name: 'soft delete',
            up: `ALTER TABLE media_attachments ADD COLUMN deletedAt INTEGER;
      ALTER TABLE media_attachments ADD COLUMN deletedBy TEXT;
      ALTER TABLE media_attachments ADD COLUMN deletedWith TEXT;`,
        },
        {
            // CB-157: images tools return (a computer's screenshots) are stored as
            // attachments of their conversation, `source` 'tool'. SQLite can't
            // change a CHECK in place, so the table is rebuilt with every row.
            version: 4,
            name: 'tool images',
            up: `CREATE TABLE media_attachments_v4(id TEXT PRIMARY KEY, fileId TEXT NOT NULL, ownerUserId TEXT NOT NULL, threadId TEXT, dotId TEXT, messageId TEXT, name TEXT NOT NULL, mediaType TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('image','text','file')), size INTEGER NOT NULL, source TEXT NOT NULL CHECK(source IN ('web','telegram','tool')), createdAt INTEGER NOT NULL, boundAt INTEGER, deletedAt INTEGER, deletedBy TEXT, deletedWith TEXT);
      INSERT INTO media_attachments_v4(id, fileId, ownerUserId, threadId, dotId, messageId, name, mediaType, kind, size, source, createdAt, boundAt, deletedAt, deletedBy, deletedWith) SELECT id, fileId, ownerUserId, threadId, dotId, messageId, name, mediaType, kind, size, source, createdAt, boundAt, deletedAt, deletedBy, deletedWith FROM media_attachments;
      DROP TABLE media_attachments;
      ALTER TABLE media_attachments_v4 RENAME TO media_attachments;
      CREATE INDEX media_attachments_thread ON media_attachments(threadId);
      CREATE INDEX media_attachments_owner ON media_attachments(ownerUserId, createdAt);
      CREATE INDEX media_attachments_file ON media_attachments(fileId);
      CREATE INDEX media_attachments_pending ON media_attachments(createdAt) WHERE threadId IS NULL;`,
        },
        {
            // CB-230: media an unfurled link's card shows, copied into the Files
            // of the person who unfurled it. A card names this id, never the
            // file's, and only files recorded here are served to page readers.
            version: 5,
            name: 'link card media',
            up: `CREATE TABLE media_embeds(id TEXT PRIMARY KEY, fileId TEXT NOT NULL, ownerUserId TEXT NOT NULL, dotId TEXT, spaceId TEXT NOT NULL, sourceUrl TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX media_embeds_file ON media_embeds(ownerUserId, fileId);`,
        },
        {
            // CB-308: page covers are media embeds too, and the cover picker
            // lists a Space's images, newest first.
            version: 6,
            name: 'space media index',
            up: 'CREATE INDEX media_embeds_space ON media_embeds(spaceId, createdAt)',
        },
        {
            // CB-524: files a socio uploads into a Space's media (import
            // assets). `origin` 'upload' marks them; `pageId` is the page they
            // are for (null: the Space); `contentHash` (sha256, hex) makes a
            // retry reuse the same asset; `uploadedAt` is the last time the
            // upload tool returned it, from which unreferenced ones are cleaned
            // up, and `checkedAt` the last time the clean-up looked for pages
            // naming it.
            version: 7,
            name: 'space uploads',
            up: `ALTER TABLE media_embeds ADD COLUMN origin TEXT;
      ALTER TABLE media_embeds ADD COLUMN pageId TEXT;
      ALTER TABLE media_embeds ADD COLUMN contentHash TEXT;
      ALTER TABLE media_embeds ADD COLUMN uploadedAt INTEGER;
      ALTER TABLE media_embeds ADD COLUMN checkedAt INTEGER;
      CREATE INDEX media_embeds_hash ON media_embeds(spaceId, contentHash) WHERE contentHash IS NOT NULL;
      CREATE INDEX media_embeds_uploads ON media_embeds(origin, uploadedAt) WHERE origin IS NOT NULL;`,
        },
    ],
};
