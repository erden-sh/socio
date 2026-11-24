import {
    RESOURCE_METRICS,
    type ResourceHistory,
    type ResourceMetric,
} from '@socio/shared/operations/operations-resources';

import { SettingsCard } from '../settings/AccountSettings';

import { useOpsAnswer } from './use-ops';

const observed = (key: ResourceMetric, value: number | null) =>
    value === null
        ? '—'
        : key.endsWith('Bytes')
          ? `${(value / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`
          : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${key === 'cpuPercent' ? '%' : ''}`;
export function ResourcePanel() {
    const { data, error } = useOpsAnswer<ResourceHistory>('/operations/resources');
    return (
        <SettingsCard>
            <div className="grid min-w-0 gap-4" data-slot="ops-resource-history">
                <div>
                    <h3 className="font-medium">Server resources (host-wide)</h3>
                    <p className="text-muted-foreground">
                        Workspace server measurements, independent of the person and source filters. Load and system
                        memory are the whole host’s as the app sees it, other tenants included; this deployment’s own
                        use is under Deployment services. Collected every {data?.collectedEverySeconds ?? '…'} seconds;
                        storage totals are collected daily. No history is inferred before collection starts.
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
                            Last sample:{' '}
                            {data.latest ? new Date(data.latest.at).toLocaleString() : 'No samples collected yet.'}
                        </p>
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {(Object.keys(RESOURCE_METRICS) as ResourceMetric[]).map((key) => {
                                const value =
                                    data.latest?.values[key] ??
                                    data.hourly.toReversed().find((hour) => hour.values[key] !== null)?.values[key] ??
                                    null;
                                return (
                                    <div key={key} className="min-w-0">
                                        <dt className="text-sm text-muted-foreground">{RESOURCE_METRICS[key]}</dt>
                                        <dd className="m-0 tabular-nums">{observed(key, value)}</dd>
                                    </div>
                                );
                            })}
                        </dl>
                        <div data-slot="ops-collection-gaps">
                            <h4 className="font-medium">Collection gaps</h4>
                            {data.gaps.length ? (
                                <ul className="m-0 grid gap-1 pl-5">
                                    {data.gaps.map((gap) => (
                                        <li key={gap.metric}>
                                            {gap.label}:{' '}
                                            {gap.state === 'missing'
                                                ? 'no history'
                                                : `last collected ${new Date(gap.lastAt!).toLocaleString()}`}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="m-0 text-muted-foreground">Every resource metric has recent history.</p>
                            )}
                        </div>
                        {data.hourly.length > 0 && (
                            <div className="min-w-0 overflow-x-auto">
                                <table className="w-full text-left text-sm">
                                    <caption className="text-left">Most recent 24 hourly averages</caption>
                                    <thead>
                                        <tr>
                                            {['Hour', 'Samples', 'Process memory', 'CPU', 'Volume free'].map(
                                                (label) => (
                                                    <th className="px-2 py-1" key={label}>
                                                        {label}
                                                    </th>
                                                ),
                                            )}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.hourly
                                            .slice(-24)
                                            .toReversed()
                                            .map((hour) => (
                                                <tr key={hour.at}>
                                                    <td className="whitespace-nowrap px-2 py-1">
                                                        {new Date(hour.at).toLocaleString()}
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
