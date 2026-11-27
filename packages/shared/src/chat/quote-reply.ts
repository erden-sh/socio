import type { RoomView } from '../rooms/rooms.js';

// Quote-reply (CB-571): Reply on a message puts a quote of it above the
// composer, and the message sent carries it as a Markdown blockquote naming
// the author, then a blank line, then what the person typed:
//
//     > **Archiver:** Yes! erden is a German verb meaning “to ground”…
//
//     What does it mean for the name?
//
// No server field: every client and the socio read it as Markdown, and the
// app and the web build it here, so a message written on either looks the
// same on both. The quote lives in the draft's text itself (the prefix and
// its blank line), so it survives leaving the chat and a reload with no
// change to the drafts' payload, and the send takes it with the rest. The
// composer shows the prefix as the chip ("Replying to Archiver", its x
// "Remove quote") and the rest in the box. The excerpt is plain text:
// Markdown taken out, line breaks folded, cut on a word, then escaped so
// nothing in it can end the quote or format it, and every `@` followed by a
// word joiner so a quoted `@Name` never mentions or routes. A message that
// starts with its quote is never a command: `invokedSkill` reads one only at
// the very start. Plain TypeScript, safe for Hermes.

/** The chip's x. */
export const REMOVE_QUOTE = 'Remove quote';
/** The chip's words for screen readers. */
export const replyingTo = (author: string) => `Replying to ${author}`;
/** A sent quote, as a screen reader says it. */
export const quoting = (author: string) => `Quoting ${author}`;

/**
 * Under the chip while the words typed start with `/` (Sol's review of #57): the server reads a
 * command only at the very start of a message, and a quote-reply starts with its quote, so the
 * command goes as ordinary text. The quote stays; Send still sends.
 */
export const QUOTED_COMMAND_NOTE = 'Commands don’t run in a reply. Remove the quote to run it.';

/** Whether the box's words look like a command while a quote is set: the note shows. */
export const quotedCommand = (quote: Quote | null, rest: string) => quote !== null && /^\s*\//.test(rest);

/** About how many characters of the quoted message the excerpt keeps. */
export const QUOTE_EXCERPT_MAX = 200;

/** Keeps `@` from starting a mention (shared's parseRoomMentions) and `!` or `<` from what follows. */
const WORD_JOINER = '\u2060';

/** CommonMark's backslash escapes the excerpt needs: emphasis, code, links, HTML, entities, tables. */
const ESCAPED = /[\\`*_[\]<>~|&]/g;

/** The author and excerpt shown, and the line the message starts with. */
export interface Quote {
    readonly author: string;
    readonly excerpt: string;
    /** `> **Author:** excerpt`, without the blank line after it. */
    readonly prefix: string;
}

/** A quote's text made inert: Markdown escaped, line breaks folded, `@` kept from mentioning. */
export function inertQuoteText(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .trim()
        .replace(ESCAPED, (char) => `\\${char}`)
        .replace(/@/g, `@${WORD_JOINER}`);
}

/** What `inertQuoteText` changed, taken back, for the chip. */
function shownQuoteText(text: string): string {
    return text.replace(/\u2060/g, '').replace(/\\([\\`*_[\]<>~|&])/g, '$1');
}

/** A Markdown message as one line of plain text: its blocks' markers, links' targets and code fences gone. */
export function plainOf(markdown: string): string {
    const body = splitQuote(markdown).rest;
    const lines = body.split('\n').flatMap((line) => {
        // A fence line itself says nothing; the code inside it stays as text.
        if (/^\s*(```|~~~)/.test(line)) {
            return [];
        }
        // A table's divider row.
        if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) {
            return [];
        }
        return [
            line
                // Quote markers, headings, list markers and task boxes at the start of a line.
                .replace(/^(\s*>)+\s?/, '')
                .replace(/^\s*#{1,6}\s+/, '')
                .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
                // A thematic break.
                .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, ''),
        ];
    });
    return (
        lines
            .join(' ')
            // Images and links keep their words.
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            // Autolinks keep their address, HTML tags go.
            .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, '$1')
            .replace(/<\/?[A-Za-z][^>]*>/g, '')
            // Strong, strikethrough and code marks; a single * or _ stays and is escaped later.
            .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
            .replace(/`+/g, '')
            // Table cells.
            .replace(/\s*\|\s*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
    );
}

/** The excerpt's words: at most about `QUOTE_EXCERPT_MAX` characters, cut on a word with "…". */
export function excerptOf(plain: string, max = QUOTE_EXCERPT_MAX): string {
    const folded = plain.replace(/\s+/g, ' ').trim();
    if (folded.length <= max) {
        return folded;
    }
    const cut = folded.slice(0, max + 1);
    const space = cut.lastIndexOf(' ');
    // A single long word (a link) is cut where it reaches the limit.
    const end = space > max / 2 ? space : max;
    return `${folded.slice(0, end).replace(/[\s.,;:!?…-]+$/, '')}…`;
}

/** A quote of `text` by `author`: the excerpt, and the line the message starts with. */
export function quoteOf(author: string, text: string): Quote {
    const name = author.replace(/\s+/g, ' ').trim() || 'Someone';
    const excerpt = excerptOf(plainOf(text));
    return { author: name, excerpt, prefix: `> **${inertQuoteText(name)}:** ${inertQuoteText(excerpt)}` };
}

/** The quote line: `> **Author:** excerpt`, the author and excerpt as `quoteOf` escapes them. */
const QUOTE_LINE = /^> \*\*((?:\\.|[^*\\\n])+):\*\* ([^\n]*)(?:\n\n|\n?$)/;

/** A draft's or a message's quote, if it starts with one, and the words after it. */
export function splitQuote(text: string): { quote: Quote | null; rest: string } {
    const match = QUOTE_LINE.exec(text);
    if (match === null) {
        return { quote: null, rest: text };
    }
    const prefix = match[0].replace(/\n+$/, '');
    return {
        quote: { author: shownQuoteText(match[1]!), excerpt: shownQuoteText(match[2]!), prefix },
        rest: text.slice(match[0].length),
    };
}

/** The draft's text with `quote` in front of what was typed (`null`: the quote removed). */
export function withQuote(quote: Pick<Quote, 'prefix'> | null, rest: string): string {
    return quote === null ? rest : `${quote.prefix}\n\n${rest}`;
}

/** The draft after Reply: the new quote in front, in place of any earlier one, the typed words kept. */
export const quotedDraft = (draft: string, quote: Pick<Quote, 'prefix'>) => withQuote(quote, splitQuote(draft).rest);

/**
 * Who a quote of `row` names, as the room names them, or null where Reply isn't offered:
 * a socio's reply by its socio (a room's speaker, else the chat's socio); another person's
 * message in a room by their name; the reader's own in a room by their name in the room
 * (the others would read "You" as themselves), else none. A private chat's own messages
 * have no Reply (quoting yourself to the socio adds nothing), nor does a reply still being
 * written or a message with no words. Where the chat has no box (a read-only room, a team
 * topic, a Telegram chat) the caller offers none either.
 */
export function replyAuthor(
    row: {
        readonly kind: 'user' | 'reply';
        readonly text: string;
        /** A room's speaker (the app's transcript.ts `Speaker`): the reader is `you`. */
        readonly speaker?: { readonly kind: string; readonly name: string };
        readonly streaming?: boolean;
    },
    context: { readonly socio: string | null; readonly room?: { readonly view: RoomView | null; readonly me: string } },
): string | null {
    if (row.text.trim() === '' || row.streaming === true) {
        return null;
    }
    if (row.kind === 'reply') {
        return row.speaker?.name ?? context.socio ?? 'Socio';
    }
    if (row.speaker === undefined || context.room === undefined) {
        return null;
    }
    if (row.speaker.kind !== 'you') {
        return row.speaker.name;
    }
    const me = context.room.view?.members.find((member) => member.userId === context.room?.me);
    return me === undefined || me.name.trim() === '' ? null : me.name;
}

/** A message's words for a screen reader: a quote it starts with said as "Quoting Ben: …", then the rest. */
export function spokenMessage(text: string): string {
    const { quote, rest } = splitQuote(text);
    return quote === null ? text : `${quoting(quote.author)}: ${quote.excerpt}. ${rest}`.trim();
}
