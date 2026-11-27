import { useTranslation } from '@socio/i18n/react';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * Busy models (CB-140) in Settings → Workspace → General: whether a reply
 * whose person's own model (a ChatGPT plan) stays busy carries on with the
 * shared model, on by default. Members read it; only admins change it.
 */
export function ModelFallbackSetting({
    enabled,
    readOnly,
    mutate,
}: {
    enabled: boolean | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave({ modelFallback: enabled ?? true }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="model-fallback">
                <AutosaveHeader
                    title={t('settings.workspace:modelFallback.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace:modelFallback.intro')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace:modelFallback.toggle')}
                    checked={auto.value.modelFallback}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { modelFallback: on },
                            t('settings.workspace:modelFallback.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:modelFallback.description')}
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
            </section>
        </SettingsCard>
    );
}
