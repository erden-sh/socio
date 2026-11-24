import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composite, contrast, parseColor, toHex } from '../../scripts/theme/color.mts';
import { theme } from '../../src/theme/theme';
import { buttonLook, type ButtonVariant } from '../../src/ui/button-look';

// Buttons in each platform's own style: iOS 26's capsules and
// Material 3's common buttons, the brand's teal as the tint.

const button = readFileSync(join(import.meta.dirname, '../../src/ui/button.tsx'), 'utf8');
const VARIANTS: ButtonVariant[] = ['primary', 'tinted', 'secondary', 'ghost', 'destructive'];

describe('buttons', () => {
    it('are capsules on iOS: filled for the main action, tinted, gray and plain in the tint for the others', () => {
        expect(buttonLook('primary', 'ios')).toMatchObject({ fill: 'primary', words: 'primary-foreground' });
        expect(buttonLook('tinted', 'ios')).toMatchObject({ fill: null, words: 'primary' });
        expect(buttonLook('secondary', 'ios')).toMatchObject({ fill: 'gray', words: 'primary' });
        expect(buttonLook('ghost', 'ios')).toMatchObject({ fill: null, words: 'primary' });
        expect(buttonLook('destructive', 'ios')).toMatchObject({ words: 'white' });
        expect(button).toContain("look.fill === 'gray'\n              ? PlatformColor('tertiarySystemFill')");
        expect(button).toContain("tinted: { box: 'bg-primary/10', padding: 'px-5 py-2' },");
        // UIKit dims a button as it is pressed.
        for (const variant of VARIANTS) {
            expect(buttonLook(variant, 'ios').pressedOpacity, variant).toBeLessThan(1);
        }
        expect(button).toContain('ios && pressed ? { opacity: look.pressedOpacity } : null');
    });

    it('are Material 3’s on Android: filled, tonal, outlined and text, with the ripple', () => {
        expect(buttonLook('primary', 'android')).toMatchObject({ fill: 'primary', words: 'primary-foreground' });
        expect(button).toContain("tinted: { box: 'bg-primary/10', padding: 'px-6 py-2' },");
        expect(button).toContain("secondary: { box: 'border border-border', padding: 'px-6 py-2' },");
        expect(buttonLook('ghost', 'android')).toMatchObject({ fill: null, words: 'primary' });
        expect(button).toContain('android_ripple={ios ? undefined : { borderless: false, foreground: true }}');
    });

    it('are fully rounded and a 44 pt target on both', () => {
        expect(button).toContain("'min-h-11 flex-row items-center justify-center gap-2 overflow-hidden rounded-full'");
        expect(button).toContain("iconOnly ? 'min-w-11' : paint.padding");
    });

    it('read on their fills: the tint on its own tint, the words on the teal, in both schemes', () => {
        for (const scheme of ['light', 'dark'] as const) {
            const { colors } = theme[scheme];
            const tintedFill = toHex(composite(parseColor(colors.primary), 0.1, parseColor(colors.screen)));
            expect(contrast(colors.primary, tintedFill), `${scheme} tinted`).toBeGreaterThanOrEqual(4.5);
            expect(contrast(colors['primary-foreground'], colors.primary), `${scheme} filled`).toBeGreaterThanOrEqual(
                4.5,
            );
            expect(contrast(colors.primary, colors.screen), `${scheme} plain`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('draw the symbol at the words’ weight and color', () => {
        expect(button).toContain('<AppSymbol name={icon} weight="semibold" color={{ value: words }} />');
        expect(button).toContain('<Text variant="button" className="shrink text-center" style={{ color: words }}>');
    });
});
