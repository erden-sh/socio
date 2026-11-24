import { Bot, ChevronDown, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';

import {
    areaLabel,
    dotRequestsOnly,
    filtersActive,
    KIND_LABEL,
    NO_FILTERS,
    PRIORITY_LABEL,
    STATUS_LABEL,
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
} from '@socio/shared/issues/issue-types';

import { componentText, type ComponentLabels } from './IssueComponents';
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

const FACETS: {
    name: FacetName;
    label: string;
    options: readonly string[];
    labelOf: (value: string) => string;
}[] = [
    {
        name: 'status',
        label: 'Status',
        options: ISSUE_STATUSES,
        labelOf: (value) => STATUS_LABEL[value as keyof typeof STATUS_LABEL],
    },
    {
        name: 'priority',
        label: 'Priority',
        options: ISSUE_PRIORITIES,
        labelOf: (value) => PRIORITY_LABEL[value as keyof typeof PRIORITY_LABEL],
    },
    {
        name: 'kind',
        label: 'Kind',
        options: ISSUE_KINDS,
        labelOf: (value) => KIND_LABEL[value as keyof typeof KIND_LABEL],
    },
    {
        name: 'area',
        label: 'Area',
        options: ISSUE_AREAS,
        labelOf: (value) => areaLabel(value as (typeof ISSUE_AREAS)[number]),
    },
    {
        name: 'label',
        label: 'Label',
        options: ISSUE_LABELS,
        labelOf: (value) => value,
    },
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
                    aria-label="Search issues"
                    placeholder="Search"
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
                    title="Capability requests filed by socios"
                    onClick={() => setFilters(toggleDotRequests)}
                >
                    <Bot />
                    Socio requests
                    {dotRequests > 0 && <span className="font-mono text-xs tabular-nums">{dotRequests}</span>}
                </Button>
                {setSortByVotes && <SortByVotes on={!!sortByVotes} setOn={setSortByVotes} />}
                {FACETS.map((facet) => (
                    <FacetMenu
                        key={facet.name}
                        {...facet}
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
                                        Show won’t fix
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
                        label="Component"
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
                        Clear
                    </Button>
                )}
            </div>
            <span
                data-slot="issue-toolbar-count"
                aria-live="polite"
                className="ml-auto hidden font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums sm:inline"
            >
                {active ? `${shown} of ${total}` : `${total} issues`}
            </span>
        </div>
    );
}

function FacetMenu({
    label,
    options,
    labelOf,
    chosen,
    setChosen,
    extra,
}: {
    label: string;
    options: readonly string[];
    labelOf: (value: string) => string;
    chosen: readonly string[];
    setChosen: (values: string[]) => void;
    /** More items at the end of the menu. */
    extra?: ReactNode;
}) {
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
                            ? `${label}: ${chosen.map(labelOf).join(', ')}`
                            : `Filter by ${label.toLowerCase()}`
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
                        <DropdownMenuItem onSelect={() => setChosen([])}>Clear {label.toLowerCase()}</DropdownMenuItem>
                    </>
                )}
                {extra}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
