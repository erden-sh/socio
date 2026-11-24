import { parentPort, workerData } from 'node:worker_threads';

import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

try {
    const patterns = (schema: unknown) => {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
            return;
        }
        const value = schema as Record<string, unknown>;
        if (typeof value.pattern === 'string') {
            new RegExp(value.pattern, 'u');
        }
        if (value.patternProperties && typeof value.patternProperties === 'object') {
            for (const pattern of Object.keys(value.patternProperties)) {
                new RegExp(pattern, 'u');
            }
        }
        for (const key of ['properties', 'patternProperties', '$defs']) {
            if (value[key] && typeof value[key] === 'object') {
                Object.values(value[key]).forEach(patterns);
            }
        }
        for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
            if (Array.isArray(value[key])) {
                value[key].forEach(patterns);
            }
        }
        for (const key of ['items', 'not', 'if', 'then', 'else', 'additionalProperties', 'propertyNames', 'contains']) {
            patterns(value[key]);
        }
        if (value.dependentSchemas && typeof value.dependentSchemas === 'object') {
            Object.values(value.dependentSchemas).forEach(patterns);
        }
    };
    patterns(workerData.schema);
    const validate = new CfWorkerJsonSchemaValidator({
        draft: workerData.draft,
    }).getValidator(workerData.schema);
    const result = validate(workerData.input);
    parentPort!.postMessage({ valid: result.valid });
} catch {
    parentPort!.postMessage({ unsupported: true });
}
