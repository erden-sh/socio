import type { InlineChartData } from '@socio/shared/inline-chart';

import { SeriesChart } from './SeriesChart';

/** Labels are React text; the existing chart draws native SVG only. */
export function InlineChart({ chart }: { chart: InlineChartData }) {
    return (
        <figure
            data-slot="inline-chart"
            className="my-3 min-w-0 max-w-full rounded-lg border bg-card p-3 text-card-foreground"
        >
            <figcaption className="mb-1 font-medium">{chart.title}</figcaption>
            <p className="text-sm text-muted-foreground">{chart.description}</p>
            <SeriesChart
                points={chart.points}
                kind={chart.kind}
                label={`${chart.title}. ${chart.description}`}
                xName={chart.xLabel}
                yName={chart.yLabel}
                exactNumbers
                boundedTooltip
            />
            <p className="text-xs text-muted-foreground">
                {chart.yLabel} by {chart.xLabel}. Missing values are not plotted.
            </p>
        </figure>
    );
}
