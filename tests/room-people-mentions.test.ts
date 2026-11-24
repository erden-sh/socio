import { expect, it } from 'vitest';

import { noticePreview, roomNoticeWanted } from '@socio/shared/rooms/room-notices';
import {
    confirmedMentions,
    insertMention,
    matchingPeople,
    mentionQuery,
    tokenCounts,
} from '@socio/shared/rooms/room-people-mentions';

// CB-216: people's mentions are structured (picked, by id), never read
// from the text alone; the same rules in the composer and the server.

const names = new Map([
    ['ana-1', 'Ana Lima'],
    ['ana-2', 'Ana Lima'],
    ['ana-short', 'Ana'],
    ['bo', 'Bo'],
    ['ada', 'Ada'],
]);

it('keeps two people who share a name apart by id', () => {
    // One pick of the first Ana Lima: only her, though the name is shared.
    expect(
        confirmedMentions('Hi @Ana Lima', [{ userId: 'ana-1', label: 'Ana Lima' }], {
            names,
        }),
    ).toEqual([{ userId: 'ana-1', label: 'Ana Lima' }]);
    // Both picked: the name must stand twice.
    const both = [
        { userId: 'ana-1', label: 'Ana Lima' },
        { userId: 'ana-2', label: 'Ana Lima' },
    ];
    expect(confirmedMentions('@Ana Lima and @Ana Lima', both, { names })).toEqual(both);
    expect(confirmedMentions('@Ana Lima only once', both, { names })).toEqual([]);
});

it('never takes typed, pasted or quoted text for a mention', () => {
    // Typed without picking: nobody.
    expect(confirmedMentions('@Bo look at this', [], { names })).toEqual([]);
    // A pick whose name was taken out of the text: nobody.
    expect(
        confirmedMentions('look at this', [{ userId: 'bo', label: 'Bo' }], {
            names,
        }),
    ).toEqual([]);
    // A pick claiming another person's id under someone else's name: nobody.
    expect(confirmedMentions('@Bo hi', [{ userId: 'ada', label: 'Bo' }], { names })).toEqual([]);
    // Someone outside the room, the author, a socio's name: nobody.
    expect(
        confirmedMentions(
            '@Nina @Ada @Manny',
            [
                { userId: 'nina', label: 'Nina' },
                { userId: 'ada', label: 'Ada' },
                { userId: 'manny-person', label: 'Manny' },
            ],
            {
                names: new Map([...names, ['manny-person', 'Manny']]),
                authorId: 'ada',
                socioNames: ['Manny'],
            },
        ),
    ).toEqual([]);
    // An email address is no mention.
    expect(
        confirmedMentions('mail ada@Bo.example', [{ userId: 'bo', label: 'Bo' }], {
            names,
        }),
    ).toEqual([]);
});

it('gives each @ to the longest name that fits', () => {
    expect(tokenCounts('@Ana Lima, @Ana!', ['Ana', 'Ana Lima'])).toEqual(
        new Map([
            ['ana lima', 1],
            ['ana', 1],
        ]),
    );
    // Picked "Ana", but the text only says "@Ana Lima": not Ana's.
    expect(
        confirmedMentions('@Ana Lima', [{ userId: 'ana-short', label: 'Ana' }], {
            names,
        }),
    ).toEqual([]);
    // `@Bob` is not `@Bo`.
    expect(confirmedMentions('@Bob', [{ userId: 'bo', label: 'Bo' }], { names })).toEqual([]);
    // Any case, folded spaces, each person once.
    expect(
        confirmedMentions(
            '@bo and @BO',
            [
                { userId: 'bo', label: 'Bo' },
                { userId: 'bo', label: 'Bo' },
            ],
            { names },
        ),
    ).toEqual([{ userId: 'bo', label: 'Bo' }]);
});

it('follows the @query being typed and puts the picked name in', () => {
    expect(mentionQuery('Hi @An', 6)).toEqual({ start: 3, query: 'An' });
    expect(mentionQuery('Hi @Ana Li', 10)).toEqual({ start: 3, query: 'Ana Li' });
    expect(mentionQuery('mail ada@x', 10)).toBeUndefined();
    expect(mentionQuery('@a\nb', 4)).toBeUndefined();
    expect(mentionQuery('no at', 5)).toBeUndefined();
    expect(mentionQuery('@ x', 3)).toBeUndefined();
    const people = [...names].map(([userId, name]) => ({ userId, name }));
    expect(matchingPeople(people, 'lim').map((person) => person.userId)).toEqual(['ana-1', 'ana-2']);
    expect(matchingPeople(people, 'b').map((person) => person.userId)).toEqual(['bo']);
    expect(insertMention('Hi @An there', 3, 6, 'Ana Lima')).toEqual({
        text: 'Hi @Ana Lima there',
        caret: 13,
    });
});

it('sends each level only what it asks for, and previews short', () => {
    expect(roomNoticeWanted('mute', 'mention')).toBe(false);
    expect(roomNoticeWanted('mentions', 'mention')).toBe(true);
    expect(roomNoticeWanted('mentions', 'own_turn')).toBe(true);
    expect(roomNoticeWanted('mentions', 'own_report')).toBe(true);
    expect(roomNoticeWanted('mentions', 'activity')).toBe(false);
    expect(roomNoticeWanted('mentions', 'report')).toBe(false);
    expect(roomNoticeWanted('all', 'activity')).toBe(true);
    expect(noticePreview('a\n\n b')).toBe('a b');
    expect(noticePreview('x'.repeat(400))).toHaveLength(280);
});
