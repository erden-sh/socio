import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useTranslation } from '@socio/i18n/react';
import { groupByStatus, issuePath } from '@socio/shared/issues/issue-board';
import { ISSUE_STATUSES, issueKey, type IssueSummary, type IssueStatus } from '@socio/shared/issues/issue-types';

import { PRIORITY_BAR } from './issue-meta';
import { Assignee, IssueKey, IssueTags, StatusBadge } from './IssueBadges';
import type { IssueSelection } from './IssueBoard';
import { MoveMenu } from './IssueBoard';
import { ComponentChips, type ComponentLabels } from './IssueComponents';
import { VoteButton } from './IssueVotes';

import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

/** Sections that start collapsed: the closed ones. */
export const COLLAPSED_BY_DEFAULT: readonly IssueStatus[] = ['done', 'wont_fix'];

/**
 * The list: issues grouped by status in collapsible sections (closed ones
 * collapsed at first, empty ones left out), one row each with an excerpt
 * of the description and its badges.
 */
export function IssueList({
    issues,
    users,
    components,
    statuses = ISSUE_STATUSES,
    canMove,
    onMove,
    selection,
}: {
    issues: readonly IssueSummary[];
    users: Record<string, string>;
    /** How the rows' components read (the list's label map, CB-442). */
    components?: ComponentLabels;
    /** The sections, in order (all statuses unless filtered). */
    statuses?: readonly IssueStatus[];
    canMove: boolean;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
    selection: IssueSelection;
}) {
    const { t } = useTranslation(['issues']);
    const groups = groupByStatus(issues);
    const [closed, setClosed] = useState<ReadonlySet<IssueStatus>>(() => new Set(COLLAPSED_BY_DEFAULT));
    const shown = statuses.filter((status) => groups[status].length);
    if (!shown.length) {
        return (
            <p data-slot="issue-list-empty" className="px-6 py-12 text-center text-sm text-muted-foreground">
                {t('issues:list.empty')}
            </p>
        );
    }
    return (
        <div data-slot="issue-list" className="h-full overflow-y-auto px-4 pb-6 md:px-6">
            <div className="overflow-hidden rounded-xl border bg-card">
                {shown.map((status) => (
                    <Collapsible
                        key={status}
                        open={!closed.has(status)}
                        onOpenChange={(open) =>
                            setClosed((current) => {
                                const next = new Set(current);
                                if (open) {
                                    next.delete(status);
                                } else {
                                    next.add(status);
                                }
                                return next;
                            })
                        }
                        data-slot="issue-group"
                        data-status={status}
                        className="border-b last:border-b-0"
                    >
                        <h2 data-slot="issue-group-title" className="text-sm">
                            <CollapsibleTrigger className="group/trigger flex w-full items-center gap-2 px-4 py-2.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50">
                                <ChevronRight
                                    aria-hidden
                                    className="size-4 text-muted-foreground transition-transform group-data-[state=open]/trigger:rotate-90"
                                />
                                <StatusBadge status={status} />
                                <span className="text-xs text-muted-foreground tabular-nums">
                                    {groups[status].length}
                                </span>
                            </CollapsibleTrigger>
                        </h2>
                        <CollapsibleContent>
                            <ul className="divide-y border-t">
                                {groups[status].map((issue) => (
                                    <IssueRow
                                        key={issue.number}
                                        issue={issue}
                                        users={users}
                                        components={components}
                                        canMove={canMove && !selection.active}
                                        onMove={onMove}
                                        selection={selection}
                                    />
                                ))}
                            </ul>
                        </CollapsibleContent>
                    </Collapsible>
                ))}
            </div>
        </div>
    );
}

function IssueRow({
    issue,
    users,
    components,
    canMove,
    onMove,
    selection,
}: {
    issue: IssueSummary;
    users: Record<string, string>;
    components?: ComponentLabels;
    canMove: boolean;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
    selection: IssueSelection;
}) {
    const { t } = useTranslation(['issues']);
    const key = issueKey(issue.number);
    const selected = selection.selected.has(issue.number);
    const summary = issue.excerpt;
    const assignee = issue.assigneeId ? (users[issue.assigneeId] ?? issue.assigneeId) : undefined;
    return (
        <li
            data-slot="issue-row"
            data-issue={key}
            onClick={selection.active ? () => selection.toggle(issue.number) : undefined}
            className={cn(
                'relative flex flex-col gap-2 px-4 py-3 hover:bg-accent/40 has-[a:focus-visible]:bg-accent/40 sm:flex-row sm:items-center sm:gap-4',
                selection.active && 'cursor-pointer',
                selected && 'bg-primary/5',
            )}
        >
            <div className="flex min-w-0 flex-1 items-start gap-3">
                <span
                    aria-hidden
                    className={cn('mt-0.5 h-9 w-1 shrink-0 rounded-full', PRIORITY_BAR[issue.priority])}
                />
                {selection.active && (
                    <Checkbox
                        className="mt-0.5"
                        checked={selected}
                        aria-label={t('issues:board.select', { key })}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => selection.toggle(issue.number)}
                    />
                )}
                <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                        <IssueKey number={issue.number} />
                        <h3 data-slot="issue-row-title" className="min-w-0 truncate text-sm font-medium">
                            {selection.active ? (
                                issue.title
                            ) : (
                                <Link
                                    data-slot="issue-link"
                                    to={issuePath(issue.number)}
                                    state={{ fromIssues: true }}
                                    className="outline-none after:absolute after:inset-0 hover:underline"
                                >
                                    {issue.title}
                                </Link>
                            )}
                        </h3>
                    </div>
                    {summary && (
                        <p data-slot="issue-row-excerpt" className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                            {summary}
                        </p>
                    )}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1 pl-4 sm:shrink-0 sm:justify-end sm:pl-0">
                <IssueTags issue={issue} />
                <ComponentChips refs={issue.components ?? []} labels={components} />
                <VoteButton issue={issue} />
                {assignee && <Assignee name={assignee} />}
                {canMove && <MoveMenu issue={issue} onMove={onMove} />}
            </div>
        </li>
    );
}
