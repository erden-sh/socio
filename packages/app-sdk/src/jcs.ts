/**
 * JSON Canonicalization Scheme (RFC 8785): one byte-exact JSON text for a
 * value, so Socio and the app SDK compute the same intent digest for an
 * approval (CB-232) whatever order the keys came in.
 *
 * Numbers use ECMAScript's shortest round-trip form (what RFC 8785 §3.2.2.3
 * specifies), strings JSON.stringify's escaping (§3.2.2.2), and object keys
 * are sorted by their UTF-16 code units (§3.2.3). Values JSON can't hold
 * (undefined, functions, symbols, bigints, non-finite numbers) are refused
 * rather than dropped, so two different inputs never share a digest.
 */
export function canonicalJson(value: unknown): string {
    return encode(value, new Set());
}

function encode(value: unknown, seen: Set<object>): string {
    if (value === null) {
        return 'null';
    }
    switch (typeof value) {
        case 'boolean':
            return value ? 'true' : 'false';
        case 'number':
            if (!Number.isFinite(value)) {
                throw new TypeError('JCS: numbers must be finite.');
            }
            // -0 serializes as 0 (RFC 8785 §3.2.2.3).
            return Object.is(value, -0) ? '0' : String(value);
        case 'string':
            return JSON.stringify(value);
        case 'object':
            break;
        default:
            throw new TypeError(`JCS: a ${typeof value} has no JSON form.`);
    }
    const object = value as object;
    if (seen.has(object)) {
        throw new TypeError('JCS: the value has a cycle.');
    }
    seen.add(object);
    try {
        if (Array.isArray(object)) {
            return `[${object.map((item) => encode(item, seen)).join(',')}]`;
        }
        const proto = Object.getPrototypeOf(object) as unknown;
        if (proto !== Object.prototype && proto !== null) {
            throw new TypeError('JCS: only plain objects and arrays.');
        }
        const keys = Object.keys(object).sort(compareUtf16);
        return `{${keys
            .map((key) => `${JSON.stringify(key)}:${encode((object as Record<string, unknown>)[key], seen)}`)
            .join(',')}}`;
    } finally {
        seen.delete(object);
    }
}

/** Code-unit order, not locale order (RFC 8785 §3.2.3). */
function compareUtf16(a: string, b: string) {
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const diff = a.charCodeAt(i) - b.charCodeAt(i);
        if (diff) {
            return diff;
        }
    }
    return a.length - b.length;
}
