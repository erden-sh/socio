import type { FontWeightName } from '../theme/theme';
import { theme } from '../theme/theme';

// The app's type on each platform's own scale (the native audit,
// owner 2026-11-18): iOS's text styles (Body 17, Subheadline 15, Footnote 13,
// Headline 17 semibold, Large Title 34…) in the system font, SF Pro, and on
// Android the same roles on Material 3's type scale (bodyLarge 16, titleMedium
// 16 medium…) in Roboto. The web's Tailwind scale (body 14, meta 12 in Menlo)
// read as a web page on a phone.
//
// Dynamic Type stays as it was: React Native multiplies fontSize, lineHeight
// and letterSpacing by the system's font scale itself (allowFontScaling), so
// these are the sizes at the default text size, and they only step in under the
// floor. iOS's titles stop growing where UIKit's do (MAX_SCALE). No React
// Native here, so the Node tests read it as the app does.

/** The smallest text the app draws, in points, whatever the system's text size (MOBILE-APP 10). */
export const TEXT_FLOOR = 12;

const round = (value: number) => Math.round(value * 100) / 100;

/** A safe font scale: the system's, or 1 when it reports none. */
const scaleOf = (fontScale: number) => (Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1);

/** iOS's text styles (UIFont.TextStyle), by the names Apple gives them. */
export const TEXT_STYLE_NAMES = [
    'largeTitle',
    'title1',
    'title2',
    'title3',
    'headline',
    'body',
    'callout',
    'subheadline',
    'footnote',
    'caption1',
    'caption2',
] as const;

export type TextStyleName = (typeof TEXT_STYLE_NAMES)[number];

/** A step of a platform's type scale: its size and line height, weight and tracking, in points. */
export interface TypeStep {
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly weight: FontWeightName;
    /** Letter spacing in points at this size (Apple's and Material's tables give it so). */
    readonly tracking: number;
}

const step = (fontSize: number, lineHeight: number, weight: FontWeightName, tracking: number): TypeStep => ({
    fontSize,
    lineHeight,
    weight,
    tracking,
});

/**
 * iOS's text styles at the default text size (Large), with Apple's line heights
 * and tracking (the HIG's Dynamic Type sizes and SF Pro's tracking table). The
 * system applies SF Pro's tracking itself, size by size, to the system font
 * (the font's own `trak` table, which UIKit and React Native both draw with),
 * so the app sets no letterSpacing of its own on iOS: adding Apple's numbers on
 * top would track every line twice. They are kept here for the record and the
 * tests.
 */
export const IOS_TEXT_STYLES = {
    largeTitle: step(34, 41, 'normal', 0.37),
    title1: step(28, 34, 'normal', 0.36),
    title2: step(22, 28, 'normal', 0.35),
    title3: step(20, 25, 'normal', 0.38),
    headline: step(17, 22, 'semibold', -0.41),
    body: step(17, 22, 'normal', -0.41),
    callout: step(16, 21, 'normal', -0.32),
    subheadline: step(15, 20, 'normal', -0.24),
    footnote: step(13, 18, 'normal', -0.08),
    caption1: step(12, 16, 'normal', 0),
    caption2: step(11, 13, 'normal', 0.07),
} as const satisfies Record<TextStyleName, TypeStep>;

/**
 * The text style's size at iOS's largest accessibility size (AX5), from the
 * HIG's table: UIKit grows the body to 53 pt but a Large Title only to 60, so
 * a title stops growing at its own multiple of its default size. React Native
 * grows every size by one factor (3.12 at AX5 on iOS), so the titles get a
 * maxFontSizeMultiplier from here (MAX_SCALE); the rest grow as the body does.
 */
const IOS_AX5_SIZES = {
    largeTitle: 60,
    title1: 58,
    title2: 56,
    title3: 55,
} as const satisfies Partial<Record<TextStyleName, number>>;

/** iOS's titles' largest multiple of their default size, as UIKit's Dynamic Type stops them. */
export const MAX_SCALE: Partial<Record<TextStyleName, number>> = Object.fromEntries(
    Object.entries(IOS_AX5_SIZES).map(([name, size]) => [
        name,
        round(size / IOS_TEXT_STYLES[name as TextStyleName].fontSize),
    ]),
);

/** Material 3's type scale (m3.material.io, Typography: type scale tokens), in sp. */
export const MATERIAL_TYPE_SCALE = {
    displayLarge: step(57, 64, 'normal', -0.25),
    displayMedium: step(45, 52, 'normal', 0),
    displaySmall: step(36, 44, 'normal', 0),
    headlineLarge: step(32, 40, 'normal', 0),
    headlineMedium: step(28, 36, 'normal', 0),
    headlineSmall: step(24, 32, 'normal', 0),
    titleLarge: step(22, 28, 'normal', 0),
    titleMedium: step(16, 24, 'medium', 0.15),
    titleSmall: step(14, 20, 'medium', 0.1),
    bodyLarge: step(16, 24, 'normal', 0.5),
    bodyMedium: step(14, 20, 'normal', 0.25),
    bodySmall: step(12, 16, 'normal', 0.4),
    labelLarge: step(14, 20, 'medium', 0.1),
    labelMedium: step(12, 16, 'medium', 0.5),
    labelSmall: step(11, 16, 'medium', 0.5),
} as const satisfies Record<string, TypeStep>;

export type MaterialTypeRole = keyof typeof MATERIAL_TYPE_SCALE;

/**
 * Each iOS text style's place on Material's scale, so a screen names one role
 * and each platform draws its own: a Large Title is the large top app bar's
 * headlineMedium, a row's Headline the list item's titleMedium, the Body
 * bodyLarge, a Footnote bodySmall.
 */
export const ANDROID_TEXT_STYLES = {
    largeTitle: 'headlineMedium',
    title1: 'headlineSmall',
    title2: 'titleLarge',
    title3: 'titleLarge',
    headline: 'titleMedium',
    body: 'bodyLarge',
    callout: 'bodyLarge',
    subheadline: 'bodyMedium',
    footnote: 'bodySmall',
    caption1: 'bodySmall',
    caption2: 'labelSmall',
} as const satisfies Record<TextStyleName, MaterialTypeRole>;

/** A text style on a platform (React Native's Platform.OS): iOS's own, or its Material role elsewhere. */
export function textStyle(name: TextStyleName, os: string): TypeStep {
    return os === 'ios' ? IOS_TEXT_STYLES[name] : MATERIAL_TYPE_SCALE[ANDROID_TEXT_STYLES[name]];
}

/**
 * A text style's size and line height at the system's font scale: the style's
 * own, unless the scaled size would fall under the floor (a text size below
 * the default), when both grow so it lands on the floor.
 */
export function textMetrics(
    name: TextStyleName,
    fontScale: number,
    os: string,
): { fontSize: number; lineHeight: number } {
    return floored(textStyle(name, os), fontScale);
}

/** Text of a size and line height of its own (prose, a page's title), under the same floor. */
export function floored(
    metrics: { readonly fontSize: number; readonly lineHeight: number },
    fontScale: number,
): { fontSize: number; lineHeight: number } {
    const { fontSize, lineHeight } = metrics;
    const scaled = fontSize * scaleOf(fontScale);
    if (scaled >= TEXT_FLOOR) {
        return { fontSize, lineHeight };
    }
    const grow = TEXT_FLOOR / scaled;
    return { fontSize: round(fontSize * grow), lineHeight: round(lineHeight * grow) };
}

/** A font weight as React Native takes it ('500'). */
export const fontWeight = (weight: FontWeightName) => String(theme.type.weights[weight]) as NumericWeight;

type NumericWeight = '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900';

/**
 * A row's height: always a minimum, never a fixed height, so the row grows with
 * its text at every text size. A row with a page's two-line excerpt and its
 * "Edited Nov 3" meta outgrew the height it had been given: the meta was cut and
 * the next row's title drew over it (CB-373). tests/ui/row-sizing.test.ts holds
 * every row to this.
 */
export function rowMinHeight(height: number): { minHeight: number } {
    return { minHeight: height };
}

/** A bar's own title stops growing here, at iOS's largest size before the accessibility ones (xxxL). */
export const BAR_TITLE_MAX_SCALE = 1.35;

/** The font scale from which a row's accessory goes under its text: iOS's accessibility sizes start near it. */
export const STACKED_ROW_SCALE = 1.5;

/**
 * Whether a row lays its trailing accessory (a state, a count) under its text
 * rather than beside it, as UIKit's list cells do at the accessibility sizes:
 * beside 17 pt text grown three times, the title kept only a letter or two.
 */
export const stacksAccessory = (fontScale: number): boolean =>
    Number.isFinite(fontScale) && fontScale >= STACKED_ROW_SCALE;

/**
 * Monospace, for real code only (a code span or block, a command, an id
 * someone copies): Menlo on iOS (SF Mono isn't open to apps by name) and the
 * system's monospace on Android. Meta (dates, counts, keys) is the system font
 * with tabular figures, as iOS and Material set it.
 */
export const MONO_FAMILY = { ios: 'Menlo', android: 'monospace' } as const;

/** The monospace family for a platform (React Native's Platform.OS). */
export const monoFamily = (os: string): string => (os === 'ios' ? MONO_FAMILY.ios : MONO_FAMILY.android);

/**
 * The family a Markdown heading names on Android, with the weight in the face
 * itself: the enriched-markdown fork draws an Android heading in the plain
 * face whatever its fontWeight ('600', even 'bold'), but takes the family it
 * is given. Roboto Medium (`sans-serif-medium`, 500) is Material's weight for
 * titles; Android has no semibold alias. iOS takes the weight, so it names none.
 */
export const headingFamily = (os: string): string | undefined => (os === 'android' ? 'sans-serif-medium' : undefined);

/** What a role sets beyond its text style: a weight per platform, a tone, capitals, tabular figures. */
export interface TextRole {
    readonly style: TextStyleName;
    /** The weight on iOS, where it differs from the style's (a large title in the bar is bold). */
    readonly iosWeight?: FontWeightName;
    /** The weight on Android, where it differs from the Material role's. */
    readonly androidWeight?: FontWeightName;
    readonly tone?: 'muted';
    /** iOS's grouped list headers are a Footnote in capitals. */
    readonly iosUppercase?: true;
    /** Figures of one width, for times, counts and keys in the system font. */
    readonly tabular?: true;
}

/**
 * The roles the app's text takes, so a screen names a role rather than a size
 * and weight. Each is an iOS text style (and through it a Material role), with
 * what the role adds:
 * - `title`: a screen's title, iOS's large title in the bar, 34 pt bold;
 *   Material's large top app bar, headlineMedium;
 * - `heading`: a heading in a screen's content (a sign-in step, a screen that
 *   failed), a Title 1 in bold as iOS's onboarding screens; headlineSmall;
 * - `document-title`: a page's title in the reader, Notes' Title, 28 pt bold;
 * - `section`: a section's label over its list, iOS's grouped list header (a
 *   Footnote in capitals, muted); Material's list subheader, titleSmall;
 * - `row-title`: a list row's title, a Headline (Mail, Notes, Reminders);
 * - `chat-title`: a chat's row title, the Body, regular as ChatGPT's history;
 * - `row-subtitle`: a row's second line, a Subheadline, muted;
 * - `meta`: dates, states, keys and counts, a Footnote with tabular figures in
 *   the system font, muted (no Menlo: that is only for real code);
 * - `button`: a button's words, a Subheadline in semibold as iOS's medium
 *   buttons; Material's labelLarge (14, medium).
 * A message's words are Markdown in the chat's prose (PROSE.chat).
 * The text styles themselves (`body`, `footnote`, …) are roles too.
 */
export const TEXT_ROLES = {
    ...(Object.fromEntries(TEXT_STYLE_NAMES.map((name) => [name, { style: name }])) as Record<
        TextStyleName,
        { readonly style: TextStyleName }
    >),
    title: { style: 'largeTitle', iosWeight: 'bold' },
    heading: { style: 'title1', iosWeight: 'bold' },
    'document-title': { style: 'title1', iosWeight: 'bold' },
    section: { style: 'footnote', tone: 'muted', iosUppercase: true, androidWeight: 'medium' },
    'row-title': { style: 'headline' },
    'chat-title': { style: 'body' },
    'row-subtitle': { style: 'subheadline', tone: 'muted' },
    meta: { style: 'footnote', tone: 'muted', tabular: true },
    button: { style: 'subheadline', iosWeight: 'semibold', androidWeight: 'medium' },
} as const satisfies Record<string, TextRole>;

export type TextVariant = keyof typeof TEXT_ROLES;

/** How a role draws on a platform at a font scale: what Text hands React Native's Text. */
export interface TextLook {
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly weight: FontWeightName;
    /** Only on Android: iOS's system font tracks itself. */
    readonly letterSpacing?: number;
    readonly tone?: 'muted';
    readonly uppercase: boolean;
    readonly tabular: boolean;
    /** Only on iOS's titles: where UIKit stops growing them. */
    readonly maxFontSizeMultiplier?: number;
}

/** A role's look on a platform (React Native's Platform.OS) at the system's font scale, under the floor. */
export function textLook(variant: TextVariant, os: string, fontScale: number): TextLook {
    const role: TextRole = TEXT_ROLES[variant];
    const ios = os === 'ios';
    const base = textStyle(role.style, os);
    const metrics = floored(base, fontScale);
    const weight = (ios ? role.iosWeight : role.androidWeight) ?? base.weight;
    const max = ios ? MAX_SCALE[role.style] : undefined;
    return {
        ...metrics,
        weight,
        ...(ios ? {} : { letterSpacing: base.tracking }),
        ...(role.tone === undefined ? {} : { tone: role.tone }),
        uppercase: ios && role.iosUppercase === true,
        tabular: role.tabular === true,
        ...(max === undefined ? {} : { maxFontSizeMultiplier: max }),
    };
}

/** A role's size and line height at the system's font scale, under the floor. */
export function variantMetrics(
    variant: TextVariant,
    fontScale: number,
    os: string,
): { fontSize: number; lineHeight: number } {
    const { fontSize, lineHeight } = textLook(variant, os, fontScale);
    return { fontSize, lineHeight };
}

/** A heading in prose: its metrics, weight and the space above and below it, in points. */
export interface ProseHeading {
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly weight: FontWeightName;
    readonly marginTop: number;
    readonly marginBottom: number;
}

/** Prose: the body's metrics, the space after a paragraph, a list's line, and its headings. */
export interface ProseStyle {
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly paragraphGap: number;
    /** A list item's line. */
    readonly listLineHeight: number;
    /** The space between a list's items (the renderer's `itemSpacing`). */
    readonly listItemGap: number;
    readonly h1: ProseHeading;
    readonly h2: ProseHeading;
    readonly h3: ProseHeading;
}

const heading = (metrics: TypeStep, weight: FontWeightName, top: number, bottom: number) => ({
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    weight,
    marginTop: top,
    marginBottom: bottom,
});

const ios = IOS_TEXT_STYLES;
const m3 = MATERIAL_TYPE_SCALE;

/**
 * Prose where Markdown shows, on iOS's text styles:
 * - `chat`: a socio's reply and the person's message, the Body at about 1.35
 *   (17/23: Messages' and ChatGPT's reading line), headings a Title 3
 *   and Headlines in semibold;
 * - `issue`: an issue's description and comments, the same reading line as a
 *   chat, a little tighter between paragraphs;
 * - `page`: a page's body, as Notes sets a note: the Body on a slightly more
 *   open line (17/24), headings Title 1 and Title 2 in bold and a Title 3 in
 *   semibold (Notes' Title, Heading and Subheading).
 */
export const PROSE = {
    chat: {
        fontSize: 17,
        lineHeight: 23,
        paragraphGap: 12,
        listLineHeight: 23,
        listItemGap: 4,
        h1: heading(ios.title3, 'semibold', 12, 6),
        h2: heading(ios.headline, 'semibold', 12, 4),
        h3: heading(ios.headline, 'semibold', 12, 4),
    },
    issue: {
        fontSize: 17,
        lineHeight: 23,
        paragraphGap: 10,
        listLineHeight: 23,
        listItemGap: 4,
        h1: heading(ios.title3, 'semibold', 16, 6),
        h2: heading(ios.headline, 'semibold', 14, 4),
        h3: heading(ios.headline, 'semibold', 12, 4),
    },
    page: {
        fontSize: 17,
        lineHeight: 24,
        paragraphGap: 14,
        listLineHeight: 24,
        listItemGap: 6,
        h1: heading(ios.title1, 'bold', 28, 10),
        h2: heading(ios.title2, 'bold', 24, 8),
        h3: heading(ios.title3, 'semibold', 20, 6),
    },
} as const satisfies Record<string, ProseStyle>;

export type ProseKind = keyof typeof PROSE;

/**
 * The same prose on Material's scale: bodyLarge (16/24) for the text, a
 * titleLarge and titleMediums for a chat's headings, and a page's in
 * headlineSmall, titleLarge and titleMedium. Headings draw in Roboto Medium
 * (headingFamily), Material's weight for titles.
 */
export const ANDROID_PROSE = {
    chat: {
        fontSize: 16,
        lineHeight: 24,
        paragraphGap: 12,
        listLineHeight: 24,
        listItemGap: 4,
        h1: heading(m3.titleLarge, 'medium', 12, 6),
        h2: heading(m3.titleMedium, 'medium', 12, 4),
        h3: heading(m3.titleMedium, 'medium', 12, 4),
    },
    issue: {
        fontSize: 16,
        lineHeight: 24,
        paragraphGap: 10,
        listLineHeight: 24,
        listItemGap: 4,
        h1: heading(m3.titleLarge, 'medium', 16, 6),
        h2: heading(m3.titleMedium, 'medium', 14, 4),
        h3: heading(m3.titleMedium, 'medium', 12, 4),
    },
    page: {
        fontSize: 16,
        lineHeight: 26,
        paragraphGap: 14,
        listLineHeight: 26,
        listItemGap: 6,
        h1: heading(m3.headlineSmall, 'medium', 28, 10),
        h2: heading(m3.titleLarge, 'medium', 24, 8),
        h3: heading(m3.titleMedium, 'medium', 20, 6),
    },
} as const satisfies Record<ProseKind, ProseStyle>;

/** A kind of prose on a platform (React Native's Platform.OS). */
export const proseOf = (kind: ProseKind, os: string): ProseStyle => (os === 'ios' ? PROSE[kind] : ANDROID_PROSE[kind]);
