import type { ReactNode } from 'react';

import { issuePath } from '@socio/shared/issues/issue-board';
import { CLOSED_ISSUE_STATUSES, issueKey } from '@socio/shared/issues/issue-types';

import { AppLink } from '../../shell/AppLink';

import { useIssueCard } from './issue-cards';
import { IssueKey } from './IssueBadges';

import { cn } from '@/lib/utils';

/** The most of a title a chip shows. */
export const CHIP_TITLE_CHARS = 60;
const chipTitle = (title: string) =>
    title.length > CHIP_TITLE_CHARS ? `${title.slice(0, CHIP_TITLE_CHARS - 1).trimEnd()}…` : title;

/**
 * "#12" or "CB-12" in an issue's description or a comment (CB-274), as a
 * chip with the issue's key and title that opens it. The issue is read
 * with the reader's own session, in the same batched request as every
 * other chip and card on the screen (`GET /api/issues/cards`, CB-87).
 * Until it arrives, and when the reader can't have it (missing, deleted,
 * no access), it is the words as written: plain text, not a link, so a
 * chip never tells more than the reader may see.
 */
export function IssueRefChip({ number, children }: { number: number; children?: ReactNode }) {
    const card = useIssueCard(number);
    if (!card) {
        return <>{children}</>;
    }
    const done = CLOSED_ISSUE_STATUSES.includes(card.status);
    // Inline, not a box of its own: it wraps with the sentence instead of
    // widening a narrow column, its border and padding on each line. A long
    // title is cut; the whole one is the tooltip.
    return (
        <AppLink
            href={issuePath(card.number)}
            state={{ fromIssues: true }}
            slot="issue-ref"
            title={`${issueKey(card.number)}: ${card.title}`}
            className="mx-px rounded-md border bg-muted/40 px-1 py-px text-foreground no-underline transition-colors [box-decoration-break:clone] [overflow-wrap:anywhere] hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
            <IssueKey number={card.number} />{' '}
            <span data-slot="issue-ref-title" className={cn('text-[0.92em]', done && 'text-muted-foreground')}>
                {chipTitle(card.title)}
            </span>
        </AppLink>
    );
}
