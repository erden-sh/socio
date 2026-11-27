import { useTranslation } from '@socio/i18n/react';
import { spaceCreatorsInForce } from '@socio/shared/spaces/create-permission';
import type { Settings } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * The "create Spaces" permission in Settings → Workspace → General: whether
 * members may create Spaces (private ones, CB-181) or only admins may.
 * Admins always may. The server enforces it and tells each person's shell
 * whether to show Create Space. Members read it; only admins change it.
 */
export function SpaceCreatorsSetting({
    settings,
    readOnly,
    mutate,
}: {
    settings: Pick<Settings, 'spaceCreators'>;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace']);
    const auto = useAutosave({ spaceCreators: spaceCreatorsInForce(settings) }, (value) =>
        mutate('/settings', 'PATCH', value),
    );
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="space-creators">
                <AutosaveHeader
                    title={t('settings.workspace:spaces.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace:spaces.intro')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace:spaces.toggle')}
                    checked={auto.value.spaceCreators === 'everyone'}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { spaceCreators: on ? 'everyone' : 'admins' },
                            t('settings.workspace:spaces.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace:spaces.description')}
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
            </section>
        </SettingsCard>
    );
}
