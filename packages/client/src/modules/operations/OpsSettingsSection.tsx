import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { OperationsSettingsView } from '@socio/shared/operations/operations';
import { ianaTimeZone } from '@socio/shared/time-zone';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsSettings } from './use-ops';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Operations → Settings (CB-164): the reporting time zone, an admin's
 * choice over the server's (`OPS_TIME_ZONE`, else UTC). Every tile and
 * chart cuts its days, weeks and months in it.
 */
export function OpsSettingsSection() {
    const { settings, saved } = useOpsSettings();
    const [zone, setZone] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [zones] = useState(() => Intl.supportedValuesOf('timeZone'));
    useEffect(() => {
        if (settings) {
            setZone(settings.timeZone);
        }
    }, [settings]);
    const save = async (timeZone: string | null) => {
        setBusy(true);
        setError('');
        try {
            const view = await api<OperationsSettingsView>('/operations/settings', 'PUT', { timeZone });
            saved(view);
            setZone(view.timeZone);
            toast.success('Settings saved');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
        } finally {
            setBusy(false);
        }
    };
    const valid = !!ianaTimeZone(zone);
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="ops-time-zone-setting"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (valid) {
                        void save(zone);
                    }
                }}
            >
                <div className="grid gap-1">
                    <h3 className="font-medium">Reporting time zone</h3>
                    <p className="text-muted-foreground">
                        Where a day starts in Operations: every tile, chart and range cuts its days, weeks and months in
                        this time zone, for every admin. The server’s is {settings?.defaults.timeZone ?? 'UTC'}.
                    </p>
                </div>
                <label className="grid max-w-sm gap-1.5">
                    <span className="font-medium">Time zone</span>
                    <Input
                        list="ops-time-zones"
                        value={zone}
                        disabled={!settings}
                        aria-invalid={!!zone && !valid}
                        onChange={(event) => setZone(event.target.value)}
                    />
                    <datalist id="ops-time-zones">
                        {zones.map((name) => (
                            <option key={name} value={name} />
                        ))}
                    </datalist>
                    {zone && !valid && (
                        <small className="text-destructive">
                            Not a time zone name. Pick one from the list, like Europe/Madrid.
                        </small>
                    )}
                </label>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !settings || !valid || zone === settings.timeZone}>
                        Save
                    </Button>
                    {settings && settings.timeZone !== settings.defaults.timeZone && (
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            Use the server’s ({settings.defaults.timeZone})
                        </Button>
                    )}
                </div>
            </form>
        </SettingsCard>
    );
}
