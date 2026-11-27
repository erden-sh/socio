import { useTranslation } from '@socio/i18n/react';
import type { AutoTriageSettings } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';
import { Input } from '@/components/ui/input';

const PER_DAY_MAX = 10_000;

/**
 * Automatic triage of new issues (CB-30) in Settings → Workspace → General:
 * the switch (off by default) and the most proposals the model makes a
 * day. Saved over `AUTO_TRIAGE` and `AUTO_TRIAGE_DAILY`; members read it,
 * only admins change it.
 */
export function AutoTriageSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: AutoTriageSettings | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const cap = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text) : NaN);
    const auto = useAutosave(
        {
            enabled: settings?.enabled ?? false,
            perDay: String(settings?.perDay ?? ''),
        },
        (value) =>
            mutate('/settings', 'PATCH', {
                autoTriage: { enabled: value.enabled, perDay: cap(value.perDay) },
            }),
    );
    const commit = () =>
        void auto.commit(t('settings.workspace:autoTriage.saved'), (value) => {
            const perDay = cap(value.perDay);
            return perDay >= 0 && perDay <= PER_DAY_MAX
                ? undefined
                : t('settings.workspace:autoTriage.invalid', { max: PER_DAY_MAX });
        });
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                data-slot="auto-triage"
                // Enter saves too, like leaving the field.
                onSubmit={(event) => {
                    event.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader
                    title={t('settings.workspace:autoTriage.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace:autoTriage.intro')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace:autoTriage.toggle')}
                    checked={auto.value.enabled}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { enabled: on },
                            t('settings.workspace:autoTriage.toggled', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:autoTriage.description')}
                </PermissionRow>
                <div className="grid gap-1.5">
                    <label htmlFor="auto-triage-per-day" className="font-medium">
                        {t('settings.workspace:autoTriage.perDay')}
                    </label>
                    <Input
                        id="auto-triage-per-day"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={PER_DAY_MAX}
                        step={1}
                        className="w-32"
                        disabled={readOnly}
                        value={auto.value.perDay}
                        onChange={(event) => auto.edit({ perDay: event.target.value })}
                        onBlur={commit}
                    />
                    <p className="text-muted-foreground">{t('settings.workspace:autoTriage.perDayHint')}</p>
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
            </form>
        </SettingsCard>
    );
}
