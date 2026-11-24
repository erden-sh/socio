import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { otherBubble, pendingOtherBubble, pendingUserBubble, userBubble } from '../src/modules/chat/ChatTranscript';

import { color, darkBlock, light, themeInline, themes } from './helpers/theme-tokens';

// The colors ChatTranscript.tsx and AppShell.tsx wrote as literals are
// globals.css tokens now, each with exactly the value its
// component painted in that theme. The fixtures are those literals, per
// theme, as the components had them (main at 42add0c7). The web looks the
// same in light and in dark as long as each token keeps its literal, the
// classes each place is given (the bubbles' lists ChatTranscript.tsx
// exports, a reply's body, the paused line) paint with the token where
// the literal was, and no other color, nor a dark: variant, paints over it.

const before = {
    light: {
        // ChatTranscript.tsx: the own bubble, bg-[#3d7e75] text-white, and
        // its links [:where(&)_a]:text-white (Tailwind's white is #fff).
        'user-bubble': '#3d7e75',
        'user-bubble-foreground': '#ffffff',
        // The pending look (pending.user, and in-data-delivery: while
        // sending): border-[#3d7e75] bg-[#e9f2f0], links text-[#357360].
        'user-bubble-pending': '#e9f2f0',
        'user-bubble-pending-border': '#3d7e75',
        // Links in replies and in another person's bubble (`links`) and on
        // the pending tint: text-[#357360].
        'chat-link': '#357360',
        // AppShell.tsx's paused line: bg-[#f3eee4] text-[#9b865e]
        // border-b-[#eae1d0].
        'paused-banner': '#f3eee4',
        'paused-banner-foreground': '#9b865e',
        'paused-banner-border': '#eae1d0',
    },
    dark: {
        // No dark: variant: the own bubble and its words stayed the same.
        'user-bubble': '#3d7e75',
        'user-bubble-foreground': '#ffffff',
        // dark:border-[#6cbfb1] dark:bg-[#1b2b28], links dark:…text-[#83c2ac].
        'user-bubble-pending': '#1b2b28',
        'user-bubble-pending-border': '#6cbfb1',
        'chat-link': '#83c2ac',
        // dark:bg-[#2b2924] dark:text-[#b6a077] dark:border-b-[#3b362e].
        'paused-banner': '#2b2924',
        'paused-banner-foreground': '#b6a077',
        'paused-banner-border': '#3b362e',
    },
} as const;

const tokens = Object.keys(before.light) as Array<keyof typeof before.light>;

const src = join(import.meta.dirname, '../src');
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const classes = (list: string) => list.split(/\s+/).filter(Boolean);

/** The paused line's classes, as AppShell.tsx gives them. */
const banner =
    read('shell/AppShell.tsx').match(/\{state\.settings\.paused && \(\s*<div className="([^"]+)"/)?.[1] ?? '';

/** The class lists that paint with the tokens. */
const lists = {
    'the own bubble': userBubble,
    'the own bubble, pending': pendingUserBubble,
    'another person’s bubble': otherBubble,
    'the paused line': banner,
};

/** Where each token paints now: a class list and the class it has. */
const uses: Record<(typeof tokens)[number], Array<[keyof typeof lists, string]>> = {
    'user-bubble': [['the own bubble', 'bg-user-bubble']],
    'user-bubble-foreground': [
        ['the own bubble', 'text-user-bubble-foreground'],
        ['the own bubble', '[:where(&)_a]:text-user-bubble-foreground'],
    ],
    'user-bubble-pending': [
        ['the own bubble', 'in-data-delivery:bg-user-bubble-pending'],
        ['the own bubble, pending', 'bg-user-bubble-pending'],
    ],
    'user-bubble-pending-border': [
        ['the own bubble', 'in-data-delivery:border-user-bubble-pending-border'],
        ['the own bubble, pending', 'border-user-bubble-pending-border'],
    ],
    // And a reply's body, below: ChatTranscript.tsx doesn't export it.
    'chat-link': [
        ['another person’s bubble', '[:where(&)_a]:text-chat-link'],
        ['the own bubble', 'in-data-delivery:[:where(&)_a]:text-chat-link'],
        ['the own bubble, pending', '[:where(&)_a]:text-chat-link'],
    ],
    'paused-banner': [['the paused line', 'bg-paused-banner']],
    'paused-banner-foreground': [['the paused line', 'text-paused-banner-foreground']],
    'paused-banner-border': [['the paused line', 'border-b-paused-banner-border']],
};

/** A list's classes with a dark: variant: dark:bg-…, in-data-delivery:dark:…, and the like. */
const darkOnes = (list: string) => classes(list).filter((name) => /(^|:)dark:/.test(name));
/** Of those, the ones that paint a color: a background, words, a border. */
const darkColors = (list: string) =>
    darkOnes(list).filter((name) => /^(bg|text|border)-/.test(name.slice(name.lastIndexOf(':') + 1)));

/** A hex as the forms a literal can take in source: #rrggbb and rgb(r, g, b). */
const forms = (hex: string) => {
    const [r, g, b] = hex
        .slice(1)
        .match(/../g)!
        .map((pair) => parseInt(pair, 16));
    return [new RegExp(hex, 'i'), new RegExp(`rgba?\\(\\s*${r}[\\s,]+${g}[\\s,]+${b}\\b`)];
};
const literals = [...new Set([...Object.values(before.light), ...Object.values(before.dark)])].filter(
    (hex) => hex !== '#ffffff',
);

const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
    });

describe.each(Object.entries(themes))('in %s', (name, theme) => {
    it.each(tokens)('--%s is the literal its component painted', (token) => {
        expect(color(theme, token).toLowerCase()).toBe(before[name as keyof typeof before][token]);
    });
});

it.each(tokens)('sets --%s in :root and in .dark, and makes it a Tailwind color', (token) => {
    expect(light[token], `:root --${token}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(darkBlock[token], `.dark --${token}`).toMatch(/^#[0-9a-f]{6}$/);
    expect(themeInline).toContain(`--color-${token}: var(--${token});`);
});

it.each(tokens)('paints with --%s where the literal was', (token) => {
    for (const [where, used] of uses[token]) {
        expect(classes(lists[where]), where).toContain(used);
    }
});

it('gives a reply’s links --chat-link, with nothing of its own over them', () => {
    const source = read('modules/chat/ChatTranscript.tsx');
    expect(source).toContain("const links = '[:where(&)_a]:text-chat-link';");
    const reply = source.match(/\n\s+assistant: cn\(([\s\S]*?)\n\s+\),\n/)?.[1];
    expect(reply, 'bodyClass.assistant').toBeDefined();
    expect(reply).toMatch(/^\s*links,$/m);
    expect(reply).not.toMatch(/_a\]:text-/);
});

it('puts the pending look in place of the own bubble’s colors, not beside them', () => {
    const pending = classes(pendingUserBubble);
    for (const own of ['bg-user-bubble', 'text-user-bubble-foreground', '[:where(&)_a]:text-user-bubble-foreground']) {
        expect(pending).not.toContain(own);
    }
    expect(pending).toContain('text-foreground');
});

it('lets no dark: variant paint over the tokens in the bubbles or the paused line', () => {
    // The one dark color the bubbles have: prose's code blocks, not a token.
    const codeBlock = 'dark:[:where(&)_pre]:bg-[#282829]';
    const bubbles = { userBubble, pendingUserBubble, otherBubble, pendingOtherBubble };
    for (const [name, list] of Object.entries(bubbles)) {
        expect(
            darkColors(list).filter((dark) => dark !== codeBlock),
            name,
        ).toEqual([]);
    }
    expect(darkOnes(banner), 'the paused line').toEqual([]);
});

it('gives the paused line no color beside its tokens', () => {
    // Its classes are a plain string, not merged: the stylesheet's order
    // would pick between two. (A size, a side's width or a style is no color.)
    const colors = classes(banner).filter(
        (name) =>
            /^(bg|text|border)-/.test(name) &&
            !/^text-\[\d+px\]$/.test(name) &&
            !/^border-([trblxy]|\d+|solid|dashed|dotted|none)$/.test(name),
    );
    expect(colors.sort()).toEqual([
        'bg-paused-banner',
        'border-b-paused-banner-border',
        'text-paused-banner-foreground',
    ]);
});

it('leaves none of the literals in ChatTranscript.tsx and AppShell.tsx, in any form or theme', () => {
    for (const file of ['modules/chat/ChatTranscript.tsx', 'shell/AppShell.tsx']) {
        const source = read(file);
        for (const hex of literals) {
            for (const form of forms(hex)) {
                expect(source, `${file}: ${hex}`).not.toMatch(form);
            }
        }
    }
    expect(read('modules/chat/ChatTranscript.tsx')).not.toMatch(/\btext-white\b/);
});

it('has no other copy of the literals in the client, but the one mention chip', () => {
    const found: string[] = [];
    for (const path of files(src)) {
        if (path.endsWith('globals.css')) {
            continue;
        }
        const source = readFileSync(path, 'utf8');
        for (const hex of literals) {
            if (forms(hex).some((form) => form.test(source))) {
                found.push(`${relative(src, path)} ${hex}`);
            }
        }
    }
    // A person mention's chip in a room is #357360 in light and the primary
    // in dark: not a link, so not --chat-link (a follow-up may give it a token).
    expect(found).toEqual(['modules/rooms/PeopleMentions.tsx #357360']);
});
