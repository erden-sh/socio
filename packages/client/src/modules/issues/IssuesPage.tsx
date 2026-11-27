import { Columns3, LayoutList, Plus, SquareCheck } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    BOARD_STATUSES,
    byVotes,
    filterIssues,
    isDotRequest,
    issueCounts,
    issueNumber,
    NO_FILTERS,
    type IssueFilters,
} from '@socio/shared/issues/issue-board';
import {
    CLOSED_ISSUE_STATUSES,
    ISSUE_STATUSES,
    issueKey,
    type IssueDetail,
    type IssueStatus,
    type IssueSummary,
} from '@socio/shared/issues/issue-types';
import { MODULE_IDS } from '@socio/shared/modules';

import { useRouteParams, useShell } from '../../shell/shell-context';
import { PageHeader } from '../../views/WorkspacePage';
import { Slot } from '../context';

import { BatchBar, type BatchChange } from './BatchBar';
import { issueCloseTarget, readView, writeView, type IssueView } from './issue-meta';
import { IssueBoard } from './IssueBoard';
import { componentFacetOptions, filterByComponents } from './IssueComponents';
import { IssueDetailDialog } from './IssueDetail';
import { IssueList } from './IssueList';
import { IssueToolbar } from './IssueToolbar';
import { openReport } from './report';
import { useIssues, useIssueSearch } from './use-issues';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export { issueNumber };

const message = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * `/issues` and `/issues/CB-12`: the team's tracker. The board (default)
 * or the list, search and filters, Select mode for batch changes, and the
 * open issue in a dialog over it (the route's `issueKey`; closing goes
 * back). Members read, file and comment; admins triage.
 */
export function IssuesPage({
    openIssue,
}: {
    /** The open issue from its route's loader (`/issues/CB-12`). */
    openIssue?: IssueDetail;
} = {}) {
    const { t } = useTranslation(['issues', 'issues.terms']);
    const { workspace, admin } = useShell();
    const user = workspace.user;
    const navigate = useNavigate();
    const location = useLocation();
    const open = issueNumber(useRouteParams().issueKey);
    const data = useIssues();
    const [view, setViewState] = useState<IssueView>(readView);
    const setView = (next: IssueView) => {
        setViewState(next);
        writeView(next);
    };
    const [filters, setFiltersState] = useState<IssueFilters>(NO_FILTERS);
    const setFilters = useCallback((update: (current: IssueFilters) => IssueFilters) => setFiltersState(update), []);
    // The Component facet (CB-442), beside the shared facets: exact refs.
    const [chosenComponents, setChosenComponents] = useState<string[]>([]);
    const [wontFix, setWontFix] = useState(false);
    const [selecting, setSelecting] = useState(false);
    const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
    const [batchBusy, setBatchBusy] = useState(false);

    const all = useMemo(() => data.issues ?? [], [data.issues]);
    const [sortByVotes, setSortByVotes] = useState(false);
    // Descriptions are searched on the server (CB-71).
    const matches = useIssueSearch(filters.q, data.version);
    const shown = useMemo(() => {
        const matching = filterByComponents(filterIssues(all, filters, matches), chosenComponents);
        return sortByVotes ? byVotes(matching) : matching;
    }, [all, filters, matches, sortByVotes, chosenComponents]);
    const componentOptions = useMemo(
        () => componentFacetOptions(all, data.components, chosenComponents),
        [all, data.components, chosenComponents],
    );
    const counts = issueCounts(all);
    const openDotRequests = all.filter(
        (issue) => isDotRequest(issue) && !CLOSED_ISSUE_STATUSES.includes(issue.status),
    ).length;
    // A status filter picks the columns (won't fix too, when chosen);
    // otherwise won't fix shows on request.
    const statuses = useMemo(
        () =>
            filters.status.length
                ? ISSUE_STATUSES.filter((status) => filters.status.includes(status))
                : wontFix
                  ? [...BOARD_STATUSES, 'wont_fix' as const]
                  : BOARD_STATUSES,
        [wontFix, filters.status],
    );
    const wontFixCount = all.filter((issue) => issue.status === 'wont_fix').length;

    const updateIssue = data.update;
    const move = useCallback(
        (issue: IssueSummary, status: IssueStatus) => {
            const key = issueKey(issue.number);
            updateIssue(issue.number, { status }).then(
                () => toast.success(t('issues:move.done', { key, status: t(`issues.terms:status.${status}`) })),
                (error: unknown) =>
                    toast.error(t('issues:move.failed', { key }), {
                        description: message(error, t('issues:move.undone')),
                    }),
            );
        },
        [updateIssue, t],
    );
    const toggle = useCallback((number: number) => {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(number)) {
                next.delete(number);
            } else {
                next.add(number);
            }
            return next;
        });
    }, []);
    const selection = useMemo(() => ({ active: selecting, selected, toggle }), [selecting, selected, toggle]);
    const selectedIssues = all.filter((issue) => selected.has(issue.number));
    const applyBatch = async (what: string, changeFor: BatchChange) => {
        setBatchBusy(true);
        let changed = 0;
        const failed: string[] = [];
        for (const issue of selectedIssues) {
            const change = changeFor(issue);
            if (!change) {
                continue;
            }
            try {
                await data.update(issue.number, change);
                changed += 1;
            } catch (error) {
                failed.push(
                    t('issues:batch.row-failed', {
                        key: issueKey(issue.number),
                        reason: message(error, t('issues:batch.refused')),
                    }),
                );
            }
        }
        setBatchBusy(false);
        if (failed.length) {
            toast.error(t('issues:batch.failed', { what, count: failed.length }), {
                description: failed.join('\n'),
            });
        } else {
            toast.success(changed ? t('issues:batch.changed', { what, count: changed }) : t('issues:batch.nothing'));
        }
    };
    const exitSelect = () => {
        setSelecting(false);
        setSelected(new Set());
    };
    const close = () => {
        // Opened from the board or a chat: going back closes it, back there
        // (and keeps history tidy). A deep link closes to the board.
        const target = issueCloseTarget(location.state);
        if (target === -1) {
            void navigate(-1);
        } else {
            void navigate(target, { replace: true });
        }
    };

    return (
        <main data-slot="issues-page" data-tour="issues" className="flex min-h-0 w-full flex-1 flex-col">
            <PageHeader
                module={MODULE_IDS.issues}
                title={t('issues:page.title')}
                titleSlot="issues-title"
                subtitleSlot="issues-counts"
                actions={
                    <>
                        {admin && (
                            <Button
                                variant={selecting ? 'secondary' : 'outline'}
                                size="sm"
                                aria-pressed={selecting}
                                onClick={() => (selecting ? exitSelect() : setSelecting(true))}
                            >
                                <SquareCheck />
                                {t('issues:page.select')}
                            </Button>
                        )}
                        <div
                            role="group"
                            aria-label={t('issues:page.view')}
                            data-tour="issue-views"
                            className="flex rounded-md border p-0.5"
                        >
                            <ViewButton
                                label={t('issues:page.board-view')}
                                active={view === 'board'}
                                onClick={() => setView('board')}
                            >
                                <Columns3 />
                            </ViewButton>
                            <ViewButton
                                label={t('issues:page.list-view')}
                                active={view === 'list'}
                                onClick={() => setView('list')}
                            >
                                <LayoutList />
                            </ViewButton>
                        </div>
                        <Button size="sm" onClick={() => openReport()} data-tour="issue-create">
                            <Plus />
                            {t('issues:page.new')}
                        </Button>
                    </>
                }
            >
                {data.issues ? t('issues:page.counts', counts) : t('issues:page.tracker')}
            </PageHeader>
            <IssueToolbar
                filters={filters}
                setFilters={setFilters}
                shown={shown.length}
                total={all.length}
                dotRequests={openDotRequests}
                sortByVotes={sortByVotes}
                setSortByVotes={setSortByVotes}
                components={{
                    options: componentOptions,
                    labels: data.components,
                    chosen: chosenComponents,
                    setChosen: setChosenComponents,
                }}
                wontFix={
                    view === 'board' && !filters.status.length
                        ? { count: wontFixCount, shown: wontFix, setShown: setWontFix }
                        : undefined
                }
            />
            {selecting && (
                <BatchBar
                    selected={selectedIssues}
                    shown={shown.length}
                    admin={admin}
                    busy={batchBusy}
                    apply={(what, change) => void applyBatch(what, change)}
                    selectAll={() => setSelected(new Set(shown.map((i) => i.number)))}
                    clear={() => setSelected(new Set())}
                    exit={exitSelect}
                />
            )}
            {data.error && !data.issues && (
                <p
                    role="alert"
                    data-slot="issues-error"
                    className="mx-4 mb-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive md:mx-6"
                >
                    {data.error}
                </p>
            )}
            <div className="min-h-0 flex-1">
                {!data.issues ? (
                    <div className="flex gap-3 px-4 md:px-6" aria-busy="true">
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-64 w-72 shrink-0 rounded-xl" />
                        ))}
                    </div>
                ) : view === 'board' ? (
                    <IssueBoard
                        issues={shown}
                        users={data.users}
                        components={data.components}
                        statuses={statuses}
                        canMove={admin}
                        onMove={move}
                        selection={selection}
                    />
                ) : (
                    <IssueList
                        issues={shown}
                        users={data.users}
                        components={data.components}
                        statuses={filters.status.length ? filters.status : undefined}
                        canMove={admin}
                        onMove={move}
                        selection={selection}
                    />
                )}
            </div>
            <div data-slot="issues-footer" className="empty:hidden">
                <Slot name="issues.footer" props={{}} />
            </div>
            <IssueDetailDialog
                number={open}
                initial={openIssue}
                user={user}
                update={data.update}
                onChanged={data.replace}
                onDeleted={data.remove}
                onClose={close}
                reread={data.reread}
            />
        </main>
    );
}

function ViewButton({
    label,
    active,
    onClick,
    children,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            aria-pressed={active}
            className={cn('size-7', active && 'bg-accent text-accent-foreground')}
            onClick={onClick}
        >
            {children}
        </Button>
    );
}
