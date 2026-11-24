import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INCREASED_CONTRAST } from '../../scripts/generate-theme.mts';
import { contrast } from '../../scripts/theme/color.mts';
import {
    accentColors,
    IOS_SYSTEM_COLORS,
    isContrastAccent,
    isSystemNeutral,
    SYSTEM_OPACITY_CLASSES,
    systemVariableNames,
    toneColors,
} from '../../src/theme/system-colors';
import { theme, type ToneName } from '../../src/theme/theme';
import { classNamesIn } from '../helpers/class-names';

// iOS's system neutrals and Increase Contrast (src/theme/system-colors.ts,
// applied by native-colors.ts).

const src = join(import.meta.dirname, '../../src');
const read = (file: string) => readFileSync(join(src, file), 'utf8');
const sources = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((file) => /\.tsx?$/.test(file));

describe('the system’s neutrals on iOS', () => {
    it('map the page, its words, the muted lines and the hairlines to UIKit’s semantic colors', () => {
        expect(IOS_SYSTEM_COLORS.screen).toBe('systemBackground');
        expect(IOS_SYSTEM_COLORS.foreground).toBe('label');
        expect(IOS_SYSTEM_COLORS['muted-foreground']).toBe('secondaryLabel');
        expect(IOS_SYSTEM_COLORS.border).toBe('separator');
        for (const token of Object.keys(IOS_SYSTEM_COLORS)) {
            expect(Object.keys(theme.light.colors), token).toContain(token);
        }
        expect(systemVariableNames()['--color-screen']).toBe('systemBackground');
    });

    it('never take the brand, a tone or a status: color stays the web’s', () => {
        for (const token of ['primary', 'brand', 'destructive', 'chat-link', 'user-bubble', 'ring', 'card', 'muted']) {
            expect(isSystemNeutral(token), token).toBe(false);
        }
    });

    it('take an opacity class only where the system color is translucent itself', () => {
        // uniwind mixes an opacity only from a hex: a system color is drawn whole.
        const neutral = new RegExp(
            `^(?:[a-z-]+:)*(?:bg|text|border)-(${Object.keys(IOS_SYSTEM_COLORS).join('|')})/\\d+$`,
        );
        const found = sources
            .flatMap((file) => classNamesIn(read(file), `src/${file}`))
            .map((use) => use.name)
            .filter((name) => neutral.test(name));
        expect([...new Set(found)].sort()).toEqual([...SYSTEM_OPACITY_CLASSES].sort());
    });

    it('are applied on iOS before anything draws, through uniwind’s variables', () => {
        const native = read('theme/native-colors.ts');
        expect(native).toMatch(/if \(!ios\) \{\s+return;\s+\}/);
        expect(native).toContain('Uniwind.updateCSSVariables(scheme, variables');
        const app = read('app.tsx');
        expect(app.indexOf('applySystemColors();')).toBeGreaterThan(-1);
        expect(app.indexOf('applySystemColors();')).toBeLessThan(app.indexOf('startLaunch();'));
    });
});

describe('Increase Contrast', () => {
    const tones = Object.keys(theme.light.tones) as ToneName[];

    it('gives the accents and every tone a variant at 7:1 on the page and a card, the same hue', () => {
        expect(INCREASED_CONTRAST).toBe(7);
        for (const scheme of ['light', 'dark'] as const) {
            const { colors } = theme[scheme];
            for (const token of ['primary', 'destructive', 'chat-link', 'brand'] as const) {
                expect(isContrastAccent(token)).toBe(true);
                const strong = accentColors(token, scheme).highContrastLight;
                expect(contrast(strong, colors.screen), `${scheme} ${token}`).toBeGreaterThanOrEqual(7);
                expect(contrast(strong, colors.card), `${scheme} ${token}`).toBeGreaterThanOrEqual(7);
                // Never weaker than the color it stands in for.
                expect(contrast(strong, colors.screen)).toBeGreaterThanOrEqual(contrast(colors[token], colors.screen));
            }
            for (const tone of tones) {
                const { light, highContrastLight } = toneColors(tone, scheme);
                expect(light).toBe(theme[scheme].tones[tone].foreground);
                expect(
                    contrast(highContrastLight, theme[scheme].tones[tone].tiles.screen),
                    `${scheme} ${tone}`,
                ).toBeGreaterThanOrEqual(7);
            }
        }
    });

    it('keeps each color as it is without Increase Contrast', () => {
        expect(accentColors('primary', 'light').light).toBe(theme.light.colors.primary);
        expect(accentColors('primary', 'dark').dark).toBe(theme.dark.colors.primary);
    });

    it('reaches the tiles, the text tones, the buttons and the symbols', () => {
        expect(read('ui/tone-tile.tsx')).toContain('const foreground = useToneColor(tone);');
        expect(read('ui/text.tsx')).toContain(
            "const strong = Platform.OS === 'ios' && (shown === 'primary' || shown === 'destructive');",
        );
        expect(read('ui/button.tsx')).toContain("const primary = useColorValue('primary');");
        expect(read('ui/symbol-parts.tsx')).toContain('const value = useColorValue(token);');
    });
});
