import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { color, contrast, light, themes } from './helpers/theme-tokens';

// The theme's tokens (globals.css) meet WCAG AA where text sits on them,
// in light and in dark: white (or the dark theme's ink) on the primary
// fill at rest, hovered and disabled; the sidebar's quieter words on its
// rows; muted words on the surfaces they're used on; the menus' focus
// ring against the menu; a pending message's words on its tint; the own
// bubble's words; a chat's links on what they sit on.

const transcript = readFileSync(new URL('../src/modules/chat/ChatTranscript.tsx', import.meta.url), 'utf8');

it.each(Object.entries(themes))(
    'keeps the primary fill’s words at 4.5:1 at rest, hovered and disabled (%s)',
    (_, theme) => {
        const ink = color(theme, 'primary-foreground');
        for (const fill of ['primary', 'primary-hover', 'primary-disabled']) {
            expect(contrast(ink, color(theme, fill)), fill).toBeGreaterThanOrEqual(4.5);
        }
        expect(
            contrast(color(theme, 'sidebar-primary-foreground'), color(theme, 'sidebar-primary')),
        ).toBeGreaterThanOrEqual(4.5);
    },
);

it('puts white on the primary fill in light, darker than the brand it comes from', () => {
    expect(color(light, 'primary-foreground').toLowerCase()).toBe('#ffffff');
    // The brand itself is under 4.5:1 with white: an accent, not a fill.
    expect(contrast('#ffffff', color(light, 'brand'))).toBeLessThan(4.5);
    expect(contrast('#ffffff', color(light, 'primary'))).toBeGreaterThanOrEqual(5);
});

it.each(Object.entries(themes))('keeps quieter words at 4.5:1 on the surfaces they sit on (%s)', (_, theme) => {
    for (const surface of ['sidebar', 'sidebar-accent']) {
        expect(
            contrast(color(theme, 'sidebar-muted-foreground'), color(theme, surface)),
            surface,
        ).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of ['background', 'card', 'popover', 'muted', 'accent']) {
        expect(contrast(color(theme, 'muted-foreground'), color(theme, surface)), surface).toBeGreaterThanOrEqual(4.5);
    }
});

it.each(Object.entries(themes))(
    'rings a menu’s keyboard item at 3:1 or more against the menu and the item (%s)',
    (_, theme) => {
        for (const surface of ['popover', 'accent']) {
            expect(contrast(color(theme, 'ring'), color(theme, surface)), surface).toBeGreaterThanOrEqual(3);
        }
    },
);

it('shows a pending message’s words at 4.5:1 on its tint, its own and its links', () => {
    const pending = transcript.match(/const pending = \{([\s\S]*?)\n\};/)![1]!;
    // Its tint and its links are tokens, and its words the theme's own.
    expect(pending).toContain('bg-user-bubble-pending ');
    expect(pending).toContain('[:where(&)_a]:text-chat-link');
    expect(pending).toContain('text-foreground');
    expect(pending).not.toMatch(/opacity/);
    for (const [name, theme] of Object.entries(themes)) {
        const tint = color(theme, 'user-bubble-pending');
        expect(contrast(color(theme, 'foreground'), tint), name).toBeGreaterThanOrEqual(4.5);
        expect(contrast(color(theme, 'chat-link'), tint), name).toBeGreaterThanOrEqual(4.5);
    }
    // The sending bubble's pending look is the same tint.
    expect(transcript).toContain('in-data-delivery:bg-user-bubble-pending ');
    expect(transcript).toContain('in-data-delivery:[:where(&)_a]:text-chat-link');
});

it.each(Object.entries(themes))('keeps the own bubble’s words and links at 4.5:1 on it (%s)', (_, theme) => {
    expect(contrast(color(theme, 'user-bubble-foreground'), color(theme, 'user-bubble'))).toBeGreaterThanOrEqual(4.5);
});

it.each(Object.entries(themes))(
    'keeps a chat’s links at 4.5:1 on a reply’s page and another person’s bubble (%s)',
    (_, theme) => {
        for (const surface of ['background', 'muted']) {
            expect(contrast(color(theme, 'chat-link'), color(theme, surface)), surface).toBeGreaterThanOrEqual(4.5);
        }
    },
);
