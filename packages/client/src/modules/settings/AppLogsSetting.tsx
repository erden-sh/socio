import { useState } from 'react';
import { toast } from 'sonner';

import {
    APP_LOG_ATTEMPTS_RANGE,
    APP_LOG_DAYS_RANGE,
    DEFAULT_APP_LOG_RETENTION,
    type AppLogRetention,
} from '@socio/shared/apps/app-log-retention';

import { SettingsCard } from './AccountSettings';

import { Input } from '@/components/ui/input';

/**
 * Mini app logs (CB-175) in Settings → Workspace → General: how long each
 * app's build and start attempts, with their logs, are kept: for this many
 * days or while they are among the app's last attempts, whichever keeps
 * more. Saved over `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS` when a field is
 * left. Members read it; only admins change it.
 */
export function AppLogsSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: AppLogRetention | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const saved = settings ?? DEFAULT_APP_LOG_RETENTION;
    const [value, setValue] = useState({
        days: String(saved.days),
        attempts: String(saved.attempts),
    });
    const save = async (key: keyof AppLogRetention) => {
        const range = key === 'days' ? APP_LOG_DAYS_RANGE : APP_LOG_ATTEMPTS_RANGE;
        const number = Number(value[key]);
        if (!Number.isInteger(number) || number < range.min || number > range.max) {
            toast.error(`Use a whole number from ${range.min} to ${range.max}.`);
            setValue({ ...value, [key]: String(saved[key]) });
            return;
        }
        if (number === saved[key]) {
            return;
        }
        if (await mutate('/settings', 'PATCH', { appLogs: { [key]: number } })) {
            toast.success('Mini app logs saved');
        } else {
            setValue({ ...value, [key]: String(saved[key]) });
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="app-logs-settings">
                <div className="grid gap-1">
                    <h3 className="font-medium">Mini app logs</h3>
                    <p className="text-muted-foreground">
                        Each build and start of a mini app keeps its log. An attempt is kept for the days below or while
                        it is one of the app’s last attempts, whichever keeps more; older ones are removed in the
                        background, and the one running now never is. Only the app’s owner and admins can read them.
                    </p>
                </div>
                {(
                    [
                        ['days', 'Keep for', 'days'],
                        ['attempts', 'Or keep the last', 'attempts per app'],
                    ] as const
                ).map(([key, label, unit]) => (
                    <div className="grid gap-2" key={key}>
                        <label htmlFor={`app-logs-${key}`} className="font-medium">
                            {label}
                        </label>
                        <div className="flex items-center gap-2">
                            <Input
                                id={`app-logs-${key}`}
                                type="number"
                                inputMode="numeric"
                                min={(key === 'days' ? APP_LOG_DAYS_RANGE : APP_LOG_ATTEMPTS_RANGE).min}
                                max={(key === 'days' ? APP_LOG_DAYS_RANGE : APP_LOG_ATTEMPTS_RANGE).max}
                                step={1}
                                className="w-32"
                                disabled={readOnly}
                                value={value[key]}
                                onChange={(event) => setValue({ ...value, [key]: event.target.value })}
                                onBlur={() => void save(key)}
                            />
                            <span className="text-muted-foreground">{unit}</span>
                        </div>
                    </div>
                ))}
                {readOnly && <p className="text-muted-foreground">Only an admin can change these settings.</p>}
            </section>
        </SettingsCard>
    );
}
