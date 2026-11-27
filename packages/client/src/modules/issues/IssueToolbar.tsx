import { Bot, ChevronDown, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    dotRequestsOnly,
    filtersActive,
    NO_FILTERS,
    type FacetName,
    toggleDotRequests,
    type IssueFilters,
} from '@socio/shared/issues/issue-board';
import {
    ISSUE_AREAS,
    ISSUE_KINDS,
    ISSUE_LABELS,
    ISSUE_PRIORITIES,
    ISSUE_STATUSES,
    type IssueArea,
    type IssueKind,
    type IssuePriority,
    type IssueStatus,
} from '@socio/shared/issues/issue-types';

import { useIssueTerms, type IssueTerms } from './issue-words';
import { useComponentText, type ComponentLabels } from './IssueComponents';
import { SortByVotes } from './IssueVotes';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The facets, each value in the reader's words (the filters keep the values). */
const FACETS: {
    name: FacetName;
    options: readonly string[];
    labelOf: (terms: IssueTerms, value: string) => string;
}[] = [
    { name: 'status', options: ISSUE_STATUSES, labelOf: (terms, value) => terms.status(value as IssueStatus) },
    { name: 'priority', options: ISSUE_PRIORITIES, labelOf: (terms, value) => terms.priority(value as IssuePriority) },
    { name: 'kind', options: ISSUE_KINDS, labelOf: (terms, value) => terms.kind(value as IssueKind) },
    { name: 'area', options: ISSUE_AREAS, labelOf: (terms, value) => terms.area(value as IssueArea) },
    { name: 'label', options: ISSUE_LABELS, labelOf: (terms, value) => terms.label(value) },
];

/** Search and the facet filters (any of the chosen values, per facet). */
export function IssueToolbar({
    filters,
    setFilters,
    shown,
    total,
    dotRequests = 0,
    sortByVotes,
    setSortByVotes,
    wontFix,
    components,
}: {
    filters: IssueFilters;
    setFilters: (update: (current: IssueFilters) => IssueFilters) => void;
    shown: number;
    total: number;
    /** Open Dot requests, for the lane toggle's count. */
    dotRequests?: number;
    /** "Most votes" (CB-83): shown when the page keeps the order. */
    sortByVotes?: boolean;
    setSortByVotes?: (on: boolean) => void;
    /**
     * The board's won't fix column, shown on request: a choice at the end of
     * the Status menu (not a line of its own). Left out where it doesn't
     * apply (the list, or a status filter that already picks the columns).
     */
    wontFix?: { count: number; shown: boolean; setShown: (on: boolean) => void };
    /**
     * The Component facet (CB-442): its values are the refs on the listed
     * issues (`componentFacetOptions`), named by the list's label map; it
     * matches exactly. Left out when no listed issue has one.
     */
    components?: {
        options: readonly string[];
        labels: ComponentLabels;
        chosen: readonly string[];
        setChosen: (refs: string[]) => void;
    };
}) {
    const { t } = useTranslation(['issues']);
    const terms = useIssueTerms();
    const componentText = useComponentText();
    const active = filtersActive(filters) || !!components?.chosen.length;
    return (
        <div data-slot="issue-toolbar" className="flex flex-wrap items-center gap-2 px-4 pb-3 md:px-6">
            <div className="relative w-full min-w-48 sm:w-auto sm:flex-1 lg:max-w-72">
                <Search
                    aria-hidden
                    className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                    type="search"
                    aria-label={t('issues:toolbar.search')}
                    placeholder={t('issues:toolbar.search-placeholder')}
                    value={filters.q}
                    // Filled grey and borderless: quieter than the filter buttons.
                    className="h-8 border-transparent bg-muted pl-8 shadow-none dark:bg-muted"
                    onChange={(event) => {
                        const q = event.target.value;
                        setFilters((current) => ({ ...current, q }));
                    }}
                />
            </div>
            <div className="-mx-4 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-none sm:flex-wrap sm:overflow-visible sm:px-0">
                <Button
                    variant={dotRequestsOnly(filters) ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-8 gap-1.5 font-normal text-muted-foreground aria-pressed:text-foreground"
                    data-slot="issue-dot-requests"
                    aria-pressed={dotRequestsOnly(filters)}
                    title={t('issues:toolbar.dot-requests-hint')}
                    onClick={() => setFilters(toggleDotRequests)}
                >
                    <Bot />
                    {t('issues:toolbar.dot-requests')}
                    {dotRequests > 0 && <span className="font-mono text-xs tabular-nums">{dotRequests}</span>}
                </Button>
                {setSortByVotes && <SortByVotes on={!!sortByVotes} setOn={setSortByVotes} />}
                {FACETS.map((facet) => (
                    <FacetMenu
                        key={facet.name}
                        name={facet.name}
                        options={facet.options}
                        labelOf={(value) => facet.labelOf(terms, value)}
                        chosen={filters[facet.name] as readonly string[]}
                        setChosen={(values) => setFilters((current) => ({ ...current, [facet.name]: values }))}
                        extra={
                            facet.name === 'status' && wontFix && wontFix.count > 0 ? (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuCheckboxItem
                                        data-slot="issue-show-wont-fix"
                                        checked={wontFix.shown}
                                        onSelect={(event) => event.preventDefault()}
                                        onCheckedChange={(checked) => wontFix.setShown(checked)}
                                    >
                                        {t('issues:toolbar.wont-fix')}
                                        <span className="ml-auto font-mono text-xs text-muted-foreground tabular-nums">
                                            {wontFix.count}
                                        </span>
                                    </DropdownMenuCheckboxItem>
                                </>
                            ) : undefined
                        }
                    />
                ))}
                {components && (components.options.length > 0 || components.chosen.length > 0) && (
                    <FacetMenu
                        name="component"
                        options={components.options}
                        labelOf={(ref) => componentText(ref, components.labels)}
                        chosen={components.chosen}
                        setChosen={components.setChosen}
                    />
                )}
                {active && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        onClick={() => {
                            setFilters(() => NO_FILTERS);
                            components?.setChosen([]);
                        }}
                    >
                        <X />
                        {t('issues:toolbar.clear')}
                    </Button>
                )}
            </div>
            <span
                data-slot="issue-toolbar-count"
                aria-live="polite"
                className="ml-auto hidden font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:inline"
            >
                {active ? t('issues:toolbar.shown', { shown, total }) : t('issues:toolbar.total', { count: total })}
            </span>
        </div>
    );
}

function FacetMenu({
    name,
    options,
    labelOf,
    chosen,
    setChosen,
    extra,
}: {
    name: FacetName | 'component';
    options: readonly string[];
    labelOf: (value: string) => string;
    chosen: readonly string[];
    setChosen: (values: string[]) => void;
    /** More items at the end of the menu. */
    extra?: ReactNode;
}) {
    const { t } = useTranslation(['issues']);
    const label = t(`issues:toolbar.facet.${name}`);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                        'h-8 gap-1.5 font-normal text-muted-foreground',
                        chosen.length > 0 && 'text-foreground',
                    )}
                    aria-label={
                        chosen.length
                            ? t('issues:toolbar.chosen', { facet: label, values: chosen.map(labelOf) })
                            : t(`issues:toolbar.filter.${name}`)
                    }
                >
                    {label}
                    {chosen.length > 0 && (
                        <Badge variant="secondary" className="rounded-sm px-1 py-0">
                            {chosen.length === 1 ? labelOf(chosen[0]!) : chosen.length}
                        </Badge>
                    )}
                    <ChevronDown className="opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-48">
                {options.map((option) => (
                    <DropdownMenuCheckboxItem
                        key={option}
                        checked={chosen.includes(option)}
                        // Stay open to pick several.
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                            setChosen(checked ? [...chosen, option] : chosen.filter((value) => value !== option))
                        }
                    >
                        {labelOf(option)}
                    </DropdownMenuCheckboxItem>
                ))}
                {chosen.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setChosen([])}>
                            {t(`issues:toolbar.clear-facet.${name}`)}
                        </DropdownMenuItem>
                    </>
                )}
                {extra}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
