import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { PermissionRow } from '@/components/form-fields';

/**
 * Invites that open the Socio app (CB-352) in Settings → Workspace →
 * General: whether invites and "Send me a link for the app" go through the
 * link domain, over the server's `AUTH_APP_INVITE_LINKS`. Members read it;
 * only admins change it.
 */
export function AppInviteLinksSetting({
    enabled,
    readOnly,
    mutate,
}: {
    enabled: boolean | undefined;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const auto = useAutosave({ appInviteLinks: enabled ?? false }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="app-invite-links">
                <AutosaveHeader title="The Socio app" status={!readOnly ? auto.status : undefined}>
                    Invites can open the Socio app on people’s phones, where they set their password and start, or the
                    web when they don’t have the app.
                </AutosaveHeader>
                <PermissionRow
                    title="Invites open the Socio app"
                    checked={auto.value.appInviteLinks}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { appInviteLinks: on },
                            `Invites that open the app turned ${on ? 'on' : 'off'}`,
                        )
                    }
                >
                    Off by default. Invite links and “Send me a link for the app” go through Socio’s link page, which
                    shows this workspace’s address before it opens anything. Only where the app can reach this workspace
                    (https, on its usual port); elsewhere invites stay as they are.
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </section>
        </SettingsCard>
    );
}
