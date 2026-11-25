import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID, THEME_IDS, resolveAppearance } from '@socio/shared/settings/appearance';

describe('workspace appearance', () => {
    it('registers the seven palettes and uses Erden Glass by default', () => {
        expect(THEME_IDS).toEqual(['socio', 'indigo', 'erden', 'erden-glass', 'cobalt', 'plum', 'clay']);
        expect(DEFAULT_THEME_ID).toBe('erden-glass');
        expect(resolveAppearance({})).toEqual({ themeId: 'erden-glass', colorMode: 'system' });
    });

    it('resolves the personal choice before the workspace default and keeps the color mode independent', () => {
        const workspace = { defaultThemeId: 'erden', colorMode: 'dark' };
        expect(resolveAppearance({ ...workspace, personalThemeId: 'plum' })).toEqual({
            themeId: 'plum',
            colorMode: 'dark',
        });
        expect(resolveAppearance({ ...workspace, personalThemeId: null })).toEqual({
            themeId: 'erden',
            colorMode: 'dark',
        });
    });

    it('skips unsupported stored choices without discarding a supported one', () => {
        expect(resolveAppearance({ personalThemeId: 'retired', defaultThemeId: 'clay', colorMode: 'sepia' })).toEqual({
            themeId: 'clay',
            colorMode: 'system',
        });
        expect(resolveAppearance({ defaultThemeId: 'retired', colorMode: 'light' })).toEqual({
            themeId: 'erden-glass',
            colorMode: 'light',
        });
    });
});
