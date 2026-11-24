import {
    DEPLOYMENT_TOTAL_METRICS,
    type DeploymentMemberKind,
    type DeploymentResourcesView,
    type DeploymentServiceRow,
} from '@socio/shared/deployment-resources';
import { dateTimeFormat, formatNumber, numberFormat } from '@socio/shared/locale';

import { LocalTime } from '../../lib/local-time';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsAnswer } from './use-ops';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const dateTime = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const timestamp = (at: number) => dateTime.format(at);

const bytes = (value: number | null | undefined) =>
    value == null
        ? '—'
        : value >= 1024 ** 3
          ? `${oneDecimal.format(value / 1024 ** 3)} GiB`
          : `${oneDecimal.format(value / 1048576)} MiB`;
const cpu = (value: number | null | undefined) => (value == null ? '—' : `${oneDecimal.format(value)}%`);
const share = (used: number | null | undefined, of: number | null | undefined) =>
    used == null || !of ? null : (100 * used) / of;

const KIND_LABELS: Record<DeploymentMemberKind, string> = {
    stack: 'Stack service',
    plugin: 'Plugin service',
    computer: 'Socio computers',
};
/** Used against a limit: a bar that turns amber, then red, as it fills. */
function Meter({ percent, label }: { percent: number | null; label: string }) {
    if (percent === null) {
        return null;
    }
    const width = Math.min(100, Math.max(0, percent));
    return (
        <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(width)}
            className="mt-1 h-1.5 w-full max-w-48 overflow-hidden rounded-full bg-muted"
        >
            <div
                className={cn(
                    'h-full rounded-full',
                    percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-amber-500' : 'bg-sky-500',
                )}
                style={{ width: `${width}%` }}
            />
        </div>
    );
}

function StateNote({ data }: { data: DeploymentResourcesView }) {
    if (data.state === 'ok') {
        return null;
    }
    const text =
        data.state === 'off'
            ? 'Deployment metrics are unavailable: they need the read-only disk usage proxy (COMPUTER_DISK_USAGE_URL).'
            : data.state === 'pending'
              ? 'Deployment metrics are not measured yet. They are read with each resource sample.'
              : 'Deployment metrics are unavailable: the last read through the disk usage proxy failed or is out of date.';
    return (
        <p data-slot="ops-deployment-state" data-state={data.state} role="status" className="m-0 text-muted-foreground">
            {text}
            {data.failedAt !== null && (
                <>
                    {' '}
                    Last tried <LocalTime value={data.failedAt} format={timestamp} />.
                </>
            )}
            {data.totals.latest && data.state !== 'off' && ' The last numbers collected are shown below.'}
        </p>
    );
}

function Totals({ data }: { data: DeploymentResourcesView }) {
    const values = data.totals.latest?.values;
    if (!values) {
        return null;
    }
    const memoryShare = share(values.limitedMemoryBytes, values.memoryLimitBytes);
    const nodeCpuShare = share(values.cpuPercent, values.nodeCpus == null ? null : values.nodeCpus * 100);
    const nodeMemoryShare = share(values.memoryBytes, values.nodeMemoryBytes);
    return (
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-slot="ops-deployment-totals">
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{DEPLOYMENT_TOTAL_METRICS.memoryBytes}</dt>
                <dd className="m-0 tabular-nums">
                    {bytes(values.memoryBytes)} of {bytes(values.memoryLimitBytes)} limits
                    <Meter percent={memoryShare} label="Memory in use by limited services, of their limits" />
                    <small className="block text-muted-foreground">
                        {memoryShare === null
                            ? 'No service has a memory limit.'
                            : `${oneDecimal.format(memoryShare)}% of the sum of limits, by the services that have one.`}
                    </small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{DEPLOYMENT_TOTAL_METRICS.cpuPercent}</dt>
                <dd className="m-0 tabular-nums">
                    {cpu(values.cpuPercent)} of one CPU
                    <Meter percent={nodeCpuShare} label="Deployment CPU, of the node's CPUs" />
                    <small className="block text-muted-foreground">
                        {values.nodeCpus == null
                            ? 'The node’s CPUs are unknown.'
                            : `${oneDecimal.format(nodeCpuShare ?? 0)}% of the node’s ${formatNumber(values.nodeCpus)} CPUs. CPU limits aren’t readable here.`}
                    </small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">Against the node</dt>
                <dd className="m-0 tabular-nums">
                    {bytes(values.memoryBytes)} of {bytes(values.nodeMemoryBytes)}
                    <Meter percent={nodeMemoryShare} label="Deployment memory, of the node's memory" />
                    <small className="block text-muted-foreground">The node’s memory, shared with other tenants.</small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{DEPLOYMENT_TOTAL_METRICS.services}</dt>
                <dd className="m-0 tabular-nums">{formatNumber(values.services ?? 0)}</dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{DEPLOYMENT_TOTAL_METRICS.unlimitedServices}</dt>
                <dd
                    className={cn(
                        'm-0 tabular-nums',
                        (values.unlimitedServices ?? 0) > 0 && 'text-amber-700 dark:text-amber-400',
                    )}
                >
                    {formatNumber(values.unlimitedServices ?? 0)}
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{DEPLOYMENT_TOTAL_METRICS.restarts}</dt>
                <dd className="m-0 tabular-nums">{values.restarts == null ? '—' : formatNumber(values.restarts)}</dd>
            </div>
        </dl>
    );
}

function ServiceRow({ row }: { row: DeploymentServiceRow }) {
    const values = row.history.latest?.values;
    const limit = values?.memoryLimitBytes ?? null;
    const used = values?.memoryBytes ?? null;
    const percent = share(used, limit);
    return (
        <tr data-slot="ops-deployment-service" data-no-limit={row.noLimit || undefined}>
            <td className="px-2 py-2 align-top">
                <strong className="break-all">{row.kind === 'computer' ? 'Socios’ computers' : row.service}</strong>
                <div className="text-muted-foreground">
                    {KIND_LABELS[row.kind]}
                    {row.stack ? ` · ${row.stack}` : ''}
                    {values?.containers != null && values.containers > 1
                        ? ` · ${formatNumber(values.containers)} containers`
                        : ''}
                </div>
                {row.noLimit && (
                    <Badge variant="outline" className="mt-1 border-amber-500 text-amber-700 dark:text-amber-400">
                        No limit: can starve its neighbors
                    </Badge>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">{cpu(values?.cpuPercent)}</td>
            <td className="px-2 py-2 align-top tabular-nums">
                {bytes(used)} / {limit === null ? 'no limit' : bytes(limit)}
                <Meter percent={percent} label={`${row.service} memory, of its limit`} />
                {percent !== null && (
                    <small className="block text-muted-foreground">{oneDecimal.format(percent)}% of limit</small>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">
                {values?.restarts == null ? '—' : formatNumber(values.restarts)}
            </td>
            <td className="px-2 py-2 align-top">{row.node ?? '—'}</td>
        </tr>
    );
}

/**
 * The deployment's services (CB-321): totals against the sum of limits and
 * the node, then each service's use against its limit, its restarts and a
 * flag when it has none. Separate from the host-wide numbers.
 */
export function DeploymentResourcesPanel() {
    const { data, error } = useOpsAnswer<DeploymentResourcesView>('/operations/resources/deployment');
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-deployment-resources">
                <div>
                    <h3 className="font-medium">Deployment services</h3>
                    <p className="text-muted-foreground">
                        Every running container of this deployment: its stacks, plugin services and socios’ computers,
                        read through the read-only disk usage proxy with each resource sample. These are this
                        deployment’s own numbers, apart from the host-wide ones below, which include other tenants on a
                        shared host. CPU is a percent of one CPU. Restarts count the replaced tasks the orchestrator
                        still keeps (updates included).
                    </p>
                    {data?.totals.latest && (
                        <p className="m-0 text-muted-foreground">
                            Last sample: <LocalTime value={data.totals.latest.at} format={timestamp} />
                        </p>
                    )}
                </div>
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                    </p>
                )}
                {data && (
                    <>
                        <StateNote data={data} />
                        <Totals data={data} />
                        {data.services.length > 0 && (
                            <div className="min-w-0 overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead>
                                        <tr>
                                            {['Service', 'CPU', 'Memory / limit', 'Restarts', 'Node'].map((label) => (
                                                <th key={label} className="px-2 py-1">
                                                    {label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.services.map((row) => (
                                            <ServiceRow key={`${row.kind}:${row.node}:${row.service}`} row={row} />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        {data.totals.hourly.length > 0 && (
                            <details>
                                <summary>Hourly history</summary>
                                <div className="max-h-64 overflow-auto">
                                    <table className="text-sm">
                                        <caption className="text-left">Most recent 24 hourly averages</caption>
                                        <thead>
                                            <tr>
                                                <th className="px-2">Hour</th>
                                                <th className="px-2">CPU</th>
                                                <th className="px-2">Memory</th>
                                                <th className="px-2">Sum of limits</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {data.totals.hourly
                                                .slice(-24)
                                                .toReversed()
                                                .map((hour) => (
                                                    <tr key={hour.at}>
                                                        <td className="whitespace-nowrap px-2">
                                                            <LocalTime value={hour.at} format={timestamp} />
                                                        </td>
                                                        <td className="px-2">{cpu(hour.values.cpuPercent)}</td>
                                                        <td className="px-2">{bytes(hour.values.memoryBytes)}</td>
                                                        <td className="px-2">{bytes(hour.values.memoryLimitBytes)}</td>
                                                    </tr>
                                                ))}
                                        </tbody>
                                    </table>
                                </div>
                            </details>
                        )}
                    </>
                )}
            </div>
        </SettingsCard>
    );
}
