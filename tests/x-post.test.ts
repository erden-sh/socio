import { expect, it } from 'vitest';

import { accountHandle, formatZonedLocal, parseZonedLocal } from '@socio/shared/planner';
import { X_POST_LIMIT, intentUrl, overLimit, threadIntents, weightedLength, weightProgram } from '@socio/shared/x-post';

/** The page script must count the same way the server does. */
function pageLength(text: string) {
    const fn = new Function('text', `${weightProgram()}; return weightedLength(text);`);
    return fn(text) as number;
}

it('counts the way X does: most letters once, emoji and CJK twice, URLs as 23', () => {
    expect(weightedLength('a'.repeat(280))).toBe(280);
    expect(weightedLength('a'.repeat(281))).toBe(281);
    expect(overLimit('a'.repeat(280))).toBe(false);
    expect(overLimit('a'.repeat(281))).toBe(true);
    expect(weightedLength('😀')).toBe(2);
    expect(weightedLength('中')).toBe(2);
    expect(weightedLength('https://example.com/a/very/long/path')).toBe(23);
    // The comma after the URL is punctuation, not part of the URL, and counts.
    expect(weightedLength('https://example.com/a,')).toBe(23 + 1);
    expect(weightedLength('see https://example.com/a, now')).toBe(4 + 23 + 5);
    expect(weightedLength('www.example.com/docs')).toBe(23);
    expect(weightedLength('')).toBe(0);
    expect(X_POST_LIMIT).toBe(280);
});

it('keeps the page script on the same weights', () => {
    const samples = [
        'hello',
        'a'.repeat(280),
        'ship 😀 today',
        'https://x.com/acme/status/1',
        'Read https://example.com/path. Then reply.',
        'www.example.com',
        '中文 post',
        '',
    ];
    for (const sample of samples) {
        expect(pageLength(sample), sample).toBe(weightedLength(sample));
    }
});

it('builds an intent link and never a post endpoint', () => {
    const url = new URL(intentUrl('Hello & friends'));
    expect(url.origin + url.pathname).toBe('https://x.com/intent/post');
    expect(url.searchParams.get('text')).toBe('Hello & friends');
    expect(url.searchParams.get('in_reply_to')).toBeNull();
    const reply = new URL(intentUrl('On it', '12345'));
    expect(reply.searchParams.get('in_reply_to')).toBe('12345');
    expect(intentUrl('hi')).not.toContain('api.x.com');
    expect(intentUrl('hi')).not.toContain('statuses/update');
});

it('threads a reply only once the previous part has an id', () => {
    const links = threadIntents([{ text: 'First' }, { text: 'Second' }, { text: 'Third', xId: 'c' }]);
    expect(new URL(links[0]!.url).searchParams.get('in_reply_to')).toBeNull();
    expect(new URL(links[1]!.url).searchParams.get('in_reply_to')).toBeNull();
    const posted = threadIntents([{ text: 'First', xId: '111' }, { text: 'Second' }]);
    expect(new URL(posted[1]!.url).searchParams.get('text')).toBe('Second');
    expect(new URL(posted[1]!.url).searchParams.get('in_reply_to')).toBe('111');
});

it('reads a New York wall time and a handle without @', () => {
    const wall = '2026-01-15T09:30';
    const utc = parseZonedLocal(wall);
    expect(utc).toBeTypeOf('number');
    expect(formatZonedLocal(utc!)).toBe(wall);
    // January is Eastern Standard Time, five hours behind UTC.
    expect(new Date(utc!).toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(accountHandle(' @Example_Co ')).toBe('example_co');
});
