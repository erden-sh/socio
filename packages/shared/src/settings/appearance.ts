export const THEME_IDS = ['socio', 'indigo', 'erden', 'erden-glass', 'cobalt', 'plum', 'clay'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME_ID = 'erden-glass' satisfies ThemeId;

export const THEME_LABELS: Readonly<Record<ThemeId, string>> = {
    socio: 'Socio',
    indigo: 'People desk · Indigo',
    erden: 'Erden',
    'erden-glass': 'Erden Glass',
    cobalt: 'Cobalt & Ice',
    plum: 'Plum & Smoke',
    clay: 'Clay & Graphite',
};

export const COLOR_MODES = ['light', 'dark', 'system'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const isThemeId = (value: unknown): value is ThemeId => THEME_IDS.some((id) => id === value);

export interface ResolvedAppearance {
    themeId: ThemeId;
    colorMode: ColorMode;
}

export function resolveAppearance(input: {
    personalThemeId?: unknown;
    defaultThemeId?: unknown;
    colorMode?: unknown;
}): ResolvedAppearance {
    const workspace = isThemeId(input.defaultThemeId) ? input.defaultThemeId : DEFAULT_THEME_ID;
    return {
        themeId: isThemeId(input.personalThemeId) ? input.personalThemeId : workspace,
        colorMode: COLOR_MODES.find((mode) => mode === input.colorMode) ?? 'system',
    };
}
