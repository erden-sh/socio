import type { ReactNode } from 'react';

import type { OpsStatus } from '@socio/shared/operations/operations';

import { useOpsFormat } from './format';
import { useOpsSettings } from './use-ops';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The store's status above a section's numbers, and what failed to load. */
export function OpsStatusNote({ status, error }: { status: OpsStatus | undefined; error: string }) {
    const { timeZone } = useOpsSettings();
    const { statusLine } = useOpsFormat();
    return (
        <>
            {status && (
                <p
                    data-slot="ops-status"
                    data-state={status.state}
                    className={cn(
                        'm-0 text-xs text-muted-foreground',
                        status.state !== 'ready' && 'rounded-lg border bg-card px-4 py-3 text-sm',
                    )}
                >
                    {statusLine(status, timeZone)}
                </p>
            )}
            {error && (
                <p role="alert" className="m-0 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                </p>
            )}
        </>
    );
}

/** A stat tile, as the Overview's: a label, a value ("–" for none), a note. */
export function OpsStat({
    id,
    label,
    value,
    note,
    tone,
}: {
    id: string;
    label: string;
    value: ReactNode;
    note?: ReactNode;
    tone?: 'bad';
}) {
    return (
        <Card data-slot="ops-tile" data-tile={id} className="min-w-0 gap-1 px-4 py-3 shadow-xs">
            <span className="text-xs text-muted-foreground">{label}</span>
            <strong
                className={cn('truncate text-2xl font-semibold tabular-nums', tone === 'bad' && 'text-destructive')}
            >
                {value}
            </strong>
            <span className="min-h-4 text-xs text-muted-foreground">{note}</span>
        </Card>
    );
}

/** A row of tiles, or their skeletons while the answer loads. */
export function OpsStats({
    label,
    loading,
    count,
    children,
}: {
    label: string;
    loading: boolean;
    count: number;
    children: ReactNode;
}) {
    return (
        <section aria-label={label} aria-busy={loading} className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            {children ??
                Array.from({ length: count }, (_, index) => <Skeleton key={index} className="h-21 rounded-xl" />)}
        </section>
    );
}
