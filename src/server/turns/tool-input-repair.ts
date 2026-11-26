// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { convertSchemaToJsonSchema, isStandardSchema, type ChatMiddleware, type StandardSchemaV1 } from '@tanstack/ai';

import { reportFailure } from '@socio/foundation/observability/failures';
import type {
    TraceInputIssue,
    TraceInputPath,
    TraceInputRepair,
    TraceInputType,
    TraceToolInput,
} from '@socio/shared/runs/run-trace';

/**
 * A narrow, logged repair of server tool inputs. The library's own repair
 * (`repairToolInput`) stays off: it reads `null` as `""`, `0` or `false`, or
 * drops the field, so `computer_files_write {contents: null}` could empty a
 * file. Models' real mistakes are mostly numbers sent as text
 * (`timeoutMs: "18000"`), and each costs a round while the model retries.
 *
 * When an input fails its schema, one pass reads only these, and only where
 * the schema's issue points:
 * - a string where the schema wants a number, when the whole string is a
 *   finite JSON number literal (`"18000"`, `"-2.5"`, `"1e3"`); where it wants
 *   an integer, plain digits only (`"1e3"`, `"1.0"` and `"1.5"` stay text);
 * - exactly `"true"` or `"false"` where the schema wants a boolean.
 *
 * Nothing else changes: `null` and missing fields are never touched, no field
 * is added, dropped or defaulted, and an empty or other string is never read
 * as zero or false. A value whose schema allows text, or any reading but
 * the one number or boolean (`$ref`, `allOf`, `not`, `if`, a union with a
 * string or object branch), stays as it is. Values are found only through the
 * properties a schema declares and the items of a plain array. When the
 * repaired input passes the schema, the tool runs with it; otherwise the
 * input stays as the model sent it and the model gets the schema error.
 *
 * Every schema failure is traced (`tool_input`): the tool, each issue's path,
 * code and expected and received types, and the repair, if it fixed the
 * input. Never a text value: only the number and boolean text it repaired.
 */

/** Issues a trace entry lists; the rest are counted. */
const MAX_ISSUES = 10;
/** Path segments a trace entry keeps. */
const MAX_PATH = 8;
/** Characters of a declared property name a path keeps. */
const MAX_NAME = 64;
/** The longest number text read as a number. */
const MAX_NUMBER_TEXT = 32;

/** A JSON number literal: no sign but `-`, no leading zeros, no spaces. */
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
/** An integer literal, as an integer field takes text: digits only. */
const INTEGER = /^-?(?:0|[1-9]\d*)$/;
/**
 * The issue codes a trace keeps (zod 4's); any other is `invalid`. A
 * schema may word its own issues, so nothing it says is kept as it is.
 */
export const ISSUE_CODES: ReadonlySet<string> = new Set([
    'invalid_type',
    'too_big',
    'too_small',
    'invalid_format',
    'not_multiple_of',
    'unrecognized_keys',
    'invalid_union',
    'invalid_key',
    'invalid_element',
    'invalid_value',
    'custom',
]);
/** The expected types a trace keeps. */
export const EXPECTED_TYPES: ReadonlySet<string> = new Set([
    'string',
    'number',
    'int',
    'integer',
    'bigint',
    'boolean',
    'object',
    'array',
    'null',
    'undefined',
    'date',
    'nan',
    'symbol',
    'function',
    'map',
    'set',
    'tuple',
    'record',
]);
/** Call IDs a trace or log keeps: a provider's short token, never free text. */
export const CALL_ID = /^[\w.:-]{1,64}$/;

/** Schema keywords that make a value's reading ambiguous: no repair there or below. */
const AMBIGUOUS = ['$ref', '$dynamicRef', 'allOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'prefixItems'];
/** The types a value can be repaired to, with `null` as a union's other branch. */
const SCALARS = new Set(['number', 'integer', 'boolean', 'null']);

type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** The number `text` is, as a field of that kind takes it; undefined when it isn't one. */
export function numberFromText(text: string, integer: boolean): number | undefined {
    if (text.length > MAX_NUMBER_TEXT || !(integer ? INTEGER : NUMBER).test(text)) {
        return undefined;
    }
    const value = Number(text);
    // Digits past what a number holds would change the value, in any
    // notation ("9007199254740993.0"), and a tiny one must not become 0.
    if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        (value === 0 && /[1-9]/.test(text.split(/[eE]/)[0]))
    ) {
        return undefined;
    }
    return value;
}

/** Whether `text` is one a repair reads: a number literal, `true` or `false`. */
export const isRepairText = (text: string) =>
    text === 'true' || text === 'false' || numberFromText(text, false) !== undefined;

/**
 * The scalar types a schema node allows, when it allows nothing else: a
 * `type` of only number, integer, boolean or null, or a union of such nodes.
 * Undefined for anything else, a string or object branch included.
 */
function scalarTypes(node: unknown, nested = false): Set<string> | undefined {
    if (!isObject(node) || AMBIGUOUS.some((key) => key in node)) {
        return undefined;
    }
    const branches = node.anyOf ?? node.oneOf;
    if (branches !== undefined) {
        if (nested || node.type !== undefined || !Array.isArray(branches) || (node.anyOf && node.oneOf)) {
            return undefined;
        }
        const types = new Set<string>();
        for (const branch of branches) {
            const inner = scalarTypes(branch, true);
            if (!inner) {
                return undefined;
            }
            inner.forEach((type) => types.add(type));
        }
        return types;
    }
    const types = typeof node.type === 'string' ? [node.type] : node.type;
    if (!Array.isArray(types) || !types.length || !types.every((type) => SCALARS.has(type as string))) {
        return undefined;
    }
    return new Set(types as string[]);
}

/** What `text` reads as under `types`, when it reads as exactly one value. */
function reading(text: string, types: Set<string>): number | boolean | undefined {
    // Compared with Object.is, so "-0" stays -0.
    const readings: Array<number | boolean> = [];
    const add = (value: number | boolean) => {
        if (!readings.some((other) => Object.is(other, value))) {
            readings.push(value);
        }
    };
    if (types.has('boolean') && (text === 'true' || text === 'false')) {
        add(text === 'true');
    }
    for (const type of ['number', 'integer']) {
        const value = types.has(type) ? numberFromText(text, type === 'integer') : undefined;
        if (value !== undefined) {
            add(value);
        }
    }
    return readings.length === 1 ? readings[0] : undefined;
}

const pathKey = (path: ReadonlyArray<string | number>) => JSON.stringify(path.map(String));

/**
 * `value` with each number or boolean text read, where `wanted` (the
 * failed paths) and the schema both point to it. Copies only what changes.
 */
function repairValue(
    value: unknown,
    node: unknown,
    path: Array<string | number>,
    wanted: ReadonlySet<string>,
    repairs: Array<{ path: Array<string | number>; from: string; to: number | boolean }>,
): unknown {
    if (typeof value === 'string') {
        const types = wanted.has(pathKey(path)) ? scalarTypes(node) : undefined;
        const to = types && reading(value, types);
        if (to === undefined) {
            return value;
        }
        repairs.push({ path: [...path], from: value, to });
        return to;
    }
    // Only where the schema says plainly what is inside.
    if (!isObject(node) || AMBIGUOUS.some((key) => key in node) || 'anyOf' in node || 'oneOf' in node) {
        return value;
    }
    if (Array.isArray(value)) {
        if (!isObject(node.items)) {
            return value;
        }
        let copy: unknown[] | undefined;
        value.forEach((item, index) => {
            const next = repairValue(item, node.items, [...path, index], wanted, repairs);
            if (next !== item) {
                (copy ??= [...value])[index] = next;
            }
        });
        return copy ?? value;
    }
    if (isObject(value) && isObject(node.properties)) {
        let copy: Record<string, unknown> | undefined;
        for (const [key, property] of Object.entries(node.properties)) {
            if (key === '__proto__' || !Object.hasOwn(value, key)) {
                continue;
            }
            const next = repairValue(value[key], property, [...path, key], wanted, repairs);
            if (next !== value[key]) {
                (copy ??= { ...value })[key] = next;
            }
        }
        return copy ?? value;
    }
    return value;
}

/** The nodes a path segment may be declared in: the node, or a union's branches. */
const declaring = (node: unknown): JsonSchema[] =>
    !isObject(node)
        ? []
        : [node, ...[node.anyOf, node.oneOf, node.allOf].flatMap((list) => (Array.isArray(list) ? list : []))].filter(
              isObject,
          );

/**
 * An issue's path as a trace keeps it: property names the schema declares,
 * array indexes, and `*` for any other key (a record's key is the model's).
 */
export function tracePath(path: ReadonlyArray<string | number>, schema: unknown): TraceInputPath {
    const out: TraceInputPath = [];
    let node: unknown = schema;
    for (const segment of path.slice(0, MAX_PATH)) {
        const nodes = declaring(node);
        const list = nodes.find((candidate) => candidate.type === 'array' || 'items' in candidate);
        if (list && (typeof segment === 'number' || /^\d{1,9}$/.test(segment))) {
            out.push(Number(segment));
            node = Array.isArray(list.items) ? list.items[Number(segment)] : list.items;
            continue;
        }
        const owner =
            typeof segment === 'string'
                ? nodes.find(
                      (candidate) => isObject(candidate.properties) && Object.hasOwn(candidate.properties, segment),
                  )
                : undefined;
        if (owner && typeof segment === 'string' && segment.length <= MAX_NAME) {
            out.push(segment);
            node = (owner.properties as JsonSchema)[segment];
            continue;
        }
        out.push('*');
        node = undefined;
    }
    return out;
}

/** The JSON type of the value at `path` in `input`. */
function typeAt(input: unknown, path: ReadonlyArray<string | number>): TraceInputType {
    let value: unknown = input;
    for (const segment of path) {
        if (Array.isArray(value)) {
            value = value[Number(segment)];
        } else if (isObject(value) && Object.hasOwn(value, String(segment))) {
            value = value[String(segment)];
        } else {
            return 'missing';
        }
    }
    if (value === undefined) {
        return 'missing';
    }
    if (value === null) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean' ? type : 'object';
}

/** A Standard Schema issue's path, its segments as plain keys. */
const issuePath = (issue: StandardSchemaV1.Issue): Array<string | number> | undefined =>
    issue.path?.map((segment) => {
        const key = typeof segment === 'object' && segment !== null ? segment.key : segment;
        return typeof key === 'number' ? key : String(key);
    });

/** An issue as a trace keeps it: its path, code and types, never its message. */
function traceIssue(issue: StandardSchemaV1.Issue, input: unknown, schema: unknown): TraceInputIssue {
    const path = issuePath(issue) ?? [];
    const { code, expected } = issue as { code?: unknown; expected?: unknown };
    const kind = typeof code === 'string' && ISSUE_CODES.has(code) ? code : 'invalid';
    return {
        path: tracePath(path, schema),
        code: kind,
        ...(kind === 'invalid_type' && typeof expected === 'string' && EXPECTED_TYPES.has(expected)
            ? { expected }
            : {}),
        received: typeAt(input, path),
    };
}

/** Each schema's input JSON Schema, read once; null when it has none. */
const jsonSchemas = new WeakMap<object, JsonSchema | null>();

function jsonSchemaOf(schema: StandardSchemaV1): JsonSchema | undefined {
    let json = jsonSchemas.get(schema);
    if (json === undefined) {
        try {
            const converted = convertSchemaToJsonSchema(schema as never, { io: 'input' }) as unknown;
            json = isObject(converted) ? converted : null;
        } catch {
            json = null;
        }
        jsonSchemas.set(schema, json);
    }
    return json ?? undefined;
}

/** What the check of one input found: nothing wrong, or its issues and repair. */
export type ToolInputCheck =
    | { valid: true }
    | {
          valid: false;
          issues: TraceInputIssue[];
          more: number;
          /** The input with its number and boolean text read, when that passes the schema. */
          repaired?: { input: unknown; repairs: TraceInputRepair[] };
      };

/**
 * Checks a tool's input against its Standard Schema, as the library does
 * just before the tool runs, and tries the repair when it fails.
 */
export async function checkToolInput(schema: StandardSchemaV1, received: unknown): Promise<ToolInputCheck> {
    // A copy: a schema's preprocess may change what it checks, and the
    // library checks the input again before the tool runs.
    const input = structuredClone(received);
    const first = await schema['~standard'].validate(structuredClone(input));
    if (!first.issues) {
        return { valid: true };
    }
    const json = jsonSchemaOf(schema);
    const issues = first.issues.slice(0, MAX_ISSUES).map((issue) => traceIssue(issue, input, json));
    const more = Math.max(0, first.issues.length - MAX_ISSUES);
    if (!json) {
        return { valid: false, issues, more };
    }
    const wanted = new Set(first.issues.map(issuePath).flatMap((path) => (path?.length ? [pathKey(path)] : [])));
    const repairs: Array<{ path: Array<string | number>; from: string; to: number | boolean }> = [];
    const repaired = repairValue(input, json, [], wanted, repairs);
    let fixed = false;
    try {
        fixed = repairs.length > 0 && !(await schema['~standard'].validate(structuredClone(repaired))).issues;
    } catch {
        // The failure stands, and is traced.
    }
    if (!fixed) {
        return { valid: false, issues, more };
    }
    return {
        valid: false,
        issues,
        more,
        repaired: {
            input: repaired,
            repairs: repairs.map(({ path, from, to }) => ({ path: tracePath(path, json), from, to })),
        },
    };
}

/** A log line's form of a path. */
const shownPath = (path: TraceInputPath) => path.join('.') || '(input)';

/**
 * The repair as chat middleware: before each server tool runs, its input is
 * checked; a failed one is traced (`trace`, with the call's round set by the
 * tracer), and a repaired one replaces the input and is logged. Anything
 * unexpected leaves the call to the library, as without this check.
 */
export function toolInputRepair(trace: (entry: Omit<TraceToolInput, 'kind' | 'round' | 'at'>) => void): ChatMiddleware {
    return {
        name: 'socio-tool-input',
        onBeforeToolCall: async (_ctx, { tool, args, toolName, toolCallId }) => {
            // Server tools only: a client tool's input goes to the browser.
            if (!tool?.execute || !isStandardSchema(tool.inputSchema)) {
                return undefined;
            }
            let check: ToolInputCheck;
            try {
                check = await checkToolInput(tool.inputSchema as StandardSchemaV1, args);
            } catch {
                return undefined;
            }
            if (check.valid) {
                return undefined;
            }
            const name = (toolName || 'unknown').slice(0, 64);
            try {
                trace({
                    name,
                    ...(CALL_ID.test(toolCallId) ? { callId: toolCallId } : {}),
                    issues: check.issues,
                    ...(check.more ? { more: check.more } : {}),
                    repaired: !!check.repaired,
                    ...(check.repaired ? { repairs: check.repaired.repairs } : {}),
                });
            } catch {
                // Tracing must never affect the turn.
            }
            if (!check.repaired) {
                return undefined;
            }
            reportFailure(`Model tool call ${name} (${CALL_ID.test(toolCallId) ? toolCallId : 'unknown'})`, [
                'repaired input (number or boolean sent as text)',
                check.repaired.repairs
                    .map(({ path, from, to }) => `${shownPath(path)}: ${JSON.stringify(from)} to ${String(to)}`)
                    .join(', '),
            ]);
            return { type: 'transformArgs', args: check.repaired.input };
        },
    };
}
