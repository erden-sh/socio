import { Trans, useTranslation } from '@socio/i18n/react';
import type {
    ComputerDiskStatus,
    ComputerResourceRow,
    ComputerResourcesView,
} from '@socio/shared/computers/computer-resources';
import { dateTimeFormat, formatNumber, numberFormat } from '@socio/shared/locale';

import { onDemand } from '../../i18n/on-demand';
import { LocalTime } from '../../lib/local-time';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsAnswer, useOpsQuery } from './use-ops';

const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const oneDecimalFixed = numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const twoDecimals = numberFormat({ maximumFractionDigits: 2 });
const dateTime = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const timestamp = (at: number) => dateTime.format(at);

const bytes = (value: number | null | undefined) => (value == null ? '—' : `${oneDecimal.format(value / 1048576)} MiB`);
const cpu = (value: number | null | undefined) => (value == null ? '—' : `${twoDecimals.format(value)}%`);
function DiskNote({ disk }: { disk: ComputerDiskStatus }) {
    const { t } = useTranslation(['operations.resources']);
    if (disk.state === 'off') {
        return <p className="text-muted-foreground">{t('operations.resources:computers.disk-off')}</p>;
    }
    return (
        <p className="text-muted-foreground" role={disk.state === 'unavailable' ? 'status' : undefined}>
            {disk.state === 'unavailable'
                ? t('operations.resources:computers.disk-unavailable', { count: disk.everyMinutes })
                : t('operations.resources:computers.disk-measured', { count: disk.everyMinutes })}
            {disk.measuredAt !== null && (
                <>
                    {' '}
                    <Trans
                        t={t}
                        i18nKey="operations.resources:computers.last-measured"
                        components={{ time: <LocalTime value={disk.measuredAt} format={timestamp} /> }}
                    />
                </>
            )}
        </p>
    );
}
function ComputerRow({ row, disk }: { row: ComputerResourceRow; disk?: ComputerDiskStatus }) {
    const { t } = useTranslation(['operations.resources']);
    const latest = row.history.latest;
    const volume = latest?.values.volumeBytes;
    const layer = latest?.values.containerBytes;
    const memory = latest?.values.memoryBytes;
    const limit = latest?.values.memoryLimitBytes;
    return (
        <tr>
            <td className="px-2 py-2 align-top">
                <strong>{row.name}</strong>
                <div className="text-muted-foreground">
                    {row.running === true
                        ? t('operations.resources:computers.running')
                        : row.running === false
                          ? t('operations.resources:computers.stopped')
                          : t('operations.resources:computers.status-unavailable')}
                </div>
                <small className="text-muted-foreground">
                    {latest ? (
                        <Trans
                            t={t}
                            i18nKey="operations.resources:computers.sampled"
                            components={{ time: <LocalTime value={latest.at} format={timestamp} /> }}
                        />
                    ) : (
                        t('operations.resources:computers.no-samples')
                    )}
                </small>
                {row.history.gaps.length > 0 && (
                    <div className="text-muted-foreground">
                        {t('operations.resources:computers.missing', {
                            metrics: row.history.gaps
                                .map((gap) => t(`operations.resources:computers.metric.${gap.metric}`))
                                .join(', '),
                        })}
                    </div>
                )}
                {row.history.hourly.length > 0 && (
                    <details className="mt-2">
                        <summary>{t('operations.resources:hourly.title')}</summary>
                        <div className="max-h-64 overflow-auto">
                            <table className="text-sm">
                                <caption>{t('operations.resources:hourly.caption')}</caption>
                                <thead>
                                    <tr>
                                        <th>{t('operations.resources:hourly.hour')}</th>
                                        <th>{t('operations.resources:hourly.cpu')}</th>
                                        <th>{t('operations.resources:hourly.memory')}</th>
                                        <th>{t('operations.resources:computers.disk')}</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {row.history.hourly
                                        .slice(-24)
                                        .toReversed()
                                        .map((hour) => (
                                            <tr key={hour.at}>
                                                <td className="whitespace-nowrap px-2">
                                                    <LocalTime value={hour.at} format={timestamp} />
                                                </td>
                                                <td className="px-2">{cpu(hour.values.cpuPercent)}</td>
                                                <td className="px-2">{bytes(hour.values.memoryBytes)}</td>
                                                <td className="px-2">{bytes(hour.values.volumeBytes)}</td>
                                            </tr>
                                        ))}
                                </tbody>
                            </table>
                        </div>
                    </details>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">{cpu(latest?.values.cpuPercent)}</td>
            <td className="px-2 py-2 align-top tabular-nums">
                {bytes(memory)} / {limit === 0 ? t('operations.resources:computers.unlimited') : bytes(limit)}
                {limit != null && limit > 0 && memory != null && (
                    <small className="block text-muted-foreground">
                        {t('operations.resources:of-limit', { share: oneDecimalFixed.format((100 * memory) / limit) })}
                    </small>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">
                {volume == null ? (
                    <span className="text-muted-foreground">
                        {disk
                            ? t(
                                  `operations.resources:computers.disk-missing.${disk.state === 'ok' ? 'unavailable' : disk.state}`,
                              )
                            : '—'}
                    </span>
                ) : (
                    bytes(volume)
                )}
                {layer != null && (
                    <small className="block text-muted-foreground">
                        {t('operations.resources:computers.container-layer', { size: bytes(layer) })}
                    </small>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">
                {formatNumber(row.appOoms)}
                {row.lastAppOomAt !== null && (
                    <small className="block text-muted-foreground">
                        <Trans
                            t={t}
                            i18nKey="operations.resources:computers.last-oom"
                            components={{ time: <LocalTime value={row.lastAppOomAt} format={timestamp} /> }}
                        />
                    </small>
                )}
            </td>
        </tr>
    );
}
/**
 * Socios' computers' resources: each one's latest reading, its disk, app
 * OOMs and hourly history. Below the Health page's numbers, so its words
 * load on demand (operations.resources).
 */
export const ComputerResourcesPanel = onDemand(['operations.resources'], ComputerResources);

function ComputerResources() {
    const { t } = useTranslation(['operations.resources']);
    const { search } = useOpsQuery();
    const { data, error } = useOpsAnswer<ComputerResourcesView>('/operations/resources/computers' + search);
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-computer-resources">
                <div>
                    <h3 className="font-medium">{t('operations.resources:computers.title')}</h3>
                    <p className="text-muted-foreground">{t('operations.resources:computers.description')}</p>
                    {data?.disk && <DiskNote disk={data.disk} />}
                </div>
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                    </p>
                )}
                {data &&
                    (data.rows.length ? (
                        <>
                            <div className="min-w-0 overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <thead>
                                        <tr>
                                            {[
                                                t('operations.resources:computers.socio'),
                                                t('operations.resources:hourly.cpu'),
                                                t('operations.resources:memory-limit'),
                                                t('operations.resources:computers.volume-disk'),
                                                t('operations.resources:computers.app-ooms'),
                                            ].map((label) => (
                                                <th key={label} className="px-2 py-1">
                                                    {label}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.rows.map((row) => (
                                            <ComputerRow key={row.dotId} row={row} disk={data.disk} />
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            {data.more && (
                                <p className="text-muted-foreground">{t('operations.resources:computers.more')}</p>
                            )}
                        </>
                    ) : (
                        <p className="text-muted-foreground">{t('operations.resources:computers.empty')}</p>
                    ))}
            </div>
        </SettingsCard>
    );
}
