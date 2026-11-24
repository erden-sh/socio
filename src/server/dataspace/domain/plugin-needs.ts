import type { TableInfo } from '@socio/shared/data-types';
import type { PluginDatasetTable } from '@socio/shared/plugins/plugins';

/**
 * Whether a plugin's need fits a dataset (CB-451): the rules
 * binding and every schema change check, apart from the data space so
 * they can be read (and tested) on their own.
 */

const norm = (type: string | undefined) =>
    (type ?? 'TEXT')
        .trim()
        .toUpperCase()
        .replace(/\(.*\)$/, '');
const INTEGERS = new Set(['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT']);
const DECIMALS = new Set(['REAL', 'NUMERIC', 'DOUBLE', 'FLOAT', 'DECIMAL']);
const DATES = new Set(['DATE', 'DATETIME', 'TIMESTAMP']);

/**
 * Whether a column of type `have` reads as the `want` a need expects: the
 * same type, an integer where a decimal is expected, or a date or time
 * where text is expected (SQLite keeps both as text). Nothing else.
 */
export function readsAs(want: string | undefined, have: string) {
    const w = norm(want);
    const h = norm(have);
    return w === h || (DECIMALS.has(w) && INTEGERS.has(h)) || (w === 'TEXT' && DATES.has(h));
}

/**
 * What keeps a dataset's tables from serving a `read` need: each expected
 * table missing, each expected column missing or of a type that doesn't
 * read as the one expected. Extra tables and columns are fine. Empty: it fits.
 */
export function readProblems(expected: readonly PluginDatasetTable[] | undefined, have: readonly TableInfo[]) {
    const problems: string[] = [];
    const tables = new Map(have.map((table) => [table.name.toLowerCase(), table]));
    for (const want of expected ?? []) {
        const table = tables.get(want.table.toLowerCase());
        if (!table) {
            problems.push(`table "${want.table}" is missing`);
            continue;
        }
        for (const column of want.columns) {
            const found = table.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
            if (!found) {
                problems.push(`column "${table.name}.${column.name}" is missing`);
            } else if (!readsAs(column.type, found.type)) {
                problems.push(
                    `column "${table.name}.${found.name}" is ${found.type || 'untyped'}, expected ${norm(column.type)}`,
                );
            }
        }
    }
    return problems;
}

/**
 * A dataset's tables as they would be once a writer's declared tables are
 * applied: declared columns take the declared type (a retype shows as one,
 * though the additive rule refuses it too), missing ones are added, and
 * missing tables made. What the readers' check reads before a writer's
 * manifest is adopted.
 */
export function tablesAfter(
    have: readonly TableInfo[],
    declared: readonly PluginDatasetTable[] | undefined,
): TableInfo[] {
    const out = have.map((table) => ({ ...table, columns: table.columns.map((column) => ({ ...column })) }));
    for (const want of declared ?? []) {
        let table = out.find((item) => item.name.toLowerCase() === want.table.toLowerCase());
        if (!table) {
            table = { name: want.table, columns: [], rowCount: 0 };
            out.push(table);
        }
        for (const column of want.columns) {
            const type = norm(column.type);
            const found = table.columns.find((item) => item.name.toLowerCase() === column.name.toLowerCase());
            if (found) {
                found.type = type;
            } else {
                table.columns.push({
                    name: column.name,
                    type,
                    notNull: !!column.notNull,
                    primaryKey: !!column.primaryKey,
                    defaultValue: null,
                });
            }
        }
    }
    return out;
}
