import type { SqliteData } from '@socio/data/open';

import type { BoardRepositories } from '../../domain/repositories.js';

import { SqliteAttachments } from './attachments.js';
import { SqliteBoardAudit } from './audit.js';
import { SqliteComments } from './comments.js';
import { SqliteComponents } from './components.js';
import { SqliteHistory } from './history.js';
import { SqliteIssues } from './issues.js';
import { SqliteBoardQueries } from './queries.js';
import { SqliteDotRequests } from './requests.js';
import { SqliteIssueRuns } from './runs.js';
import { SqliteTriage } from './triage.js';
import { SqliteVotes } from './votes.js';
import { SqliteIssueWatches } from './watches.js';

/**
 * The Board's repositories on a migrated connection (CB-110): the only
 * code that reads or writes its tables. Hot reads are prepared once here.
 */
export function sqliteBoardRepositories(data: SqliteData): BoardRepositories {
    return {
        issues: new SqliteIssues(data),
        components: new SqliteComponents(data),
        watches: new SqliteIssueWatches(data),
        comments: new SqliteComments(data),
        attachments: new SqliteAttachments(data),
        history: new SqliteHistory(data),
        votes: new SqliteVotes(data),
        triage: new SqliteTriage(data),
        requests: new SqliteDotRequests(data),
        audit: new SqliteBoardAudit(data),
        queries: new SqliteBoardQueries(data),
        runs: new SqliteIssueRuns(data),
    };
}
