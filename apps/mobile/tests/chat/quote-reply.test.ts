import { describe, expect, it } from 'vitest';

import { parseRoomMentions } from '@socio/shared/rooms/room-mentions';
import type { RoomView } from '@socio/shared/rooms/rooms';

import { messageMenu, REPLY } from '../../src/chat/long-press';
import { safeMarkdown } from '../../src/chat/markdown';
import {
    excerptOf,
    inertQuoteText,
    plainOf,
    QUOTE_EXCERPT_MAX,
    quotedDraft,
    quoteOf,
    REMOVE_QUOTE,
    replyAuthor,
    replyingTo,
    spokenMessage,
    splitQuote,
    withQuote,
} from '../../src/chat/quote-reply';
import { bubbleLabel, type Speaker } from '../../src/chat/transcript';
import { MENU_SYMBOLS, nativeMenuItems } from '../../src/shell/native-menu';

// Quote-reply (CB-571): the excerpt, its escaping, the draft's prefix and who
// a quote names. The draft's round trip through user.db and the sends' payloads
// are in tests/sync/chat-drafts.test.ts, composer.test.ts and room-composer.test.ts.

describe('the excerpt', () => {
    it('takes a reply’s Markdown out and folds its lines', () => {
        const reply = [
            '# Plans',
            '',
            'Yes! **erden** is a German verb meaning *“to ground”*,',
            'see [the notes](https://example.com/notes) and `code`.',
            '',
            '- one',
            '- [x] two',
            '1. three',
            '> quoted',
            '![chart](https://example.com/a.png)',
            '```ts',
            'const a = 1;',
            '```',
            '| a | b |',
            '| --- | --- |',
            '| 1 | 2 |',
            '<b>bold</b> <https://example.com>',
        ].join('\n');
        expect(plainOf(reply)).toBe(
            'Plans Yes! erden is a German verb meaning *“to ground”*, see the notes and code. one two three ' +
                'quoted chart const a = 1; a b 1 2 bold https://example.com',
        );
    });

    it('cuts at about 200 characters on a word, with an ellipsis', () => {
        const words = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
        const excerpt = excerptOf(words);
        expect(excerpt.endsWith('…')).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(QUOTE_EXCERPT_MAX + 1);
        // Whole words only.
        expect(words.startsWith(excerpt.slice(0, -1))).toBe(true);
        expect(words[excerpt.length - 1]).toBe(' ');
        expect(excerptOf('short and sweet')).toBe('short and sweet');
        // A single long word is cut where it reaches the limit.
        expect(excerptOf('x'.repeat(500))).toBe(`${'x'.repeat(QUOTE_EXCERPT_MAX)}…`);
    });

    it('quotes the words after a quoted message’s own quote, not the quote again', () => {
        const earlier = `${quoteOf('Archiver', 'The first answer').prefix}\n\nMy question`;
        expect(plainOf(earlier)).toBe('My question');
    });
});

describe('escaping', () => {
    it('keeps Markdown in a quote from formatting or ending it', () => {
        expect(inertQuoteText('a *b* _c_ `d` [e](f) <g> ~h~ | & \\')).toBe(
            'a \\*b\\* \\_c\\_ \\`d\\` \\[e\\](f) \\<g\\> \\~h\\~ \\| \\& \\\\',
        );
        // Line breaks fold, so nothing can start a new block.
        expect(inertQuoteText('one\n\n# two\n- three')).toBe('one # two - three');
    });

    it('keeps a quoted @Name from mentioning or routing', () => {
        const quote = quoteOf('Ben', 'Ask @Sebas and @Ada about it');
        const text = withQuote(quote, 'Sure, @Ada?');
        const found = parseRoomMentions(text, {
            socios: [{ id: 'dot-s', name: 'Sebas' }],
            people: [{ id: 'u-ada', name: 'Ada' }],
        });
        // Only the words typed after the quote mention anyone.
        expect(found).toEqual({ socios: [], people: ['u-ada'] });
    });

    it('makes one blockquote line naming the author, which the renderer keeps as written', () => {
        const quote = quoteOf('Archiver', 'Yes!\n\n**erden** means *to ground*.');
        expect(quote.prefix).toBe('> **Archiver:** Yes! erden means \\*to ground\\*.');
        expect(quote.excerpt).toBe('Yes! erden means *to ground*.');
        expect(safeMarkdown(withQuote(quote, 'Thanks'))).toBe(withQuote(quote, 'Thanks'));
        // A name with Markdown in it.
        expect(quoteOf('Ana_B *', 'hi').prefix).toBe('> **Ana\\_B \\*:** hi');
        expect(quoteOf('  ', 'hi').author).toBe('Someone');
    });
});

describe('the draft', () => {
    it('reads the quote back from the text it writes, the escapes undone for the chip', () => {
        const quote = quoteOf('Ana_B', 'Look at *this* [link](https://example.com) @Ben');
        const draft = withQuote(quote, 'What do you think?');
        expect(splitQuote(draft)).toEqual({
            quote: { author: 'Ana_B', excerpt: 'Look at *this* link @Ben', prefix: quote.prefix },
            rest: 'What do you think?',
        });
        // Nothing typed yet: the quote alone.
        expect(splitQuote(withQuote(quote, ''))).toEqual({ quote: splitQuote(draft).quote, rest: '' });
        // The quote removed, the words kept.
        expect(withQuote(null, 'What do you think?')).toBe('What do you think?');
        expect(splitQuote('> just a quote of mine\n\nhi')).toEqual({
            quote: null,
            rest: '> just a quote of mine\n\nhi',
        });
    });

    it('puts a new quote in place of the earlier one and keeps what was typed', () => {
        const first = quoteOf('Archiver', 'First');
        const second = quoteOf('Ben', 'Second');
        expect(quotedDraft('Half a thought', first)).toBe(`${first.prefix}\n\nHalf a thought`);
        expect(quotedDraft(withQuote(first, 'Half a thought'), second)).toBe(`${second.prefix}\n\nHalf a thought`);
        expect(quotedDraft('', second)).toBe(`${second.prefix}\n\n`);
    });
});

describe('a sent quote', () => {
    it('is said in words, never its Markdown', () => {
        const text = withQuote(quoteOf('Ben', 'Lunch at *noon*?'), 'Sure');
        expect(spokenMessage(text)).toBe('Quoting Ben: Lunch at *noon*?. Sure');
        expect(spokenMessage('Plain')).toBe('Plain');
        // The bubble's label says it even with no speaker or time.
        expect(bubbleLabel({ text })).toBe('Quoting Ben: Lunch at *noon*?. Sure');
        expect(bubbleLabel({ text, speaker: { kind: 'you', name: 'You' } })).toBe(
            'You: Quoting Ben: Lunch at *noon*?. Sure',
        );
        expect(bubbleLabel({ text: 'Plain' })).toBeUndefined();
    });
});

describe('the menu and who a quote names', () => {
    const view = {
        members: [
            { userId: 'u-ada', name: 'Ada Lovelace' },
            { userId: 'u-ben', name: 'Ben' },
        ],
    } as unknown as RoomView;
    const room = { view, me: 'u-ada' };

    it('offers Reply first, with its symbol on iOS, only when asked', () => {
        expect(messageMenu(null).map((action) => action.name)).toEqual(['copy', 'share']);
        expect(messageMenu(null, true).map((action) => action.label)).toEqual(['Reply', 'Copy', 'Share']);
        expect(MENU_SYMBOLS[REPLY.name]).toBe('arrowshape.turn.up.left');
        expect(nativeMenuItems([REPLY], 'ios')[0]).toMatchObject({ id: 'reply', image: 'arrowshape.turn.up.left' });
        expect(nativeMenuItems([REPLY], 'android')[0]).toEqual({ id: 'reply', title: 'Reply' });
        expect(replyingTo('Archiver')).toBe('Replying to Archiver');
        expect(REMOVE_QUOTE).toBe('Remove quote');
    });

    it('names a reply’s socio, another person, or the reader by their name in the room', () => {
        const reply = { kind: 'reply' as const, text: 'Hi', streaming: false };
        expect(replyAuthor(reply, { socio: 'Archiver' })).toBe('Archiver');
        const sebas: Speaker = { kind: 'socio', name: 'Sebas', character: 'local' as never };
        expect(replyAuthor({ ...reply, speaker: sebas }, { socio: 'Archiver', room })).toBe('Sebas');
        const person = {
            kind: 'user' as const,
            text: 'Hello',
            speaker: { kind: 'person' as const, name: 'Ben', initials: 'B', tone: 'blue' as never },
        };
        expect(replyAuthor(person, { socio: 'Archiver', room })).toBe('Ben');
        const mine = { kind: 'user' as const, text: 'Mine', speaker: { kind: 'you' as const, name: 'You' } };
        expect(replyAuthor(mine, { socio: 'Archiver', room })).toBe('Ada Lovelace');
        // The reader's name not known yet: no Reply rather than "You".
        expect(replyAuthor(mine, { socio: 'Archiver', room: { view: null, me: 'u-ada' } })).toBeNull();
    });

    it('offers none on a private chat’s own message, a reply being written, or no words', () => {
        expect(replyAuthor({ kind: 'user', text: 'Mine' }, { socio: 'Archiver' })).toBeNull();
        expect(replyAuthor({ kind: 'reply', text: 'Hal', streaming: true }, { socio: 'Archiver' })).toBeNull();
        expect(replyAuthor({ kind: 'reply', text: '  ', streaming: false }, { socio: 'Archiver' })).toBeNull();
    });
});
