import type { IssueTitle } from '@socio/shared/issues/issue-types';

/**
 * The Board's published port for other contexts (CB-110):
 * issues' numbers, titles and statuses by id, in one batch, instead of a
 * join on the Board's tables. Deleted issues are left out unless asked for.
 */
export interface IssueTitles {
    titlesById(ids: readonly string[], options?: { deleted?: boolean }): Promise<Map<string, IssueTitle>>;
}
