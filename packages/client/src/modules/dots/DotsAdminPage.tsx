import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type { DotActivity, DotAdminDetail, DotAdminRow } from '@socio/shared/dot-admin-types';
import { MODULE_IDS } from '@socio/shared/modules';

import { api } from '../../lib/api';
import { WorkspacePage } from '../../views/WorkspacePage';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const failed = (e: unknown, fallback: string) => toast.error(e instanceof Error ? e.message : fallback);
const when = (t: number | null) =>
    t
        ? new Date(t).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
          })
        : '—';

function Status({ row }: { row: DotAdminRow }) {
    return row.dot.archivedAt ? <Badge variant="secondary">archived</Badge> : <Badge variant="outline">active</Badge>;
}

/** `/admin/dots`: every Dot, company Dots first, then everyone's own. */
export function DotsAdminPage() {
    const [rows, setRows] = useState<DotAdminRow[]>();
    useEffect(() => {
        api<{ dots: DotAdminRow[] }>('/admin/dots')
            .then((answer) => setRows(answer.dots))
            .catch((e) => failed(e, 'Could not load the socios.'));
    }, []);
    return (
        <WorkspacePage
            slot="admin-dots"
            module={MODULE_IDS.dots}
            title="Socios"
            description="Every socio in the workspace: the company’s, and each person’s own. Open one for its settings, who uses it and its audit: every turn, filing, approval and computer, web and data action, with who it acted for."
        >
            {!rows ? (
                <Skeleton className="h-32" />
            ) : (
                <Table data-slot="admin-dot-list">
                    <TableHeader>
                        <TableRow>
                            <TableHead>Socio</TableHead>
                            <TableHead>Owner</TableHead>
                            <TableHead>Chats</TableHead>
                            <TableHead>People</TableHead>
                            <TableHead>Last activity</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row.dot.id} data-dot={row.dot.id}>
                                <TableCell>
                                    <Link to={`/admin/dots/${encodeURIComponent(row.dot.id)}`}>{row.dot.name}</Link>{' '}
                                    <Status row={row} />
                                </TableCell>
                                <TableCell>{row.ownerName ?? 'Company'}</TableCell>
                                <TableCell>{row.conversations}</TableCell>
                                <TableCell>{row.people}</TableCell>
                                <TableCell>{when(row.lastActivityAt)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </WorkspacePage>
    );
}

const on = (value: unknown) => (value ? 'on' : 'off');

/** `/admin/dots/:dotId`: one Dot's settings, use and audit. */
export function DotAdminDetailPage({ dotId }: { dotId: string }) {
    const [detail, setDetail] = useState<DotAdminDetail>();
    // Older pages: their lines, names and the cursor after the last one.
    const [more, setMore] = useState<DotActivity[]>([]);
    const [names, setNames] = useState<Record<string, string>>({});
    const [next, setNext] = useState<DotAdminDetail['next']>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(false);
    const path = `/admin/dots/${encodeURIComponent(dotId)}`;
    const load = useCallback(() => {
        api<DotAdminDetail>(path)
            .then((answer) => {
                setDetail(answer);
                setMore([]);
                setNames({});
                setNext(answer.next);
            })
            .catch((e) => failed(e, 'Could not load the socio.'));
    }, [path]);
    useEffect(load, [load]);
    if (!detail) {
        return <Skeleton className="m-6 h-32" />;
    }
    const { row } = detail;
    const users = { ...detail.users, ...names };
    const dot = row.dot;
    const activity = [...detail.activity, ...more];
    const name = (id: string | null) => (id ? (users[id] ?? id) : '—');
    const archive = async () => {
        setBusy(true);
        try {
            await api(`/dots/${encodeURIComponent(dot.id)}/${dot.archivedAt ? 'unarchive' : 'archive'}`, 'POST');
            load();
        } catch (e) {
            failed(e, 'Could not change the socio.');
        } finally {
            setBusy(false);
        }
    };
    const older = async () => {
        if (!next || loading) {
            return;
        }
        setLoading(true);
        try {
            const page = await api<DotAdminDetail>(`${path}?before=${next.before}&skip=${next.skip}`);
            setMore((lines) => [...lines, ...page.activity]);
            setNames((known) => ({ ...known, ...page.users }));
            setNext(page.next);
        } catch (e) {
            failed(e, 'Could not load more.');
        } finally {
            setLoading(false);
        }
    };
    return (
        <WorkspacePage
            slot="admin-dot"
            module={MODULE_IDS.dots}
            bodyClassName="grid grid-cols-1 gap-4"
            title={dot.name}
            description={
                <>
                    {row.ownerName ? `${row.ownerName}’s own socio` : 'A company socio'} · made {when(dot.createdAt)}
                    {dot.archivedAt ? ` · archived ${when(dot.archivedAt)} by ${name(dot.archivedBy ?? null)}` : ''}
                </>
            }
        >
            <Card>
                <CardHeader>
                    <CardTitle>Settings</CardTitle>
                    <CardDescription>
                        {row.conversations} chats with {row.people} people · {detail.filings} board filings ·{' '}
                        {detail.goals.active} active goals of {detail.goals.total}
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                    <p className="whitespace-pre-wrap">{dot.instructions}</p>
                    <p className="text-muted-foreground">
                        <Link
                            className="underline underline-offset-2 hover:text-foreground"
                            to={`/dots/${encodeURIComponent(dot.id)}/soul`}
                        >
                            Soul{dot.soul ? `, version ${dot.soul.version}` : ''}
                        </Link>
                        : its role, voice and every version
                    </p>
                    <p className="text-muted-foreground">
                        Research {on(dot.researchAllowed)} · memories {on(dot.memoryAllowed)} · Improvements board
                        filing {on(dot.issuesAllowed)} · Spaces:{' '}
                        {detail.spaces.map((space) => space.name).join(', ') || 'none'}
                    </p>
                    <div>
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void archive()}>
                            {dot.archivedAt ? 'Unarchive' : 'Archive'}
                        </Button>
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Audit</CardTitle>
                    <CardDescription>
                        Newest first: what this socio did and who changed it, with the person it acted for. Metadata
                        only, never chat, page or data contents.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {!activity.length ? (
                        <p className="text-sm text-muted-foreground">Nothing yet.</p>
                    ) : (
                        <Table data-slot="admin-dot-audit">
                            <TableHeader>
                                <TableRow>
                                    <TableHead>When</TableHead>
                                    <TableHead>What</TableHead>
                                    <TableHead>By</TableHead>
                                    <TableHead>For</TableHead>
                                    <TableHead>Detail</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {activity.map((line, index) => (
                                    <TableRow key={`${line.at}:${index}`} data-kind={line.kind}>
                                        <TableCell className="whitespace-nowrap">{when(line.at)}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline">{line.kind}</Badge>
                                        </TableCell>
                                        <TableCell>{name(line.actor)}</TableCell>
                                        <TableCell>{name(line.onBehalfOf)}</TableCell>
                                        <TableCell className="max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                                            {line.summary}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                    {next && (
                        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void older()}>
                            Older
                        </Button>
                    )}
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Chats</CardTitle>
                    <CardDescription>Owners and dates only: each chat is its owner’s to read.</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-1 text-sm">
                    {detail.conversations.map((thread) => (
                        <span key={thread.id}>
                            {name(thread.ownerId)}{' '}
                            <span className="text-muted-foreground">· started {when(thread.createdAt)}</span>
                        </span>
                    ))}
                    {!detail.conversations.length && <span className="text-muted-foreground">No chats.</span>}
                    <Link to="/admin/dots" className="mt-2">
                        ← All socios
                    </Link>
                </CardContent>
            </Card>
        </WorkspacePage>
    );
}
