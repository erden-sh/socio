import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { PluginDataBudget } from '@socio/shared/data-types';

import { api } from '../../lib/api';

import { failed } from './plugin-rows';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The plugin page's data budget (CB-473): how many data operations its
 * token may make a minute, the workspace's plugin default (Settings →
 * General → Plugin datasets) unless an admin set this plugin's own. Saved
 * at once; **Use the default** clears it.
 */
export function PluginDataBudgetField({ pluginId }: { pluginId: string }) {
    const { t } = useTranslation(['plugins.manage']);
    const [budget, setBudget] = useState<PluginDataBudget>();
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const path = `/data/plugins/${encodeURIComponent(pluginId)}/budget`;
    const show = useCallback((next: PluginDataBudget) => {
        setBudget(next);
        setValue(String(next.statementsPerMinute));
    }, []);
    useEffect(() => {
        api<PluginDataBudget>(path)
            .then(show)
            .catch((error) => failed(error, t('plugins.manage:budget.load-failed')));
    }, [path, show, t]);
    // An answer of another shape (an older server) shows nothing.
    if (typeof budget?.statementsPerMinute !== 'number') {
        return null;
    }
    const save = async (statementsPerMinute: number | null) => {
        setBusy(true);
        try {
            show(await api<PluginDataBudget>(path, 'PUT', { statementsPerMinute }));
            toast.success(
                statementsPerMinute === null ? t('plugins.manage:budget.reset') : t('plugins.manage:budget.saved'),
            );
        } catch (error) {
            failed(error, t('plugins.manage:budget.save-failed'));
        } finally {
            setBusy(false);
        }
    };
    const number = Number(value);
    const valid = Number.isInteger(number) && number >= 1 && number <= budget.max;
    const id = `plugin-budget-${pluginId}`;
    return (
        <form
            className="grid gap-1.5 text-sm"
            data-slot="plugin-data-budget"
            onSubmit={(event) => {
                event.preventDefault();
                if (valid && number !== budget.statementsPerMinute) {
                    void save(number);
                }
            }}
        >
            <label htmlFor={id} className="font-medium">
                {t('plugins.manage:budget.label')}
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    id={id}
                    type="number"
                    min={1}
                    max={budget.max}
                    step={1}
                    className="w-32"
                    value={value}
                    disabled={busy}
                    onChange={(event) => setValue(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={busy || !valid || number === budget.statementsPerMinute}>
                    {t('plugins.manage:budget.save')}
                </Button>
                {budget.override !== null && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                        {t('plugins.manage:budget.use-default')}
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground" data-slot="plugin-data-budget-state">
                {budget.override === null
                    ? t('plugins.manage:budget.default', { limit: budget.workspaceDefault })
                    : t('plugins.manage:budget.override', { limit: budget.workspaceDefault })}{' '}
                {t('plugins.manage:budget.counts')}
            </p>
        </form>
    );
}
