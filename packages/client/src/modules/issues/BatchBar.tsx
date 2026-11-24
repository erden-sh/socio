import { ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { PRIORITY_LABEL, STATUS_LABEL } from '@socio/shared/issues/issue-board';
import { ISSUE_LABELS, ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueSummary } from '@socio/shared/issues/issue-types';

import { Slot } from '../context';

import type { IssueChange } from './use-issues';

import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** A change for each selected issue (undefined: leave that one alone). */
export type BatchChange = (issue: IssueSummary) => IssueChange | undefined;

/**
 * Select mode's bar: how many are selected, select all shown, and for
 * admins the batch actions (status, priority, labels) plus the
 * `issues.batch` slot, where other modules add theirs.
 */
export function BatchBar({
    selected,
    shown,
    admin,
    busy,
    apply,
    selectAll,
    clear,
    exit,
}: {
    selected: readonly IssueSummary[];
    shown: number;
    admin: boolean;
    busy: boolean;
    apply: (what: string, change: BatchChange) => void;
    selectAll: () => void;
    clear: () => void;
    exit: () => void;
}) {
    const none = !selected.length || busy;
    return (
        <div
            data-slot="issue-batch-bar"
            role="toolbar"
            aria-label="Batch actions"
            className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-xs md:mx-6"
        >
            <span data-slot="issue-batch-count" aria-live="polite" className="text-sm font-medium tabular-nums">
                {selected.length} selected
            </span>
            <Button variant="ghost" size="sm" className="h-8" disabled={selected.length === shown} onClick={selectAll}>
                Select all {shown}
            </Button>
            {selected.length > 0 && (
                <Button variant="ghost" size="sm" className="h-8" onClick={clear}>
                    Clear
                </Button>
            )}
            {admin && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <BatchMenu label="Status" disabled={none}>
                        {ISSUE_STATUSES.map((status) => (
                            <DropdownMenuItem
                                key={status}
                                onSelect={() =>
                                    apply(`Moved to ${STATUS_LABEL[status]}`, (issue) =>
                                        issue.status === status ? undefined : { status },
                                    )
                                }
                            >
                                {STATUS_LABEL[status]}
                            </DropdownMenuItem>
                        ))}
                    </BatchMenu>
                    <BatchMenu label="Priority" disabled={none}>
                        {ISSUE_PRIORITIES.map((priority) => (
                            <DropdownMenuItem
                                key={priority}
                                onSelect={() =>
                                    apply(`Priority set to ${PRIORITY_LABEL[priority]}`, (issue) =>
                                        issue.priority === priority ? undefined : { priority },
                                    )
                                }
                            >
                                {PRIORITY_LABEL[priority]}
                            </DropdownMenuItem>
                        ))}
                    </BatchMenu>
                    <BatchMenu label="Labels" disabled={none}>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>Add label</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {ISSUE_LABELS.map((label) => (
                                    <DropdownMenuItem
                                        key={label}
                                        onSelect={() =>
                                            apply(`Added ${label}`, (issue) =>
                                                issue.labels.includes(label)
                                                    ? undefined
                                                    : { labels: [...issue.labels, label] },
                                            )
                                        }
                                    >
                                        {label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>Remove label</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {ISSUE_LABELS.map((label) => (
                                    <DropdownMenuItem
                                        key={label}
                                        onSelect={() =>
                                            apply(`Removed ${label}`, (issue) =>
                                                issue.labels.includes(label)
                                                    ? {
                                                          labels: issue.labels.filter((value) => value !== label),
                                                      }
                                                    : undefined,
                                            )
                                        }
                                    >
                                        {label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    </BatchMenu>
                </div>
            )}
            <div data-slot="issue-batch-actions" className="flex items-center gap-1.5">
                <Slot name="issues.batch" props={{ issues: selected, clear }} />
            </div>
            <Button variant="outline" size="sm" className="ml-auto h-8" onClick={exit}>
                <X />
                Done
            </Button>
        </div>
    );
}

function BatchMenu({ label, disabled, children }: { label: string; disabled: boolean; children: ReactNode }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="secondary"
                    size="sm"
                    className="h-8"
                    disabled={disabled}
                    aria-label={`Set ${label.toLowerCase()} of the selected issues`}
                >
                    {label}
                    <ChevronDown className="opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuLabel className="text-xs">{label}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {children}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
