import type { Issue, IssueStatus } from '@socio/shared/issues/issue-types';

import type { RecordedNotice } from '../contract.js';

/**
 * The Board's domain events (CB-110): raised in the unit of work that made
 * the change, delivered once it commits (`packages/data/src/events.ts`), so a subscriber
 * always reads what the event says is saved.
 */
export interface BoardEvents extends Record<string, unknown> {
    /** A new issue was filed (not an import's: those bring their own triage). */
    created: { issue: Issue };
    /** An update changed the issue's status from `from`. */
    statusChanged: { issue: Issue; from: IssueStatus };
    /** The issue was deleted (stamped); `actorId` is who deleted it. */
    removed: { issue: Issue; actorId: string | null };
    /** A person who asked for a Dot request is to be told it closed. */
    noticeRecorded: { notice: RecordedNotice };
}

/** What each event's failing subscriber is logged as. */
export const BOARD_EVENT_FAILURES: Record<keyof BoardEvents, string> = {
    created: 'Issue created listener failed:',
    statusChanged: 'Issue status listener failed:',
    removed: 'Issue removed listener failed:',
    noticeRecorded: 'Socio request notice listener failed:',
};
