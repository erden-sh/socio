import type { InlineChartData } from '@socio/shared/inline-chart';

// A `socio-chart` fence's drawing: the web's
// SeriesChart (packages/client/src/components/charts/SeriesChart.tsx and
// scale.ts), its geometry ported for react-native-svg, without the pointer
// readout. No React Native here: tests/chat runs it under Node.

export const CHART_HEIGHT = 240;
const MARGIN = { top: 12, right: 16, bottom: 30, left: 52 };

/** Round axis ticks (0, 250, 500…) covering min..max (the web's `niceTicks`). */
export function niceTicks(min: number, max: number, count = 4): number[] {
    if (min === max) {
        if (min === 0) {
            max = 1;
        } else if (min > 0) {
            min = 0;
        } else {
            max = 0;
        }
    }
    const raw = (max - min) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / magnitude;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * magnitude;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let value = lo; value <= hi + step / 2; value += step) {
        ticks.push(Math.round(value / step) * step);
    }
    return ticks;
}

/** A bar with a 4 px rounded data end, square at the baseline (the web's `barPath`). */
export function barPath(x: number, base: number, end: number, width: number): string {
    const r = Math.min(4, width / 2, Math.abs(base - end));
    if (end <= base) {
        return `M${x},${base}V${end + r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end + r}V${base}Z`;
    }
    return `M${x},${base}V${end - r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end - r}V${base}Z`;
}

/** An axis label for inline data: exact, small nonzero values kept (the web's `exactNumbers`). */
export function formatTick(value: number): string {
    const rounded = Number(value.toPrecision(4));
    return rounded !== 0 && Math.abs(rounded) < 0.001 ? rounded.toExponential() : String(rounded);
}

const shorten = (text: string, max = 14) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export interface ChartLayout {
    readonly height: number;
    readonly ticks: readonly { readonly y: number; readonly label: string }[];
    readonly gridX: readonly [number, number];
    readonly labels: readonly {
        readonly x: number;
        readonly text: string;
        readonly anchor: 'start' | 'middle' | 'end';
    }[];
    /** Bars' paths (a bar chart), or the line's path and its dots (a line chart). */
    readonly bars: readonly string[];
    readonly line: string;
    readonly dots: readonly { readonly x: number; readonly y: number }[];
    /** The zero line, when it falls inside the plot. */
    readonly baseline: number | null;
    readonly labelY: number;
    readonly tickX: number;
}

/** The chart's shapes at `width` points wide. */
export function chartLayout(chart: InlineChartData, width: number): ChartLayout {
    const { points, kind } = chart;
    const values = points.map((point) => point.value).filter((value): value is number => value !== null);
    const inner = {
        w: Math.max(40, width - MARGIN.left - MARGIN.right),
        h: CHART_HEIGHT - MARGIN.top - MARGIN.bottom,
    };
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const lo = ticks[0] ?? 0;
    const hi = ticks[ticks.length - 1] ?? 1;
    const sy = (value: number) => MARGIN.top + inner.h - ((value - lo) / (hi - lo || 1)) * inner.h;
    const band = inner.w / points.length;
    const cx = (index: number) =>
        kind === 'bar'
            ? MARGIN.left + band * (index + 0.5)
            : MARGIN.left + (points.length === 1 ? inner.w / 2 : (inner.w * index) / (points.length - 1));
    const barWidth = Math.max(1, Math.min(24, band - 2));
    const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(inner.w / 72))));
    const zero = sy(0);
    const segments: string[] = [];
    let open = false;
    points.forEach((point, index) => {
        if (point.value === null) {
            open = false;
            return;
        }
        segments.push(`${open ? 'L' : 'M'}${cx(index).toFixed(1)},${sy(point.value).toFixed(1)}`);
        open = true;
    });
    const last = points.length - 1;
    return {
        height: CHART_HEIGHT,
        ticks: ticks.map((tick) => ({ y: sy(tick), label: formatTick(tick) })),
        gridX: [MARGIN.left, MARGIN.left + inner.w],
        labels: points.flatMap((point, index) =>
            index % every
                ? []
                : [
                      {
                          x: cx(index),
                          text: shorten(point.label),
                          anchor:
                              kind === 'line' && points.length > 1 && index === 0
                                  ? ('start' as const)
                                  : kind === 'line' && points.length > 1 && index === last
                                    ? ('end' as const)
                                    : ('middle' as const),
                      },
                  ],
        ),
        bars:
            kind === 'bar'
                ? points.flatMap((point, index) =>
                      point.value === null ? [] : [barPath(cx(index) - barWidth / 2, zero, sy(point.value), barWidth)],
                  )
                : [],
        line: kind === 'line' ? segments.join('') : '',
        dots:
            kind === 'line' && points.length <= 24
                ? points.flatMap((point, index) => (point.value === null ? [] : [{ x: cx(index), y: sy(point.value) }]))
                : [],
        baseline: zero > MARGIN.top && zero < MARGIN.top + inner.h + 0.5 ? zero : null,
        labelY: CHART_HEIGHT - 10,
        tickX: MARGIN.left - 8,
    };
}

/** What a screen reader hears for the chart (the web's accessible name). */
export function chartSummary(chart: InlineChartData): string {
    const values = chart.points.map((point) => point.value).filter((value): value is number => value !== null);
    const kind = chart.kind === 'bar' ? 'Bar' : 'Line';
    const range = values.length
        ? `${chart.points.length} points, from ${Math.min(...values)} to ${Math.max(...values)}.`
        : 'no values.';
    return `${chart.title}. ${chart.description}: ${kind} chart of ${chart.yLabel} by ${chart.xLabel}, ${range}`;
}

/** The note under the chart, as on the web. */
export const chartNote = (chart: InlineChartData) =>
    `${chart.yLabel} by ${chart.xLabel}. Missing values are not plotted.`;
