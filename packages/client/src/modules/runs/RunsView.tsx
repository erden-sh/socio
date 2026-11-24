import { ChevronRight } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';

import type { AgentRunStatus, AgentRunSummary } from '@socio/shared/types';
import type { RunList } from '@socio/shared/web/web';

import { apiIfChanged, PollTags, UNCHANGED } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useSlot } from '../context';

import { formatDuration, formatRunTime, fullRunTime } from './format';
import { RunTimeline, TraceSummaryLine } from './RunTimeline';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const sourceLabel: Record<AgentRunSummary['source'], string> = {
    web: 'Web',
    telegram: 'Telegram',
    scheduled: 'Scheduled task',
    voice: 'Voice call',
};

/**
 * Each status as a word beside a dot (CB-308): green when it finished,
 * red when it failed or broke off, the accent while it runs.
 */
const statusLabel: Record<AgentRunStatus, string> = {
    running: 'Running',
    finished: 'Finished',
    stopped: 'Stopped',
    failed: 'Failed',
    interrupted: 'Interrupted',
};
const statusDot: Record<AgentRunStatus, string> = {
    running: 'bg-primary motion-safe:animate-pulse',
    finished: 'bg-emerald-600 dark:bg-emerald-500',
    stopped: 'bg-muted-foreground/50',
    failed: 'bg-destructive',
    interrupted: 'bg-destructive',
};

function RunStatusWord({ status }: { status: AgentRunStatus }) {
    return (
        <span data-slot="run-status" className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusDot[status])} />
            {statusLabel[status]}
        </span>
    );
}

// The status filter; Radix Select has no empty value, so "all" stands in.
const ALL = 'all';
const filters: [string, string][] = [
    [ALL, 'All turns'],
    ['failed', 'Failed only'],
    ['interrupted', 'Interrupted'],
    ['stopped', 'Stopped'],
    ['running', 'Running'],
    ['finished', 'Finished'],
];
const columns = ['Status', 'Conversation', 'Owner', 'Source', 'Started', 'Duration'];

/**
 * A turn with a trace to show: one that runs, or ended since traces
 * (CB-128), and that the viewer may open (in a room, a member opens only
 * their own turns', CB-213).
 */
const traceable = (run: AgentRunSummary) => run.canTrace !== false && (!!run.trace || run.status === 'running');

/**
 * Runs: recent turns, across all users for admins and their own for
 * members (in a room, by role: CB-213), with `run.actions` and each
 * turn's trace (CB-128) under it.
 */
export function RunsView({
    onOpen,
    initial,
}: {
    onOpen: (threadId: string) => void;
    /** The page's loader data: the latest runs, as many as the first screen. */
    initial?: RunList;
}) {
    // Other modules' per-run actions (Issues' "File issue").
    const runActions = useSlot('run.actions');
    const [filter, setFilter] = useState<AgentRunStatus | ''>('');
    const [data, setData] = useState<RunList | undefined>(initial);
    // A first screen that may hide older runs is filled in at once; one
    // that has every run waits for the next poll.
    const skipFirst = useRef(!!initial && initial.runs.length < initial.limit);
    // The list's tag: a poll with no change is a 304 (api.ts). New loader
    // data replaces the list, so its tag goes too.
    const [tags] = useState(() => new PollTags());
    useLoaderSeed(initial, (next) => {
        tags.forget();
        setData(next);
    });
    const [error, setError] = useState('');
    // The turn whose trace is open.
    const [traced, setTraced] = useState<string>();
    const load = useCallback(() => {
        const path = `/runs${filter ? `?status=${filter}` : ''}`;
        void apiIfChanged<RunList>(path, tags.get(path))
            .then((answer) => {
                if (answer !== UNCHANGED) {
                    setData(answer.data);
                    tags.set(path, answer.tag);
                }
                setError('');
            })
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, [filter, tags]);
    useEffect(() => {
        if (skipFirst.current) {
            skipFirst.current = false;
        } else {
            load();
        }
        const timer = setInterval(load, 10_000);
        return () => clearInterval(timer);
    }, [load]);
    useLiveTopic('runs', load);
    return (
        <section data-slot="runs-view" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center gap-3">
                <Select
                    value={filter || ALL}
                    onValueChange={(value) => {
                        setData(undefined);
                        setFilter(value === ALL ? '' : (value as AgentRunStatus));
                    }}
                >
                    <SelectTrigger aria-label="Filter by status">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {filters.map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                {data && data.runs.length >= data.limit && (
                    <span className="text-xs text-muted-foreground">Showing the latest {data.limit}.</span>
                )}
            </div>
            {error && (
                <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                    {error}
                </p>
            )}
            {data?.runs.length ? (
                <Table data-slot="runs-table" className="text-xs">
                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            {columns.map((column) => (
                                <TableHead key={column} className="h-auto py-1.5 text-muted-foreground">
                                    {column}
                                </TableHead>
                            ))}
                        </TableRow>
                    </TableHeader>
                    <TableBody className="[&_tr:last-child]:border-b">
                        {data.runs.map((run) => (
                            <Fragment key={run.runId}>
                                <TableRow data-run={run.runId} data-status={run.status} className="[&>td]:align-top">
                                    <TableCell>
                                        {traceable(run) ? (
                                            // The status opens the turn's trace in place, a row
                                            // disclosure (CB-308), so a touch has a target bigger
                                            // than the chevron alone.
                                            <button
                                                type="button"
                                                className="-my-1 -ml-1.5 inline-flex items-center gap-1 rounded-md py-1 pr-1.5 pl-0.5 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                                aria-expanded={traced === run.runId}
                                                aria-label={`${traced === run.runId ? 'Hide' : 'Show'} the trace of ${run.title ?? 'this turn'}`}
                                                onClick={() => setTraced(traced === run.runId ? undefined : run.runId)}
                                            >
                                                <ChevronRight
                                                    className={cn(
                                                        'size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                                                        traced === run.runId && 'rotate-90',
                                                    )}
                                                    aria-hidden="true"
                                                />
                                                <RunStatusWord status={run.status} />
                                            </button>
                                        ) : (
                                            <span className="inline-flex pl-[18px]">
                                                <RunStatusWord status={run.status} />
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="min-w-40 whitespace-normal">
                                        {run.readable ? (
                                            <Button
                                                variant="link"
                                                className="h-auto p-0 text-left text-xs font-normal whitespace-normal text-foreground"
                                                onClick={() => onOpen(run.threadId)}
                                            >
                                                {run.title ?? 'Untitled conversation'}
                                            </Button>
                                        ) : (
                                            <span>{run.title ?? 'Deleted conversation'}</span>
                                        )}
                                        {run.dotName && <span className="text-muted-foreground"> · {run.dotName}</span>}
                                        {run.error && (
                                            <p
                                                data-slot="run-error"
                                                className="mt-1 leading-relaxed [overflow-wrap:anywhere] text-destructive"
                                            >
                                                {run.error}
                                            </p>
                                        )}
                                        {run.errorDetail && (
                                            <p
                                                data-slot="run-error-detail"
                                                className="mt-1 font-mono leading-relaxed [overflow-wrap:anywhere] text-destructive"
                                            >
                                                {run.errorDetail}
                                            </p>
                                        )}
                                        {run.trace && <TraceSummaryLine summary={run.trace} />}
                                        {runActions.length > 0 && (
                                            <div data-slot="run-actions" className="mt-1 flex gap-2">
                                                {runActions.map(({ key, Component }) => (
                                                    <Component key={key} run={run} />
                                                ))}
                                            </div>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        {run.ownerName ?? run.ownerId ?? 'unknown'}
                                        {run.room && <span className="text-muted-foreground"> · room</span>}
                                    </TableCell>
                                    <TableCell>{sourceLabel[run.source]}</TableCell>
                                    <TableCell className="tabular-nums">
                                        <LocalTime value={run.startedAt} format={formatRunTime} title={fullRunTime} />
                                    </TableCell>
                                    <TableCell className="tabular-nums">
                                        {run.finishedAt === null ? '…' : formatDuration(run.finishedAt - run.startedAt)}
                                    </TableCell>
                                </TableRow>
                                {traced === run.runId && (
                                    <TableRow data-slot="run-trace-row" className="hover:bg-transparent">
                                        <TableCell colSpan={columns.length} className="whitespace-normal">
                                            <RunTimeline
                                                runId={run.runId}
                                                version={`${run.status}:${run.finishedAt}`}
                                            />
                                        </TableCell>
                                    </TableRow>
                                )}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {data ? (filter ? `No ${filter} turns.` : 'No turns yet.') : 'Loading…'}
                </p>
            )}
        </section>
    );
}
