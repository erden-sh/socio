import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import {
    reservedUserId,
    type DataAuditEntry,
    type DataSpaceState,
    type DatasetView,
    type GrantAccess,
} from '@socio/shared/data-types';
import { MODULE_IDS } from '@socio/shared/modules';
import type { Dot } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';
import { LocalTime } from '../../lib/local-time';
import { useLoaderSeed } from '../../lib/page-loader';
import { useShell } from '../../shell/shell-context';
import { WorkspacePage } from '../../views/WorkspacePage';

import { fieldClass, formatBytes, formatTime } from './format';
import { SharedAreas } from './SharedAreas';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);

/** Where a dataset comes from, in a badge. */
export function DatasetKind({ dataset }: { dataset: DatasetView }) {
    if (dataset.plugin) {
        // A workspace dataset a service plugin writes (CB-451): admins manage it.
        return <Badge variant="outline">Written by {dataset.plugin.name}</Badge>;
    }
    if (dataset.wasWrittenBy) {
        // Its writer was uninstalled or rebound: the workspace's, bindable again.
        return <Badge variant="outline">Was written by {dataset.wasWrittenBy.name}</Badge>;
    }
    if (dataset.access === 'shared') {
        return <Badge variant="secondary">Shared with {dataset.dotName ?? 'a socio'}</Badge>;
    }
    if (dataset.access === 'read' && reservedUserId(dataset.ownerUserId)) {
        // A workspace dataset a promoted app's data moved into (CB-354).
        return <Badge variant="outline">Workspace · {dataset.dotName ?? 'a socio'}</Badge>;
    }
    if (dataset.access === 'read') {
        return <Badge variant="outline">Shared by {dataset.ownerName}</Badge>;
    }
    if (dataset.kind === 'scratch') {
        return (
            <Badge variant="secondary">
                {dataset.fromDeletedDot ? 'From a deleted socio' : `Scratch · ${dataset.dotName ?? 'Socio'}`}
            </Badge>
        );
    }
    return <Badge variant="outline">{dataset.sharedSpaceId ? 'Shared with a Space' : 'Dataset'}</Badge>;
}

function UsageBar({ used, max }: { used: number; max: number }) {
    const share = Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
    return (
        <div className="grid gap-1">
            <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="meter"
                aria-label="Data space used"
                aria-valuenow={share}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
            </div>
            <small className="text-xs text-muted-foreground">
                {formatBytes(used)} of {formatBytes(max)} used ({share}%)
            </small>
        </div>
    );
}

/**
 * `/data`: the signed-in user's data space. Datasets (their Dots' scratch
 * datasets, their own, and others' shared with a Space), files, grants per
 * Dot, the audit trail, and usage; admins also see everyone's usage.
 */
export function DataPage({
    initial,
}: {
    /** The page's loader data: shown at once, with no second read. */
    initial?: DataSpaceState;
} = {}) {
    const shell = useShell();
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') ?? 'datasets';
    const [state, setState] = useState<DataSpaceState | undefined>(initial);
    const seeded = useRef(!!initial);
    useLoaderSeed(initial, setState);
    const [audit, setAudit] = useState<DataAuditEntry[]>();
    const load = useCallback(
        () =>
            // Files are listed on Media; this page shows their count.
            api<DataSpaceState>('/data?files=false')
                .then(setState)
                .catch((e) => failed(e, 'Could not load your data.')),
        [],
    );
    useLiveTopic('data', load);
    useEffect(() => {
        if (seeded.current) {
            seeded.current = false;
            return;
        }
        void load();
    }, [load]);
    useEffect(() => {
        if (tab === 'audit') {
            void api<DataAuditEntry[]>('/data/audit')
                .then(setAudit)
                .catch((e) => failed(e, 'Could not load the audit trail.'));
        }
    }, [tab]);
    const dots = shell.workspace.dots;
    return (
        <WorkspacePage
            slot="data-page"
            module={MODULE_IDS.data}
            title="Data"
            description="What your socios keep for you: datasets and files that outlast a conversation. It is yours: browse, export and delete it, and choose which socio may use what."
        >
            {state && (
                <div className="mb-4 max-w-md">
                    <UsageBar used={state.usage.own.totalBytes} max={state.usage.limits.userMaxBytes} />
                </div>
            )}
            <Tabs
                value={tab}
                onValueChange={(next) => setParams(next === 'datasets' ? {} : { tab: next }, { replace: true })}
                className="gap-4"
            >
                <TabsList
                    aria-label="Data"
                    className="max-w-full flex-wrap justify-start gap-1 group-data-[orientation=horizontal]/tabs:h-auto"
                >
                    <TabsTrigger value="datasets">Datasets</TabsTrigger>
                    <TabsTrigger value="files">Files</TabsTrigger>
                    <TabsTrigger value="shared">Shared with socios</TabsTrigger>
                    <TabsTrigger value="dots">Socio access</TabsTrigger>
                    <TabsTrigger value="audit">Audit</TabsTrigger>
                    <TabsTrigger value="usage">Usage</TabsTrigger>
                </TabsList>
                <TabsContent value="datasets">
                    {state ? <Datasets state={state} reload={load} /> : <Skeleton className="h-32" />}
                </TabsContent>
                <TabsContent value="files">
                    {state ? <Files count={state.usage.own.files} /> : <Skeleton className="h-32" />}
                </TabsContent>
                <TabsContent value="shared">
                    {state ? <SharedAreas areas={state.shared ?? []} reload={load} /> : <Skeleton className="h-32" />}
                </TabsContent>
                <TabsContent value="dots">
                    {state ? <DotAccess state={state} dots={dots} reload={load} /> : <Skeleton className="h-32" />}
                </TabsContent>
                <TabsContent value="audit">
                    {audit ? <AuditTable entries={audit} /> : <Skeleton className="h-32" />}
                </TabsContent>
                <TabsContent value="usage">
                    {state ? <Usage state={state} /> : <Skeleton className="h-32" />}
                </TabsContent>
            </Tabs>
        </WorkspacePage>
    );
}

function Datasets({ state, reload }: { state: DataSpaceState; reload: () => void }) {
    const [name, setName] = useState('');
    const [creating, setCreating] = useState(false);
    const create = async (event: FormEvent) => {
        event.preventDefault();
        if (!name.trim()) {
            return;
        }
        setCreating(true);
        try {
            await api('/data/datasets', 'POST', { name: name.trim() });
            setName('');
            reload();
        } catch (e) {
            failed(e, 'Could not create the dataset.');
        } finally {
            setCreating(false);
        }
    };
    return (
        <Card>
            <CardHeader>
                <CardTitle>Datasets</CardTitle>
                <CardDescription>
                    Each socio has a scratch dataset for you, created the first time it needs one. Other datasets a
                    socio uses only with your grant.
                </CardDescription>
                <CardAction>
                    <form className="flex gap-2" onSubmit={create}>
                        <Input
                            aria-label="New dataset name"
                            placeholder="New dataset"
                            value={name}
                            maxLength={80}
                            onChange={(event) => setName(event.target.value)}
                        />
                        <Button type="submit" disabled={creating || !name.trim()}>
                            <Plus /> Create
                        </Button>
                    </form>
                </CardAction>
            </CardHeader>
            <CardContent>
                {!state.datasets.length ? (
                    <p className="text-sm text-muted-foreground">
                        Nothing yet. Ask a socio to keep track of something, and its scratch dataset shows up here.
                    </p>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead>Kind</TableHead>
                                <TableHead className="text-right">Tables</TableHead>
                                <TableHead className="text-right">Size</TableHead>
                                {/* On a phone the dataset's page shows these (CB-262). */}
                                <TableHead className="hidden sm:table-cell">Retention</TableHead>
                                <TableHead className="hidden sm:table-cell">Updated</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {state.datasets.map((dataset) => (
                                <TableRow key={dataset.id} data-dataset={dataset.name}>
                                    <TableCell className="font-medium whitespace-normal wrap-anywhere">
                                        <Link
                                            className="underline-offset-4 hover:underline"
                                            to={`/data/datasets/${dataset.id}`}
                                        >
                                            {dataset.name}
                                        </Link>
                                    </TableCell>
                                    <TableCell>
                                        <DatasetKind dataset={dataset} />
                                    </TableCell>
                                    <TableCell className="text-right">{dataset.tableCount}</TableCell>
                                    <TableCell className="text-right">{formatBytes(dataset.sizeBytes)}</TableCell>
                                    <TableCell className="hidden sm:table-cell">
                                        {dataset.retentionDays ? `${dataset.retentionDays} days` : 'Keep'}
                                    </TableCell>
                                    <TableCell className="hidden sm:table-cell">
                                        <LocalTime value={dataset.updatedAt} format={formatTime} />
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}

/** Files moved to the Media page (CB-54); the tab points there. */
function Files({ count }: { count: number }) {
    return (
        <Card data-slot="data-files-moved">
            <CardHeader>
                <CardTitle>Files</CardTitle>
                <CardDescription>
                    Files and chat attachments are in Media: browse and preview them, upload, move and delete, and
                    choose which socios may read a folder.
                </CardDescription>
                <CardAction>
                    <Button asChild>
                        <Link to="/media">Open Media</Link>
                    </Button>
                </CardAction>
            </CardHeader>
            <CardContent>
                <p className="text-sm text-muted-foreground">
                    {count === 1 ? '1 file' : `${count} files`}, encrypted at rest. Each socio writes in its own folder
                    unless you grant it another.
                </p>
            </CardContent>
        </Card>
    );
}

function DotAccess({ state, dots, reload }: { state: DataSpaceState; dots: Dot[]; reload: () => void }) {
    const own = state.datasets.filter((dataset) => dataset.access === 'owner');
    const save = async (body: Record<string, unknown>) => {
        try {
            await api('/data/grants', 'PUT', body);
            reload();
        } catch (e) {
            failed(e, 'Could not save the grant.');
        }
    };
    const revoke = async (id: string) => {
        try {
            await api(`/data/grants/${id}`, 'DELETE');
            reload();
        } catch (e) {
            failed(e, 'Could not remove the grant.');
        }
    };
    return (
        <div className="grid gap-4">
            {dots.map((dot) => {
                const grants = state.grants.filter((grant) => grant.dotId === dot.id);
                return (
                    <Card key={dot.id} data-dot={dot.name}>
                        <CardHeader>
                            <CardTitle>{dot.name}</CardTitle>
                            <CardDescription>
                                Its scratch dataset and its own folder (dots/{dot.id}/) are always its own. Everything
                                else needs a grant from you.
                            </CardDescription>
                            <CardAction>
                                <Button variant="outline" size="sm" asChild>
                                    <Link to={`/approvals?dot=${dot.id}`}>Approval policies</Link>
                                </Button>
                            </CardAction>
                        </CardHeader>
                        <CardContent className="grid gap-3">
                            {grants.map((grant) => (
                                <div
                                    key={grant.id}
                                    className="flex flex-wrap items-center gap-2 text-sm"
                                    data-grant={grant.datasetName ?? grant.folder}
                                >
                                    <span className="font-medium">
                                        {grant.datasetName
                                            ? `Dataset “${grant.datasetName}”`
                                            : `Folder ${grant.folder}`}
                                    </span>
                                    <select
                                        data-slot="grant-access"
                                        aria-label="Access"
                                        className={fieldClass}
                                        value={grant.access}
                                        onChange={(event) =>
                                            void save({
                                                dotId: dot.id,
                                                ...(grant.datasetId
                                                    ? { datasetId: grant.datasetId }
                                                    : { folder: grant.folder }),
                                                access: event.target.value as GrantAccess,
                                            })
                                        }
                                    >
                                        <option value="read">Read</option>
                                        <option value="write">Read and write</option>
                                    </select>
                                    <Button variant="ghost" size="sm" onClick={() => void revoke(grant.id)}>
                                        Remove
                                    </Button>
                                </div>
                            ))}
                            {!grants.length && <p className="text-sm text-muted-foreground">No grants.</p>}
                            <GrantForm
                                dot={dot}
                                datasets={own.filter((dataset) => dataset.scratchForDotId !== dot.id)}
                                onSave={save}
                            />
                        </CardContent>
                    </Card>
                );
            })}
        </div>
    );
}

function GrantForm({
    dot,
    datasets,
    onSave,
}: {
    dot: Dot;
    datasets: DatasetView[];
    onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
    const [target, setTarget] = useState('');
    const [folder, setFolder] = useState('');
    const [access, setAccess] = useState<GrantAccess>('read');
    return (
        <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
                event.preventDefault();
                if (!target) {
                    return;
                }
                void onSave({
                    dotId: dot.id,
                    ...(target === '__folder' ? { folder } : { datasetId: target }),
                    access,
                }).then(() => {
                    setTarget('');
                    setFolder('');
                });
            }}
        >
            <select
                data-slot="grant-target"
                aria-label={`Give ${dot.name} access to`}
                className={fieldClass}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
            >
                <option value="">Give access to…</option>
                {datasets.map((dataset) => (
                    <option key={dataset.id} value={dataset.id}>
                        {dataset.name}
                    </option>
                ))}
                <option value="__folder">A folder of files…</option>
            </select>
            {target === '__folder' && (
                <Input
                    aria-label="Folder"
                    placeholder="reports/"
                    className="w-48"
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                />
            )}
            <select
                data-slot="grant-new-access"
                aria-label="Access"
                className={fieldClass}
                value={access}
                onChange={(event) => setAccess(event.target.value as GrantAccess)}
            >
                <option value="read">Read</option>
                <option value="write">Read and write</option>
            </select>
            <Button type="submit" size="sm" disabled={!target || (target === '__folder' && !folder.trim())}>
                Grant
            </Button>
        </form>
    );
}

const ACTOR: Record<DataAuditEntry['actorKind'], string> = {
    user: 'You',
    dot: 'Socio',
    token: 'Computer',
    system: 'Socio',
    plugin: 'Plugin',
};

export function AuditTable({ entries }: { entries: DataAuditEntry[] }) {
    if (!entries.length) {
        return <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>;
    }
    return (
        <Table data-slot="data-audit">
            <TableHeader>
                <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>On</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Detail</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {entries.map((entry) => (
                    <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">{formatTime(entry.createdAt)}</TableCell>
                        <TableCell>
                            {entry.actorKind === 'dot' || entry.actorKind === 'token'
                                ? `${entry.dotName ?? 'A deleted socio'}${entry.actorKind === 'token' ? ' (computer)' : ''}`
                                : ACTOR[entry.actorKind]}
                        </TableCell>
                        <TableCell>{entry.action.replace(/_/g, ' ')}</TableCell>
                        <TableCell className="max-w-48 truncate">{entry.target}</TableCell>
                        <TableCell>
                            <Badge
                                variant={
                                    entry.outcome === 'ok'
                                        ? 'secondary'
                                        : entry.outcome === 'pending'
                                          ? 'outline'
                                          : 'destructive'
                                }
                            >
                                {entry.outcome}
                            </Badge>
                        </TableCell>
                        <TableCell className="max-w-80 truncate text-muted-foreground" title={entry.detail ?? ''}>
                            {entry.detail}
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}

function Usage({ state }: { state: DataSpaceState }) {
    const { limits, own, all } = state.usage;
    return (
        <div className="grid gap-4">
            <Card>
                <CardHeader>
                    <CardTitle>Your usage</CardTitle>
                    <CardDescription>Limits apply to every socio, approvals or not.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 text-sm">
                    <UsageBar used={own.totalBytes} max={limits.userMaxBytes} />
                    <ul className="grid gap-1 text-muted-foreground" data-slot="data-limits">
                        <li>
                            {own.datasets} dataset(s), {formatBytes(own.datasetBytes)}; {own.files} file(s),{' '}
                            {formatBytes(own.fileBytes)}
                        </li>
                        <li>
                            Each dataset up to {formatBytes(limits.datasetMaxBytes)}; files up to{' '}
                            {formatBytes(limits.fileMaxBytes)}
                        </li>
                        <li>Up to {limits.maxDatasets} datasets besides the socios’ scratch datasets</li>
                        <li>
                            Queries stop after {limits.queryTimeoutMs / 1000} s and return at most {limits.queryMaxRows}{' '}
                            rows; a socio makes at most {limits.statementsPerMinute} data operations a minute
                        </li>
                    </ul>
                </CardContent>
            </Card>
            {all && (
                <Card data-slot="data-usage-all">
                    <CardHeader>
                        <CardTitle>Everyone’s usage</CardTitle>
                        <CardDescription>
                            Admins see how much each person uses, never what is in it. What people delete is kept, and
                            so are the earlier versions of files they replace; neither counts toward their quota.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Person</TableHead>
                                    <TableHead className="text-right">Datasets</TableHead>
                                    <TableHead className="text-right">Files</TableHead>
                                    <TableHead className="text-right">Used</TableHead>
                                    <TableHead className="text-right">Deleted, kept</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {all.map((entry) => (
                                    <TableRow key={entry.userId}>
                                        <TableCell>{entry.userName}</TableCell>
                                        <TableCell className="text-right">{entry.datasets}</TableCell>
                                        <TableCell className="text-right">{entry.files}</TableCell>
                                        <TableCell className="text-right">{formatBytes(entry.totalBytes)}</TableCell>
                                        <TableCell
                                            className="text-right"
                                            title={`${entry.deletedDatasets ?? 0} datasets, ${entry.deletedFiles ?? 0} files`}
                                        >
                                            {formatBytes(entry.deletedBytes ?? 0)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
