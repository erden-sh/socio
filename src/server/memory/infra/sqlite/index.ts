import type { SqliteData } from '@socio/data/open';

import type { MemoryRepositories } from '../../contract.js';

import { SqliteEpisodes } from './episodes.js';
import { SqliteMemories } from './memories.js';
import { SqliteProfiles } from './profiles.js';
import { SqliteSpaceMemories } from './space-memories.js';
import { SqliteTimeZoneNotes } from './time-zone-notes.js';

/**
 * The Memory context's repositories on a migrated connection (CB-110): the
 * only code that reads or writes its tables. Hot reads (every turn reads
 * the person's profile and memories) are prepared once here.
 */
export function sqliteMemoryRepositories(data: SqliteData): MemoryRepositories {
    return {
        memories: new SqliteMemories(data),
        profiles: new SqliteProfiles(data),
        timeZoneNotes: new SqliteTimeZoneNotes(data),
        episodes: new SqliteEpisodes(data),
        spaceMemories: new SqliteSpaceMemories(data),
    };
}
