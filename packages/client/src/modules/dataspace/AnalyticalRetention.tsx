import { useState } from 'react';
import { toast } from 'sonner';

import {
    ANALYTICAL_RETAIN_DAYS_MAX,
    type AnalyticalRetention,
    type AnalyticalRetentionPreview,
} from '@socio/shared/dataspace/analytics';

import { api } from '../../lib/api';

import { fieldClass, formatBytes } from './format';

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

const SOURCE = {
    override: 'an admin’s override',
    manifest: 'the plugin',
    default: 'the workspace default',
} as const;

const keeps = (days: number | null) => (days ? `${days} days` : 'every partition');

/** Where an analytical table's retention comes from, in a sentence (CB-387). */
export function retentionLine(retention: AnalyticalRetention) {
    return `Retention: ${keeps(retention.days)}, from ${SOURCE[retention.source]}.`;
}

/** What a change would make the retention: days, null to keep everything. */
type Change = { days: number | null } | { clear: true };

/**
 * An admin's retention override on an analytical table (CB-387): days, or
 * keep everything, which wins over the plugin's manifest until cleared.
 * Before a value that drops more is saved, the server's preview says what
 * the next nightly run would drop, and the admin confirms it.
 */
export function AnalyticalRetentionControl({
    base,
    table,
    retention,
    saved,
}: {
    /** `/data/datasets/<id>`. */
    base: string;
    table: string;
    retention: AnalyticalRetention;
    saved: () => unknown;
}) {
    const [value, setValue] = useState(String(retention.days ?? ''));
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<{ change: Change; preview: AnalyticalRetentionPreview }>();
    const path = `${base}/tables/${encodeURIComponent(table)}/retention`;
    const save = async (change: Change) => {
        setBusy(true);
        try {
            await ('clear' in change ? api(path, 'DELETE') : api(path, 'PUT', { days: change.days }));
            setConfirm(undefined);
            toast.success('Retention saved.');
            await saved();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not save the retention.');
        } finally {
            setBusy(false);
        }
    };
    /** Saves at once unless the change would drop partitions now: then it asks first. */
    const ask = async (change: Change) => {
        const next = 'clear' in change ? (retention.declared ?? retention.workspaceDefault) : change.days;
        const lower = next !== null && (retention.days === null || next < retention.days);
        if (!lower) {
            return save(change);
        }
        setBusy(true);
        try {
            const preview = await api<AnalyticalRetentionPreview>(`${path}/preview?days=${next}`);
            if (!preview.partitions) {
                return await save(change);
            }
            setConfirm({ change, preview });
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not preview the retention.');
        } finally {
            setBusy(false);
        }
    };
    const days = Number(value);
    const valid = /^\d+$/.test(value.trim()) && days >= 1 && days <= ANALYTICAL_RETAIN_DAYS_MAX;
    return (
        <div className="grid gap-2" data-slot="table-retention-control">
            <div className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1">
                    Keep partitions for (days)
                    <input
                        type="number"
                        min={1}
                        max={ANALYTICAL_RETAIN_DAYS_MAX}
                        inputMode="numeric"
                        aria-label={`Days ${table} keeps its partitions`}
                        className={`${fieldClass} w-32`}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                    />
                </label>
                <Button variant="outline" size="sm" disabled={busy || !valid} onClick={() => void ask({ days })}>
                    Save override
                </Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void ask({ days: null })}>
                    Keep everything
                </Button>
                {retention.source === 'override' && (
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void ask({ clear: true })}>
                        Clear override ({keeps(retention.declared ?? retention.workspaceDefault)})
                    </Button>
                )}
            </div>
            <p>
                An override wins over the plugin’s updates until you clear it. The plugin declares{' '}
                {retention.declared ? `${retention.declared} days` : 'none'}; the workspace default is{' '}
                {keeps(retention.workspaceDefault)}.
            </p>
            {confirm && (
                <AlertDialog open onOpenChange={(open) => !open && setConfirm(undefined)}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>
                                Keep {table}’s partitions {keeps(confirm.preview.days)}?
                            </AlertDialogTitle>
                            <AlertDialogDescription data-slot="table-retention-preview">
                                The next nightly run drops {confirm.preview.partitions} partition(s),{' '}
                                {confirm.preview.firstPartition} to {confirm.preview.lastPartition}:{' '}
                                {confirm.preview.rows} row(s), {formatBytes(confirm.preview.bytes)}. Queries stop
                                reading them then; backups keep them for a while.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <Button variant="destructive" disabled={busy} onClick={() => void save(confirm.change)}>
                                Drop them and save
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            )}
        </div>
    );
}
