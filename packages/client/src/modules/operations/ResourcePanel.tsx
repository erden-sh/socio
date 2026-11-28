import { useTranslation } from '@socio/i18n/react';
import { dateTimeFormat, numberFormat } from '@socio/shared/locale';
import {
    RESOURCE_METRICS,
    type ResourceHistory,
    type ResourceMetric,
} from '@socio/shared/operations/operations-resources';

import { onDemand } from '../../i18n/on-demand';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsAnswer } from './use-ops';

// In the reader's locale (`@socio/shared/locale`), not the runtime's.
const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const twoDecimals = numberFormat({ maximumFractionDigits: 2 });
const when = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'medium' });

const observed = (key: ResourceMetric, value: number | null) =>
    value === null
        ? '—'
        : key.endsWith('Bytes')
          ? `${oneDecimal.format(value / 1048576)} MiB`
          : `${twoDecimals.format(value)}${key === 'cpuPercent' ? '%' : ''}`;

/**
 * The workspace server's own resources, host-wide: the latest sample, the
 * metrics that stopped being collected, and the last day's hourly
 * averages. Below the Health page's numbers, so its words load on demand
 * (operations.resources).
 */
export const ResourcePanel = onDemand(['operations.resources'], HostResources);

function HostResources() {
    const { t } = useTranslation(['operations.resources']);
    const { data, error } = useOpsAnswer<ResourceHistory>('/operations/resources');
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-resource-history">
                <div>
                    <h3 className="font-medium">{t('operations.resources:host.title')}</h3>
                    <p className="text-muted-foreground">
                        {t('operations.resources:host.description', {
                            seconds: data ? String(data.collectedEverySeconds) : '…',
                        })}
                    </p>
                </div>
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                    </p>
                )}
                {data && (
                    <>
                        <p>
                            {t('operations.resources:host.last-sample', {
                                when: data.latest
                                    ? when.format(data.latest.at)
                                    : t('operations.resources:host.no-samples'),
                            })}
                        </p>
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {(Object.keys(RESOURCE_METRICS) as ResourceMetric[]).map((key) => {
                                const value =
                                    data.latest?.values[key] ??
                                    data.hourly.toReversed().find((hour) => hour.values[key] !== null)?.values[key] ??
                                    null;
                                return (
                                    <div key={key} className="min-w-0">
                                        <dt className="text-sm text-muted-foreground">
                                            {t(`operations.resources:host.metric.${key}`)}
                                        </dt>
                                        <dd className="m-0 tabular-nums">{observed(key, value)}</dd>
                                    </div>
                                );
                            })}
                        </dl>
                        <div data-slot="ops-collection-gaps">
                            <h4 className="font-medium">{t('operations.resources:host.gaps')}</h4>
                            {data.gaps.length ? (
                                <ul className="m-0 grid gap-1 pl-5">
                                    {data.gaps.map((gap) => (
                                        <li key={gap.metric}>
                                            {gap.state === 'missing'
                                                ? t('operations.resources:host.gap-missing', {
                                                      metric: t(`operations.resources:host.metric.${gap.metric}`),
                                                  })
                                                : t('operations.resources:host.gap-stale', {
                                                      metric: t(`operations.resources:host.metric.${gap.metric}`),
                                                      when: when.format(gap.lastAt!),
                                                  })}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="m-0 text-muted-foreground">{t('operations.resources:host.no-gaps')}</p>
                            )}
                        </div>
                        {data.hourly.length > 0 && (
                            <div className="min-w-0 overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <caption className="text-left">{t('operations.resources:hourly.caption')}</caption>
                                    <thead>
                                        <tr>
                                            {[
                                                t('operations.resources:hourly.hour'),
                                                t('operations.resources:host.samples'),
                                                t('operations.resources:host.metric.rssBytes'),
                                                t('operations.resources:hourly.cpu'),
                                                t('operations.resources:host.volume-free'),
                                            ].map((label) => (
                                                <th className="px-2 py-1" key={label}>
                                                    {label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.hourly
                                            .slice(-24)
                                            .toReversed()
                                            .map((hour) => (
                                                <tr key={hour.at}>
                                                    <td className="whitespace-nowrap px-2 py-1">
                                                        {when.format(hour.at)}
                                                    </td>
                                                    <td className="px-2 py-1">{hour.samples}</td>
                                                    <td className="px-2 py-1">
                                                        {observed('rssBytes', hour.values.rssBytes)}
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        {observed('cpuPercent', hour.values.cpuPercent)}
                                                    </td>
                                                    <td className="px-2 py-1">
                                                        {observed('volumeFreeBytes', hour.values.volumeFreeBytes)}
                                                    </td>
                                                </tr>
                                            ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
        </SettingsCard>
    );
}
