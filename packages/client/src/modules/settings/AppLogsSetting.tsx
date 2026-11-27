import { useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@socio/i18n/react';
import {
    APP_LOG_ATTEMPTS_RANGE,
    APP_LOG_DAYS_RANGE,
    DEFAULT_APP_LOG_RETENTION,
    type AppLogRetention,
} from '@socio/shared/apps/app-log-retention';

import { onDemand } from '../../i18n/on-demand';

import { SettingsCard } from './AccountSettings';

import { Input } from '@/components/ui/input';

/**
 * Mini app logs (CB-175) in Settings → Workspace → General: how long each
 * app's build and start attempts, with their logs, are kept: for this many
 * days or while they are among the app's last attempts, whichever keeps
 * more. Saved over `APPS_LOG_DAYS` and `APPS_LOG_ATTEMPTS` when a field is
 * left. Members read it; only admins change it.
 */
function AppLogsSettingBody({
    settings,
    readOnly,
    mutate,
}: {
    settings: AppLogRetention | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace-apps', 'settings.workspace']);
    const saved = settings ?? DEFAULT_APP_LOG_RETENTION;
    const [value, setValue] = useState({
        days: String(saved.days),
        attempts: String(saved.attempts),
    });
    const save = async (key: keyof AppLogRetention) => {
        const range = key === 'days' ? APP_LOG_DAYS_RANGE : APP_LOG_ATTEMPTS_RANGE;
        const number = Number(value[key]);
        if (!Number.isInteger(number) || number < range.min || number > range.max) {
            toast.error(t('settings.workspace-apps:logs.invalid', { min: range.min, max: range.max }));
            setValue({ ...value, [key]: String(saved[key]) });
            return;
        }
        if (number === saved[key]) {
            return;
        }
        if (await mutate('/settings', 'PATCH', { appLogs: { [key]: number } })) {
            toast.success(t('settings.workspace-apps:logs.saved'));
        } else {
            setValue({ ...value, [key]: String(saved[key]) });
        }
    };
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="app-logs-settings">
                <div className="grid gap-1">
                    <h3 className="font-medium">{t('settings.workspace-apps:logs.title')}</h3>
                    <p className="text-muted-foreground">{t('settings.workspace-apps:logs.intro')}</p>
                </div>
                {(
                    [
                        [
                            'days',
                            t('settings.workspace-apps:logs.days.label'),
                            t('settings.workspace-apps:logs.days.unit'),
                        ],
                        [
                            'attempts',
                            t('settings.workspace-apps:logs.attempts.label'),
                            t('settings.workspace-apps:logs.attempts.unit'),
                        ],
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
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.settings')}</p>}
            </section>
        </SettingsCard>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-apps, in no route's entry). */
export const AppLogsSetting = onDemand(['settings.workspace-apps'], AppLogsSettingBody);
