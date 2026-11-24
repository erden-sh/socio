import { z } from 'zod';

/** A durable chart is data in assistant Markdown, never executable markup. */
export const INLINE_CHART_LANGUAGE = 'socio-chart';
export const INLINE_CHART_BYTES = 24 * 1024;
export const INLINE_CHART_POINTS = 100;
export const INLINE_CHARTS_PER_MESSAGE = 3;
const text = (max: number) =>
    z
        .string()
        .trim()
        .min(1)
        .max(max)
        .refine(
            (value) =>
                !Array.from(value).some((character) => {
                    const code = character.charCodeAt(0);
                    return code < 32 || code === 127;
                }),
            'Use plain text without control characters.',
        );
const value = z
    .number()
    .finite()
    .min(-1e12)
    .max(1e12)
    .refine(
        (number) => number === 0 || Math.abs(number) >= 1e-9,
        'Use values between 1e-9 and 1e12 in magnitude, or zero; choose suitable axis units.',
    );
const chartShape = z
    .object({
        version: z.literal(1),
        kind: z.enum(['bar', 'line']),
        title: text(200),
        description: text(600),
        xLabel: text(80),
        yLabel: text(80),
        points: z
            .array(z.object({ label: text(120), value: value.nullable() }).strict())
            .min(1)
            .max(INLINE_CHART_POINTS),
    })
    .strict();
export type InlineChartData = z.infer<typeof chartShape>;

/** Escape fence markers without changing the JSON-decoded labels. */
const chartJSON = (chart: InlineChartData) => JSON.stringify(chart, null, 2).replaceAll('`', '\\u0060');
const bytes = (source: string) => new TextEncoder().encode(source).byteLength;
export const inlineChartSchema = chartShape.superRefine((chart, context) => {
    if (bytes(chartJSON(chart)) > INLINE_CHART_BYTES) {
        context.addIssue({
            code: 'custom',
            message: 'Keep chart data under 24 KiB.',
        });
    }
});

/** Invalid, excessive or incomplete data remains ordinary code in the chat. */
export function parseInlineChart(source: string): InlineChartData | undefined {
    if (source.length > INLINE_CHART_BYTES || bytes(source) > INLINE_CHART_BYTES) {
        return undefined;
    }
    try {
        const result = inlineChartSchema.safeParse(JSON.parse(source));
        return result.success ? result.data : undefined;
    } catch {
        return undefined;
    }
}

/** The renderer waits for the closing fence, including during streaming. */
export const completeInlineChartFence = (source: string) =>
    /^```socio-chart[ \t]*\r?\n[\s\S]*\r?\n```[ \t]*$/.test(source);

// Code spans are ordinary Markdown but cannot become links/HTML/images,
// including GFM's automatic links. A longer delimiter contains any backticks.
const codeSpan = (source: string) => {
    if (!source.trim()) {
        return source.replaceAll(' ', '&#32;');
    }
    const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
    const delimiter = '`'.repeat(longest + 1);
    return `${delimiter} ${source} ${delimiter}`;
};
// A pipe entity sits outside code spans: preceding user backslashes cannot
// turn it back into a Markdown table separator.
const literal = (source: string) => source.split('|').map(codeSpan).join('&#124;');
export function inlineChartTable(chart: InlineChartData): string {
    return [
        `**${literal(chart.title)}**`,
        '',
        literal(chart.description),
        '',
        `| ${literal(chart.xLabel)} | ${literal(chart.yLabel)} |`,
        '| --- | ---: |',
        ...chart.points.map(
            (point) => `| ${literal(point.label)} | ${point.value === null ? 'Not available' : String(point.value)} |`,
        ),
    ].join('\n');
}

/** Other clients can read the same normal Markdown summary and data table. */
export function formatInlineChart(input: unknown): string {
    const chart = inlineChartSchema.parse(input);
    return `\`\`\`${INLINE_CHART_LANGUAGE}\n${chartJSON(chart)}\n\`\`\`\n\n${inlineChartTable(chart)}`;
}
