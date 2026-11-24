import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROFILE_FIELDS } from '@socio/shared/memory';

import { PROFILE_FORM } from '../src/shell/memories';

// On the sign-in screen and the invite's set-password form the keyboard covered the next
// field, and its Next key did nothing, so the only way on was to close the keyboard. Every Field
// whose key says Next must move the focus to a field after it that takes a ref (`submitBehavior`
// "submit" keeps the keyboard up while it does).
const SCREENS = join(import.meta.dirname, '../src/screens');

/** Each `<Field … />` element's attributes, in source order. */
function fields(source: string) {
    return [...source.matchAll(/<Field\b([\s\S]*?)\/>/g)].map((match) => match[1]);
}

/** The ways in's forms, and File an issue's. */
const FILES = ['sign-in.tsx', 'invite.tsx', 'sign-in-code.tsx', 'file-issue.tsx'];

describe("a Field's Next key on the ways in", () => {
    it('is found on the sign-in and invite screens', () => {
        for (const name of ['sign-in.tsx', 'invite.tsx']) {
            expect(
                fields(readFileSync(join(SCREENS, name), 'utf8')).filter((attrs) =>
                    attrs.includes('returnKeyType="next"'),
                ).length,
                name,
            ).toBeGreaterThan(0);
        }
    });

    it.each(FILES)('moves to a later field in %s', (name) => {
        const all = fields(readFileSync(join(SCREENS, name), 'utf8'));
        all.forEach((attrs, index) => {
            if (!attrs.includes('returnKeyType="next"')) {
                return;
            }
            const target = /onSubmitEditing=\{\(\) => (\w+)\.current\?\.focus\(\)\}/.exec(attrs)?.[1];
            expect(target, `${name}: field ${index + 1} says Next but focuses nothing`).toBeDefined();
            expect(attrs, `${name}: field ${index + 1}`).toContain('submitBehavior="submit"');
            const later = all.slice(index + 1).some((other) => other.includes(`ref={${target}}`));
            expect(later, `${name}: ${target} isn't a later field's ref`).toBe(true);
        });
    });
});

// The same gap on the app's other forms: File an issue's title said Next and did nothing, and the
// profile sheet's one-line fields (name to language) had no Next at all.
describe("a Field's Next key on the app's other forms", () => {
    it("moves from File an issue's title to its description, which keeps its new lines", () => {
        const all = fields(readFileSync(join(SCREENS, 'file-issue.tsx'), 'utf8'));
        const title = all.find((attrs) => attrs.includes('label="Title"'));
        const body = all.find((attrs) => attrs.includes('label="Description"'));
        expect(title).toContain('returnKeyType="next"');
        expect(title).toContain('submitBehavior="submit"');
        const target = /onSubmitEditing=\{\(\) => (\w+)\.current\?\.focus\(\)\}/.exec(title ?? '')?.[1];
        expect(target).toBeDefined();
        expect(body).toContain(`ref={${target}}`);
        expect(body).toContain('multiline');
        expect(body).not.toContain('returnKeyType');
        expect(body).not.toContain('submitBehavior');
    });

    it("chains the profile's one-line fields in order, and leaves its paragraphs' Return alone", () => {
        expect(PROFILE_FORM.map((field) => [field.name, field.next])).toEqual([
            ['name', 'pronouns'],
            ['pronouns', 'role'],
            ['role', 'timezone'],
            ['timezone', 'language'],
            ['language', 'style'],
            ['style', null],
            ['instructions', null],
        ]);
        for (const field of PROFILE_FORM) {
            if (field.next !== null) {
                expect(PROFILE_FIELDS.indexOf(field.next)).toBeGreaterThan(PROFILE_FIELDS.indexOf(field.name));
            }
        }
    });

    it("wires the profile sheet's Next to the next field's input", () => {
        const source = readFileSync(join(SCREENS, 'memories.tsx'), 'utf8');
        const sheet = source.slice(source.indexOf('function ProfileSheet'));
        const field = fields(sheet).find((attrs) => attrs.includes('PROFILE_FORM') || attrs.includes('field.label'));
        expect(field).toBeDefined();
        expect(field).toContain('inputs.current[field.name] = input');
        expect(field).toMatch(/field\.long\s*\?\s*\{\}/);
        expect(field).toContain("returnKeyType: 'next'");
        expect(field).toContain("submitBehavior: 'submit'");
        expect(field).toContain('onSubmitEditing: () => inputs.current[field.next!]?.focus()');
        expect(field).toContain("returnKeyType: 'done'");
    });
});
