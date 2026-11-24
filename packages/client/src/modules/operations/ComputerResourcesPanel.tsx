import type {
    ComputerDiskStatus,
    ComputerResourceRow,
    ComputerResourcesView,
} from '@socio/shared/computers/computer-resources';
import { dateTimeFormat, formatNumber, numberFormat } from '@socio/shared/locale';

import { LocalTime } from '../../lib/local-time';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsAnswer, useOpsQuery } from './use-ops';

const oneDecimal = numberFormat({ maximumFractionDigits: 1 });
const twoDecimals = numberFormat({ maximumFractionDigits: 2 });
const dateTime = dateTimeFormat({ dateStyle: 'medium', timeStyle: 'short' });
const timestamp = (at: number) => dateTime.format(at);

const bytes = (value: number | null | undefined) => (value == null ? '—' : `${oneDecimal.format(value / 1048576)} MiB`);
const cpu = (value: number | null | undefined) => (value == null ? '—' : `${twoDecimals.format(value)}%`);
/** Why a computer has no disk reading, in a few words. */
const DISK_MISSING: Record<ComputerDiskStatus['state'], string> = {
    off: 'Not set up',
    pending: 'Not measured yet',
    ok: 'Unavailable',
    unavailable: 'Unavailable',
};
function DiskNote({ disk }: { disk: ComputerDiskStatus }) {
    const every = `every ${disk.everyMinutes} minutes`;
    if (disk.state === 'off') {
        return (
            <p className="text-muted-foreground">
                Disk usage is not set up: it needs the read-only disk usage proxy (COMPUTER_DISK_USAGE_URL).
            </p>
        );
    }
    return (
        <p className="text-muted-foreground" role={disk.state === 'unavailable' ? 'status' : undefined}>
            {disk.state === 'unavailable'
                ? `Disk usage is unavailable: the last measurement through Docker failed. It is tried again ${every}.`
                : `Disk usage is measured through Docker ${every}.`}
            {disk.measuredAt !== null && (
                <>
                    {' '}
                    Last measured <LocalTime value={disk.measuredAt} format={timestamp} />.
                </>
            )}
        </p>
    );
}
function ComputerRow({ row, disk }: { row: ComputerResourceRow; disk?: ComputerDiskStatus }) {
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
                    {row.running === true ? 'Running' : row.running === false ? 'Stopped' : 'Status unavailable'}
                </div>
                <small className="text-muted-foreground">
                    {latest ? (
                        <>
                            Sampled <LocalTime value={latest.at} format={timestamp} />
                        </>
                    ) : (
                        'No samples yet'
                    )}
                </small>
                {row.history.gaps.length > 0 && (
                    <div className="text-muted-foreground">
                        Missing or stale: {row.history.gaps.map((gap) => gap.label).join(', ')}
                    </div>
                )}
                {row.history.hourly.length > 0 && (
                    <details className="mt-2">
                        <summary>Hourly history</summary>
                        <div className="max-h-64 overflow-auto">
                            <table className="text-sm">
                                <caption>Most recent 24 hourly averages</caption>
                                <thead>
                                    <tr>
                                        <th>Hour</th>
                                        <th>CPU</th>
                                        <th>Memory</th>
                                        <th>Disk</th>
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
                {bytes(memory)} / {limit === 0 ? 'Unlimited' : bytes(limit)}
                {limit != null && limit > 0 && memory != null && (
                    <small className="block text-muted-foreground">
                        {((100 * memory) / limit).toFixed(1)}% of limit
                    </small>
                )}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">
                {volume == null ? (
                    <span className="text-muted-foreground">{disk ? DISK_MISSING[disk.state] : '—'}</span>
                ) : (
                    bytes(volume)
                )}
                {layer != null && <small className="block text-muted-foreground">{bytes(layer)} container layer</small>}
            </td>
            <td className="px-2 py-2 align-top tabular-nums">
                {formatNumber(row.appOoms)}
                {row.lastAppOomAt !== null && (
                    <small className="block text-muted-foreground">
                        Last <LocalTime value={row.lastAppOomAt} format={timestamp} />
                    </small>
                )}
            </td>
        </tr>
    );
}
export function ComputerResourcesPanel() {
    const { search } = useOpsQuery();
    const { data, error } = useOpsAnswer<ComputerResourcesView>('/operations/resources/computers' + search);
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-computer-resources">
                <div>
                    <h3 className="font-medium">Socio computers</h3>
                    <p className="text-muted-foreground">
                        Current resource readings and hourly history for computers with permissions or retained history.
                        Disk includes workspace, private homes and browser profile volumes. App OOM counts cover
                        retained attempts in the selected period. Socio and Space filters apply; shared computers are
                        independent of the person and source filters.
                    </p>
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
                                            {['Socio', 'CPU', 'Memory / limit', 'Volume disk', 'App OOMs'].map(
                                                (label) => (
                                                    <th key={label} className="px-2 py-1">
                                                        {label}
                                                    </th>
                                                ),
                                            )}
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
                                <p className="text-muted-foreground">
                                    Showing the first 100 computers. Narrow the socio or Space filter for more.
                                </p>
                            )}
                        </>
                    ) : (
                        <p className="text-muted-foreground">
                            No computers with permissions or retained resource history in this view.
                        </p>
                    ))}
            </div>
        </SettingsCard>
    );
}
