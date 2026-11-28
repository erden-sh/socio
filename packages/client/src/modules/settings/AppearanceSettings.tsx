import { useId } from 'react';

import { useTranslation } from '@socio/i18n/react';
import {
    COLOR_MODES,
    DEFAULT_THEME_ID,
    THEME_IDS,
    isThemeId,
    resolveAppearance,
    type ColorMode,
    type ThemeId,
} from '@socio/shared/settings/appearance';

import type { Shell } from '../../shell/shell-context';

import { SettingsCard, nativeSelect } from './AccountSettings';
import { AutosaveHeader, SaveError, useAutosave } from './autosave';

function useAppearanceLabels() {
    const { t } = useTranslation(['settings.appearance']);
    const themeLabel = (id: ThemeId) => t(`settings.appearance:themes.${id}`);
    return { t, themeLabel, paletteOptions: THEME_IDS.map((value) => ({ value, label: themeLabel(value) })) };
}

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
                data-slot="native-select"
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
    const { t, themeLabel, paletteOptions } = useAppearanceLabels();
    const inherited = resolveAppearance({ defaultThemeId }).themeId;
    const modes = resolveAppearance({ colorMode }).colorMode;
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="personal-appearance">
                <AutosaveHeader title={t('settings.appearance:personal.title')} status="idle">
                    {t('settings.appearance:personal.description')}
                </AutosaveHeader>
                <Choice<ThemeId | ''>
                    label={t('settings.appearance:personal.theme')}
                    selected={isThemeId(themeId) ? themeId : ''}
                    options={[
                        {
                            value: '',
                            label: t('settings.appearance:personal.inherit', { theme: themeLabel(inherited) }),
                        },
                        ...paletteOptions,
                    ]}
                    persist={(value) => mutate('/preferences', 'PATCH', { themeId: value || null })}
                />
                <Choice
                    label={t('settings.appearance:personal.colorMode')}
                    selected={modes}
                    options={COLOR_MODES.map((value) => ({ value, label: t(`settings.appearance:modes.${value}`) }))}
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
    const { t, themeLabel, paletteOptions } = useAppearanceLabels();
    return (
        <SettingsCard>
            <section className="grid gap-4" data-slot="workspace-appearance">
                <AutosaveHeader title={t('settings.appearance:workspace.title')} status="idle">
                    {t('settings.appearance:workspace.description')}
                </AutosaveHeader>
                <Choice<ThemeId | ''>
                    label={t('settings.appearance:workspace.defaultTheme')}
                    selected={isThemeId(defaultThemeId) ? defaultThemeId : ''}
                    options={[
                        {
                            value: '',
                            label: t('settings.appearance:workspace.inherit', { theme: themeLabel(DEFAULT_THEME_ID) }),
                        },
                        ...paletteOptions,
                    ]}
                    persist={(value) => mutate('/settings', 'PATCH', { defaultThemeId: value || null })}
                />
            </section>
        </SettingsCard>
    );
}
