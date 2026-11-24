import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

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
            .catch((error) => failed(error, 'Could not load the plugin’s data budget.'));
    }, [path, show]);
    // An answer of another shape (an older server) shows nothing.
    if (typeof budget?.statementsPerMinute !== 'number') {
        return null;
    }
    const save = async (statementsPerMinute: number | null) => {
        setBusy(true);
        try {
            show(await api<PluginDataBudget>(path, 'PUT', { statementsPerMinute }));
            toast.success(
                statementsPerMinute === null ? 'It uses the workspace’s default again.' : 'Data budget saved.',
            );
        } catch (error) {
            failed(error, 'Could not save the data budget.');
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
                Data operations a minute
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
                    Save
                </Button>
                {budget.override !== null && (
                    <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                        Use the default
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground" data-slot="plugin-data-budget-state">
                {budget.override === null
                    ? `The workspace’s default for plugins, ${budget.workspaceDefault}, set in Settings → General → Plugin datasets.`
                    : `Set for this plugin; the workspace’s default is ${budget.workspaceDefault}.`}{' '}
                A query or a read batch counts as one, a write batch as one per statement. Socios and people keep their
                own limit.
            </p>
        </form>
    );
}
