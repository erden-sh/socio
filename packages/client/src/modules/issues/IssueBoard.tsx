import { ArrowRightLeft } from 'lucide-react';
import { memo, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';

import { areaLabel, groupByStatus, issuePath, KIND_LABEL, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import { ISSUE_STATUSES, issueKey, type IssueSummary, type IssueStatus } from '@socio/shared/issues/issue-types';

import { Assignee, BlockedBadge, DemandBadge, IssueKey, PriorityPill, QuietTag, StatusRing } from './IssueBadges';
import { ComponentChips, type ComponentLabels } from './IssueComponents';
import { VoteButton } from './IssueVotes';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** The drag payload's type: an issue number. */
const DRAG_TYPE = 'application/x-socio-issue';

export interface IssueSelection {
    /** Select mode is on: cards toggle instead of opening. */
    active: boolean;
    selected: ReadonlySet<number>;
    toggle: (number: number) => void;
}

interface BoardProps {
    issues: readonly IssueSummary[];
    users: Record<string, string>;
    /** How the cards' components read (the list's label map, CB-442). */
    components?: ComponentLabels;
    /** The columns, in order. */
    statuses: readonly IssueStatus[];
    /** Admins move cards (drag, or the card's Move menu); members only look. */
    canMove: boolean;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
    selection: IssueSelection;
}

/**
 * The kanban board: one column per status with its count. Admins drag a
 * card to another column (or use its Move menu, the keyboard way); for
 * members the board is read-only.
 */
export const IssueBoard = memo(function IssueBoard({
    issues,
    users,
    components,
    statuses,
    canMove,
    onMove,
    selection,
}: BoardProps) {
    const groups = groupByStatus(issues);
    const [dragging, setDragging] = useState<number>();
    const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
    return (
        <div
            data-slot="issue-board"
            className="flex h-full min-h-0 gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 pb-4 md:px-6"
        >
            {statuses.map((status) => (
                <BoardColumn
                    key={status}
                    status={status}
                    issues={groups[status]}
                    users={users}
                    components={components}
                    canMove={canMove && !selection.active}
                    dragging={dragging}
                    setDragging={setDragging}
                    onDrop={(number) => {
                        const issue = byNumber.get(number);
                        if (issue && issue.status !== status) {
                            onMove(issue, status);
                        }
                    }}
                    onMove={onMove}
                    selection={selection}
                />
            ))}
        </div>
    );
});

function BoardColumn({
    status,
    issues,
    users,
    components,
    canMove,
    dragging,
    setDragging,
    onDrop,
    onMove,
    selection,
}: {
    status: IssueStatus;
    issues: readonly IssueSummary[];
    users: Record<string, string>;
    components?: ComponentLabels;
    canMove: boolean;
    dragging?: number;
    setDragging: (number: number | undefined) => void;
    onDrop: (number: number) => void;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
    selection: IssueSelection;
}) {
    const [over, setOver] = useState(false);
    const depth = useRef(0);
    const accepts = (event: DragEvent) => canMove && event.dataTransfer.types.includes(DRAG_TYPE);
    const headingId = `issue-column-${status}`;
    return (
        <section
            data-slot="issue-column"
            data-status={status}
            aria-labelledby={headingId}
            className={cn(
                // No column box: the cards sit on the page; a drag lights it up.
                'flex min-h-0 w-[min(85vw,18rem)] shrink-0 flex-col rounded-xl border border-transparent transition-colors md:w-72',
                over && 'border-ring/60 bg-accent/60 ring-2 ring-ring/30',
            )}
            onDragEnter={(event) => {
                if (!accepts(event)) {
                    return;
                }
                event.preventDefault();
                depth.current += 1;
                setOver(true);
            }}
            onDragOver={(event) => {
                if (!accepts(event)) {
                    return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
            }}
            onDragLeave={() => {
                depth.current = Math.max(0, depth.current - 1);
                if (!depth.current) {
                    setOver(false);
                }
            }}
            onDrop={(event) => {
                if (!accepts(event)) {
                    return;
                }
                event.preventDefault();
                depth.current = 0;
                setOver(false);
                const number = Number(event.dataTransfer.getData(DRAG_TYPE));
                if (number) {
                    onDrop(number);
                }
            }}
        >
            <header className="flex h-9 shrink-0 items-center gap-2 px-3">
                <h2
                    id={headingId}
                    data-slot="issue-column-title"
                    className="flex items-center gap-2 text-sm font-medium"
                >
                    <StatusRing status={status} />
                    {STATUS_LABEL[status]}
                    <span className="sr-only">, {issues.length} issues</span>
                </h2>
                <span
                    aria-hidden
                    data-slot="issue-column-count"
                    className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                    {issues.length}
                </span>
            </header>
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pb-2">
                {issues.map((issue) => (
                    <li key={issue.number} className="shrink-0">
                        <IssueCard
                            issue={issue}
                            users={users}
                            components={components}
                            canMove={canMove}
                            dragging={dragging === issue.number}
                            setDragging={setDragging}
                            onMove={onMove}
                            selection={selection}
                        />
                    </li>
                ))}
                {!issues.length && (
                    <li
                        className={cn(
                            'flex h-16 items-center justify-center rounded-lg border-2 border-dashed text-xs text-muted-foreground',
                            over ? 'border-ring/50' : 'border-transparent',
                        )}
                    >
                        {over ? 'Drop here' : 'No issues'}
                    </li>
                )}
            </ul>
        </section>
    );
}

export const IssueCard = memo(function IssueCard({
    issue,
    users,
    components,
    canMove,
    dragging,
    setDragging,
    onMove,
    selection,
}: {
    issue: IssueSummary;
    users: Record<string, string>;
    components?: ComponentLabels;
    canMove: boolean;
    dragging: boolean;
    setDragging: (number: number | undefined) => void;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
    selection: IssueSelection;
}) {
    const key = issueKey(issue.number);
    const selected = selection.selected.has(issue.number);
    const assignee = issue.assigneeId ? (users[issue.assigneeId] ?? issue.assigneeId) : undefined;
    return (
        <article
            data-slot="issue-card"
            data-issue={key}
            aria-label={`${key}: ${issue.title}`}
            draggable={canMove}
            onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_TYPE, String(issue.number));
                event.dataTransfer.setData('text/plain', key);
                event.dataTransfer.effectAllowed = 'move';
                setDragging(issue.number);
            }}
            onDragEnd={() => setDragging(undefined)}
            onClick={selection.active ? () => selection.toggle(issue.number) : undefined}
            className={cn(
                'group/card relative flex flex-col gap-2 overflow-hidden rounded-xl border bg-card px-3.5 py-3 text-card-foreground transition-[border-color,box-shadow,opacity] hover:border-ring/40 hover:shadow-xs has-[a:focus-visible]:ring-[3px] has-[a:focus-visible]:ring-ring/50',
                canMove && 'cursor-grab active:cursor-grabbing',
                selection.active && 'cursor-pointer',
                selected && 'border-primary bg-primary/5 ring-1 ring-primary/40',
                dragging && 'opacity-40',
            )}
        >
            <div className="flex min-h-6 items-center gap-2">
                {selection.active && (
                    <Checkbox
                        checked={selected}
                        aria-label={`Select ${key}`}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => selection.toggle(issue.number)}
                    />
                )}
                <IssueKey number={issue.number} />
                <PriorityPill priority={issue.priority} />
                <span className="ml-auto flex items-center gap-1">
                    <VoteButton issue={issue} className="font-mono" />
                    {assignee && <Assignee name={assignee} />}
                    {canMove && <MoveMenu issue={issue} onMove={onMove} />}
                </span>
            </div>
            <h3 data-slot="issue-card-title" className="text-sm leading-snug font-medium">
                {selection.active ? (
                    issue.title
                ) : (
                    <Link
                        data-slot="issue-link"
                        to={issuePath(issue.number)}
                        state={{ fromIssues: true }}
                        draggable={false}
                        className="outline-none after:absolute after:inset-0 hover:underline"
                    >
                        {issue.title}
                    </Link>
                )}
            </h3>
            <div
                data-slot="issue-card-meta"
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4 text-muted-foreground"
            >
                <span>
                    {KIND_LABEL[issue.kind]}
                    {issue.area && ` · ${areaLabel(issue.area)}`}
                </span>
                {issue.labels.map((label) => (
                    <QuietTag key={label} label={label} />
                ))}
                <ComponentChips refs={issue.components ?? []} labels={components} />
                <DemandBadge demand={issue.demand} />
                <BlockedBadge blockers={issue.openBlockers} />
            </div>
        </article>
    );
});

/** The keyboard (and touch) way to move a card: a status menu. */
export function MoveMenu({
    issue,
    onMove,
}: {
    issue: IssueSummary;
    onMove: (issue: IssueSummary, status: IssueStatus) => void;
}) {
    const key = issueKey(issue.number);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="relative z-10 size-6 text-muted-foreground"
                    aria-label={`Move ${key}`}
                    title="Move to another status"
                    onClick={(event) => event.stopPropagation()}
                >
                    <ArrowRightLeft className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-xs">Move {key} to</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                    value={issue.status}
                    onValueChange={(status) => {
                        if (status !== issue.status) {
                            onMove(issue, status as IssueStatus);
                        }
                    }}
                >
                    {ISSUE_STATUSES.map((status) => (
                        <DropdownMenuRadioItem key={status} value={status}>
                            {STATUS_LABEL[status]}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
