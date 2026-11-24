/**
 * Page search timings as the daily rollup keeps them: a histogram of
 * quarter-octave buckets, and percentiles read back from it. Moved from
 * `src/server/pages/page-search.ts`, which re-exports `percentile`: pure,
 * and the operations knowledge view reads the same percentiles.
 */

/** Search timing buckets: a quarter octave each from 0.05 ms. */
const BUCKET_BASE = 0.05;
const BUCKETS_PER_OCTAVE = 4;
/** The bucket a search time falls in (0 to 100). */
export const bucketOf = (ms: number) =>
    Math.max(0, Math.min(100, Math.ceil(Math.log2(Math.max(ms, BUCKET_BASE) / BUCKET_BASE) * BUCKETS_PER_OCTAVE)));
const bucketValue = (bucket: number) => BUCKET_BASE * 2 ** ((bucket - 0.5) / BUCKETS_PER_OCTAVE);

/** The p-th percentile of a bucket histogram (bucket → count), in ms; null when empty. */
export function percentile(histogram: Record<number, number>, p: number) {
    const entries = Object.entries(histogram)
        .map(([bucket, count]) => [Number(bucket), count] as const)
        .sort((a, b) => a[0] - b[0]);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    if (!total) {
        return null;
    }
    const rank = Math.ceil((p / 100) * total);
    let seen = 0;
    for (const [bucket, count] of entries) {
        seen += count;
        if (seen >= rank) {
            return Math.round(bucketValue(bucket) * 100) / 100;
        }
    }
    return null;
}
