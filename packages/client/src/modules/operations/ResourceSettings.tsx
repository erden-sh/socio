import { useCallback, useEffect, useState } from 'react';

import {
    OPS_RETENTION,
    type ResourcePolicy,
    type ResourcePolicyView,
} from '@socio/shared/operations/operations-resources';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ResourceSettings() {
    const [view, setView] = useState<ResourcePolicyView>();
    const [values, setValues] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const loaded = useCallback((next: ResourcePolicyView) => {
        setView(next);
        setValues(Object.fromEntries(Object.entries(next.policy).map(([key, value]) => [key, String(value)])));
    }, []);
    useEffect(() => {
        const controller = new AbortController();
        api<ResourcePolicyView>('/operations/retention', 'GET', undefined, controller.signal)
            .then(loaded)
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    setError(error instanceof Error ? error.message : 'Could not load retention settings.');
                }
            });
        return () => controller.abort();
    }, [loaded]);
    const valid =
        Object.entries(values).length > 0 &&
        Object.entries(values).every(([key, raw]) => {
            const value = Number(raw);
            return (
                raw.trim() !== '' &&
                Number.isInteger(value) &&
                (key === 'sampleEverySeconds'
                    ? value >= 60 && value <= 3600 && value % 60 === 0
                    : value >= 0 && value <= 36500)
            );
        });
    const save = async (reset = false) => {
        setBusy(true);
        setError('');
        try {
            const change = Object.fromEntries(
                Object.entries(values).map(([key, raw]) => [key, reset ? null : Number(raw)]),
            );
            loaded(await api<ResourcePolicyView>('/operations/retention', 'PUT', change));
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Could not save.');
        } finally {
            setBusy(false);
        }
    };
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="ops-retention-setting"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (valid) {
                        void save();
                    }
                }}
            >
                <div>
                    <h3 className="font-medium">Collection and retention</h3>
                    <p className="text-muted-foreground">
                        Retention is in days. Zero disables pruning for that setting. Analytics rollups also depend on
                        retained analytics facts; source agent runs are always kept. Changes are recorded in the
                        workspace audit.
                    </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                    {(
                        [
                            ...Object.entries(OPS_RETENTION).map(([key, spec]) => [key, spec.label] as const),
                            ['sampleEverySeconds', 'Sampling interval (seconds)'],
                        ] as Array<[keyof ResourcePolicy, string]>
                    ).map(([key, label]) => (
                        <label key={key} className="grid gap-1.5">
                            <span>{label}</span>
                            <Input
                                type="number"
                                min={key === 'sampleEverySeconds' ? 60 : 0}
                                max={key === 'sampleEverySeconds' ? 3600 : 36500}
                                step={key === 'sampleEverySeconds' ? 60 : 1}
                                value={values[key] ?? ''}
                                disabled={!view || busy}
                                onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                            />
                            <small className="text-muted-foreground">
                                Server default: {view?.defaults[key] ?? '…'}
                                {key === 'sampleEverySeconds' ? ' seconds' : ' days'}
                            </small>
                        </label>
                    ))}
                </div>
                {error && (
                    <p role="alert" className="text-destructive">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !view || !valid}>
                        Save retention
                    </Button>
                    <Button type="button" variant="outline" disabled={busy || !view} onClick={() => void save(true)}>
                        Use server defaults
                    </Button>
                </div>
            </form>
        </SettingsCard>
    );
}
