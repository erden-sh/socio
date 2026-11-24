import { ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { issueKey, type Issue, type IssueDetail } from '@socio/shared/issues/issue-types';

import { api } from '../../lib/api';

import { notifyIssuesChanged } from './report';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const votesText = (votes: number) => `${votes} ${votes === 1 ? 'vote' : 'votes'}`;

/**
 * An item's upvotes (CB-83), on its card, row and detail: the count, and a
 * toggle for the signed-in person's own vote (one each; a vote a Dot cast
 * for them is theirs too). Shown at once, then sent; the list reloads.
 */
export function VoteButton({
    issue,
    onVoted,
    className,
}: {
    issue: Pick<Issue, 'number' | 'votes' | 'voted'>;
    /** After the server saved it, with the fresh detail. */
    onVoted?: (detail: IssueDetail) => void;
    className?: string;
}) {
    const current = { votes: issue.votes ?? 0, voted: !!issue.voted };
    const from = `${current.votes}|${current.voted}`;
    // What a click showed, until the issue itself changes.
    const [pending, setPending] = useState<{ from: string; votes: number; voted: boolean } | undefined>();
    const [busy, setBusy] = useState(false);
    const shown = pending?.from === from ? pending : current;
    const key = issueKey(issue.number);
    const toggle = async () => {
        const voted = !shown.voted;
        setPending({ from, voted, votes: shown.votes + (voted ? 1 : -1) });
        setBusy(true);
        try {
            const detail = await api<IssueDetail>(`/issues/${issue.number}/vote`, voted ? 'POST' : 'DELETE');
            onVoted?.(detail);
            notifyIssuesChanged();
        } catch (error) {
            setPending(undefined);
            toast.error(error instanceof Error ? error.message : 'Could not save your vote.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Button
            type="button"
            variant={shown.voted ? 'secondary' : 'ghost'}
            size="xs"
            data-slot="issue-vote"
            aria-pressed={shown.voted}
            aria-label={`${shown.voted ? 'Withdraw your vote on' : 'Vote for'} ${key} (${votesText(shown.votes)})`}
            title={shown.voted ? 'You voted. Click to withdraw.' : 'Vote for this'}
            disabled={busy}
            className={cn('relative z-10 tabular-nums', shown.voted && 'text-primary', className)}
            onClick={(event) => {
                // On a card: not a click on the card's link or its selection.
                event.stopPropagation();
                void toggle();
            }}
        >
            <ThumbsUp className={cn(shown.voted && 'fill-current')} />
            {shown.votes}
        </Button>
    );
}

/** The toolbar's "Most votes" order: on, the board sorts by votes first. */
export function SortByVotes({ on, setOn }: { on: boolean; setOn: (on: boolean) => void }) {
    return (
        <Button
            variant={on ? 'secondary' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 font-normal text-muted-foreground aria-pressed:text-foreground"
            data-slot="issue-sort-votes"
            aria-pressed={on}
            title="Most votes first, in each column"
            onClick={() => setOn(!on)}
        >
            <ThumbsUp />
            Most votes
        </Button>
    );
}
