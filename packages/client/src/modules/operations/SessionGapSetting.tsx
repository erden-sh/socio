import { useEffect, useState } from 'react';
import { toast } from 'sonner';

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
            toast.success('Settings saved');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not save.');
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
                    <h3 className="font-medium">Sessions</h3>
                    <p className="text-muted-foreground">
                        Activity and Value count a chat’s messages as one session until nobody writes for this long. A
                        change applies to every range at once. The server’s is{' '}
                        {settings?.defaults.sessionGapMinutes ?? OPS_SESSION_GAP.default} minutes.
                    </p>
                </div>
                <label className="grid max-w-56 gap-1.5">
                    <span className="font-medium">Gap in minutes</span>
                    <Input
                        inputMode="numeric"
                        value={minutes}
                        disabled={!settings}
                        aria-invalid={!!minutes && !valid}
                        onChange={(event) => setMinutes(event.target.value.trim())}
                    />
                    {minutes && !valid && (
                        <small className="text-destructive">
                            A whole number from {OPS_SESSION_GAP.min} to {OPS_SESSION_GAP.max}.
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
                        Save
                    </Button>
                    {settings && settings.sessionGapMinutes !== settings.defaults.sessionGapMinutes && (
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void save(null)}>
                            Use the server’s ({settings.defaults.sessionGapMinutes} minutes)
                        </Button>
                    )}
                </div>
            </form>
        </SettingsCard>
    );
}
