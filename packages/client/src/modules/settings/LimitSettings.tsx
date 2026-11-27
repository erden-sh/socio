import { useTranslation } from '@socio/i18n/react';
import type { EnglishResources } from '@socio/i18n/resources.gen';
import { LIMIT_GROUPS, LIMIT_SPECS, validLimit, type LimitKey, type LimitValues } from '@socio/shared/limits';
import type { State } from '@socio/shared/types';

import { onDemand } from '../../i18n/on-demand';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** A card's id in LIMIT_GROUPS, which names its words in `settings.workspace-limits`. */
type LimitGroupId = keyof EnglishResources['settings.workspace-limits']['groups'];

/**
 * Settings → Workspace → General: the limits an admin tunes without a
 * redeploy (CB-108), a card for each group in `packages/shared/src/limits.ts`. What they
 * save takes the place of the matching variables, which stay the starting
 * values; "Use the server's defaults" goes back to them. Members read them.
 */
function LimitSettingsBody({
    state,
    readOnly,
    mutate,
}: {
    state: State;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { limits, limitDefaults } = state.settings;
    if (!limits || !limitDefaults) {
        return null;
    }
    return (
        <>
            {LIMIT_GROUPS.map((group) => (
                <LimitCard
                    // A saved change from another admin comes in through the props
                    // (useAutosave follows them while nothing here is unsaved).
                    key={group.id}
                    {...group}
                    limits={limits}
                    defaults={limitDefaults}
                    readOnly={readOnly}
                    mutate={mutate}
                />
            ))}
        </>
    );
}

function LimitCard({
    id,
    keys,
    limits,
    defaults,
    readOnly,
    mutate,
}: (typeof LIMIT_GROUPS)[number] & {
    limits: Partial<LimitValues>;
    defaults: LimitValues;
    readOnly: boolean;
    mutate: (path: string, method: string, body?: unknown) => Promise<boolean>;
}) {
    const { t } = useTranslation(['settings.workspace-limits', 'settings.workspace']);
    const title = t(`settings.workspace-limits:groups.${id as LimitGroupId}.title`);
    const auto = useAutosave(
        Object.fromEntries(keys.map((key) => [key, String(limits[key] ?? defaults[key])])) as Record<string, string>,
        (values) => mutate('/settings', 'PATCH', { limits: change(values) }),
    );
    // Each field as the server takes it: null for one at the server's value.
    // A field left there is not checked: the environment may hold one outside
    // the range an admin can enter.
    function change(values: Record<string, string>) {
        const result: Partial<Record<LimitKey, number | null>> = {};
        for (const key of keys) {
            const text = values[key].trim();
            const value = text === '' ? NaN : Number(text);
            result[key] = value === defaults[key] ? null : value;
        }
        return result;
    }
    const commit = () =>
        void auto.commit(t('settings.workspace-limits:saved', { title }), (values) => {
            for (const [key, value] of Object.entries(change(values)) as [LimitKey, number | null][]) {
                if (value === null || validLimit(key, value)) {
                    continue;
                }
                const { min, max } = LIMIT_SPECS[key];
                // `units`, not `unit`: the number formatter would take `unit` as its Intl option.
                return t('settings.workspace-limits:invalid', {
                    label: t(`settings.workspace-limits:limits.${key}.label`),
                    min,
                    max,
                    units: t(`settings.workspace-limits:limits.${key}.unit`),
                });
            }
        });
    const usingDefaults = keys.every((key) => (limits[key] ?? defaults[key]) === defaults[key]);
    return (
        <SettingsCard>
            <form
                className="grid gap-4"
                // The fields are checked below; the browser's own check would also
                // refuse a server value that is outside the range an admin may enter.
                noValidate
                data-slot={`limits-${id}`}
                // Enter saves too, like leaving a field.
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <AutosaveHeader title={title} status={!readOnly ? auto.status : undefined}>
                    {t(`settings.workspace-limits:groups.${id as LimitGroupId}.intro`)}
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {keys.map((key) => {
                        const spec = LIMIT_SPECS[key];
                        return (
                            <div key={key} className="grid content-start gap-1.5">
                                <label htmlFor={`limit-${key}`} className="font-medium">
                                    {t(`settings.workspace-limits:limits.${key}.label`)}
                                </label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        id={`limit-${key}`}
                                        type="number"
                                        inputMode={spec.cents ? 'decimal' : 'numeric'}
                                        min={spec.min}
                                        max={spec.max}
                                        step={spec.cents ? 0.01 : 1}
                                        className="w-32"
                                        disabled={readOnly}
                                        value={auto.value[key]}
                                        onChange={(event) => auto.edit({ [key]: event.target.value })}
                                        onBlur={commit}
                                    />
                                    <span className="text-muted-foreground">
                                        {t(`settings.workspace-limits:limits.${key}.unit`)}
                                    </span>
                                </div>
                                <p className="text-muted-foreground">
                                    {t(`settings.workspace-limits:limits.${key}.help`)}{' '}
                                    {t('settings.workspace-limits:startsAt', { value: defaults[key] })}
                                </p>
                            </div>
                        );
                    })}
                </div>
                <SaveError error={auto.error} />
                {readOnly ? (
                    <p className="text-muted-foreground">{t('settings.workspace:readOnly.limits')}</p>
                ) : (
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={auto.status === 'saving' || usingDefaults}
                            onClick={() =>
                                void auto.change(
                                    Object.fromEntries(keys.map((key) => [key, String(defaults[key])])),
                                    t('settings.workspace-limits:reset', { title }),
                                )
                            }
                        >
                            {t('settings.workspace-limits:useDefaults')}
                        </Button>
                    </div>
                )}
            </form>
        </SettingsCard>
    );
}

/** Below the fold: its words load when it mounts (settings.workspace-limits, in no route's entry). */
export const LimitSettings = onDemand(['settings.workspace-limits'], LimitSettingsBody);
