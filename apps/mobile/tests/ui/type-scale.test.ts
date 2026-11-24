import { describe, expect, it } from 'vitest';

import {
    ANDROID_TEXT_STYLES,
    BAR_TITLE_MAX_SCALE,
    fontWeight,
    IOS_TEXT_STYLES,
    MATERIAL_TYPE_SCALE,
    MAX_SCALE,
    rowMinHeight,
    stacksAccessory,
    TEXT_FLOOR,
    TEXT_STYLE_NAMES,
    textLook,
    textMetrics,
    textStyle,
} from '../../src/ui/type-scale';

// Each platform's own type scale with Dynamic Type (src/ui/type-scale.ts):
// iOS's text styles at the default size, Material 3's
// roles on Android, scaled by the system's font scale except where the scaled
// size would fall under the 12 pt floor.

/** iOS's smallest Dynamic Type size and Android's smallest font size, the default, and large text up to AX5. */
const SCALES = [0.82, 0.85, 1, 1.15, 1.5, 2, 3.12];
const PLATFORMS = ['ios', 'android'] as const;

describe('iOS’s text styles', () => {
    it('are Apple’s sizes, line heights and weights at the default text size', () => {
        const sizes = Object.fromEntries(
            TEXT_STYLE_NAMES.map((name) => [name, [IOS_TEXT_STYLES[name].fontSize, IOS_TEXT_STYLES[name].lineHeight]]),
        );
        expect(sizes).toEqual({
            largeTitle: [34, 41],
            title1: [28, 34],
            title2: [22, 28],
            title3: [20, 25],
            headline: [17, 22],
            body: [17, 22],
            callout: [16, 21],
            subheadline: [15, 20],
            footnote: [13, 18],
            caption1: [12, 16],
            caption2: [11, 13],
        });
        expect(IOS_TEXT_STYLES.headline.weight).toBe('semibold');
        for (const name of TEXT_STYLE_NAMES.filter((style) => style !== 'headline')) {
            expect(IOS_TEXT_STYLES[name].weight, name).toBe('normal');
        }
        expect(IOS_TEXT_STYLES.body.tracking).toBe(-0.41);
        expect(IOS_TEXT_STYLES.largeTitle.tracking).toBe(0.37);
    });

    it('track as the system tracks SF Pro, with no letterSpacing of the app’s on top', () => {
        for (const name of TEXT_STYLE_NAMES) {
            expect(textLook(name, 'ios', 1).letterSpacing, name).toBeUndefined();
        }
    });

    it('stop the titles growing where UIKit does at AX5, and let the rest grow as the body', () => {
        expect(MAX_SCALE).toEqual({ largeTitle: 1.76, title1: 2.07, title2: 2.55, title3: 2.75 });
        expect(textLook('title', 'ios', 3.12).maxFontSizeMultiplier).toBe(1.76);
        expect(textLook('body', 'ios', 3.12).maxFontSizeMultiplier).toBeUndefined();
        expect(textLook('title', 'android', 2).maxFontSizeMultiplier).toBeUndefined();
    });
});

describe('Material’s type scale on Android', () => {
    it('takes each text style’s place on Material 3’s scale', () => {
        expect(ANDROID_TEXT_STYLES).toMatchObject({
            largeTitle: 'headlineMedium',
            headline: 'titleMedium',
            body: 'bodyLarge',
            subheadline: 'bodyMedium',
            footnote: 'bodySmall',
        });
        expect(MATERIAL_TYPE_SCALE.bodyLarge).toEqual({
            fontSize: 16,
            lineHeight: 24,
            weight: 'normal',
            tracking: 0.5,
        });
        expect(MATERIAL_TYPE_SCALE.titleMedium).toEqual({
            fontSize: 16,
            lineHeight: 24,
            weight: 'medium',
            tracking: 0.15,
        });
        expect(textStyle('body', 'android')).toBe(MATERIAL_TYPE_SCALE.bodyLarge);
        expect(textStyle('body', 'ios')).toBe(IOS_TEXT_STYLES.body);
    });

    it('sets Material’s tracking, in points', () => {
        expect(textLook('body', 'android', 1).letterSpacing).toBe(0.5);
        expect(textLook('headline', 'android', 1)).toMatchObject({
            fontSize: 16,
            weight: 'medium',
            letterSpacing: 0.15,
        });
    });
});

describe('Dynamic Type', () => {
    it('leaves every style its own size at the default text size and above', () => {
        for (const os of PLATFORMS) {
            for (const name of TEXT_STYLE_NAMES) {
                const own = textStyle(name, os);
                const atLeast12 = own.fontSize >= TEXT_FLOOR;
                for (const scale of [1, 1.5, 2, 3.12]) {
                    if (atLeast12) {
                        expect(textMetrics(name, scale, os), `${os} ${name} ${scale}`).toEqual({
                            fontSize: own.fontSize,
                            lineHeight: own.lineHeight,
                        });
                    }
                }
            }
        }
    });

    it('never draws text under 12 pt, whatever the system’s text size', () => {
        for (const os of PLATFORMS) {
            for (const scale of SCALES) {
                for (const name of TEXT_STYLE_NAMES) {
                    const { fontSize, lineHeight } = textMetrics(name, scale, os);
                    expect(fontSize * scale, `${os} ${name} at ${scale}`).toBeGreaterThanOrEqual(TEXT_FLOOR - 0.01);
                    // The line keeps its proportion to its text.
                    const own = textStyle(name, os);
                    expect(lineHeight / fontSize).toBeCloseTo(own.lineHeight / own.fontSize, 2);
                }
            }
        }
    });

    it('lifts only what would fall under the floor', () => {
        expect(TEXT_FLOOR).toBe(12);
        expect(textMetrics('footnote', 0.85, 'ios')).toEqual({ fontSize: 14.12, lineHeight: 19.55 });
        expect(textMetrics('body', 0.85, 'ios')).toEqual({ fontSize: 17, lineHeight: 22 });
        // Caption 2 is under the floor at every size below AX: it lands on 12.
        expect(textMetrics('caption2', 1, 'ios')).toEqual({ fontSize: 12, lineHeight: 14.18 });
    });

    it('takes a font scale the system doesn’t report as the default', () => {
        for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(textMetrics('footnote', scale, 'ios')).toEqual({ fontSize: 13, lineHeight: 18 });
        }
    });

    it('gives the weights as React Native takes them', () => {
        expect(fontWeight('normal')).toBe('400');
        expect(fontWeight('medium')).toBe('500');
        expect(fontWeight('semibold')).toBe('600');
        expect(fontWeight('bold')).toBe('700');
    });
});

describe('a bar’s own title', () => {
    it('stops growing at xxxL, iOS’s largest size before the accessibility ones', () => {
        expect(BAR_TITLE_MAX_SCALE).toBe(1.35);
    });
});

describe('a row at the accessibility sizes', () => {
    it('lays its trailing accessory under its text from a font scale of 1.5, as UIKit’s cells do', () => {
        expect(stacksAccessory(1)).toBe(false);
        expect(stacksAccessory(1.35)).toBe(false);
        expect(stacksAccessory(1.5)).toBe(true);
        expect(stacksAccessory(3.12)).toBe(true);
        expect(stacksAccessory(Number.NaN)).toBe(false);
    });
});

describe('a row’s height', () => {
    it('is only ever a minimum, so the row grows with its text at every text size (CB-373)', () => {
        expect(rowMinHeight(56)).toEqual({ minHeight: 56 });
        expect(Object.keys(rowMinHeight(68))).toEqual(['minHeight']);
    });

    it('can’t be fixed: a page’s row holds more than its leading tile and padding at the default text size', () => {
        // ListRow's page row: 12 pt padding, a row-title line, a 2 pt gap, two
        // lines of excerpt, a 2 pt gap, the meta line, 12 pt padding. The 68 pt
        // it was once fixed at (a 44 pt tile and its padding) cut the meta.
        for (const os of PLATFORMS) {
            const line = (variant: Parameters<typeof textLook>[0]) => textLook(variant, os, 1).lineHeight;
            const content = 12 + line('row-title') + 2 + 2 * line('row-subtitle') + 2 + line('meta') + 12;
            expect(content, os).toBeGreaterThan(44 + 24);
        }
    });
});
