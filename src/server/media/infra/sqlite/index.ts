import type { SqliteData } from '@socio/data/open';

import type { MediaRepositories } from '../../domain/repositories.js';

import { SqliteAttachments } from './attachments.js';
import { SqliteEmbedMedia } from './embeds.js';
import { SqliteMediaFolders } from './folders.js';

/**
 * Media's repositories on a migrated connection (CB-110): the only code
 * that reads or writes its tables.
 */
export function sqliteMediaRepositories(data: SqliteData): MediaRepositories {
    return {
        attachments: new SqliteAttachments(data),
        folders: new SqliteMediaFolders(data),
        embeds: new SqliteEmbedMedia(data),
    };
}
