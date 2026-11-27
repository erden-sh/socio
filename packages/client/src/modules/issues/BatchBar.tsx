import { ChevronDown, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { ISSUE_LABELS, ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueSummary } from '@socio/shared/issues/issue-types';

import { Slot } from '../context';

import { useIssueTerms } from './issue-words';
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
    const { t } = useTranslation(['issues']);
    const terms = useIssueTerms();
    const none = !selected.length || busy;
    return (
        <div
            data-slot="issue-batch-bar"
            role="toolbar"
            aria-label={t('issues:batch.toolbar')}
            className="mx-4 mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-xs md:mx-6"
        >
            <span data-slot="issue-batch-count" aria-live="polite" className="text-sm font-medium tabular-nums">
                {t('issues:batch.selected', { count: selected.length })}
            </span>
            <Button variant="ghost" size="sm" className="h-8" disabled={selected.length === shown} onClick={selectAll}>
                {t('issues:batch.select-all', { count: shown })}
            </Button>
            {selected.length > 0 && (
                <Button variant="ghost" size="sm" className="h-8" onClick={clear}>
                    {t('issues:batch.clear')}
                </Button>
            )}
            {admin && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <BatchMenu label={t('issues:batch.status')} set={t('issues:batch.set-status')} disabled={none}>
                        {ISSUE_STATUSES.map((status) => (
                            <DropdownMenuItem
                                key={status}
                                onSelect={() =>
                                    apply(t('issues:batch.moved', { status: terms.status(status) }), (issue) =>
                                        issue.status === status ? undefined : { status },
                                    )
                                }
                            >
                                {terms.status(status)}
                            </DropdownMenuItem>
                        ))}
                    </BatchMenu>
                    <BatchMenu label={t('issues:batch.priority')} set={t('issues:batch.set-priority')} disabled={none}>
                        {ISSUE_PRIORITIES.map((priority) => (
                            <DropdownMenuItem
                                key={priority}
                                onSelect={() =>
                                    apply(
                                        t('issues:batch.priority-set', { priority: terms.priority(priority) }),
                                        (issue) => (issue.priority === priority ? undefined : { priority }),
                                    )
                                }
                            >
                                {terms.priority(priority)}
                            </DropdownMenuItem>
                        ))}
                    </BatchMenu>
                    <BatchMenu label={t('issues:batch.labels')} set={t('issues:batch.set-labels')} disabled={none}>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>{t('issues:batch.add-label')}</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {ISSUE_LABELS.map((label) => (
                                    <DropdownMenuItem
                                        key={label}
                                        onSelect={() =>
                                            apply(t('issues:batch.added', { label: terms.label(label) }), (issue) =>
                                                issue.labels.includes(label)
                                                    ? undefined
                                                    : { labels: [...issue.labels, label] },
                                            )
                                        }
                                    >
                                        {terms.label(label)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>{t('issues:batch.remove-label')}</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {ISSUE_LABELS.map((label) => (
                                    <DropdownMenuItem
                                        key={label}
                                        onSelect={() =>
                                            apply(t('issues:batch.removed', { label: terms.label(label) }), (issue) =>
                                                issue.labels.includes(label)
                                                    ? {
                                                          labels: issue.labels.filter((value) => value !== label),
                                                      }
                                                    : undefined,
                                            )
                                        }
                                    >
                                        {terms.label(label)}
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
                {t('issues:batch.done')}
            </Button>
        </div>
    );
}

function BatchMenu({
    label,
    set,
    disabled,
    children,
}: {
    label: string;
    /** The trigger's accessible name. */
    set: string;
    disabled: boolean;
    children: ReactNode;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="h-8" disabled={disabled} aria-label={set}>
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
