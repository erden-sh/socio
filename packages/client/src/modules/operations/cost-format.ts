import { useCallback, useEffect, useState } from 'react';

import { useTranslation } from '@socio/i18n/react';
import { numberFormat } from '@socio/shared/locale';
import {
    PRICE_SOURCES,
    type PriceOrigin,
    type PriceSourceId,
    type PricingView,
} from '@socio/shared/operations/operations-cost';

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

/** A price: "$0.15 / M" (US dollars per million tokens); "–" for none. */
export function useFormatPerM() {
    const { t } = useTranslation(['operations.cost']);
    return (value: number | null | undefined) =>
        value === null || value === undefined ? '–' : t('operations.cost:per-million', { price: rate.format(value) });
}

/** Dollars per million tokens of `tokens`, or null without tokens. */
export const perMillion = (usd: number | null, tokens: number) =>
    usd === null || tokens <= 0 ? null : (usd / tokens) * 1e6;

/** Where a price came from, as people know it: an admin, a list's name, or its id. */
export function useOriginLabel() {
    const { t } = useTranslation(['operations.cost-admin']);
    return (source: PriceOrigin) => {
        if (source === 'admin') {
            return t('operations.cost-admin:sources.admin');
        }
        const id = source.slice(source.indexOf(':') + 1);
        return Object.hasOwn(PRICE_SOURCES, id) ? t(`operations.cost-admin:sources.${id as PriceSourceId}`) : id;
    };
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
    const { t } = useTranslation(['operations.cost']);
    const [view, setView] = useState<PricingView>();
    const [error, setError] = useState('');
    const reload = useCallback(
        async (signal?: AbortSignal) => {
            try {
                const next = await api<PricingView>('/operations/pricing', 'GET', undefined, signal);
                if (!signal?.aborted) {
                    setView(next);
                    setError('');
                }
            } catch (e) {
                if (!signal?.aborted) {
                    setError(e instanceof Error ? e.message : t('operations.cost:load-failed'));
                }
            }
        },
        [t],
    );
    useEffect(() => {
        const controller = new AbortController();
        void reload(controller.signal);
        return () => controller.abort();
    }, [reload]);
    return { view, error, reload };
}
