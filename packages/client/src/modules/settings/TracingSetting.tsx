import { useTranslation } from '@socio/i18n/react';
import type { TraceSettings } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * Turn traces (CB-128) in Settings → Workspace → General: whether they go
 * to an OpenTelemetry collector (the operator's `OTEL_EXPORTER_OTLP_*`),
 * and the switch that lets exported spans carry content (off by default),
 * saved over `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. Members
 * read it; only admins change it.
 */
export function TracingSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: TraceSettings | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave({ includeContent: settings?.includeContent ?? false }, (value) =>
        mutate('/settings', 'PATCH', { tracing: value }),
    );
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="tracing">
                <AutosaveHeader
                    title={t('settings.workspace:tracing.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace:tracing.intro')}{' '}
                    {settings?.exporting
                        ? t('settings.workspace:tracing.exporting')
                        : t('settings.workspace:tracing.notExporting')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace:tracing.toggle')}
                    checked={auto.value.includeContent}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { includeContent: on },
                            t('settings.workspace:tracing.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:tracing.description')}
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
            </section>
        </SettingsCard>
    );
}
