import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    ANDROID_PROSE,
    headingFamily,
    MONO_FAMILY,
    monoFamily,
    PROSE,
    proseOf,
    TEXT_FLOOR,
    TEXT_ROLES,
    textLook,
    variantMetrics,
} from '../../src/ui/type-scale';

// The app's text roles and prose on each platform's own scale (src/ui/type-scale.ts;
// owner 2026-11-18): iOS's text styles in SF Pro,
// Material 3's roles in Roboto. How the screens use them is read as source.

const app = join(import.meta.dirname, '../..');
const src = (file: string) => readFileSync(join(app, 'src', file), 'utf8');

describe('the text roles', () => {
    it('are iOS’s text styles: a 34 pt bold large title, 17 pt rows and 15 pt lines under them', () => {
        expect(textLook('title', 'ios', 1)).toMatchObject({ fontSize: 34, lineHeight: 41, weight: 'bold' });
        expect(textLook('row-title', 'ios', 1)).toMatchObject({ fontSize: 17, lineHeight: 22, weight: 'semibold' });
        expect(textLook('chat-title', 'ios', 1)).toMatchObject({ fontSize: 17, weight: 'normal' });
        expect(textLook('row-subtitle', 'ios', 1)).toMatchObject({ fontSize: 15, lineHeight: 20, tone: 'muted' });
        expect(textLook('body', 'ios', 1)).toMatchObject({ fontSize: 17, lineHeight: 22, weight: 'normal' });
        expect(textLook('heading', 'ios', 1)).toMatchObject({ fontSize: 28, weight: 'bold' });
        expect(textLook('document-title', 'ios', 1)).toMatchObject({ fontSize: 28, lineHeight: 34, weight: 'bold' });
        expect(textLook('button', 'ios', 1)).toMatchObject({ fontSize: 15, weight: 'semibold' });
    });

    it('are Material’s roles on Android, in its weights', () => {
        expect(textLook('title', 'android', 1)).toMatchObject({ fontSize: 28, lineHeight: 36, weight: 'normal' });
        expect(textLook('row-title', 'android', 1)).toMatchObject({ fontSize: 16, lineHeight: 24, weight: 'medium' });
        expect(textLook('body', 'android', 1)).toMatchObject({ fontSize: 16, lineHeight: 24 });
        expect(textLook('row-subtitle', 'android', 1)).toMatchObject({ fontSize: 14, lineHeight: 20 });
        expect(textLook('button', 'android', 1)).toMatchObject({ fontSize: 14, weight: 'medium' });
        expect(textLook('section', 'android', 1)).toMatchObject({ uppercase: false, weight: 'medium' });
    });

    it('head a grouped list as iOS does: a muted Footnote in capitals', () => {
        expect(TEXT_ROLES.section).toEqual({
            style: 'footnote',
            tone: 'muted',
            iosUppercase: true,
            androidWeight: 'medium',
        });
        expect(textLook('section', 'ios', 1)).toMatchObject({ fontSize: 13, uppercase: true, tone: 'muted' });
    });

    it('set meta in the system font with tabular figures, never Menlo', () => {
        expect(TEXT_ROLES.meta).toEqual({ style: 'footnote', tone: 'muted', tabular: true });
        expect(textLook('meta', 'ios', 1)).toMatchObject({ fontSize: 13, tabular: true });
        // Menlo is for real code only: code spans and blocks, a command.
        expect(MONO_FAMILY).toEqual({ ios: 'Menlo', android: 'monospace' });
        expect(monoFamily('ios')).toBe('Menlo');
        expect(monoFamily('android')).toBe('monospace');
    });

    it('keep the floor at small font scales', () => {
        expect(variantMetrics('meta', 1, 'ios')).toEqual({ fontSize: 13, lineHeight: 18 });
        const small = variantMetrics('meta', 0.82, 'ios');
        expect(small.fontSize * 0.82).toBeGreaterThanOrEqual(TEXT_FLOOR - 0.01);
        expect(variantMetrics('body', 3.12, 'ios')).toEqual({ fontSize: 17, lineHeight: 22 });
    });
});

describe('prose', () => {
    it('is the transcript’s reading line on iOS: the Body at about 1.35, paragraphs 12 pt apart', () => {
        expect(PROSE.chat).toMatchObject({ fontSize: 17, lineHeight: 23, paragraphGap: 12, listLineHeight: 23 });
        expect(PROSE.chat.lineHeight / PROSE.chat.fontSize).toBeCloseTo(1.35, 1);
        expect(PROSE.chat.h1).toMatchObject({ fontSize: 20, lineHeight: 25, weight: 'semibold' });
        expect(PROSE.chat.h2).toMatchObject({ fontSize: 17, lineHeight: 22, weight: 'semibold' });
    });

    it('is Material’s bodyLarge on Android', () => {
        expect(ANDROID_PROSE.chat).toMatchObject({ fontSize: 16, lineHeight: 24 });
        expect(ANDROID_PROSE.page.h1).toMatchObject({ fontSize: 24, lineHeight: 32 });
        expect(proseOf('chat', 'android')).toBe(ANDROID_PROSE.chat);
        expect(proseOf('chat', 'ios')).toBe(PROSE.chat);
    });

    it('sets a page as Notes sets a note: the Body, then Title 1 and Title 2 in bold', () => {
        expect(PROSE.page).toMatchObject({ fontSize: 17, lineHeight: 24, paragraphGap: 14, listItemGap: 6 });
        expect(PROSE.page.h1).toMatchObject({ fontSize: 28, lineHeight: 34, weight: 'bold' });
        expect(PROSE.page.h2).toMatchObject({ fontSize: 22, lineHeight: 28, weight: 'bold' });
        expect(PROSE.page.h3).toMatchObject({ fontSize: 20, lineHeight: 25, weight: 'semibold' });
    });

    it('gives the renderer the list gap as its itemSpacing', () => {
        const list = src('screens/chat-markdown.tsx').match(/\n {8}list: \{[^}]*\}/)?.[0] ?? '';
        expect(list).toContain('itemSpacing: prose.listItemGap,');
    });

    it('is an issue’s description and comments on the chat’s reading line', () => {
        expect(PROSE.issue).toMatchObject({ fontSize: 17, lineHeight: 23, paragraphGap: 10 });
    });
});

describe('the screens', () => {
    it('take their type from the roles, not sizes and weights of their own', () => {
        // No screen names the web's Tailwind steps any more (text-xs, text-sm…).
        for (const file of [
            'screens/home-parts.tsx',
            'screens/shell-parts.tsx',
            'screens/board.tsx',
            'screens/issue.tsx',
            'screens/settings.tsx',
            'screens/page.tsx',
            'screens/space.tsx',
            'screens/chat.tsx',
        ]) {
            expect(src(file), file).not.toMatch(/<Text\b[^>]*\ssize=/);
            expect(src(file), file).not.toMatch(/<Text\b[^>]*\stracking=/);
        }
        const home = src('screens/home-parts.tsx');
        expect(home).toContain('<Text variant="title" numberOfLines={1} className="shrink">');
        expect(home).toContain('<Text accessibilityRole="header" variant="section" className="flex-1">');
        // The bar's name and the account's initial (in a fixed circle) stop growing at xxxL.
        expect(home.match(/maxFontSizeMultiplier=\{BAR_TITLE_MAX_SCALE\}/g)?.length).toBe(3);
        const parts = src('screens/shell-parts.tsx');
        expect(parts).toMatch(/<Text accessibilityRole="header" variant="title"[\s>]/);
        expect(parts).toContain('<Text accessibilityRole="header" variant="section" className="px-3">');
        expect(parts).toContain("variant={props.titleVariant ?? 'row-title'}");
        // At the accessibility sizes the accessory goes under the text (Home's "Idle" took the title's width).
        expect(parts).toContain(
            'const stacked = stacksAccessory(useWindowDimensions().fontScale) && props.trailing !== undefined;',
        );
        expect(parts).toContain('{stacked ? null : props.trailing}');
        // A row's second line is a Subheadline.
        expect(parts).toMatch(/<Text\s+variant="row-subtitle"\s+numberOfLines=\{props\.subtitleLines \?\? 1\}/);
        // A socio's state is in the system font with its dot, never mono (CB-431).
        const state = parts.slice(parts.indexOf('export function SocioStateLabel'));
        expect(state.slice(0, state.indexOf('\n}\n'))).toMatch(/<Text variant="footnote" tone="muted"/);
        expect(src('screens/chat-rows.tsx')).toContain('titleVariant="chat-title"');
        const page = src('screens/page.tsx');
        expect(page).toMatch(/variant="document-title"\s+testID="page-title"/);
        expect(page).toContain('<Text variant="meta" testID="page-edited">');
        expect(page).toContain('prose="page"');
        expect(src('screens/space.tsx')).toContain('<Text variant="meta">{page.edited}</Text>');
        const board = src('screens/board.tsx');
        expect(board).toContain('<Text variant="meta">{row.label}</Text>');
        expect(board).toContain('<Text variant="meta">{column.count}</Text>');
        // Keys and votes are meta in the system font, not Menlo.
        expect(board).not.toMatch(/<Text\b[^>]*\smono\b/);
        expect(src('screens/issue-card.tsx')).not.toMatch(/<Text\b[^>]*\smono\b/);
        expect(src('screens/issue.tsx')).toContain("<Text variant=\"meta\" tone={vote.voted ? 'primary' : 'muted'}>");
        // A person's bubble is Markdown in the chat's prose (CB-415).
        expect(src('screens/chat.tsx')).toMatch(/<MessageText text=\{row\.text\} surface=\{theirs/);
        expect(src('screens/message-text.tsx')).not.toMatch(/prose=/);
        expect(src('screens/issue.tsx')).toContain(
            '<ReplyMarkdown text={view.body} testID="issue-body" prose="issue" />',
        );
        expect(src('ui/button.tsx')).toContain(
            '<Text variant="button" className="shrink text-center" style={{ color: words }}',
        );
    });

    it('name a family with the weight in it for Markdown headings on Android, where the fork ignores fontWeight', () => {
        expect(headingFamily('android')).toBe('sans-serif-medium');
        expect(headingFamily('ios')).toBeUndefined();
        const markdown = src('screens/chat-markdown.tsx');
        expect(markdown).toContain('const headingFace = headingFamily(Platform.OS);');
        expect(markdown).toContain('...(headingFace === undefined ? {} : { fontFamily: headingFace }),');
        const fork = readFileSync(
            join(app, 'node_modules/react-native-enriched-markdown/src/normalizeMarkdownStyle.ts'),
            'utf8',
        );
        expect(fork).toContain("android: 'sans-serif',");
    });

    it('draw Markdown from the platform’s prose and the mono family, keeping Dynamic Type', () => {
        const markdown = src('screens/chat-markdown.tsx');
        expect(markdown).toContain('const prose = proseOf(kind, Platform.OS);');
        expect(markdown).toContain('floored(prose, fontScale)');
        expect(markdown).toContain('marginBottom: prose.paragraphGap');
        expect(markdown).toContain('const monospace = monoFamily(Platform.OS);');
        expect(markdown).not.toContain("'Menlo'");
        const text = src('ui/text.tsx');
        expect(text).toContain('useWindowDimensions');
        expect(text).toContain("textLook(variant ?? 'body', Platform.OS, fontScale)");
        expect(text).toContain("look.tabular ? { fontVariant: ['tabular-nums'] } : null");
        expect(text).toContain("look.uppercase ? { textTransform: 'uppercase' } : null");
    });
});
