import { useMemo, useState } from 'react';

import type { CellValue } from '@socio/shared/data-types';
import type { ViewDisplay, ViewQueryResult } from '@socio/shared/dataset-view';

import { SeriesChart } from '../components/charts/SeriesChart';
import { formatCell } from '../modules/dataspace/format';

/**
 * How an embedded dataset view draws a query result: a paged table
 * or a single-series bar or line chart (`SeriesChart`).
 */
export function DatasetViewDisplay({
    result,
    display,
    x,
    y,
    title,
}: {
    result: Pick<ViewQueryResult, 'columns' | 'rows' | 'truncated' | 'maxRows'>;
    display: ViewDisplay;
    x?: string;
    y?: string;
    title?: string;
}) {
    if (!result.rows.length) {
        return (
            <p className="dataset-view-state" data-state="empty">
                The query returned no rows.
            </p>
        );
    }
    return (
        <>
            {display === 'table' ? (
                <ViewTable result={result} label={title || 'Dataset view'} />
            ) : (
                <ViewChart result={result} kind={display} x={x} y={y} label={title || 'Dataset view'} />
            )}
            {result.truncated && (
                <p className="dataset-view-note" data-slot="view-truncated">
                    Showing the first {result.rows.length} rows: views stop at {result.maxRows} rows (or 256 KB).
                </p>
            )}
        </>
    );
}

export const VIEW_PAGE = 25;

function ViewTable({ result, label }: { result: Pick<ViewQueryResult, 'columns' | 'rows'>; label: string }) {
    const [page, setPage] = useState(0);
    const pages = Math.max(1, Math.ceil(result.rows.length / VIEW_PAGE));
    const current = Math.min(page, pages - 1);
    const rows = result.rows.slice(current * VIEW_PAGE, (current + 1) * VIEW_PAGE);
    // Right-align a column when its values are numbers.
    const numeric = result.columns.map(
        (_, index) =>
            result.rows.some((row) => typeof row[index] === 'number') &&
            result.rows.every((row) => row[index] === null || typeof row[index] === 'number'),
    );
    return (
        <div className="dataset-view-table">
            <div className="dataset-view-scroll">
                <table aria-label={label}>
                    <thead>
                        <tr>
                            {result.columns.map((column, index) => (
                                <th
                                    key={`${column}-${index}`}
                                    scope="col"
                                    className={numeric[index] ? 'numeric' : undefined}
                                >
                                    {column}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, index) => (
                            <tr key={current * VIEW_PAGE + index}>
                                {row.map((value, cell) => (
                                    <td
                                        key={cell}
                                        className={numeric[cell] ? 'numeric' : undefined}
                                        title={formatCell(value)}
                                    >
                                        {value === null ? <span className="null">null</span> : formatCell(value)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {pages > 1 && (
                <div className="dataset-view-pager">
                    <span data-slot="view-rows-range">
                        {current * VIEW_PAGE + 1}–{current * VIEW_PAGE + rows.length} of {result.rows.length}
                    </span>
                    <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>
                        Previous
                    </button>
                    <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
                        Next
                    </button>
                </div>
            )}
        </div>
    );
}

/** A cell as a chart value: numbers, and text that is a number. */
export function chartNumber(value: CellValue): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function ViewChart({
    result,
    kind,
    x,
    y,
    label,
}: {
    result: Pick<ViewQueryResult, 'columns' | 'rows'>;
    kind: 'bar' | 'line';
    x?: string;
    y?: string;
    label: string;
}) {
    const { columns, rows } = result;
    const xi = x ? columns.indexOf(x) : 0;
    const yi = y
        ? columns.indexOf(y)
        : columns.findIndex((_, index) => index !== xi && rows.some((row) => chartNumber(row[index]) !== null));
    const points = useMemo(
        () =>
            xi < 0 || yi < 0
                ? []
                : rows.map((row) => ({
                      label: formatCell(row[xi]),
                      value: chartNumber(row[yi]),
                  })),
        [rows, xi, yi],
    );
    if (xi < 0 || yi < 0) {
        return (
            <p className="dataset-view-state" data-state="error" role="alert">
                {xi < 0
                    ? `The query has no column “${x}” for the chart’s x axis.`
                    : y
                      ? `The query has no column “${y}” for the chart’s values.`
                      : 'The query has no column of numbers to chart.'}{' '}
                It returns {columns.join(', ')}.
            </p>
        );
    }
    if (!points.some((point) => point.value !== null)) {
        return (
            <p className="dataset-view-state" data-state="error" role="alert">
                Column “{columns[yi]}” has no numbers to chart.
            </p>
        );
    }
    return <SeriesChart points={points} kind={kind} label={label} xName={columns[xi]!} yName={columns[yi]!} />;
}
