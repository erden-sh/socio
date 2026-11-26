import { useCallback, useEffect, useState } from 'react';

import type { CloudConnection, CloudStatus } from '@socio/shared/cloud';

import { api } from '../../lib/api';
import { LocalTime } from '../../lib/local-time';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const dateTime = (value: number) => new Date(value).toLocaleString();

const LABEL: Record<CloudConnection, string> = {
    off: 'Off',
    'not-connected': 'Not connected',
    connected: 'Connected',
    paused: 'Paused',
    revoked: 'Revoked',
    lost: 'Identity lost',
};

/** What each state means for the admin, and what they can do about it. */
const EXPLAIN: Record<CloudConnection, string> = {
    off: 'SOCIO_CLOUD=off is set, so this server never calls the cloud services.',
    'not-connected':
        'This server has no cloud identity yet. Hosted deployments connect when provisioning sets an enrollment token (docs/SETUP.md, "Cloud connection").',
    connected: 'This server holds a key the cloud services know, and gets short-lived tokens with it.',
    paused: 'The cloud services are holding tokens back until Ingenio confirms a change of this server’s address. Nothing is needed from you; it resumes by itself.',
    revoked:
        'The cloud services refused this server’s key, so nothing more is sent. Ask Ingenio about it; connecting again needs a new enrollment.',
    lost: 'An identity is stored but this server’s data key can’t open it, most likely because the data key changed. Restore the previous data key, or enroll again with SOCIO_CLOUD_REPLACE_LOST=true and a new token.',
};

const VARIANT: Record<CloudConnection, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    off: 'outline',
    'not-connected': 'outline',
    connected: 'default',
    paused: 'secondary',
    revoked: 'destructive',
    lost: 'destructive',
};

/**
 * The Platform page's "Cloud connection" card (admins): how this server
 * stands with Ingenio's cloud services, from `GET /api/cloud`: its
 * deployment id and mode, what it may use, when it enrolled and last
 * synced, and what to do when it is revoked or its identity is lost.
 */
export function CloudConnectionCard() {
    const [status, setStatus] = useState<CloudStatus>();
    const [loadError, setLoadError] = useState('');
    const load = useCallback(
        () =>
            api<CloudStatus>('/cloud')
                .then((next) => {
                    setStatus(next);
                    setLoadError('');
                })
                .catch((e: unknown) =>
                    setLoadError(e instanceof Error ? e.message : 'Could not load the cloud connection.'),
                ),
        [],
    );
    useEffect(() => void load(), [load]);
    return (
        <Card className="mt-6" data-slot="cloud-connection">
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    Cloud connection
                    {status && <Badge variant={VARIANT[status.connection]}>{LABEL[status.connection]}</Badge>}
                </CardTitle>
                <CardDescription>
                    This server’s identity at Ingenio’s cloud services. Nothing uses it yet beyond its own daily sync.
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
                {!status && !loadError && <Skeleton className="h-16" />}
                {loadError && <p className="text-destructive">{loadError}</p>}
                {status && (
                    <>
                        <p className="text-muted-foreground" data-slot="cloud-explain">
                            {EXPLAIN[status.connection]}
                        </p>
                        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                            <dt className="text-muted-foreground">Issuer</dt>
                            <dd className="break-all">{status.issuer}</dd>
                            {status.deploymentId && (
                                <>
                                    <dt className="text-muted-foreground">Deployment</dt>
                                    <dd className="font-mono break-all">{status.deploymentId}</dd>
                                </>
                            )}
                            {status.deploymentMode && (
                                <>
                                    <dt className="text-muted-foreground">Deployment mode</dt>
                                    <dd>{status.deploymentMode === 'hosted' ? 'Hosted' : 'Self-hosted'}</dd>
                                </>
                            )}
                            {status.deploymentId && (
                                <>
                                    <dt className="text-muted-foreground">Allowed</dt>
                                    <dd>{status.scopes.length ? status.scopes.join(', ') : 'Nothing'}</dd>
                                </>
                            )}
                            {status.enrolledAt && (
                                <>
                                    <dt className="text-muted-foreground">Enrolled</dt>
                                    <dd>
                                        <LocalTime value={status.enrolledAt} format={dateTime} />
                                    </dd>
                                </>
                            )}
                            {status.deploymentId && (
                                <>
                                    <dt className="text-muted-foreground">Last sync</dt>
                                    <dd>
                                        {status.lastSyncAt ? (
                                            <LocalTime value={status.lastSyncAt} format={dateTime} />
                                        ) : (
                                            'Not yet'
                                        )}
                                    </dd>
                                </>
                            )}
                        </dl>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
