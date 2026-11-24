import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';

import { areaLabel, KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import { issueKey, type Issue, type IssuePriority, type IssueStatus } from '@socio/shared/issues/issue-types';

import { toneTile } from '../../shell/tones';

import { PRIORITY_PILL_TONE, PRIORITY_TONE, STATUS_RING, STATUS_TONE } from './issue-meta';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const chip = 'rounded-md px-1.5 py-0 text-[11px] leading-5 font-medium';

export function StatusBadge({ status, className }: { status: IssueStatus; className?: string }) {
    return (
        <Badge variant="outline" className={cn(chip, STATUS_TONE[status], className)}>
            {STATUS_LABEL[status]}
        </Badge>
    );
}

export function PriorityBadge({ priority }: { priority: IssuePriority }) {
    return (
        <Badge
            variant="outline"
            className={cn(chip, PRIORITY_TONE[priority])}
            title={`Priority: ${PRIORITY_LABEL[priority]}`}
        >
            {PRIORITY_LABEL[priority]}
        </Badge>
    );
}

/**
 * The priority as a tinted pill in its tone, the word inside: on board
 * cards and in the triage proposal. Every level is colored, low included.
 */
export function PriorityPill({
    priority,
    title = `Priority: ${PRIORITY_LABEL[priority]}`,
}: {
    priority: IssuePriority;
    title?: string;
}) {
    return (
        <span
            data-slot="priority-pill"
            data-priority={priority}
            title={title}
            className={cn(
                'inline-flex shrink-0 items-center rounded-sm px-1.5 py-px font-sans text-xs leading-4 font-medium whitespace-nowrap',
                toneTile[PRIORITY_PILL_TONE[priority]],
            )}
        >
            {PRIORITY_LABEL[priority]}
        </span>
    );
}

/** A status as a ring in its hue, for column headers and the detail line. */
export function StatusRing({ status }: { status: IssueStatus }) {
    return (
        <span
            aria-hidden
            data-slot="status-ring"
            className={cn('size-2 shrink-0 rounded-full border-[1.5px] border-current', STATUS_RING[status])}
        />
    );
}

/**
 * A quiet tag on a board card: grey, borderless. `needs-decision` is
 * tinted teal, since it asks a person to act.
 */
export function QuietTag({ label }: { label: string }) {
    return (
        <span
            data-slot="issue-tag"
            title="Label"
            className={cn(
                'rounded-sm px-1.5 py-px text-xs leading-4 whitespace-nowrap',
                label === 'needs-decision' ? toneTile.mint : 'bg-muted text-muted-foreground',
            )}
        >
            {label}
        </span>
    );
}

/** A neutral tag: kind, area or label. */
export function Tag({ children, title }: { children: ReactNode; title?: string }) {
    return (
        <Badge variant="outline" title={title} className={cn(chip, 'border-border bg-muted/40 text-muted-foreground')}>
            {children}
        </Badge>
    );
}

/** A Dot request's demand: how many Dot and user pairs asked. */
export function DemandBadge({ demand }: { demand?: number }) {
    if (!demand) {
        return null;
    }
    const text = `${demand} ${demand === 1 ? 'ask' : 'asks'}`;
    return (
        <Badge
            variant="outline"
            data-slot="issue-demand"
            title={`Requested by ${demand} socio and user ${demand === 1 ? 'pair' : 'pairs'}`}
            className={cn(
                chip,
                'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/10 dark:text-fuchsia-300',
            )}
        >
            {text}
        </Badge>
    );
}

/**
 * Blocked-by links (CB-29): shown while any blocker is still open, with how
 * many. Closed blockers (done, won't fix) no longer count.
 */
export function BlockedBadge({
    blockers,
}: {
    /** The open blockers' numbers. */
    blockers?: readonly number[];
}) {
    const open = blockers?.length ?? 0;
    if (!open) {
        return null;
    }
    return (
        <Badge
            variant="outline"
            data-slot="issue-blocked"
            title={`Waiting for ${open} open ${open === 1 ? 'issue' : 'issues'}`}
            className={cn(
                chip,
                'gap-1 border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
            )}
        >
            <Lock className="size-3" aria-hidden />
            Blocked by {open}
        </Badge>
    );
}

/** Priority, kind, area and labels, in that order; a Dot request's demand. */
export function IssueTags({
    issue,
    status = false,
}: {
    issue: Pick<Issue, 'status' | 'priority' | 'kind' | 'area' | 'labels' | 'demand' | 'openBlockers'>;
    /** Lead with the status (the list, where rows aren't in columns). */
    status?: boolean;
}) {
    return (
        <>
            {status && <StatusBadge status={issue.status} />}
            <PriorityBadge priority={issue.priority} />
            <Tag title="Kind">{KIND_LABEL[issue.kind]}</Tag>
            {issue.area && <Tag title="Area">{areaLabel(issue.area)}</Tag>}
            {issue.labels.map((label) => (
                <Tag key={label} title="Label">
                    {label}
                </Tag>
            ))}
            <DemandBadge demand={issue.demand} />
            <BlockedBadge blockers={issue.openBlockers} />
        </>
    );
}

export const IssueKey = ({ number }: { number: number }) => (
    <span className="shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">
        {issueKey(number)}
    </span>
);

/** Initials in a circle, for the assignee. */
export function Assignee({ name }: { name: string }) {
    const initials = name
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
    return (
        <span
            title={`Assigned to ${name}`}
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-secondary-foreground"
        >
            <span aria-hidden>{initials}</span>
            <span className="sr-only">Assigned to {name}</span>
        </span>
    );
}
