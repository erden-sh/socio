import { Download, Play, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';

import {
    HISTORY_DAYS,
    RETENTION_DAYS,
    type DataAuditEntry,
    type DatasetDetail,
    type QueryResult,
    type RowsPage,
} from '@socio/shared/data-types';
import { MODULE_IDS } from '@socio/shared/modules';
import type { PageTreeItem } from '@socio/shared/pages/page-library';

import { ConfirmDelete } from '../../components/confirm-delete';
import { useRevalidateOn } from '../../hooks/use-tab-refresh';
import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useFlag } from '../../shell/flags';
import { useRouteParams, useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { AnalyticalRetentionControl, retentionLine } from './AnalyticalRetention';
import { AuditTable, DatasetKind } from './DataPage';
import { FieldsPanel } from './FieldsPanel';
import { fieldClass, formatBytes, formatCell, formatTime } from './format';

import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const PAGE = 50;
const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

function ResultTable({
    result,
    label,
    rowids,
    remove,
}: {
    result: QueryResult;
    label: string;
    rowids?: number[];
    remove?: (rowid: number) => void;
}) {
    return (
        <div className="overflow-x-auto rounded-md border">
            <Table aria-label={label}>
                <TableHeader>
                    <TableRow>
                        {remove && rowids && <TableHead>Actions</TableHead>}
                        {result.columns.map((column, index) => (
                            <TableHead key={`${column}-${index}`}>{column}</TableHead>
                        ))}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {result.rows.map((row, index) => (
                        <TableRow key={index}>
                            {remove && rowids && (
                                <TableCell>
                                    <Button variant="outline" size="sm" onClick={() => remove(rowids[index])}>
                                        Delete row
                                    </Button>
                                </TableCell>
                            )}
                            {row.map((value, cell) => (
                                <TableCell
                                    key={cell}
                                    className="max-w-72 truncate font-mono text-xs"
                                    title={formatCell(value)}
                                >
                                    {value === null ? (
                                        <span className="text-muted-foreground">null</span>
                                    ) : (
                                        formatCell(value)
                                    )}
                                </TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

/**
 * `/data/datasets/:datasetId`: one dataset. Browse its tables a page at a
 * time, run a read-only query, export (CSV per table, the SQLite file),
 * and, for the owner, retention, sharing with a Space, delete and audit.
 */
export function DatasetPage({
    initial,
}: {
    /** The dataset from the page's loader (its schema and sizes); null: none. */
    initial?: DatasetDetail | null;
} = {}) {
    const { datasetId = '' } = useRouteParams();
    const shell = useShell();
    // Its place under a page of its Space (CB-451), with the flag on.
    const placeUnder = useFlag('datasets-in-spaces');
    const navigate = useNavigate();
    const seed = initial?.dataset.id === datasetId ? initial : undefined;
    const [detail, setDetail] = useState<DatasetDetail | undefined>(seed);
    const seeded = useRef(!!seed);
    const [missing, setMissing] = useState(false);
    const [table, setTable] = useState(seed?.tables[0]?.name ?? '');
    const [page, setPage] = useState<RowsPage>();
    const [offset, setOffset] = useState(0);
    const [sql, setSql] = useState('');
    const [result, setResult] = useState<QueryResult>();
    const [queryError, setQueryError] = useState('');
    const [running, setRunning] = useState(false);
    // CB-369: DuckDB over both kinds of table, for a plugin's dataset with analytical ones.
    const [analyticsSql, setAnalyticsSql] = useState(false);
    const [audit, setAudit] = useState<DataAuditEntry[]>();
    const [confirm, setConfirm] = useState(false);
    // A table whose row history the owner is turning off (CB-369).
    const [historyOff, setHistoryOff] = useState<string>();
    const [removeRow, setRemoveRow] = useState<{
        table: string;
        rowid: number;
    }>();
    const base = `/data/datasets/${encodeURIComponent(datasetId)}`;
    const show = useCallback((next: DatasetDetail) => {
        setDetail(next);
        setMissing(false);
        setTable((current) => (next.tables.some((t) => t.name === current) ? current : (next.tables[0]?.name ?? '')));
    }, []);
    const load = useCallback(
        () =>
            api<DatasetDetail>(base)
                .then(show)
                .catch(() => setMissing(true)),
        [base, show],
    );
    // Another tab changed it (retention, sharing, a delete), or this tab
    // came back: the loader runs again and its copy replaces this one. A
    // loader that finds nothing (null) means it was deleted, or is no
    // longer this user's.
    useRevalidateOn('data');
    useLoaderSeed(initial, (next) => {
        if (next.dataset.id === datasetId) {
            show(next);
        }
    });
    const revalidated = useRef(initial);
    useEffect(() => {
        if (initial === revalidated.current) {
            return;
        }
        revalidated.current = initial;
        if (initial === null) {
            setMissing(true);
        }
    }, [initial]);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void load();
    }, [load]);
    const owner = detail?.dataset.access === 'owner';
    useEffect(() => {
        if (owner) {
            void api<DataAuditEntry[]>(`/data/audit?dataset=${encodeURIComponent(datasetId)}&limit=50`)
                .then(setAudit)
                .catch(() => setAudit([]));
        }
    }, [owner, datasetId, detail?.dataset.updatedAt]);
    // An analytical table has no row pages: it is read with an analytical query.
    const selectedAnalytical = detail?.tables.find((t) => t.name === table)?.kind === 'analytical';
    useEffect(() => {
        if (!table || selectedAnalytical) {
            return setPage(undefined);
        }
        void api<RowsPage>(`${base}/tables/${encodeURIComponent(table)}/rows?offset=${offset}&limit=${PAGE}`)
            .then(setPage)
            .catch((e) => failed(e, 'Could not load the rows.'));
        // A new copy of the dataset (a revalidation, a save): its rows too.
    }, [base, table, offset, detail, selectedAnalytical]);
    useEffect(() => {
        setOffset(0);
        if (table) {
            setSql(`SELECT * FROM "${table}" LIMIT 20`);
        }
        if (selectedAnalytical) {
            setAnalyticsSql(true);
        }
    }, [table, selectedAnalytical]);
    const run = async () => {
        setRunning(true);
        setQueryError('');
        try {
            const analytical = analyticsSql && detail?.dataset.access === 'owner' && !!detail.dataset.plugin;
            setResult(await api<QueryResult>(`${base}/${analytical ? 'analytics/query' : 'query'}`, 'POST', { sql }));
        } catch (e) {
            setResult(undefined);
            setQueryError(e instanceof Error ? e.message : 'The query failed.');
        } finally {
            setRunning(false);
        }
    };
    const setHistory = async (name: string, history: boolean) => {
        try {
            await api(`${base}/tables/${encodeURIComponent(name)}`, 'PATCH', { history });
            setHistoryOff(undefined);
            await load();
        } catch (e) {
            failed(e, 'Could not change the row history.');
        }
    };
    const compact = async (cancel: boolean) => {
        try {
            await api(`${base}/compact`, 'POST', cancel ? { cancel: true } : {});
            await load();
        } catch (e) {
            failed(e, 'Could not ask to compact the file.');
        }
    };
    const patch = async (body: Record<string, unknown>) => {
        try {
            await api(base, 'PATCH', body);
            await load();
        } catch (e) {
            failed(e, 'Could not save.');
        }
    };
    if (missing) {
        return (
            <WorkspacePage
                module={MODULE_IDS.data}
                title="Dataset not found"
                description={
                    <>
                        It was deleted, or it isn’t yours. <Link to="/data">Back to Data</Link>
                    </>
                }
            />
        );
    }
    if (!detail) {
        return (
            <main className="w-full px-4 pt-(--page-top) md:px-6">
                <Skeleton className="h-40" />
            </main>
        );
    }
    const { dataset, tables } = detail;
    // Phase 1: analytical tables are a plugin's, read by admins who manage it.
    const hasAnalytical = tables.some((t) => t.kind === 'analytical');
    const canAnalytics = hasAnalytical && owner && !!dataset.plugin;
    return (
        <WorkspacePage
            slot="dataset-page"
            module={MODULE_IDS.data}
            title={dataset.name}
            actions={
                <>
                    <Button variant="outline" asChild>
                        <a href={`/api${base}/export.sqlite`} download>
                            <Download /> Export SQLite
                        </a>
                    </Button>
                    {owner && (
                        <Button variant="destructive" onClick={() => setConfirm(true)}>
                            <Trash2 /> Delete
                        </Button>
                    )}
                </>
            }
            description={
                <>
                    {dataset.description || 'No description.'} <DatasetKind dataset={dataset} />{' '}
                    <span className="text-muted-foreground">
                        {formatBytes(dataset.sizeBytes)} · updated{' '}
                        <LocalTime value={dataset.updatedAt} format={formatTime} />
                    </span>
                </>
            }
        >
            {/* minmax(0, 1fr), not the grid's auto track: a card as wide as its
          longest unbreakable line would push the page sideways (CB-162). */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
                {owner && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Settings</CardTitle>
                            <CardDescription>
                                Retention deletes the dataset once it has not changed for that long. Sharing with a
                                Space lets everyone read it in the app; Socios then need your approval for each change.
                                Row history keeps the rows changes replace or delete; older rows go each night.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4 text-sm sm:flex sm:flex-wrap">
                            <label className="grid min-w-0 gap-1">
                                Retention
                                <select
                                    data-slot="dataset-retention"
                                    className={`${fieldClass} w-full sm:w-auto`}
                                    value={dataset.retentionDays ?? ''}
                                    onChange={(event) =>
                                        void patch({
                                            retentionDays: event.target.value ? Number(event.target.value) : null,
                                        })
                                    }
                                >
                                    <option value="">Keep until I delete it</option>
                                    {RETENTION_DAYS.map((days) => (
                                        <option key={days} value={days}>
                                            {days} days without changes
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="grid min-w-0 gap-1">
                                Shared with
                                <select
                                    data-slot="dataset-share"
                                    className={`${fieldClass} w-full sm:w-auto`}
                                    value={dataset.sharedSpaceId ?? ''}
                                    onChange={(event) => void patch({ sharedSpaceId: event.target.value || null })}
                                >
                                    <option value="">Nobody (private)</option>
                                    {/* Only a Space's editors place datasets in it (CB-451); its own stays listed. */}
                                    {shell.workspace.spaces
                                        .filter(
                                            (space) => space.access === 'editor' || space.id === dataset.sharedSpaceId,
                                        )
                                        .map((space) => (
                                            <option key={space.id} value={space.id}>
                                                {space.name}
                                            </option>
                                        ))}
                                </select>
                            </label>
                            {placeUnder && dataset.sharedSpaceId && (
                                <DatasetParent
                                    spaceId={dataset.sharedSpaceId}
                                    value={dataset.spaceParentId ?? null}
                                    disabled={
                                        shell.workspace.spaces.find((space) => space.id === dataset.sharedSpaceId)
                                            ?.access !== 'editor'
                                    }
                                    onChange={(spaceParentId) => void patch({ spaceParentId })}
                                />
                            )}
                            <label className="grid min-w-0 gap-1">
                                Row history
                                <select
                                    data-slot="dataset-history-days"
                                    className={`${fieldClass} w-full sm:w-auto`}
                                    value={dataset.historyDays ?? ''}
                                    onChange={(event) =>
                                        void patch({
                                            historyDays: event.target.value ? Number(event.target.value) : null,
                                        })
                                    }
                                >
                                    <option value="">Keep all of it</option>
                                    {HISTORY_DAYS.map((days) => (
                                        <option key={days} value={days}>
                                            Keep {days} days
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <div className="grid min-w-0 gap-1" data-slot="dataset-compact">
                                <span>
                                    File{' '}
                                    <span className="text-muted-foreground">
                                        ({formatBytes(dataset.sizeBytes + (dataset.historyBytes ?? 0))}, of which
                                        history {formatBytes(dataset.historyBytes ?? 0)})
                                    </span>
                                </span>
                                {dataset.compactRequestedAt ? (
                                    <span className="flex flex-wrap items-center gap-2">
                                        <span className="text-muted-foreground">Compacts tonight.</span>
                                        <Button variant="outline" size="sm" onClick={() => void compact(true)}>
                                            Don’t compact
                                        </Button>
                                    </span>
                                ) : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="w-fit"
                                        title="Gives back the space pruned history leaves in the file, tonight."
                                        onClick={() => void compact(false)}
                                    >
                                        Compact file
                                    </Button>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                )}
                <Card>
                    <CardHeader>
                        <CardTitle>Tables</CardTitle>
                        <CardDescription>
                            {tables.length
                                ? `${tables.length} table(s). Rows in storage order, ${PAGE} at a time.`
                                : 'No tables yet: the socio creates them as it needs them.'}
                        </CardDescription>
                        {table && !selectedAnalytical && (
                            <CardAction>
                                <Button variant="outline" size="sm" asChild>
                                    <a href={`/api${base}/export.csv?table=${encodeURIComponent(table)}`} download>
                                        <Download /> Export CSV
                                    </a>
                                </Button>
                            </CardAction>
                        )}
                    </CardHeader>
                    {!!tables.length && (
                        <CardContent className="grid gap-3">
                            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Tables">
                                {tables.map((t) => (
                                    <Button
                                        key={t.name}
                                        role="tab"
                                        aria-selected={t.name === table}
                                        variant={t.name === table ? 'default' : 'outline'}
                                        size="sm"
                                        className="h-auto min-h-8 max-w-full whitespace-normal break-all py-1 text-left"
                                        onClick={() => setTable(t.name)}
                                    >
                                        {t.name} <span className="opacity-70">({t.rowCount})</span>
                                        {t.kind === 'analytical' && <span className="opacity-70"> · analytical</span>}
                                    </Button>
                                ))}
                            </div>
                            {tables
                                .filter((t) => t.name === table)
                                .map((t) => (
                                    <div key={t.name} className="grid gap-1 text-xs text-muted-foreground">
                                        {t.analytical && (
                                            <p data-slot="table-analytical">
                                                Analytical (append-only Parquet), partitioned by{' '}
                                                {t.analytical.partitionBy.column} ({t.analytical.partitionBy.grain}):{' '}
                                                {t.analytical.partitions} partition(s)
                                                {t.analytical.firstPartition
                                                    ? `, ${t.analytical.firstPartition} to ${t.analytical.lastPartition}`
                                                    : ''}
                                                , {t.analytical.parts} file(s), {formatBytes(t.analytical.bytes)}.
                                                {t.analytical.retention
                                                    ? ` ${retentionLine(t.analytical.retention)}`
                                                    : t.analytical.retainDays
                                                      ? ` Partitions are kept ${t.analytical.retainDays} days.`
                                                      : ''}{' '}
                                                Read it with an analytical query below.
                                            </p>
                                        )}
                                        {owner && t.analytical?.retention && (
                                            <AnalyticalRetentionControl
                                                key={t.name}
                                                base={base}
                                                table={t.name}
                                                retention={t.analytical.retention}
                                                saved={load}
                                            />
                                        )}
                                        {t.history === false && (
                                            <p data-slot="table-no-history">
                                                No row history: changes to its rows aren’t kept.
                                            </p>
                                        )}
                                        {owner && t.history !== undefined && (
                                            <div>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    data-slot="table-history-toggle"
                                                    onClick={() =>
                                                        t.history
                                                            ? setHistoryOff(t.name)
                                                            : void setHistory(t.name, true)
                                                    }
                                                >
                                                    {t.history ? 'Turn row history off' : 'Keep row history'}
                                                </Button>
                                            </div>
                                        )}
                                        <p className="break-words">
                                            {t.columns
                                                .map(
                                                    (column) =>
                                                        `${column.name} ${column.type}${column.primaryKey ? ' (key)' : ''}`,
                                                )
                                                .join(' · ')}
                                        </p>
                                        {/* Declared indexes (CB-355), read-only: socios and apps add them. */}
                                        {!!t.indexes?.length && (
                                            <ul
                                                data-slot="table-indexes"
                                                aria-label={`Indexes of ${t.name}`}
                                                className="grid gap-0.5"
                                            >
                                                {t.indexes.map((index) => (
                                                    <li key={index.name} className="break-words">
                                                        <span className="font-medium">{index.name}</span> on{' '}
                                                        {index.columns.join(', ')}
                                                        {index.unique ? ' (unique)' : ''}
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                ))}
                            {page && (
                                <ResultTable
                                    result={page}
                                    label={`Rows of ${table}`}
                                    rowids={page.rowids}
                                    remove={
                                        dataset.access === 'shared'
                                            ? (rowid) => setRemoveRow({ table, rowid })
                                            : undefined
                                    }
                                />
                            )}
                            {page && (
                                <div className="flex items-center gap-2 text-sm">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={offset === 0}
                                        onClick={() => setOffset(Math.max(0, offset - PAGE))}
                                    >
                                        Previous
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={offset + PAGE >= page.total}
                                        onClick={() => setOffset(offset + PAGE)}
                                    >
                                        Next
                                    </Button>
                                    <span className="text-muted-foreground" data-slot="rows-range">
                                        {page.total
                                            ? `${offset + 1}–${Math.min(offset + PAGE, page.total)} of ${page.total}`
                                            : 'No rows'}
                                    </span>
                                </div>
                            )}
                        </CardContent>
                    )}
                </Card>
                {/* The Fields panel (CB-451): the dataset's page is what its
          item in a Space opens; only people who may write it see it. */}
                {placeUnder && owner && table && <FieldsPanel datasetId={datasetId} table={table} />}
                <Card>
                    <CardHeader>
                        <CardTitle>Query</CardTitle>
                        <CardDescription>
                            {analyticsSql && canAnalytics
                                ? 'One read-only SELECT (DuckDB) over every table, analytical ones included. Nothing you run here changes the data.'
                                : 'One read-only SELECT (SQLite). Nothing you run here changes the data.'}
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                        {canAnalytics && (
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    data-slot="query-analytics"
                                    checked={analyticsSql}
                                    onChange={(event) => setAnalyticsSql(event.target.checked)}
                                />
                                Analytical query (DuckDB), which reads analytical tables
                            </label>
                        )}
                        <Textarea
                            aria-label="SQL query"
                            className="min-h-20 font-mono text-sm"
                            value={sql}
                            onChange={(event) => setSql(event.target.value)}
                            placeholder='SELECT count(*) FROM "table"'
                        />
                        <div>
                            <Button disabled={running || !sql.trim()} onClick={() => void run()}>
                                <Play /> {running ? 'Running…' : 'Run query'}
                            </Button>
                        </div>
                        {queryError && (
                            <p role="alert" className="text-sm text-destructive">
                                {queryError}
                            </p>
                        )}
                        {result && (
                            <>
                                <ResultTable result={result} label="Query result" />
                                <small className="text-xs text-muted-foreground">
                                    {result.rows.length} row(s) in {result.ms} ms
                                    {result.truncated ? ', more were left out' : ''}
                                </small>
                            </>
                        )}
                    </CardContent>
                </Card>
                {owner && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Audit</CardTitle>
                            <CardDescription>Which socio read or wrote what, and when.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {audit ? <AuditTable entries={audit} /> : <Skeleton className="h-16" />}
                        </CardContent>
                    </Card>
                )}
            </div>
            {removeRow && (
                <ConfirmDelete
                    title="Delete this row?"
                    onClose={() => setRemoveRow(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(
                                `/data/shared/${encodeURIComponent(dataset.scratchForDotId!)}/tables/${encodeURIComponent(removeRow.table)}/rows`,
                                'DELETE',
                                { rowids: [removeRow.rowid] },
                            );
                            setRemoveRow(undefined);
                            await load();
                        } catch (error) {
                            failed(error, 'Could not delete this row.');
                        }
                    }}
                >
                    It is removed from the shared table for everyone who uses this socio. Its previous contents are kept
                    in history.
                </ConfirmDelete>
            )}
            {historyOff && (
                <AlertDialog open onOpenChange={(open) => !open && setHistoryOff(undefined)}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Turn row history off for “{historyOff}”?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Changes to its rows are no longer kept, and the rows it kept so far are deleted tonight.
                                Use it for tables that are rebuilt from others. Older backups still have them.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <Button variant="destructive" onClick={() => void setHistory(historyOff, false)}>
                                Turn it off
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            )}
            <AlertDialog open={confirm} onOpenChange={setConfirm}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete “{dataset.name}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {dataset.plugin
                                ? `The ${dataset.plugin.name} plugin can no longer write to it; enabling the plugin again starts a new, empty one. `
                                : ''}
                            It’s removed from {dataset.plugin ? 'the workspace’s' : 'your'} data
                            {dataset.sharedSpaceId && ' and from the Space it’s shared with'}. Socios lose access to it,
                            and views of it on pages stop showing its rows.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={async () => {
                                try {
                                    await api(base, 'DELETE');
                                    setConfirm(false);
                                    toast.success(`Deleted ${dataset.name}.`);
                                    navigate('/data');
                                } catch (e) {
                                    failed(e, 'Could not delete the dataset.');
                                }
                            }}
                        >
                            Delete dataset
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </WorkspacePage>
    );
}

/**
 * "Under page" (CB-451): where the dataset sits in its Space,
 * at its root or under one of its pages; never under another dataset. Only
 * the Space's editors move it there; the server checks again.
 */
function DatasetParent({
    spaceId,
    value,
    disabled,
    onChange,
}: {
    spaceId: string;
    value: string | null;
    disabled: boolean;
    onChange: (parentId: string | null) => void;
}) {
    const [pages, setPages] = useState<PageTreeItem[]>([]);
    useEffect(() => {
        let current = true;
        api<PageTreeItem[]>(`/spaces/${encodeURIComponent(spaceId)}/page-tree`).then(
            (tree) => current && setPages(tree),
            () => current && setPages([]),
        );
        return () => {
            current = false;
        };
    }, [spaceId]);
    return (
        <label className="grid min-w-0 gap-1">
            Under page
            <select
                data-slot="dataset-parent"
                className={`${fieldClass} w-full sm:w-auto`}
                value={value ?? ''}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value || null)}
            >
                <option value="">The Space’s top level</option>
                {pages.map((page) => (
                    <option key={page.id} value={page.id}>
                        {page.title.trim() || 'Untitled page'}
                    </option>
                ))}
            </select>
        </label>
    );
}
