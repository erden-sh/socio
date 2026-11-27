import { Trans, useTranslation } from '@socio/i18n/react';
import { type DeploymentResourcesView, type DeploymentServiceRow } from '@socio/shared/deployment-resources';
import { dateTimeFormat, formatNumber, numberFormat } from '@socio/shared/locale';

import { onDemand } from '../../i18n/on-demand';
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
    const { t } = useTranslation(['operations.resources']);
    if (data.state === 'ok') {
        return null;
    }
    return (
        <p data-slot="ops-deployment-state" data-state={data.state} role="status" className="m-0 text-muted-foreground">
            {t(`operations.resources:deployment.state.${data.state}`)}
            {data.failedAt !== null && (
                <>
                    {' '}
                    <Trans
                        t={t}
                        i18nKey="operations.resources:deployment.last-tried"
                        components={{ time: <LocalTime value={data.failedAt} format={timestamp} /> }}
                    />
                </>
            )}
            {data.totals.latest && data.state !== 'off' && ` ${t('operations.resources:deployment.shown-below')}`}
        </p>
    );
}

function Totals({ data }: { data: DeploymentResourcesView }) {
    const { t } = useTranslation(['operations.resources']);
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
                <dt className="text-sm text-muted-foreground">
                    {t('operations.resources:deployment.total.memoryBytes')}
                </dt>
                <dd className="m-0 tabular-nums">
                    {t('operations.resources:deployment.of-limits', {
                        used: bytes(values.memoryBytes),
                        limit: bytes(values.memoryLimitBytes),
                    })}
                    <Meter percent={memoryShare} label={t('operations.resources:deployment.limits-meter')} />
                    <small className="block text-muted-foreground">
                        {memoryShare === null
                            ? t('operations.resources:deployment.no-limits')
                            : t('operations.resources:deployment.limits-share', {
                                  share: oneDecimal.format(memoryShare),
                              })}
                    </small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                    {t('operations.resources:deployment.total.cpuPercent')}
                </dt>
                <dd className="m-0 tabular-nums">
                    {t('operations.resources:deployment.of-one-cpu', { cpu: cpu(values.cpuPercent) })}
                    <Meter percent={nodeCpuShare} label={t('operations.resources:deployment.cpu-meter')} />
                    <small className="block text-muted-foreground">
                        {values.nodeCpus == null
                            ? t('operations.resources:deployment.node-cpus-unknown')
                            : t('operations.resources:deployment.node-cpus', {
                                  share: oneDecimal.format(nodeCpuShare ?? 0),
                                  count: values.nodeCpus,
                              })}
                    </small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{t('operations.resources:deployment.against-node')}</dt>
                <dd className="m-0 tabular-nums">
                    {t('operations.resources:deployment.of-node', {
                        used: bytes(values.memoryBytes),
                        total: bytes(values.nodeMemoryBytes),
                    })}
                    <Meter percent={nodeMemoryShare} label={t('operations.resources:deployment.node-meter')} />
                    <small className="block text-muted-foreground">
                        {t('operations.resources:deployment.node-shared')}
                    </small>
                </dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">{t('operations.resources:deployment.total.services')}</dt>
                <dd className="m-0 tabular-nums">{formatNumber(values.services ?? 0)}</dd>
            </div>
            <div className="min-w-0">
                <dt className="text-sm text-muted-foreground">
                    {t('operations.resources:deployment.total.unlimitedServices')}
                </dt>
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
                <dt className="text-sm text-muted-foreground">{t('operations.resources:deployment.total.restarts')}</dt>
                <dd className="m-0 tabular-nums">{values.restarts == null ? '—' : formatNumber(values.restarts)}</dd>
            </div>
        </dl>
    );
}

function ServiceRow({ row }: { row: DeploymentServiceRow }) {
    const { t } = useTranslation(['operations.resources']);
    const values = row.history.latest?.values;
    const limit = values?.memoryLimitBytes ?? null;
    const used = values?.memoryBytes ?? null;
    const percent = share(used, limit);
    return (
        <tr data-slot="ops-deployment-service" data-no-limit={row.noLimit || undefined}>
            <td className="px-2 py-2 align-top">
                <strong className="break-all">
                    {row.kind === 'computer' ? t('operations.resources:deployment.computers') : row.service}
                </strong>
                <div className="text-muted-foreground">
                    {t(`operations.resources:deployment.kind.${row.kind}`)}
                    {row.stack ? ` · ${row.stack}` : ''}
                    {values?.containers != null && values.containers > 1
                        ? ` · ${t('operations.resources:deployment.containers', { count: values.containers })}`
                        : ''}
                </div>
                {row.noLimit && (
                    <Badge variant="outline" className="mt-1 border-amber-500 text-amber-700 dark:text-amber-400">
                        {t('operations.resources:deployment.no-limit-badge')}
                    </Badge>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">{cpu(values?.cpuPercent)}</td>
            <td className="px-2 py-2 align-top tabular-nums">
                {bytes(used)} / {limit === null ? t('operations.resources:deployment.no-limit') : bytes(limit)}
                <Meter
                    percent={percent}
                    label={t('operations.resources:deployment.service-meter', { service: row.service })}
                />
                {percent !== null && (
                    <small className="block text-muted-foreground">
                        {t('operations.resources:of-limit', { share: oneDecimal.format(percent) })}
                    </small>
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
 * flag when it has none. Separate from the host-wide numbers. Below the
 * Health page's numbers, so its words load on demand (operations.resources).
 */
export const DeploymentResourcesPanel = onDemand(['operations.resources'], DeploymentResources);

function DeploymentResources() {
    const { t } = useTranslation(['operations.resources']);
    const { data, error } = useOpsAnswer<DeploymentResourcesView>('/operations/resources/deployment');
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-deployment-resources">
                <div>
                    <h3 className="font-medium">{t('operations.resources:deployment.title')}</h3>
                    <p className="text-muted-foreground">{t('operations.resources:deployment.description')}</p>
                    {data?.totals.latest && (
                        <p className="m-0 text-muted-foreground">
                            <Trans
                                t={t}
                                i18nKey="operations.resources:deployment.last-sample"
                                components={{ time: <LocalTime value={data.totals.latest.at} format={timestamp} /> }}
                            />
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
                                            {[
                                                t('operations.resources:deployment.service'),
                                                t('operations.resources:hourly.cpu'),
                                                t('operations.resources:memory-limit'),
                                                t('operations.resources:deployment.restarts'),
                                                t('operations.resources:deployment.node'),
                                            ].map((label) => (
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
                                <summary>{t('operations.resources:hourly.title')}</summary>
                                <div className="max-h-64 overflow-auto">
                                    <table className="text-sm">
                                        <caption className="text-left">
                                            {t('operations.resources:hourly.caption')}
                                        </caption>
                                        <thead>
                                            <tr>
                                                <th className="px-2">{t('operations.resources:hourly.hour')}</th>
                                                <th className="px-2">{t('operations.resources:hourly.cpu')}</th>
                                                <th className="px-2">{t('operations.resources:hourly.memory')}</th>
                                                <th className="px-2">
                                                    {t('operations.resources:deployment.sum-of-limits')}
                                                </th>
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
