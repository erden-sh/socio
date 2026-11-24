import { expect, it } from 'vitest';

import { argumentsSummary, readToolArguments } from '@socio/foundation/turns/tool-call-args';

it('reads valid tool arguments as they are', () => {
    expect(readToolArguments(' {"title":"Notes"} ')).toEqual({
        args: { title: 'Notes' },
    });
});

it('repairs only the tool-argument breaks that leave no doubt (CB-12)', () => {
    expect(readToolArguments('{"a":{"b":[1,2]}}}')).toEqual({
        args: { a: { b: [1, 2] } },
        repair: 'trailing text',
    });
    expect(readToolArguments('{"a":"}"} <|im_end|>')).toEqual({
        args: { a: '}' },
        repair: 'trailing text',
    });
    expect(readToolArguments('{"a":{"b":"x"}')).toEqual({
        args: { a: { b: 'x' } },
        repair: 'missing closing brace',
    });
    expect(readToolArguments('{"a":[1,2]')).toEqual({
        args: { a: [1, 2] },
        repair: 'missing closing brace',
    });
    expect(readToolArguments(JSON.stringify('{"a":"\\"x\\""}'))).toEqual({
        args: { a: '"x"' },
        repair: 'double-encoded',
    });
    for (const unreadable of [
        // Cut off: a string, a number (5 or 50?), a key, after a comma.
        '{"content":"# Not',
        '{"limit":5',
        '{"title":"Notes","content"',
        '{"title":"Notes",',
        // Two calls run together: never drop the second.
        '{"a":1}{"b":2}',
        '{"a":1} {"b":"2"}',
        // Not an object at all.
        '[{"a":1}]',
        '"just text"',
        '42',
        'title=Notes',
        '{"a":1]',
    ]) {
        expect(readToolArguments(unreadable)).toBeUndefined();
    }
});

it('describes tool arguments by size and a short excerpt only', () => {
    const raw = `{"content":"${'private '.repeat(20)}"}`;
    const summary = argumentsSummary(raw);
    expect(summary).toBe(`${raw.length} characters, starting "{\\"content\\":\\"priv", ending "ivate private \\"}"`);
    expect(summary.match(/private/g)).toHaveLength(1);
    expect(argumentsSummary('{"a":')).toBe('5 characters, "{\\"a\\":"');
});
