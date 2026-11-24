import { describe, expect, it } from 'vitest';

import {
    configErrors,
    configValueError,
    pluginConfigFieldError,
    validCron,
    type PluginConfigField,
} from '@socio/shared/plugins/plugin-config';

const field = (patch: Partial<PluginConfigField> = {}): PluginConfigField => ({ description: 'A setting.', ...patch });

describe('typed plugin settings (CB-395)', () => {
    it('takes any string when a field has no type, as before', () => {
        expect(configValueError(field(), 'anything at all')).toBeUndefined();
        expect(configValueError(field(), '')).toBeUndefined();
        expect(configValueError(field(), 'x'.repeat(2001))).toMatch(/at most 2000/);
    });

    it('refuses an empty required value, unless the field has a default', () => {
        expect(configValueError(field({ required: true }), '')).toBe('This setting is required.');
        expect(configValueError(field({ required: true, default: 'a' }), '')).toBeUndefined();
        expect(configValueError(field({ required: true }), 'set')).toBeUndefined();
    });

    it('takes true or false for a boolean', () => {
        const flag = field({ type: 'boolean' });
        expect(configValueError(flag, 'true')).toBeUndefined();
        expect(configValueError(flag, 'false')).toBeUndefined();
        expect(configValueError(flag, 'yes')).toBe('Use true or false.');
        expect(configValueError(flag, 'TRUE')).toBe('Use true or false.');
    });

    it('checks numbers, integers and their bounds', () => {
        const number = field({ type: 'number', min: 0, max: 10 });
        expect(configValueError(number, '2.5')).toBeUndefined();
        expect(configValueError(number, '-1')).toBe('Use a number from 0 to 10.');
        expect(configValueError(number, '11')).toBe('Use a number from 0 to 10.');
        expect(configValueError(number, '12abc')).toBe('Enter a number.');
        expect(configValueError(number, 'Infinity')).toBe('Enter a number.');
        const integer = field({ type: 'integer', min: 1 });
        expect(configValueError(integer, '3')).toBeUndefined();
        expect(configValueError(integer, '3.5')).toBe('Enter a whole number.');
        expect(configValueError(integer, '0')).toBe('Use 1 or more.');
        expect(configValueError(field({ type: 'integer', max: 5 }), '6')).toBe('Use 5 or less.');
    });

    it('takes only an enum’s options', () => {
        const choice = field({ type: 'enum', options: ['pit', 'oauth'] });
        expect(configValueError(choice, 'pit')).toBeUndefined();
        expect(configValueError(choice, 'other')).toBe('Choose one of: pit, oauth.');
    });

    it('checks cron expressions', () => {
        for (const ok of [
            '0 9 * * 1-5',
            '*/15 * * * *',
            '0 0 1 jan,jul *',
            '30 8 * * mon-fri',
            '0 */5 9 * * *',
            '@daily',
            '0 0 * * 7',
        ]) {
            expect(validCron(ok), ok).toBe(true);
        }
        for (const bad of [
            '',
            'every day',
            '60 * * * *',
            '* 24 * * *',
            '* * 0 * *',
            '* * * 13 *',
            '* * * * 8',
            '*/0 * * * *',
            '1-2-3 * * * *',
            '* * * *',
            '@sometimes',
            '5-1 * * * *',
        ]) {
            expect(validCron(bad), bad).toBe(false);
        }
        expect(configValueError(field({ type: 'cron' }), 'nightly')).toMatch(/cron expression/);
    });

    it('takes an absolute http or https URL', () => {
        const url = field({ type: 'url' });
        expect(configValueError(url, 'https://event-docs.example.dev')).toBeUndefined();
        expect(configValueError(url, 'http://localhost:4310/x')).toBeUndefined();
        expect(configValueError(url, 'event-docs.example.dev')).toMatch(/http or https/);
        expect(configValueError(url, 'javascript:alert(1)')).toMatch(/http or https/);
        expect(configValueError(url, 'ftp://example.com')).toMatch(/http or https/);
    });

    it('matches a string’s pattern in full', () => {
        const id = field({ pattern: '[A-Za-z0-9]{20}' });
        expect(configValueError(id, 'JvXAXG9qFWNgJ66nHF9N')).toBeUndefined();
        expect(configValueError(id, 'JvXAXG9qFWNgJ66nHF9N-extra')).toMatch(/expected format/);
    });

    it('lists every field’s error for a whole config', () => {
        const fields = {
            A: field({ type: 'boolean' }),
            B: field({ required: true }),
            C: field({ type: 'integer' }),
        };
        expect(configErrors(fields, { A: 'maybe', C: '4' })).toEqual({
            A: 'Use true or false.',
            B: 'This setting is required.',
        });
    });

    it('accepts well-formed manifest fields and says what is wrong with the others', () => {
        expect(pluginConfigFieldError({ description: 'x' })).toBeUndefined();
        expect(
            pluginConfigFieldError({ description: 'x', type: 'enum', options: ['a', 'b'], default: 'a' }),
        ).toBeUndefined();
        expect(
            pluginConfigFieldError({ description: 'x', type: 'integer', min: 1, max: 5, required: true }),
        ).toBeUndefined();
        expect(pluginConfigFieldError({ description: 'x', type: 'cron', default: '0 9 * * *' })).toBeUndefined();
        const bad: [Record<string, unknown>, RegExp][] = [
            [{}, /description/],
            [{ description: 'x', default: 3 }, /default must be a string/],
            [{ description: 'x', type: 'date' }, /type must be one of/],
            [{ description: 'x', required: 'yes' }, /required/],
            [{ description: 'x', type: 'enum' }, /options/],
            [{ description: 'x', type: 'enum', options: ['a', 'a'] }, /distinct/],
            [{ description: 'x', options: ['a'] }, /enum only/],
            [{ description: 'x', min: 1 }, /number or an integer only/],
            [{ description: 'x', type: 'number', min: '1' }, /min must be a number/],
            [{ description: 'x', type: 'number', min: 5, max: 1 }, /min is above max/],
            [{ description: 'x', type: 'url', pattern: 'a' }, /string only/],
            [{ description: 'x', pattern: '(' }, /not a valid regular expression/],
            [{ description: 'x', type: 'boolean', default: 'yes' }, /default does not fit/],
            [{ description: 'x', type: 'enum', options: ['a'], default: 'b' }, /default does not fit/],
        ];
        for (const [entry, message] of bad) {
            expect(pluginConfigFieldError(entry), JSON.stringify(entry)).toMatch(message);
        }
    });
});
