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
        void auto.commit('Automatic triage saved', (value) => {
            const perDay = cap(value.perDay);
            return perDay >= 0 && perDay <= PER_DAY_MAX ? undefined : `Use a whole number from 0 to ${PER_DAY_MAX}.`;
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
                <AutosaveHeader title="Automatic triage" status={!readOnly ? auto.status : undefined}>
                    When a new issue lands in triage, the workspace’s model suggests its kind, area, priority and
                    labels, and posts them as a comment. Nothing changes until an admin applies the suggestion from the
                    issue.
                </AutosaveHeader>
                <PermissionRow
                    title="Propose triage for new issues"
                    checked={auto.value.enabled}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                        void auto.change({ enabled: on }, `Automatic triage turned ${on ? 'on' : 'off'}`)
                    }
                >
                    Off by default. Issues are sent to the model as data, once each; a failed or invalid answer is not
                    retried.
                </PermissionRow>
                <div className="grid gap-1.5">
                    <label htmlFor="auto-triage-per-day" className="font-medium">
                        Most a day
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
                    <p className="text-muted-foreground">
                        Issues asked about in 24 hours, failures included. 0 asks about none.
                    </p>
                </div>
                <SaveError error={auto.error} />
                {readOnly && <p className="text-muted-foreground">Only an admin can change this setting.</p>}
            </form>
        </SettingsCard>
    );
}
