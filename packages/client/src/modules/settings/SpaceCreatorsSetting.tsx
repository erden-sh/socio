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
    const auto = useAutosave({ spaceCreators: spaceCreatorsInForce(settings) }, (value) =>
        mutate('/settings', 'PATCH', value),
    );
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="space-creators">
                <AutosaveHeader title="Spaces" status={!readOnly ? auto.status : undefined}>
                    Who can create Spaces. Workspace admins always can.
                </AutosaveHeader>
                <PermissionRow
                    title="Members can create Spaces"
                    checked={auto.value.spaceCreators === 'everyone'}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { spaceCreators: on ? 'everyone' : 'admins' },
                            on ? 'Members can create Spaces' : 'Only admins can create Spaces',
                        )
                    }
                >
                    On by default. A member’s Space is private to them and the people they add; only admins make one for
                    the whole workspace.
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </section>
        </SettingsCard>
    );
}
