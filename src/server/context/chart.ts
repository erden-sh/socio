// Must stay first: see packages/foundation/src/no-vendor-telemetry.ts.
import '@socio/foundation/no-vendor-telemetry';
import { defineTool } from '@copilotkit/runtime/v2';

import type { DotTurn } from '@socio/foundation/turns/turn';
import { formatInlineChart, inlineChartSchema } from '@socio/shared/inline-chart';

/** Pure formatting only: no query, persistence, model call or network access. */
export function formatChartTool(turn: Pick<DotTurn, 'check'>) {
    return defineTool({
        name: 'format_chart',
        description:
            'Format supplied observed data as an inline bar or line chart for your reply (at most three rich charts per message; additional fences remain code). Supply version:1, kind, title, description, xLabel, yLabel, and 1–100 points {label,value}; use null for unknown values, never infer missing or historical data. Numeric magnitudes must be zero or 1e-9–1e12; choose appropriate axis units. No data is fetched or verified by this tool. Put the returned markdown unchanged in your assistant reply: its socio-chart fence renders richly in Socio, and its ordinary Markdown summary/table remains readable in other clients. Never put HTML, JavaScript, external resources or guessed burndown/history into a chart.',
        parameters: inlineChartSchema,
        execute: async (input) => {
            turn.check();
            return { outcome: 'formatted', markdown: formatInlineChart(input) };
        },
    });
}
