import { useTranslation } from '@socio/i18n/react';

import { onDemand } from '../../i18n/on-demand';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * Invites that open the Socio app (CB-352) in Settings → Workspace →
 * General: whether invites and "Send me a link for the app" go through the
 * link domain, over the server's `AUTH_APP_INVITE_LINKS`. Members read it;
 * only admins change it.
 */
function AppInviteLinksSettingBody({
    enabled,
    readOnly,
    mutate,
}: {
    enabled: boolean | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace-apps', 'settings.workspace']);
    const auto = useAutosave({ appInviteLinks: enabled ?? false }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="app-invite-links">
                <AutosaveHeader
                    title={t('settings.workspace-apps:inviteLinks.title')}
                    status={!readOnly ? auto.status : undefined}
                >
                    {t('settings.workspace-apps:inviteLinks.intro')}
                </AutosaveHeader>
                <PermissionRow
                    title={t('settings.workspace-apps:inviteLinks.toggle')}
                    checked={auto.value.appInviteLinks}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { appInviteLinks: on },
                            t('settings.workspace-apps:inviteLinks.saved', { context: on ? undefined : 'off' }),
                        )
                    }
                >
                    {t('settings.workspace-apps:inviteLinks.description')}
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">{t('settings.workspace:readOnly.setting')}</p>}
            </section>
        </SettingsCard>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-apps, in no route's entry). */
export const AppInviteLinksSetting = onDemand(['settings.workspace-apps'], AppInviteLinksSettingBody);
