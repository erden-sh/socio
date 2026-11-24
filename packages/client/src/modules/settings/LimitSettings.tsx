import { LIMIT_GROUPS, LIMIT_SPECS, validLimit, type LimitKey, type LimitValues } from '@socio/shared/limits';
import type { State } from '@socio/shared/types';

import { SettingsCard } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Settings → Workspace → General: the limits an admin tunes without a
 * redeploy (CB-108), a card for each group in `packages/shared/src/limits.ts`. What they
 * save takes the place of the matching variables, which stay the starting
 * values; "Use the server's defaults" goes back to them. Members read them.
 */
export function LimitSettings({
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
    title,
    intro,
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
        void auto.commit(`${title} saved`, (values) => {
            for (const [key, value] of Object.entries(change(values)) as [LimitKey, number | null][]) {
                if (value === null || validLimit(key, value)) {
                    continue;
                }
                const { label, min, max, unit } = LIMIT_SPECS[key];
                return `${label}: use a number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')} ${unit}.`;
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
                    {intro}
                </AutosaveHeader>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {keys.map((key) => {
                        const spec = LIMIT_SPECS[key];
                        return (
                            <div key={key} className="grid content-start gap-1.5">
                                <label htmlFor={`limit-${key}`} className="font-medium">
                                    {spec.label}
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
                                    <span className="text-muted-foreground">{spec.unit}</span>
                                </div>
                                <p className="text-muted-foreground">
                                    {spec.help} The server starts at {defaults[key].toLocaleString('en-US')}.
                                </p>
                            </div>
                        );
                    })}
                </div>
                <SaveError error={auto.error} />
                {readOnly ? (
                    <p className="text-muted-foreground">Only an admin can change these limits.</p>
                ) : (
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={auto.status === 'saving' || usingDefaults}
                            onClick={() =>
                                void auto.change(
                                    Object.fromEntries(keys.map((key) => [key, String(defaults[key])])),
                                    `${title} back to the server’s defaults`,
                                )
                            }
                        >
                            Use the server’s defaults
                        </Button>
                    </div>
                )}
            </form>
        </SettingsCard>
    );
}
