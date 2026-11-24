/**
 * A drill-down list's cursor (CB-164): a keyset position after the last
 * row of a page, its sort key and id, so the next page starts there
 * whatever was added in between. Opaque to the client: base64url JSON.
 */
export interface OpsCursor {
    /** The row's sort key: a time in ms, a count, or text. */
    key: number | string;
    /** Its id, which breaks ties between equal keys. */
    id: string;
}

export function encodeCursor(cursor: OpsCursor): string {
    return Buffer.from(JSON.stringify([cursor.key, cursor.id])).toString('base64url');
}

/** The cursor in `text`, or undefined when it isn't one. */
export function decodeCursor(text: string): OpsCursor | undefined {
    if (!text || text.length > 512 || !/^[\w-]+$/.test(text)) {
        return undefined;
    }
    try {
        const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 2) {
            return undefined;
        }
        const [key, id] = value as unknown[];
        if (!((typeof key === 'number' && Number.isFinite(key)) || typeof key === 'string') || typeof id !== 'string') {
            return undefined;
        }
        return { key, id };
    } catch {
        return undefined;
    }
}

/**
 * Whether a row comes after the cursor in a newest-first list (key
 * descending, then id descending).
 */
export const afterCursor = (row: OpsCursor, cursor: OpsCursor | undefined): boolean =>
    !cursor || row.key < cursor.key || (row.key === cursor.key && row.id < cursor.id);
