import { useEffect, useState } from 'react';

import type { ContinuousCopyStatus } from '@socio/shared/types';

import { api } from '../../lib/api';
import { useContinuousLine } from '../settings/setup-lines';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const sentence = (line: string) => `${line[0].toUpperCase()}${line.slice(1)}.`;

/**
 * The continuous copy of the database (CB-109): Litestream's replica on
 * the backup volume, how new its newest copy is, and the last write. Not
 * shown when LITESTREAM_REPLICA_DIR isn't set.
 */
export function ContinuousCopyCard() {
    const continuousLine = useContinuousLine();
    const [copy, setCopy] = useState<ContinuousCopyStatus | null>();
    const [error, setError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        api<{ continuous: ContinuousCopyStatus | null }>('/operator/replication', 'GET', undefined, controller.signal)
            .then((next) => !controller.signal.aborted && setCopy(next.continuous))
            .catch((e: unknown) => {
                if (!controller.signal.aborted) {
                    setError(e instanceof Error ? e.message : 'Could not load.');
                }
            });
        return () => controller.abort();
    }, []);
    if (copy === null) {
        return null;
    }
    return (
        <Card className="mt-6" data-slot="continuous-copy">
            <CardHeader>
                <CardTitle>Continuous copy</CardTitle>
                <CardDescription>
                    Litestream copies each write to the database onto the backup volume within seconds and keeps 14
                    days, to restore to any point in them (docs/SETUP.md, “Continuous copy”). The daily backups are
                    apart from it.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
                {error && <p className="text-destructive">{error}</p>}
                {copy && (
                    <>
                        <p className={copy.behind ? 'text-destructive' : undefined}>{sentence(continuousLine(copy))}</p>
                        {copy.lastWriteAt !== undefined && (
                            <p className="text-muted-foreground">
                                Last write to the database: {new Date(copy.lastWriteAt).toLocaleString()}.
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
