import { useEffect, useRef, useState } from 'react';

import { numberFormat } from '@socio/shared/locale';

import { barPath, niceTicks } from './scale';
import './series-chart.css';

/** One point: its label on the x axis and in the readout, and its value. */
export interface ChartPoint {
    label: string;
    /** Null leaves a gap (no bar; the line breaks). */
    value: number | null;
}

const compact = numberFormat({
    notation: 'compact',
    maximumFractionDigits: 1,
});
const full = numberFormat({ maximumFractionDigits: 4 });
const shorten = (text: string, max = 14) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * A single-series bar or line chart in the theme's chart color: plain
 * SVG, no chart library; light and dark come from the tokens. It fills
 * its box's width; pointer and arrow keys move a readout along the
 * points. Dataset views and the Operations dashboard draw with it.
 */
export function SeriesChart({
    points,
    kind,
    label,
    xName,
    yName,
    boundedTooltip = false,
    exactNumbers = false,
}: {
    points: readonly ChartPoint[];
    kind: 'bar' | 'line';
    /** What the chart is, for its accessible name. */
    label: string;
    /** What the axes are, for its description ("total by month"). */
    xName: string;
    yName: string;
    /** Long labels in a narrow chat stay inside the chart's width. */
    boundedTooltip?: boolean;
    /** Inline data keeps exact readouts and nonzero small axis labels. */
    exactNumbers?: boolean;
}) {
    const formatTick = exactNumbers
        ? (value: number) => {
              const rounded = Number(value.toPrecision(4));
              return rounded !== 0 && Math.abs(rounded) < 0.001 ? rounded.toExponential() : String(rounded);
          }
        : (value: number) => compact.format(value);
    const formatReadout = exactNumbers ? (value: number) => String(value) : (value: number) => full.format(value);
    const formatRange = exactNumbers ? (value: number) => String(value) : (value: number) => compact.format(value);
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(640);
    const [active, setActive] = useState<number | null>(null);
    useEffect(() => {
        const element = box.current;
        if (!element || typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(([entry]) => {
            const next = Math.round(entry.contentRect.width);
            if (next > 0) {
                setWidth(next);
            }
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const values = points.map((point) => point.value).filter((value): value is number => value !== null);
    const height = 240;
    const margin = { top: 12, right: 16, bottom: 30, left: 52 };
    const inner = {
        w: Math.max(40, width - margin.left - margin.right),
        h: height - margin.top - margin.bottom,
    };
    const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
    const lo = ticks[0];
    const hi = ticks[ticks.length - 1];
    const sy = (v: number) => margin.top + inner.h - ((v - lo) / (hi - lo || 1)) * inner.h;
    const band = inner.w / points.length;
    const cx = (i: number) =>
        kind === 'bar'
            ? margin.left + band * (i + 0.5)
            : margin.left + (points.length === 1 ? inner.w / 2 : (inner.w * i) / (points.length - 1));
    const barWidth = Math.max(1, Math.min(24, band - 2));
    const every = Math.max(1, Math.ceil(points.length / Math.floor(inner.w / 72)));
    const zero = sy(0);
    // The line, broken where a value is missing.
    const segments: string[] = [];
    let open = false;
    points.forEach((point, i) => {
        if (point.value === null) {
            open = false;
            return;
        }
        segments.push(`${open ? 'L' : 'M'}${cx(i).toFixed(1)},${sy(point.value).toFixed(1)}`);
        open = true;
    });
    const pick = (clientX: number, rect: DOMRect) => {
        const px = ((clientX - rect.left) / rect.width) * width;
        const i =
            kind === 'bar'
                ? Math.floor((px - margin.left) / band)
                : Math.round(((px - margin.left) / inner.w) * Math.max(1, points.length - 1));
        setActive(Math.max(0, Math.min(points.length - 1, i)));
    };
    const shown = active !== null ? points[active] : undefined;
    const tooltipWidth = Math.max(1, Math.min(288, width - 16));
    const tooltipX = shown
        ? boundedTooltip
            ? Math.max(tooltipWidth / 2, Math.min(width - tooltipWidth / 2, cx(active!)))
            : cx(active!)
        : 0;
    const summary = values.length
        ? `${kind === 'bar' ? 'Bar' : 'Line'} chart of ${yName} by ${xName}, ${points.length} points, from ${formatRange(Math.min(...values))} to ${formatRange(Math.max(...values))}.`
        : `${kind === 'bar' ? 'Bar' : 'Line'} chart of ${yName} by ${xName}, no values.`;
    return (
        <div className="series-chart" ref={box}>
            <svg
                role="img"
                aria-label={`${label}: ${summary}`}
                tabIndex={0}
                width="100%"
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                data-chart={kind}
                onPointerMove={(event) => pick(event.clientX, event.currentTarget.getBoundingClientRect())}
                onPointerLeave={() => setActive(null)}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => {
                    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
                        return;
                    }
                    event.preventDefault();
                    const step = event.key === 'ArrowRight' ? 1 : -1;
                    setActive((current) =>
                        Math.max(0, Math.min(points.length - 1, (current ?? (step > 0 ? -1 : points.length)) + step)),
                    );
                }}
            >
                <g className="grid">
                    {ticks.map((tick) => (
                        <g key={tick}>
                            <line x1={margin.left} x2={margin.left + inner.w} y1={sy(tick)} y2={sy(tick)} />
                            <text x={margin.left - 8} y={sy(tick)} dy="0.32em" textAnchor="end">
                                {formatTick(tick)}
                            </text>
                        </g>
                    ))}
                </g>
                <g className="x-labels">
                    {points.map((point, i) =>
                        i % every ? null : (
                            <text
                                key={i}
                                x={cx(i)}
                                y={height - 10}
                                // A line's end points sit on the plot's edges: keep their
                                // labels inside it.
                                textAnchor={
                                    kind === 'line' && points.length > 1 && i === 0
                                        ? 'start'
                                        : kind === 'line' && points.length > 1 && i === points.length - 1
                                          ? 'end'
                                          : 'middle'
                                }
                            >
                                {shorten(point.label)}
                            </text>
                        ),
                    )}
                </g>
                {kind === 'bar' ? (
                    <g className="marks">
                        {points.map((point, i) =>
                            point.value === null ? null : (
                                <path
                                    key={i}
                                    data-active={i === active || undefined}
                                    d={barPath(cx(i) - barWidth / 2, zero, sy(point.value), barWidth)}
                                />
                            ),
                        )}
                    </g>
                ) : (
                    <g className="marks">
                        {shown && (
                            <line
                                className="crosshair"
                                x1={cx(active!)}
                                x2={cx(active!)}
                                y1={margin.top}
                                y2={margin.top + inner.h}
                            />
                        )}
                        <path className="line" d={segments.join('')} />
                        {points.map((point, i) =>
                            point.value === null || (i !== active && points.length > 24) ? null : (
                                <circle key={i} cx={cx(i)} cy={sy(point.value)} r={i === active ? 5 : 4} />
                            ),
                        )}
                    </g>
                )}
                {zero > margin.top && zero < margin.top + inner.h + 0.5 && (
                    <line className="baseline" x1={margin.left} x2={margin.left + inner.w} y1={zero} y2={zero} />
                )}
            </svg>
            {shown && (
                <div
                    className="series-chart-tooltip"
                    role="status"
                    style={{
                        left: `${(tooltipX / width) * 100}%`,
                        ...(boundedTooltip
                            ? ({
                                  maxWidth: `${tooltipWidth}px`,
                                  whiteSpace: 'normal',
                                  overflowWrap: 'anywhere',
                              } as const)
                            : {}),
                        top: `${shown.value === null ? margin.top : sy(shown.value)}px`,
                    }}
                >
                    <strong>{shown.value === null ? 'No value' : formatReadout(shown.value)}</strong>
                    <span>{shown.label}</span>
                </div>
            )}
        </div>
    );
}
