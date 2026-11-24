import { LIMIT_SPECS, type LimitValues } from '@socio/shared/limits';
import type { OpsQuota, OpsStorage } from '@socio/shared/operations/operations-knowledge';

const MB = 1024 * 1024;
/** "Near" a per-person limit: this share of it or more. */
const NEAR = 0.8;

const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

/**
 * The data space quotas in force (`limitsInForce`, CB-191) beside how
 * full they are, from the analytics store's storage answer: each
 * person's data (live datasets and files) and number of datasets, and
 * the largest dataset and file. Counts are of people, never who.
 */
export function quotasOf(
    limits: Pick<LimitValues, 'dataUserMaxMb' | 'dataDatasetMaxMb' | 'dataFileMaxMb' | 'dataMaxDatasets'>,
    storage: OpsStorage | null,
): OpsQuota[] {
    const quota = (
        key: OpsQuota['key'],
        highest: number | null,
        people?: (limit: number) => { near: number; at: number },
    ): OpsQuota => {
        const limit = limits[key];
        const counted = storage && people ? people(limit) : null;
        return {
            key,
            label: LIMIT_SPECS[key].label,
            limit,
            unit: LIMIT_SPECS[key].unit,
            highest: storage ? highest : null,
            near: counted?.near ?? null,
            at: counted?.at ?? null,
        };
    };
    const owners = storage?.owners ?? [];
    const count = (value: (owner: (typeof owners)[number]) => number) => (limit: number) => ({
        near: owners.filter((owner) => value(owner) >= NEAR * limit).length,
        at: owners.filter((owner) => value(owner) >= limit).length,
    });
    return [
        quota(
            'dataUserMaxMb',
            mb(owners[0]?.bytes ?? 0),
            count((owner) => owner.bytes / MB),
        ),
        quota(
            'dataMaxDatasets',
            owners.reduce((most, owner) => Math.max(most, owner.datasets), 0),
            count((owner) => owner.datasets),
        ),
        quota('dataDatasetMaxMb', mb(storage?.largestDatasetBytes ?? 0)),
        quota('dataFileMaxMb', mb(storage?.largestFileBytes ?? 0)),
    ];
}
