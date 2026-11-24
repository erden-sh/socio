import { createHash } from 'node:crypto';

import { MCP_LIMITS } from '@socio/shared/mcp-connections';

import { mcpAssert } from './errors.js';

export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** Reject cycles, prototypes and excess structure before any schema or protocol work. */
export function boundedJson(value: unknown, maxBytes: number): void {
    const seen = new Set<object>();
    let nodes = 0;
    const visit = (item: unknown, depth: number) => {
        mcpAssert(++nodes <= MCP_LIMITS.nodes && depth <= MCP_LIMITS.depth, 'External tool data is too complex.');
        if (item === null || typeof item === 'string' || typeof item === 'boolean') {
            return;
        }
        if (typeof item === 'number') {
            mcpAssert(Number.isFinite(item), 'External tool data must contain finite numbers.');
            return;
        }
        mcpAssert(typeof item === 'object' && item && !seen.has(item), 'External tool data must be ordinary JSON.');
        seen.add(item);
        mcpAssert(
            Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)),
            'External tool data must be ordinary JSON.',
        );
        for (const [key, child] of Object.entries(item)) {
            mcpAssert(!['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe external tool data key.');
            visit(child, depth + 1);
        }
        seen.delete(item);
    };
    visit(value, 0);
    mcpAssert(jsonBytes(value) <= maxBytes, 'External tool data exceeds its size limit.');
}
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalJson).join(',') + ']';
    }
    if (value && typeof value === 'object') {
        return (
            '{' +
            Object.keys(value)
                .sort()
                .map((key) => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]))
                .join(',') +
            '}'
        );
    }
    return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
