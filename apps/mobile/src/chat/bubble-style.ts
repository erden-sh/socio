import type { MarkdownStyle } from 'react-native-enriched-markdown';

import type { Colors } from '../theme/theme';

// A person's message in Markdown (CB-415): the reply's style (chat-markdown.tsx's
// replyStyle) recolored for the bubble it sits in. No React Native here:
// tests/chat runs it under Node.

/**
 * The bubble a person's message sits in (CB-415): their own (teal, white words), their own still
 * waiting (a light tint, dark words) or another person's in a room (muted, the reply's words).
 */
export type BubbleSurface = 'own' | 'pending' | 'other';

/** Translucent white on the teal bubble: its code, quotes and table lines (the web's `#ffffff40` lines). */
const ON_BUBBLE_LINE = '#ffffff40';
const ON_BUBBLE_TINT = '#ffffff26';

/**
 * Markdown in a person's bubble, as the web's `Markdown onBubble`: the bubble's word color, links
 * underlined in it (their own) or in the chat's link color (pending, another's), plain rather than
 * issue chips (the web's bubbles draw AppLinks), and code and tables that show on the bubble. Pure.
 */
export function bubbleStyle(style: MarkdownStyle, colors: Colors, surface: BubbleSurface | undefined): MarkdownStyle {
    if (surface === undefined) {
        return style;
    }
    const own = surface === 'own';
    const words =
        surface === 'own'
            ? colors['user-bubble-foreground']
            : surface === 'pending'
              ? colors['user-bubble-pending-foreground']
              : colors.foreground;
    const tint = own ? ON_BUBBLE_TINT : colors.background;
    const line = own ? ON_BUBBLE_LINE : colors.border;
    const muted = own ? words : colors['muted-foreground'];
    const recolor = <T extends object | undefined>(block: T) => ({ ...block, color: words });
    return {
        ...style,
        paragraph: recolor(style.paragraph),
        h1: recolor(style.h1),
        h2: recolor(style.h2),
        h3: recolor(style.h3),
        h4: recolor(style.h4),
        h5: recolor(style.h5),
        h6: recolor(style.h6),
        strong: { ...style.strong, color: words },
        link: { color: own ? words : colors['chat-link'], underline: true },
        linkVariants: {},
        code: { ...style.code, color: words, backgroundColor: tint },
        codeBlock: {
            ...style.codeBlock,
            color: words,
            backgroundColor: tint,
            borderColor: line,
            // GitHub's syntax colors don't read on the teal: their own code is one color, as on the web.
            ...(own
                ? {
                      syntaxColors: Object.fromEntries(
                          Object.keys(style.codeBlock?.syntaxColors ?? {}).map((key) => [key, words]),
                      ),
                  }
                : {}),
        },
        blockquote: { ...style.blockquote, color: muted, borderColor: line },
        list: { ...style.list, color: words, bulletColor: muted, markerColor: muted },
        thematicBreak: { ...style.thematicBreak, color: line },
        table: {
            ...style.table,
            color: words,
            borderColor: line,
            headerTextColor: words,
            headerBackgroundColor: own ? 'transparent' : tint,
        },
        taskList: { ...style.taskList, checkedColor: words, checkedTextColor: words, borderColor: muted },
    };
}
