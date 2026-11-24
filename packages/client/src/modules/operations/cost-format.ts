import { useCallback, useEffect, useState } from 'react';

import { numberFormat } from '@socio/shared/locale';
import { PRICE_SOURCES, type PriceOrigin, type PricingView } from '@socio/shared/operations/operations-cost';

import { api } from '../../lib/api';

const whole = numberFormat({
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
});
const cents = numberFormat({
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
const small = numberFormat({
    style: 'currency',
    currency: 'USD',
    maximumSignificantDigits: 2,
});
const rate = numberFormat({
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
});

/** Dollars: "$1,234", "$12.34", "$0.0045"; "–" for none. */
export function formatUsd(value: number | null | undefined) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return '–';
    }
    const size = Math.abs(value);
    if (size === 0) {
        return '$0';
    }
    if (size < 0.01) {
        return small.format(value);
    }
    return (size >= 1000 ? whole : cents).format(value);
}

/** A price: "$0.15 / M" (US dollars per million tokens). */
export const formatPerM = (value: number | null | undefined) =>
    value === null || value === undefined ? '–' : `${rate.format(value)} / M`;

/** Dollars per million tokens of `tokens`, or null without tokens. */
export const perMillion = (usd: number | null, tokens: number) =>
    usd === null || tokens <= 0 ? null : (usd / tokens) * 1e6;

/** Where a price came from, as people know it. */
export function originLabel(source: PriceOrigin) {
    if (source === 'admin') {
        return 'Admin';
    }
    const id = source.slice(source.indexOf(':') + 1);
    return PRICE_SOURCES[id as keyof typeof PRICE_SOURCES]?.label ?? id;
}

/** A UTC day for a date input, and back. */
export const dayInput = (at: number) => new Date(at).toISOString().slice(0, 10);
export const dayOf = (value: string) => {
    const at = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(at) ? at : null;
};

/**
 * The prices, sync, backends and pools (`/operations/pricing`), and a
 * way to read them again after a change.
 */
export function usePricing() {
    const [view, setView] = useState<PricingView>();
    const [error, setError] = useState('');
    const reload = useCallback(async (signal?: AbortSignal) => {
        try {
            const next = await api<PricingView>('/operations/pricing', 'GET', undefined, signal);
            if (!signal?.aborted) {
                setView(next);
                setError('');
            }
        } catch (e) {
            if (!signal?.aborted) {
                setError(e instanceof Error ? e.message : 'Could not load prices.');
            }
        }
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        void reload(controller.signal);
        return () => controller.abort();
    }, [reload]);
    return { view, error, reload };
}
