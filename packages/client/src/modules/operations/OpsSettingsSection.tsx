import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
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
    const { t } = useTranslation(['operations.settings', 'operations']);
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
            toast.success(t('operations.settings:saved'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.settings:save-failed'));
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
                    <h3 className="font-medium">{t('operations.settings:time-zone.title')}</h3>
                    <p className="text-muted-foreground">
                        {t('operations.settings:time-zone.description', { zone: settings?.defaults.timeZone ?? 'UTC' })}
                    </p>
                </div>
                <label className="grid max-w-sm gap-1.5">
                    <span className="font-medium">{t('operations.settings:time-zone.label')}</span>
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
                        <small className="text-destructive">{t('operations.settings:time-zone.invalid')}</small>
                    )}
                </label>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={busy || !settings || !valid || zone === settings.timeZone}>
                        {t('operations.settings:save')}
                    </Button>
                    {settings && settings.timeZone !== settings.defaults.timeZone && (
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            {t('operations.settings:time-zone.reset', { zone: settings.defaults.timeZone })}
                        </Button>
                    )}
                </div>
            </form>
        </SettingsCard>
    );
}
