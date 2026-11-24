import { Worker } from 'node:worker_threads';

import { MCP_LIMITS } from '@socio/shared/mcp-connections';

import { mcpAssert, mcpError } from './errors.js';
import { boundedJson, canonicalJson } from './json.js';

const allowed = new Set(
    '$schema $id $anchor $ref $defs definitions type title description default examples deprecated readOnly writeOnly enum const allOf anyOf oneOf not if then else properties patternProperties additionalProperties required propertyNames minProperties maxProperties dependentRequired dependentSchemas dependencies items additionalItems prefixItems contains minContains maxContains minItems maxItems uniqueItems minLength maxLength pattern format contentEncoding contentMediaType minimum maximum exclusiveMinimum exclusiveMaximum multipleOf'.split(
        ' ',
    ),
);
const maps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const lists = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const singles = new Set([
    'not',
    'if',
    'then',
    'else',
    'additionalProperties',
    'additionalItems',
    'propertyNames',
    'contains',
]);
export function inspectMcpSchema(schema: Record<string, unknown>): '2020-12' {
    boundedJson(schema, MCP_LIMITS.schemaBytes);
    mcpAssert(schema.type === 'object', 'External tool inputs must use an object schema.');
    mcpAssert(
        !schema.$schema ||
            ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2020-12/schema#'].includes(
                String(schema.$schema),
            ),
        'Only bounded JSON Schema 2020-12 is supported.',
    );
    const schemaNodes = new Set<Record<string, unknown>>();
    const edges = new Map<Record<string, unknown>, Record<string, unknown>[]>();
    let currentParent: Record<string, unknown> | undefined;
    const visit = (value: unknown) => {
        if (typeof value === 'boolean') {
            return;
        }
        mcpAssert(value && typeof value === 'object' && !Array.isArray(value), 'Unsupported external input schema.');
        const node = value as Record<string, unknown>;
        schemaNodes.add(node);
        if (currentParent) {
            const list = edges.get(currentParent) ?? [];
            list.push(node);
            edges.set(currentParent, list);
        }
        const previous = currentParent;
        currentParent = node;
        for (const [key, child] of Object.entries(value)) {
            if (key === '$schema') {
                mcpAssert(
                    [
                        'https://json-schema.org/draft/2020-12/schema',
                        'https://json-schema.org/draft/2020-12/schema#',
                    ].includes(String(child)),
                    'Only bounded JSON Schema 2020-12 is supported.',
                );
            }
            mcpAssert(
                !['$id', '$anchor', 'definitions', 'dependencies', 'additionalItems'].includes(key),
                'This schema uses unsupported resource or legacy draft semantics.',
            );
            mcpAssert(allowed.has(key), 'The external tool uses unsupported JSON Schema keywords.');
            if (
                [
                    '$schema',
                    '$id',
                    '$anchor',
                    '$ref',
                    'title',
                    'description',
                    'pattern',
                    'format',
                    'contentEncoding',
                    'contentMediaType',
                ].includes(key)
            ) {
                mcpAssert(typeof child === 'string', 'Invalid JSON Schema string keyword.');
            }
            if (['readOnly', 'writeOnly', 'deprecated', 'uniqueItems'].includes(key)) {
                mcpAssert(typeof child === 'boolean', 'Invalid JSON Schema boolean keyword.');
            }
            if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key)) {
                mcpAssert(
                    typeof child === 'number' && Number.isFinite(child) && (key !== 'multipleOf' || child > 0),
                    'Unsupported numeric JSON Schema keyword.',
                );
            }
            if (
                [
                    'minProperties',
                    'maxProperties',
                    'minLength',
                    'maxLength',
                    'minItems',
                    'maxItems',
                    'minContains',
                    'maxContains',
                ].includes(key)
            ) {
                mcpAssert(
                    typeof child === 'number' && Number.isSafeInteger(child) && child >= 0,
                    'Invalid JSON Schema count keyword.',
                );
            }
            if (key === 'type') {
                const types = Array.isArray(child) ? child : [child];
                mcpAssert(
                    types.length > 0 &&
                        new Set(types).size === types.length &&
                        types.every((t) =>
                            ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(t)),
                        ),
                    'Unsupported JSON Schema type.',
                );
            }
            if (key === 'required') {
                mcpAssert(
                    Array.isArray(child) &&
                        child.every((x) => typeof x === 'string') &&
                        new Set(child).size === child.length,
                    'Invalid required properties.',
                );
            }
            if (key === 'enum') {
                mcpAssert(
                    Array.isArray(child) && child.length > 0 && new Set(child.map(canonicalJson)).size === child.length,
                    'Invalid JSON Schema enum.',
                );
            }
            if (key === 'dependentRequired') {
                mcpAssert(
                    child && typeof child === 'object' && !Array.isArray(child),
                    'Invalid dependent required properties.',
                );
                for (const names of Object.values(child)) {
                    mcpAssert(
                        Array.isArray(names) && names.every((x) => typeof x === 'string'),
                        'Invalid dependent required properties.',
                    );
                }
            }
            if (key === 'format') {
                mcpAssert(
                    [
                        'date',
                        'time',
                        'date-time',
                        'duration',
                        'uri',
                        'uri-reference',
                        'uri-template',
                        'url',
                        'email',
                        'hostname',
                        'ipv4',
                        'ipv6',
                        'regex',
                        'uuid',
                        'json-pointer',
                        'json-pointer-uri-fragment',
                        'relative-json-pointer',
                    ].includes(String(child)),
                    'This schema uses an unsupported format.',
                );
            }
            if (key === '$ref') {
                mcpAssert(
                    typeof child === 'string' && child.startsWith('#'),
                    'External schema references are not fetched.',
                );
            }
            if (maps.has(key)) {
                mcpAssert(child && typeof child === 'object' && !Array.isArray(child), 'Invalid schema map.');
                Object.values(child).forEach(visit);
            } else if (lists.has(key)) {
                mcpAssert(Array.isArray(child) && child.length > 0, 'Invalid schema list.');
                child.forEach(visit);
            } else if (singles.has(key)) {
                visit(child);
            } else if (key === 'items') {
                mcpAssert(!Array.isArray(child), 'Use prefixItems for JSON Schema 2020-12 tuples.');
                visit(child);
            } else if (key === 'dependencies') {
                mcpAssert(child && typeof child === 'object', 'Invalid schema dependencies.');
                Object.values(child)
                    .filter((x) => !Array.isArray(x))
                    .forEach(visit);
            }
        }
        currentParent = previous;
    };
    visit(schema);
    for (const node of schemaNodes) {
        if (node.$ref === undefined) {
            continue;
        }
        const reference = String(node.$ref);
        mcpAssert(
            reference === '#' || reference.startsWith('#/'),
            'Only local JSON Pointer schema references are supported.',
        );
        let target: unknown = schema;
        if (reference !== '#') {
            for (const encoded of reference.slice(2).split('/')) {
                let key: string;
                try {
                    key = decodeURIComponent(encoded).replaceAll('~1', '/').replaceAll('~0', '~');
                } catch {
                    throw mcpError('Invalid local schema reference.');
                }
                mcpAssert(
                    target && typeof target === 'object' && !Array.isArray(target) && Object.hasOwn(target, key),
                    'Unresolved local schema reference.',
                );
                target = (target as Record<string, unknown>)[key];
            }
        }
        mcpAssert(
            typeof target === 'boolean' || schemaNodes.has(target as Record<string, unknown>),
            'Local schema reference must identify a supported schema.',
        );
        if (typeof target === 'object') {
            const list = edges.get(node) ?? [];
            list.push(target as Record<string, unknown>);
            edges.set(node, list);
        }
    }
    const visiting = new Set<object>(),
        done = new Set<object>();
    const acyclic = (node: Record<string, unknown>) => {
        mcpAssert(!visiting.has(node), 'Recursive schema references are not supported.');
        if (done.has(node)) {
            return;
        }
        visiting.add(node);
        for (const next of edges.get(node) ?? []) {
            acyclic(next);
        }
        visiting.delete(node);
        done.add(node);
    };
    acyclic(schema);
    return '2020-12';
}
/** The SDK's real JSON Schema validator runs in a disposable bounded worker: remote regexes cannot block the server. */
export async function validateMcpInput(
    schema: Record<string, unknown>,
    input: unknown,
    signal?: AbortSignal,
    timeoutMs = 1500,
    maxBytes: number = MCP_LIMITS.argumentBytes,
): Promise<void> {
    const draft = inspectMcpSchema(schema);
    boundedJson(input, Math.min(maxBytes, MCP_LIMITS.resultBytes));
    signal?.throwIfAborted();
    // From source (tsx) the worker is the .ts file; built, the .js beside this one.
    // Two literal URLs, so scripts/check-feature-boundaries.mjs can read the reference.
    const workerUrl = import.meta.url.endsWith('.ts')
        ? new URL('./schema-worker.ts', import.meta.url)
        : new URL('./schema-worker.js', import.meta.url);
    const worker = new Worker(workerUrl, {
        workerData: { schema, input, draft },
        resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(mcpError('External input validation exceeded its limit.')),
                timeoutMs,
            );
            const abort = () => reject(mcpError('External input validation was canceled.'));
            signal?.addEventListener('abort', abort, { once: true });
            const end = (error?: Error) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };
            worker.once('message', (result) =>
                end(
                    result.valid
                        ? undefined
                        : mcpError(
                              result.unsupported
                                  ? 'External input schema is unsupported.'
                                  : 'Arguments do not satisfy the reviewed external tool schema.',
                          ),
                ),
            );
            worker.once('error', () => end(mcpError('External input schema could not be validated.')));
            worker.once('exit', (code) => {
                if (code !== 0) {
                    end(mcpError('External input validator stopped.'));
                }
            });
        });
    } finally {
        await worker.terminate();
    }
}
