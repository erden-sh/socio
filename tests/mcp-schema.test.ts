import { expect, it } from 'vitest';

import { reviewMcpCatalog } from '../src/server/mcp/catalog.js';
import { inspectMcpSchema, validateMcpInput } from '../src/server/mcp/schema.js';

const schema = {
    type: 'object',
    properties: {
        operation: { type: 'string', enum: ['read', 'write'] },
        input: {
            type: 'object',
            properties: { count: { type: 'integer', minimum: 1, maximum: 3 } },
            required: ['count'],
            additionalProperties: false,
        },
    },
    required: ['operation', 'input'],
    additionalProperties: false,
};
it('validates full original JSON Schema constraints without lossy conversion or external fetch', async () => {
    await expect(validateMcpInput(schema, { operation: 'read', input: { count: 2 } })).resolves.toBeUndefined();
    for (const input of [
        { operation: 'delete', input: { count: 2 } },
        { operation: 'read', input: { count: 4 } },
        { operation: 'read', input: { count: 1, extra: 2 } },
        { operation: 'read', input: { count: 1 }, extra: 2 },
    ]) {
        await expect(validateMcpInput(schema, input)).rejects.toThrow('Arguments');
    }
});
it('keeps unsupported schemas visible but ungrantable and fingerprints descriptions, schemas and output contracts', () => {
    const tool = {
        name: 'execute_operation',
        description: 'Review me',
        inputSchema: schema,
    };
    const a = reviewMcpCatalog([tool]);
    expect(a.tools[0]?.supported).toBe(true);
    for (const patch of [
        { description: 'Changed' },
        { inputSchema: { type: 'object' } },
        { outputSchema: { type: 'object' } },
    ]) {
        expect(reviewMcpCatalog([{ ...tool, ...patch }]).revision).not.toBe(a.revision);
    }
    expect(
        reviewMcpCatalog([
            {
                ...tool,
                inputSchema: { type: 'object', unevaluatedProperties: false },
            },
        ]).tools[0],
    ).toMatchObject({ supported: false, refusal: expect.any(String) });
    expect(
        reviewMcpCatalog([
            {
                ...tool,
                inputSchema: {
                    type: 'object',
                    properties: { x: { $ref: 'https://example.test/schema' } },
                },
            },
        ]).tools[0]?.supported,
    ).toBe(false);
});
it('rejects duplicate names, unsafe object keys, excessive arguments and malformed schema keywords', async () => {
    const tool = { name: 'tool', inputSchema: schema };
    expect(() => reviewMcpCatalog([tool, tool])).toThrow('unique');
    expect(() =>
        inspectMcpSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')),
    ).toThrow('Unsafe');
    expect(() => inspectMcpSchema({ type: 'object', minimum: '1' })).toThrow('numeric');
    expect(() =>
        inspectMcpSchema({
            type: 'object',
            properties: { x: { type: 'magical' } },
        }),
    ).toThrow('type');
    await expect(validateMcpInput({ type: 'object' }, { text: 'x'.repeat(4097) })).rejects.toThrow('size');
});
it('can cancel or terminate pathological validators without blocking the main event loop', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(validateMcpInput(schema, {}, cancelled.signal)).rejects.toThrow();
    await expect(
        validateMcpInput(
            {
                type: 'object',
                properties: { x: { type: 'string', pattern: '^(a+)+$' } },
            },
            { x: 'a'.repeat(1500) + '!' },
            undefined,
            300,
        ),
    ).rejects.toThrow(/limit|validated|stopped/);
});

it('refuses legacy/malformed drafts, unresolved or recursive local refs and unknown formats without weakening constraints', async () => {
    for (const $schema of [
        'http://json-schema.org/draft-04/schema#',
        'http://json-schema.org/draft-07/schema#',
        'https://json-schema.org/draft/2019-09/schema',
    ]) {
        for (const exclusiveMinimum of [true, 2]) {
            expect(() =>
                inspectMcpSchema({
                    $schema,
                    type: 'object',
                    properties: { x: { type: 'number', minimum: 1, exclusiveMinimum } },
                }),
            ).toThrow('2020-12');
        }
    }
    for (const candidate of [
        {
            type: 'object',
            properties: {
                x: {
                    $schema: 'http://json-schema.org/draft-04/schema#',
                    type: 'number',
                    exclusiveMinimum: 2,
                },
            },
        },
        { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } },
        {
            type: 'object',
            $defs: { node: { $ref: '#/$defs/node' } },
            properties: { next: { $ref: '#/$defs/node' } },
        },
        {
            type: 'object',
            properties: { x: { type: 'string', format: 'unimplemented-format' } },
        },
        {
            type: 'object',
            properties: { x: { type: 'array', items: [{ type: 'string' }] } },
        },
    ]) {
        expect(() => inspectMcpSchema(candidate)).toThrow();
    }
    const refs = {
        type: 'object',
        $defs: { positive: { type: 'integer', exclusiveMinimum: 2 } },
        properties: { x: { $ref: '#/$defs/positive' } },
        required: ['x'],
        additionalProperties: false,
    };
    await expect(validateMcpInput(refs, { x: 3 })).resolves.toBeUndefined();
    await expect(validateMcpInput(refs, { x: 2 })).rejects.toThrow('Arguments');
    const email = {
        type: 'object',
        properties: { email: { type: 'string', format: 'email' } },
        required: ['email'],
    };
    await expect(validateMcpInput(email, { email: 'person@example.test' })).resolves.toBeUndefined();
    await expect(validateMcpInput(email, { email: 'not-an-address' })).rejects.toThrow('Arguments');
});

it('the actual SDK validator rejects false local refs and malformed regexes even on an optional field', async () => {
    await expect(
        validateMcpInput(
            {
                type: 'object',
                $defs: { deny: false },
                properties: { x: { $ref: '#/$defs/deny' } },
                required: ['x'],
            },
            { x: 'anything' },
        ),
    ).rejects.toThrow('Arguments');
    await expect(
        validateMcpInput({ type: 'object', properties: { x: { type: 'string', pattern: '[' } } }, {}),
    ).rejects.toThrow('unsupported');
});
