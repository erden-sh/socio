import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import type { OperationsSettingsView } from '@socio/shared/operations/operations';
import { OPS_SESSION_GAP } from '@socio/shared/operations/operations-activity';

import { api } from '../../lib/api';
import { SettingsCard } from '../settings/AccountSettings';

import { useOpsSettings } from './use-ops';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Operations → Settings → Sessions (CB-190): the gap that ends a session,
 * an admin's choice over the server's (`OPS_SESSION_GAP_MINUTES`, else
 * 30 minutes). Sessions are worked out from the messages each time, so a
 * new gap applies to every range at once, past ones included.
 */
export function SessionGapSetting() {
    const { t } = useTranslation(['operations.settings', 'operations']);
    const { settings, saved } = useOpsSettings();
    const [minutes, setMinutes] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (settings) {
            setMinutes(String(settings.sessionGapMinutes));
        }
    }, [settings]);
    const save = async (sessionGapMinutes: number | null) => {
        setBusy(true);
        setError('');
        try {
            const view = await api<OperationsSettingsView>('/operations/settings', 'PUT', { sessionGapMinutes });
            saved(view);
            setMinutes(String(view.sessionGapMinutes));
            toast.success(t('operations.settings:saved'));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('operations.settings:save-failed'));
        } finally {
            setBusy(false);
        }
    };
    const value = Number(minutes);
    const valid = /^\d+$/.test(minutes) && value >= OPS_SESSION_GAP.min && value <= OPS_SESSION_GAP.max;
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="ops-session-gap-setting"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (valid) {
                        void save(value);
                    }
                }}
            >
                <div className="grid gap-1">
                    <h3 className="font-medium">{t('operations.settings:session-gap.title')}</h3>
                    <p className="text-muted-foreground">
                        {t('operations.settings:session-gap.description', {
                            count: settings?.defaults.sessionGapMinutes ?? OPS_SESSION_GAP.default,
                        })}
                    </p>
                </div>
                <label className="grid max-w-56 gap-1.5">
                    <span className="font-medium">{t('operations.settings:session-gap.label')}</span>
                    <Input
                        inputMode="numeric"
                        value={minutes}
                        disabled={!settings}
                        aria-invalid={!!minutes && !valid}
                        onChange={(event) => setMinutes(event.target.value.trim())}
                    />
                    {minutes && !valid && (
                        <small className="text-destructive">
                            {t('operations.settings:session-gap.invalid', {
                                min: OPS_SESSION_GAP.min,
                                max: OPS_SESSION_GAP.max,
                            })}
                        </small>
                    )}
                </label>
                {error && (
                    <p className="rounded-lg bg-destructive/10 p-3 text-destructive" role="alert">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="submit"
                        disabled={busy || !settings || !valid || value === settings.sessionGapMinutes}
                    >
                        {t('operations.settings:save')}
                    </Button>
                    {settings && settings.sessionGapMinutes !== settings.defaults.sessionGapMinutes && (
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            {t('operations.settings:session-gap.reset', {
                                count: settings.defaults.sessionGapMinutes,
                            })}
                        </Button>
                    )}
                </div>
            </form>
        </SettingsCard>
    );
}
