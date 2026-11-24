import type { SqliteData } from '@socio/data/open';

import type { PageRepositories } from '../../domain/repositories.js';

import { SqlitePageLinks } from './links.js';
import { SqlitePages } from './pages.js';
import { SqlitePageReviews } from './reviews.js';
import { SqlitePageRevisions } from './revisions.js';
import { SqlitePageSearchIndex, SqlitePageUse } from './search.js';
import { SqlitePageTags } from './tags.js';
import { SqlitePageThreads } from './threads.js';

/**
 * The pages context's repositories on a migrated connection (CB-110): the
 * only code that writes its tables. Its reads move here with the
 * workspace and chats contexts, whose callers read them synchronously.
 */
export function sqlitePageRepositories(data: SqliteData): PageRepositories {
    return {
        pages: new SqlitePages(data),
        revisions: new SqlitePageRevisions(data),
        reviews: new SqlitePageReviews(data),
        threads: new SqlitePageThreads(data),
        search: new SqlitePageSearchIndex(data),
        use: new SqlitePageUse(data),
        tags: new SqlitePageTags(data),
        links: new SqlitePageLinks(data),
    };
}
