import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OUTPUT_DIR, SCHEMES, SELECTED_ROW_CONTRAST, type Theme } from '../../scripts/generate-theme.mts';
import { composite, contrast, parseColor, toHex } from '../../scripts/theme/color.mts';

// The generated theme meets WCAG AA where the app puts words and marks on it,
// in light and dark. Ported from the web's packages/client/tests/theme-contrast.test.ts
// (white, or dark ink in dark, on the primary fill at rest, hovered and
// disabled; quieter words on the surfaces they sit on; the bubbles' words and
// the chat's links; the keyboard ring), with T3 Code's check that a selected
// row stays visible, and every tone on every surface it sits on.
// It reads theme.json, what the
// app ships; generate.test.ts holds that to the web's tokens.

const theme: Theme = JSON.parse(readFileSync(join(OUTPUT_DIR, 'theme.json'), 'utf8'));

/** Words, and the large type and marks WCAG lets off lighter. */
const WORDS = 4.5;
const MARKS = 3;

const TONE_WORDS =
    'The web’s tone tiles (tones.ts: Tailwind’s 700 on a 12% tint of its 500, picked against the page) carry words only in the issue priority pill, on rows on the page and on cards, where every tone passes. On the sidebar’s grey, and more so on a selected row in it, some fall under 4.5:1. There the app’s tiles hold icons, which pass 3:1; the app keeps the tones as they are, so this is the floor until the web changes them.';

/**
 * Pairs under their bar today, each at the ratio it measures now (rounded
 * down), so it can only get better. The mobile roles depart from the web only
 * for the selected row, so these stay as the web has them.
 * An entry fails once its pair clears the bar: delete it then.
 */
const EXCEPTIONS: Readonly<Record<string, { ratio: number; reason: string }>> = {
    'light: paused-banner-foreground on paused-banner': {
        ratio: 3.04,
        reason: 'The web’s paused line (AppShell.tsx), kept as it was when it moved into tokens.',
    },
    'light: the mint tone’s words on its tile over sidebar': { ratio: 4.28, reason: TONE_WORDS },
    'light: the amber tone’s words on its tile over sidebar': { ratio: 4.38, reason: TONE_WORDS },
    'light: the orange tone’s words on its tile over sidebar': { ratio: 4.38, reason: TONE_WORDS },
    'light: the mint tone’s words on its tile over row-selected': { ratio: 3.6, reason: TONE_WORDS },
    'light: the sky tone’s words on its tile over row-selected': { ratio: 4.17, reason: TONE_WORDS },
    'light: the amber tone’s words on its tile over row-selected': { ratio: 3.68, reason: TONE_WORDS },
    'light: the emerald tone’s words on its tile over row-selected': { ratio: 3.83, reason: TONE_WORDS },
    'light: the orange tone’s words on its tile over row-selected': { ratio: 3.67, reason: TONE_WORDS },
    'light: the rose tone’s words on its tile over row-selected': { ratio: 4.01, reason: TONE_WORDS },
};

interface Pair {
    label: string;
    front: string;
    back: string;
    bar: number;
}

const pairs: Pair[] = [];
const add = (label: string, front: string | undefined, back: string | undefined, bar: number) => {
    expect(front, label).toBeDefined();
    expect(back, label).toBeDefined();
    pairs.push({ label, front: front!, back: back!, bar });
};

for (const scheme of SCHEMES) {
    const { colors, tones } = theme[scheme];
    const token = (front: string, back: string, bar: number) =>
        add(`${scheme}: ${front} on ${back}`, colors[front], colors[back], bar);

    // White (light) or the dark ink (dark) on the primary fill, in every state.
    for (const fill of ['primary', 'primary-hover', 'primary-disabled']) {
        token('primary-foreground', fill, WORDS);
    }
    token('sidebar-primary-foreground', 'sidebar-primary', WORDS);

    // Quieter words on the surfaces they sit on: the web's, then the app's.
    for (const surface of ['background', 'card', 'popover', 'muted', 'accent', 'screen', 'sheet', 'header']) {
        token('muted-foreground', surface, WORDS);
    }
    for (const surface of ['sidebar', 'sidebar-accent', 'tab-bar']) {
        token('sidebar-muted-foreground', surface, WORDS);
    }
    token('tab-bar-muted-foreground', 'tab-bar', WORDS);

    // Words on each of the app's roles.
    token('screen-foreground', 'screen', WORDS);
    token('sheet-foreground', 'sheet', WORDS);
    token('header-foreground', 'header', WORDS);
    token('tab-bar-foreground', 'tab-bar', WORDS);
    token('user-bubble-foreground', 'user-bubble', WORDS);
    token('user-bubble-pending-foreground', 'user-bubble-pending', WORDS);
    for (const surface of ['user-bubble-pending', 'background', 'muted', 'screen']) {
        token('chat-link', surface, WORDS);
    }
    token('paused-banner-foreground', 'paused-banner', WORDS);

    // The banners (src/ui/banner.tsx), each over the screen and a sheet: info's
    // words and muted icon on muted/60, error's destructive words on
    // destructive/10, and warning's words in the foreground, with the paused
    // line's color only for its icon, a mark.
    const tint = (color: string, alpha: number, surface: string) =>
        toHex(composite(parseColor(colors[color]!), alpha, parseColor(colors[surface]!)));
    for (const surface of ['screen', 'sheet']) {
        add(`${scheme}: an info banner’s words over ${surface}`, colors.foreground, tint('muted', 0.6, surface), WORDS);
        add(
            `${scheme}: an info banner’s icon over ${surface}`,
            colors['muted-foreground'],
            tint('muted', 0.6, surface),
            MARKS,
        );
        add(
            `${scheme}: an error banner’s words over ${surface}`,
            colors.destructive,
            tint('destructive', 0.1, surface),
            WORDS,
        );
    }
    add(`${scheme}: a warning banner’s words`, colors.foreground, colors['paused-banner'], WORDS);
    add(`${scheme}: a warning banner’s icon`, colors['paused-banner-foreground'], colors['paused-banner'], MARKS);

    // The keyboard ring against a menu and its item.
    for (const surface of ['popover', 'accent']) {
        token('ring', surface, MARKS);
    }

    // A selected row stays visible where it sits (the drawer, the tab bar, a
    // list on the screen), and its words stay readable on it.
    for (const surface of ['sidebar', 'tab-bar', 'screen']) {
        token('row-selected', surface, SELECTED_ROW_CONTRAST);
    }
    token('tab-bar-active', 'tab-bar', SELECTED_ROW_CONTRAST);
    token('row-selected-foreground', 'row-selected', WORDS);
    token('row-selected-muted-foreground', 'row-selected', WORDS);
    token('tab-bar-active-foreground', 'tab-bar-active', WORDS);

    // Every tone on every surface: its icon, and words in it.
    for (const [tone, { foreground, tiles }] of Object.entries(tones)) {
        for (const [surface, tile] of Object.entries(tiles)) {
            add(`${scheme}: the ${tone} tone’s icon on its tile over ${surface}`, foreground, tile, MARKS);
            add(`${scheme}: the ${tone} tone’s words on its tile over ${surface}`, foreground, tile, WORDS);
        }
    }
}

describe('the generated theme’s contrast', () => {
    it.each(pairs)('$label: $bar:1', ({ label, front, back, bar }) => {
        const ratio = contrast(front, back);
        const exception = EXCEPTIONS[label];
        if (exception === undefined) {
            expect(ratio, label).toBeGreaterThanOrEqual(bar);
            return;
        }
        expect(ratio, `${label}: no worse than ${exception.ratio}:1`).toBeGreaterThanOrEqual(exception.ratio);
        expect(ratio, `${label} clears ${bar}:1 now: delete its exception`).toBeLessThan(bar);
    });

    it('names a real pair in every exception, each with its reason', () => {
        const labels = new Set(pairs.map((pair) => pair.label));
        for (const [label, { reason }] of Object.entries(EXCEPTIONS)) {
            expect(labels.has(label), label).toBe(true);
            expect(reason.length).toBeGreaterThan(20);
        }
    });

    it('draws no words in the color of a token pair kept as an exception', () => {
        // An exception keeps a web pair as it is; the app doesn't spread it to
        // its own words (the warning banner draws its words in the foreground).
        const src = join(import.meta.dirname, '../../src');
        const code = readdirSync(src, { recursive: true, encoding: 'utf8' })
            .filter((file) => /\.tsx?$/.test(file))
            .map((file) => readFileSync(join(src, file), 'utf8'))
            .join('\n');
        const fronts = Object.keys(EXCEPTIONS).flatMap((label) => /^\w+: ([a-z-]+) on [a-z-]+$/.exec(label)?.[1] ?? []);
        expect(fronts).toContain('paused-banner-foreground');
        for (const front of fronts) {
            expect(code, front).not.toMatch(new RegExp(`\\btext-${front}\\b`));
        }
    });

    it('puts white on the primary fill in light', () => {
        expect(theme.light.colors['primary-foreground']).toBe('#ffffff');
    });

    it('needs the selected row’s correction: the web’s own mark is too faint on its sidebar', () => {
        for (const scheme of SCHEMES) {
            const { colors } = theme[scheme];
            expect(
                contrast(colors['sidebar-accent']!, colors.sidebar!),
                `${scheme}: the web's mark is visible now, so the correction does nothing: delete this test`,
            ).toBeLessThan(SELECTED_ROW_CONTRAST);
            expect(colors['row-selected']).not.toBe(colors['sidebar-accent']);
        }
    });
});
