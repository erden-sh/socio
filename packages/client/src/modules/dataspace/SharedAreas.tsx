import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';

import type { SharedAreaView, SharedOrigin } from '@socio/shared/data-types';

import { ConfirmDelete } from '../../components/confirm-delete';
import { api } from '../../lib/api';

import { formatBytes, formatTime } from './format';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function origin(value: SharedOrigin | null) {
    return value
        ? `${value.by ?? 'Unknown contributor'} · ${value.via} · ${formatTime(value.at)}`
        : 'Contributor not recorded';
}

/** Company socio data is shared with its users; personal data stays separate. */
export function SharedAreas({ areas, reload }: { areas: SharedAreaView[]; reload: () => Promise<unknown> }) {
    const [remove, setRemove] = useState<{ label: string; path: string }>();
    return (
        <div className="grid gap-4" data-slot="shared-areas">
            <p className="text-sm text-muted-foreground">
                Files and tables kept by company socios you use. Other people who use the same socio can see and delete
                these items too.
            </p>
            {!areas.length && <p>No shared data yet.</p>}
            {areas.map((area) => {
                const base = `/data/shared/${encodeURIComponent(area.dotId)}`;
                return (
                    <Card key={area.dotId}>
                        <CardHeader>
                            <CardTitle>
                                {area.dotName ?? 'Deleted socio'}
                                {area.archived ? ' (archived)' : ''}
                            </CardTitle>
                            <CardDescription>
                                {formatBytes(area.totalBytes)} ·{' '}
                                {area.retentionDays
                                    ? `Items unchanged for ${area.retentionDays} days are deleted.`
                                    : 'Kept until someone deletes them.'}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4">
                            {area.dataset && area.dataset.tables.length > 0 && (
                                <section aria-label="Shared tables" className="grid gap-2">
                                    <h3 className="font-medium">Tables</h3>
                                    {area.dataset.tables.map((table) => (
                                        <div
                                            key={table.name}
                                            className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                                        >
                                            <div>
                                                <Link className="underline" to={`/data/datasets/${area.dataset!.id}`}>
                                                    {table.name}
                                                </Link>
                                                <p className="text-sm text-muted-foreground">
                                                    {table.rowCount} rows · {formatBytes(table.sizeBytes)}
                                                </p>
                                                <p className="text-xs text-muted-foreground">
                                                    Added: {origin(table.created)}
                                                </p>
                                                {table.changed && (
                                                    <p className="text-xs text-muted-foreground">
                                                        Last changed: {origin(table.changed)}
                                                    </p>
                                                )}
                                            </div>
                                            <Button
                                                variant="outline"
                                                onClick={() =>
                                                    setRemove({
                                                        label: table.name,
                                                        path: `${base}/tables/${encodeURIComponent(table.name)}`,
                                                    })
                                                }
                                            >
                                                Delete table
                                            </Button>
                                        </div>
                                    ))}
                                </section>
                            )}
                            {area.files.length > 0 && (
                                <section aria-label="Shared files" className="grid gap-2">
                                    <h3 className="font-medium">Files</h3>
                                    {area.files.map((file) => (
                                        <div
                                            key={file.path}
                                            className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
                                        >
                                            <div>
                                                <a
                                                    className="underline"
                                                    href={`/api${base}/files/raw?path=${encodeURIComponent(file.path)}`}
                                                    download
                                                >
                                                    {file.path}
                                                </a>
                                                <p className="text-sm text-muted-foreground">
                                                    {formatBytes(file.size)} · {origin(file.added)}
                                                </p>
                                            </div>
                                            <Button
                                                variant="outline"
                                                onClick={() =>
                                                    setRemove({
                                                        label: file.path,
                                                        path: `${base}/files?path=${encodeURIComponent(file.path)}`,
                                                    })
                                                }
                                            >
                                                Delete file
                                            </Button>
                                        </div>
                                    ))}
                                </section>
                            )}
                        </CardContent>
                    </Card>
                );
            })}
            {remove && (
                <ConfirmDelete
                    title={`Delete ${remove.label}?`}
                    onClose={() => setRemove(undefined)}
                    onConfirm={async () => {
                        try {
                            await api(remove.path, 'DELETE');
                            setRemove(undefined);
                            await reload();
                        } catch (error) {
                            toast.error(error instanceof Error ? error.message : 'Could not delete this item.');
                        }
                    }}
                >
                    This removes it from the shared area for everyone who uses this socio. A deleted copy is kept for
                    recovery.
                </ConfirmDelete>
            )}
        </div>
    );
}
