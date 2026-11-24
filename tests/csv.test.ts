import { describe, expect, it } from 'vitest';

import { CSV_FORMULA_START, csvField, csvRow, csvText } from '@socio/shared/text/csv';

describe('csvField', () => {
    it.each([
        ['=1+1', "'=1+1"],
        ['+cmd', "'+cmd"],
        ['-2+3', "'-2+3"],
        ['@SUM(A1)', "'@SUM(A1)"],
        ['\t=1', "'\t=1"],
        ['\r=1', '"\'\r=1"'],
        ['=HYPERLINK("https://example.com","x")', '"\'=HYPERLINK(""https://example.com"",""x"")"'],
        ['=1,2', '"\'=1,2"'],
    ])('guards %j', (input, output) => {
        expect(csvField(input)).toBe(output);
    });

    it('leaves text that starts elsewhere as it was', () => {
        expect(csvField('plain')).toBe('plain');
        expect(csvField('a=1')).toBe('a=1');
        expect(csvField("'quoted")).toBe("'quoted");
        expect(csvField('')).toBe('');
    });

    it('writes numbers, bigints and booleans unguarded', () => {
        expect(csvField(-5)).toBe('-5');
        expect(csvField(-1.5)).toBe('-1.5');
        expect(csvField(-9007199254740993n)).toBe('-9007199254740993');
        expect(csvField(true)).toBe('true');
        expect(csvField(false)).toBe('false');
    });

    it('guards a negative number stored as text', () => {
        expect(csvField('-5')).toBe("'-5");
    });

    it('writes null and undefined as empty fields', () => {
        expect(csvField(null)).toBe('');
        expect(csvField(undefined)).toBe('');
    });

    it('quotes as RFC 4180 asks', () => {
        expect(csvField('x,y')).toBe('"x,y"');
        expect(csvField('say "hi"')).toBe('"say ""hi"""');
        expect(csvField('two\nlines')).toBe('"two\nlines"');
        expect(csvField(' edge ')).toBe('" edge "');
    });

    it('guards base64 that starts with +, and the bytes come back without the apostrophe', () => {
        const formulas: Array<[number[], string]> = [
            [[0xfb, 0x5f, 0xb5], '+1+1'],
            [[248, 13, 116, 248, 13, 117], '+A10+A11'],
            [[0xfb, 0xff, 0xbf], '+/+/'],
        ];
        for (const [raw, encoded] of formulas) {
            const bytes = new Uint8Array(raw);
            expect(Buffer.from(bytes).toString('base64')).toBe(encoded);
            const field = csvField(bytes);
            expect(field).toBe(`'${encoded}`);
            expect([...Buffer.from(field.replace(/^'/, ''), 'base64')]).toEqual(raw);
        }
    });

    it('writes other bytes as plain base64', () => {
        expect(csvField(new Uint8Array([1, 2, 3]))).toBe('AQID');
        const big = new Uint8Array(100_000).fill(7);
        expect(csvField(big)).toBe(Buffer.from(big).toString('base64'));
    });

    it('matches exactly the formula starts', () => {
        expect(['=', '+', '-', '@', '\t', '\r'].every((c) => CSV_FORMULA_START.test(`${c}x`))).toBe(true);
        expect([' ', '#', "'", '\n', 'a', '1'].some((c) => CSV_FORMULA_START.test(`${c}x`))).toBe(false);
    });
});

describe('csvRow and csvText', () => {
    it('join fields with commas and lines with CRLF', () => {
        expect(csvRow(['a', 1, null, '=x'])).toBe("a,1,,'=x");
        expect(
            csvText([
                ['a', 'b'],
                ['=1', 2],
            ]),
        ).toBe("a,b\r\n'=1,2\r\n");
        expect(csvText([])).toBe('');
    });
});
