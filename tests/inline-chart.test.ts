import { expect, it, vi } from 'vitest';

import {
    completeInlineChartFence,
    formatInlineChart,
    INLINE_CHART_BYTES,
    inlineChartSchema,
    parseInlineChart,
} from '@socio/shared/inline-chart';

import { formatChartTool } from '../src/server/context/chart';

const chart = {
    version: 1 as const,
    kind: 'line' as const,
    title: 'Observed work remaining',
    description: 'Only the supplied observations; one day is unknown.',
    xLabel: 'Day',
    yLabel: 'Open issues',
    points: [
        { label: 'Monday', value: 8 },
        { label: 'Tuesday', value: null },
        { label: 'Wednesday', value: 3 },
    ],
};

it('formats validated supplied points without inventing gaps and includes a normal Markdown fallback', () => {
    const source = formatInlineChart(chart);
    const fence = source.slice(0, source.indexOf('\n```', 3) + 4);
    expect(completeInlineChartFence(fence)).toBe(true);
    expect(completeInlineChartFence(fence.slice(0, -3))).toBe(false);
    expect(parseInlineChart(fence.split('\n').slice(1, -1).join('\n'))).toEqual(chart);
    expect(source).toContain('| ` Tuesday ` | Not available |');
    expect(source).toContain('| ` Wednesday ` | 3 |');
    expect(source).toContain(chart.description);
});

it('rejects unknown fields and prototype keys at every data-object boundary', () => {
    for (const extra of ['__proto__', 'prototype', 'constructor', 'script', 'url']) {
        const root = JSON.parse(JSON.stringify(chart));
        Object.defineProperty(root, extra, {
            value: 'https://example.invalid/script.js',
            enumerable: true,
        });
        expect(inlineChartSchema.safeParse(root).success).toBe(false);
        expect(parseInlineChart(JSON.stringify(root))).toBeUndefined();
        const point = JSON.parse(JSON.stringify(chart));
        Object.defineProperty(point.points[0], extra, {
            value: {},
            enumerable: true,
        });
        expect(inlineChartSchema.safeParse(point).success).toBe(false);
    }
});

it('enforces version, shape, finite values, numeric safety and bounded resource use', () => {
    for (const change of [
        { version: 2 },
        { kind: 'html' },
        { points: [] },
        {
            points: Array.from({ length: 101 }, () => ({ label: 'Point', value: 1 })),
        },
        { points: [{ label: 'Point', value: NaN }] },
        { points: [{ label: 'Point', value: Infinity }] },
        { points: [{ label: 'Point', value: 1e13 }] },
        { points: [{ label: 'Point', value: 1e-300 }] },
        { points: [{ label: 'Point', value: '4' }] },
        { title: '' },
        { title: 'x'.repeat(201) },
        { title: 'Title\nextra row' },
    ]) {
        expect(inlineChartSchema.safeParse({ ...chart, ...change }).success).toBe(false);
    }
    expect(
        inlineChartSchema.safeParse({
            ...chart,
            points: [
                { label: 'Loss', value: -3 },
                { label: 'Zero', value: 0 },
            ],
        }).success,
    ).toBe(true);
    const large = {
        ...chart,
        points: Array.from({ length: 100 }, () => ({
            label: '界'.repeat(120),
            value: 1,
        })),
    };
    expect(inlineChartSchema.safeParse(large).success).toBe(false);
    expect(parseInlineChart(' '.repeat(INLINE_CHART_BYTES + 1))).toBeUndefined();
    expect(parseInlineChart('{"version":1')).toBeUndefined();
});

it('escapes backticks in JSON and Markdown metacharacters in the fallback without changing labels', () => {
    const hostile = {
        ...chart,
        title: '``` <script>alert(1)</script>',
        points: [
            {
                label: '[click](https://example.invalid/a) | ![image](https://example.invalid/i.png)',
                value: 2,
            },
        ],
    };
    const source = formatInlineChart(hostile);
    expect(source.split('\n').filter((line) => line === '```')).toHaveLength(1);
    const json = source.split('\n').slice(1, source.split('\n').indexOf('```')).join('\n');
    expect(parseInlineChart(json)).toEqual(hostile);
    expect(source).toContain('&#124;');
    expect(source).toContain('[click](https://example.invalid/a)');
});

it('exposes pure formatting as a stopped-turn-aware tool, without fetching or validating data authenticity', async () => {
    const check = vi.fn();
    const tool = formatChartTool({ check });
    expect(tool.name).toBe('format_chart');
    expect(await tool.execute!(chart)).toEqual({
        outcome: 'formatted',
        markdown: formatInlineChart(chart),
    });
    expect(check).toHaveBeenCalledOnce();
    await expect(tool.execute!({ ...chart, points: [] })).rejects.toThrow();
    const stopped = formatChartTool({
        check: () => {
            throw Error('Stopped');
        },
    });
    await expect(stopped.execute!(chart)).rejects.toThrow('Stopped');
    expect(tool.description).toContain('No data is fetched or verified');
    expect(tool.description).toContain('never infer missing or historical data');
});
