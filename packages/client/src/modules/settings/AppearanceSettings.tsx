import { useId } from 'react';

import {
    DEFAULT_THEME_ID,
    THEME_IDS,
    THEME_LABELS,
    isThemeId,
    resolveAppearance,
    type ColorMode,
    type ThemeId,
} from '@socio/shared/settings/appearance';

import type { Shell } from '../../shell/shell-context';
import { useThemeChoices } from '../../shell/theme';

import { SettingsCard, nativeSelect } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

const paletteOptions = THEME_IDS.map((value) => ({ value, label: THEME_LABELS[value] }));

function Choice<T extends string>({
    label,
    selected,
    options,
    persist,
}: {
    label: string;
    selected: T;
    options: readonly { value: T; label: string }[];
    persist: (choice: T) => Promise<boolean>;
}) {
    const id = useId();
    const auto = useAutosave({ choice: selected }, ({ choice }) => persist(choice));
    return (
        <div className="grid gap-1.5">
            <label className="font-medium" htmlFor={id}>
                {label}
            </label>
            <select
                id={id}
                className={nativeSelect}
                value={auto.value.choice}
                aria-busy={auto.status === 'saving'}
                onChange={(event) => {
                    const option = options.find(({ value }) => value === event.currentTarget.value);
                    if (option) {
                        void auto.change({ choice: option.value }, undefined, false);
                    }
                }}
            >
                {options.map(({ value, label: optionLabel }) => (
                    <option key={value} value={value}>
                        {optionLabel}
                    </option>
                ))}
            </select>
            <SaveError error={auto.error} />
        </div>
    );
}

export function PersonalAppearance({
    defaultThemeId,
    themeId,
    colorMode,
    mutate,
}: {
    defaultThemeId?: ThemeId | null;
    themeId?: ThemeId | null;
    colorMode?: ColorMode;
    mutate: Shell['mutate'];
}) {
    const inherited = resolveAppearance({ defaultThemeId }).themeId;
    const modes = resolveAppearance({ colorMode }).colorMode;
    const themeChoices = useThemeChoices();
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="personal-appearance">
                <AutosaveHeader title="Appearance" status="idle">
                    Your preferences follow you across browsers.
                </AutosaveHeader>
                <Choice<ThemeId | ''>
                    label="Theme"
                    selected={isThemeId(themeId) ? themeId : ''}
                    options={[
                        { value: '', label: `Use workspace theme (${THEME_LABELS[inherited]})` },
                        ...paletteOptions,
                    ]}
                    persist={(value) => mutate('/preferences', 'PATCH', { themeId: value || null })}
                />
                <Choice
                    label="Color mode"
                    selected={modes}
                    options={themeChoices}
                    persist={(value) => mutate('/preferences', 'PATCH', { colorMode: value })}
                />
            </section>
        </SettingsCard>
    );
}

export function WorkspaceAppearance({
    defaultThemeId,
    mutate,
}: {
    defaultThemeId?: ThemeId | null;
    mutate: Shell['mutate'];
}) {
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="workspace-appearance">
                <AutosaveHeader title="Workspace appearance" status="idle">
                    Applies to people who use the workspace theme.
                </AutosaveHeader>
                <Choice<ThemeId | ''>
                    label="Default theme"
                    selected={isThemeId(defaultThemeId) ? defaultThemeId : ''}
                    options={[
                        { value: '', label: `Use Socio default (${THEME_LABELS[DEFAULT_THEME_ID]})` },
                        ...paletteOptions,
                    ]}
                    persist={(value) => mutate('/settings', 'PATCH', { defaultThemeId: value || null })}
                />
            </section>
        </SettingsCard>
    );
}
