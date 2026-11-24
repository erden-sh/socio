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
    const auto = useAutosave({ modelFallback: enabled ?? true }, (value) => mutate('/settings', 'PATCH', value));
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="model-fallback">
                <AutosaveHeader title="Busy models" status={!readOnly ? auto.status : undefined}>
                    When a model turns a reply away for a moment, the socio waits and tries again within the turn time
                    limit. If it still can’t go on, it ends with what it did and what is left, so the person can ask it
                    to carry on.
                </AutosaveHeader>
                <PermissionRow
                    title="Fall back to the shared model when a person’s own model is busy"
                    checked={auto.value.modelFallback}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change(
                            { modelFallback: on },
                            `Fallback to the shared model turned ${on ? 'on' : 'off'}`,
                        )
                    }
                >
                    On by default. A reply on someone’s own ChatGPT plan finishes on the workspace’s shared model, and
                    says so. Never when they chose their own model for that conversation.
                </PermissionRow>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </section>
        </SettingsCard>
    );
}
