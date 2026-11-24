import { expect, it } from 'vitest';

import { MARKS_MAX, inertText } from '@socio/shared/text/inert-text';

// The consent cards' inert text (CB-232): every invisible or reordering character shows as an
// escape, and stacked combining marks are capped. Escapes first.

const text = (value: string) => inertText(value, { max: 500 });
const at = (code: number) => String.fromCodePoint(code);
const hex = (code: number) => `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`;

it('escapes the hieroglyph, shorthand and musical format controls', () => {
    for (const code of [0x13430, 0x13438, 0x1343f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a]) {
        expect(text(`a${at(code)}b`)).toBe(`a${hex(code)}b`);
    }
});

it('escapes every other invisible character the review names', () => {
    for (const code of [
        0x2028, 0x2029, 0x061c, 0x180b, 0x180f, 0xfe00, 0xfe0f, 0xe0000, 0xe0041, 0xe007f, 0x034f, 0x115f, 0x1160,
        0x3164, 0xffa0, 0x202e, 0x200b,
    ]) {
        expect(text(`a${at(code)}b`)).toBe(`a${hex(code)}b`);
    }
});

it('caps the combining marks on one character, and says how many it left out', () => {
    const acute = '́';
    const zalgo = `Z${acute.repeat(40)}ok`;
    expect(text(zalgo)).toBe(`Z${acute.repeat(MARKS_MAX)}[+36 marks]ok`);
    // Per character: the next one gets its own.
    expect(text(`a${acute.repeat(6)}b${acute.repeat(6)}`)).toBe(
        `a${acute.repeat(4)}[+2 marks]b${acute.repeat(4)}[+2 marks]`,
    );
    // Marks with no character before them, and at the cut.
    expect(text(acute.repeat(5))).toBe(`${acute.repeat(4)}[+1 marks]`);
    expect(inertText(`x${acute.repeat(9)}y`, { max: 7 })).toBe(`x${acute.repeat(4)}[+2 marks]…`);
});

it('leaves ordinary text as it is: accents, scripts and emoji', () => {
    for (const value of [
        'Café “Prices” – 42 €',
        'e\u0301', // e and a combining acute
        'क्षत्रिय', // Devanagari, with its marks
        'Ελληνικά, 日本語, עברית',
        'Ship it 🚀',
    ]) {
        expect(text(value)).toBe(value);
    }
});
