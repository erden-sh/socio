import { numberFormat } from './locale.js';

const whole = numberFormat({ maximumFractionDigits: 0 });
const thousands = numberFormat({
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});
const millions = numberFormat({
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});

/**
 * A token count in one format everywhere (CB-308): `453`, `1.3k`,
 * `72.2k`, `1.36M`. Thousands keep one decimal and millions two, so a
 * column of counts reads at the same precision; a count that would round
 * to `1000.0k` shows as `1.00M` instead.
 */
export function formatTokens(value: number) {
    if (value < 1_000) {
        return whole.format(value);
    }
    if (Math.round(value / 100) < 10_000) {
        return `${thousands.format(value / 1_000)}k`;
    }
    return `${millions.format(value / 1_000_000)}M`;
}
