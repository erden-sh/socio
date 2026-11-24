import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import type {
    DomainCertificate,
    DomainOp,
    DomainOpStarted,
    DomainsStatus,
    ManagedHostname,
} from '@socio/shared/domains';

import { api } from '../../lib/api';
import { useLiveTopic } from '../../lib/change-channel';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const KIND: Record<DomainOp['kind'], string> = {
    ensure_base: 'Set up base',
    provision: 'Provision',
    remove: 'Remove',
};

const when = (ms: number) => new Date(ms).toLocaleString();

function expiry(cert?: DomainCertificate) {
    if (!cert) {
        return 'no certificate';
    }
    if (!cert.expiresOn) {
        return 'certificate pending';
    }
    const date = new Date(cert.expiresOn);
    const days = Math.round((date.getTime() - Date.now()) / 86_400_000);
    return days < 0
        ? `certificate expired ${date.toLocaleDateString()}`
        : `certificate until ${date.toLocaleDateString()} (${days} days)`;
}

function HostRow({ host, onRemove, busy }: { host: ManagedHostname; onRemove?: () => void; busy?: boolean }) {
    return (
        <div
            data-slot="domain-row"
            data-hostname={host.hostname}
            className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
        >
            <span className="font-medium">{host.hostname}</span>
            <Badge variant={host.proxyHostOk ? 'secondary' : 'destructive'}>
                {host.proxyHostOk ? 'Proxy host ok' : host.proxyHostId ? 'Proxy host drifted' : 'No proxy host'}
            </Badge>
            <span className="text-muted-foreground">
                {host.dnsContent ? `A ${host.dnsContent}` : 'no A record'} · {expiry(host.certificate)}
            </span>
            {onRemove && (
                <Button
                    className="ml-auto"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${host.hostname}`}
                    onClick={onRemove}
                >
                    Remove
                </Button>
            )}
        </div>
    );
}

/**
 * The Platform page's "Domains" card (operators): the base setup
 * (`DOMAINS_BASE` and its wildcard), "Set up domains" or "Repair",
 * hostnames provisioned on their own with their certificates' expiry, a
 * form to provision one under the zone, and the recent operations. An
 * operation runs in the background; the card polls until it ends.
 */
export function DomainsCard() {
    const [status, setStatus] = useState<DomainsStatus>();
    const [failedLoad, setFailedLoad] = useState('');
    const [hostname, setHostname] = useState('');
    const load = useCallback(
        () =>
            api<DomainsStatus>('/domains')
                .then((next) => {
                    setStatus(next);
                    setFailedLoad('');
                })
                .catch((e) => setFailedLoad(e instanceof Error ? e.message : 'Could not load domains.')),
        [],
    );
    useEffect(() => void load(), [load]);
    useLiveTopic('domains', load);
    const running = !!status?.running;
    useEffect(() => {
        if (!running) {
            return;
        }
        const timer = setInterval(() => void load(), 2000);
        return () => clearInterval(timer);
    }, [running, load]);
    const start = async (call: () => Promise<DomainOpStarted>) => {
        try {
            const { op } = await call();
            toast.success(`${KIND[op.kind]} ${op.hostname}: started.`);
            return true;
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Could not start.');
            return false;
        } finally {
            await load();
        }
    };
    const provision = async (event: FormEvent) => {
        event.preventDefault();
        if (
            await start(() =>
                api<DomainOpStarted>('/domains/hosts', 'POST', {
                    hostname: hostname.trim(),
                }),
            )
        ) {
            setHostname('');
        }
    };
    const lastBaseOp = status?.ops.find((op) => op.kind === 'ensure_base');
    return (
        <Card className="mt-6" data-slot="domains">
            <CardHeader>
                <CardTitle>Domains</CardTitle>
                <CardDescription>
                    {status?.settings
                        ? `${status.settings.base} and *.${status.settings.base} through Nginx Proxy Manager, A records in ${status.settings.zone} to ${status.settings.targetIp} (DNS only), forwarding to ${status.settings.upstream}.`
                        : 'Host names through Nginx Proxy Manager and Cloudflare DNS.'}
                </CardDescription>
                {status?.enabled && (
                    <CardAction>
                        <Button
                            disabled={running}
                            onClick={() => void start(() => api<DomainOpStarted>('/domains/base', 'POST', {}))}
                        >
                            {lastBaseOp ? 'Repair' : 'Set up domains'}
                        </Button>
                    </CardAction>
                )}
            </CardHeader>
            <CardContent className="grid gap-4 text-sm">
                {!status && !failedLoad && <Skeleton className="h-16" />}
                {failedLoad && <p className="text-destructive">{failedLoad}</p>}
                {status && !status.enabled && (
                    <p className="text-muted-foreground" data-slot="domains-off">
                        Off: set {status.missing.join(', ')} (docs/SETUP.md, “Domains”).
                    </p>
                )}
                {status?.enabled && (
                    <>
                        {status.error && <p className="text-destructive">{status.error}</p>}
                        {!status.settings?.acmeEmail && (
                            <p className="text-muted-foreground">
                                DOMAINS_ACME_EMAIL is not set: new certificates are refused.
                            </p>
                        )}
                        {status.running && (
                            <p data-slot="domains-running">
                                {KIND[status.running.kind]} {status.running.hostname}: running
                                {status.running.steps.length ? ` (${status.running.steps.length} steps done)` : ''}…
                            </p>
                        )}
                        <div className="grid gap-2" data-slot="domains-base">
                            <div className="flex items-center gap-2">
                                <span className="font-medium">Base</span>
                                <Badge variant={status.base?.ok ? 'secondary' : 'outline'}>
                                    {status.base?.ok
                                        ? 'Ready'
                                        : status.base?.hostnames.length
                                          ? 'Needs repair'
                                          : 'Not set up'}
                                </Badge>
                                {status.base?.certificate && (
                                    <span className="text-muted-foreground">{expiry(status.base.certificate)}</span>
                                )}
                            </div>
                            {status.base?.hostnames.map((host) => (
                                <HostRow key={host.hostname} host={host} />
                            ))}
                        </div>
                        <div className="grid gap-2" data-slot="domains-hosts">
                            <span className="font-medium">Provisioned host names</span>
                            {!status.hosts.length && (
                                <p className="text-muted-foreground">
                                    None. Names one label under the base are covered by the wildcard already.
                                </p>
                            )}
                            {status.hosts.map((host) => (
                                <HostRow
                                    key={host.hostname}
                                    host={host}
                                    busy={running}
                                    onRemove={() =>
                                        void start(() =>
                                            api<DomainOpStarted>(
                                                `/domains/hosts/${encodeURIComponent(host.hostname)}`,
                                                'DELETE',
                                            ),
                                        )
                                    }
                                />
                            ))}
                            <form className="flex gap-2" onSubmit={provision}>
                                <Input
                                    aria-label="Host name to provision"
                                    placeholder={`name.${status.settings?.zone ?? 'example.com'}`}
                                    value={hostname}
                                    onChange={(event) => setHostname(event.target.value)}
                                />
                                <Button type="submit" variant="outline" disabled={running || !hostname.trim()}>
                                    Provision
                                </Button>
                            </form>
                        </div>
                    </>
                )}
                {!!status?.ops.length && (
                    <div className="grid gap-1" data-slot="domains-ops">
                        <span className="font-medium">Recent operations</span>
                        {status.ops.slice(0, 10).map((op) => (
                            <div key={op.id} data-slot="domain-op" className="text-muted-foreground">
                                <Badge
                                    variant={
                                        op.status === 'failed'
                                            ? 'destructive'
                                            : op.status === 'ok'
                                              ? 'secondary'
                                              : 'outline'
                                    }
                                >
                                    {op.status}
                                </Badge>{' '}
                                {KIND[op.kind]} {op.hostname} · {when(op.startedAt)} · {op.actor}
                                {op.steps.length
                                    ? ` · ${
                                          op.steps
                                              .filter((step) => step.action !== 'kept')
                                              .map((step) => `${step.item} ${step.name} ${step.action}`)
                                              .join(', ') || 'nothing to change'
                                      }`
                                    : ''}
                                {op.error && <span className="text-destructive"> · {op.error}</span>}
                            </div>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
