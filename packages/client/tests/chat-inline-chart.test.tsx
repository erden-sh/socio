import type { Message } from '@ag-ui/core';
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { formatInlineChart } from '@socio/shared/inline-chart';

import { SeriesChart } from '../src/components/charts/SeriesChart';
import { Markdown } from '../src/modules/chat/ChatMarkdown';
import { ChatTranscript } from '../src/modules/chat/ChatTranscript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
});
function render(node: React.ReactNode) {
    if (!host) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    }
    act(() => root!.render(node));
    return host;
}
const chart = {
    version: 1 as const,
    kind: 'line' as const,
    title: 'Observed work',
    description: 'Recorded observations only.',
    xLabel: 'Day',
    yLabel: 'Open issues',
    points: [
        { label: 'Monday', value: 8 },
        { label: 'Tuesday', value: null },
        { label: 'Wednesday', value: 3 },
    ],
};
const markdown = formatInlineChart(chart);

it('renders assistant chart data with native SVG, accessible labels, keyboard readout, and a normal table', () => {
    const view = render(<Markdown reply>{markdown}</Markdown>);
    expect(view.querySelector('[data-slot="inline-chart"]')).not.toBeNull();
    const svg = view.querySelector<SVGElement>('svg[data-chart="line"]')!;
    expect(svg.getAttribute('aria-label')).toContain('Observed work. Recorded observations only.');
    expect(svg.getAttribute('aria-label')).toContain('Open issues by Day');
    expect(svg.getAttribute('width')).toBe('100%');
    expect(svg.getAttribute('tabindex')).toBe('0');
    // Null is an actual gap: two separate line segments, never an invented zero.
    expect(svg.querySelector('path.line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(view.querySelector('[role="status"]')?.textContent).toContain('8Monday');
    expect(view.querySelector<HTMLElement>('[role="status"]')?.style.maxWidth).toBe('288px');
    act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(view.querySelector('[role="status"]')?.textContent).toContain('No valueTuesday');
    const table = view.querySelector('[data-chat-table] table')!;
    expect(table.textContent).toContain('Not available');
    expect(table.querySelectorAll('tbody tr')).toHaveLength(3);
});

it('keeps malformed, oversized, unknown-field and still-streaming fences as ordinary readable code', () => {
    const closed = markdown.slice(0, markdown.indexOf('\n```', 3) + 4);
    for (const source of [
        closed.slice(0, -3),
        '```socio-chart\n{"version":1\n```',
        '```socio-chart\n' + JSON.stringify({ ...chart, script: 'alert(1)' }) + '\n```',
        '```socio-chart\n' + ' '.repeat(25_000) + '\n```',
    ]) {
        const view = render(<Markdown reply>{source}</Markdown>);
        expect(view.querySelector('[data-slot="inline-chart"]')).toBeNull();
        expect(view.querySelector('pre code')).not.toBeNull();
    }
});

it('does not activate chart syntax in user messages, reasoning, or ordinary Markdown consumers', () => {
    const view = render(<Markdown>{markdown}</Markdown>);
    expect(view.querySelector('[data-slot="inline-chart"]')).toBeNull();
    expect(view.querySelector('pre code')).not.toBeNull();
    const messages: Message[] = [
        { id: 'u', role: 'user', content: markdown },
        { id: 'r', role: 'reasoning', content: markdown },
        { id: 'a', role: 'assistant', content: 'A reply.' },
    ];
    render(<ChatTranscript messages={messages} calls={[]} />);
    const trace = view.querySelector<HTMLDetailsElement>('[data-slot="turn-trace"]')!;
    act(() => {
        trace.open = true;
        trace.dispatchEvent(new Event('toggle'));
    });
    expect(view.querySelector('[data-slot="inline-chart"]')).toBeNull();
});

it('treats hostile labels as text with no executable SVG, HTML, images, links or network references', () => {
    const hostile = formatInlineChart({
        ...chart,
        title: '<script>window.evil=1</script> ```',
        description: '<img src="https://example.invalid/tracker" onerror="alert(1)">',
        points: [
            {
                label: '[link](https://example.invalid/) ![image](https://example.invalid/i.png) | row',
                value: 2,
            },
        ],
    });
    const view = render(<Markdown reply>{hostile}</Markdown>);
    expect(view.querySelector('[data-slot="inline-chart"]')).not.toBeNull();
    expect(view.querySelector('script,img,iframe,foreignObject,a,use,image')).toBeNull();
    expect(view.textContent).toContain('<script>window.evil=1</script>');
    expect(view.querySelectorAll('tbody tr')).toHaveLength(1);
});

it('reconstructs the same rich chart and fallback from durable assistant message text after reload', () => {
    const stored = JSON.stringify([{ id: 'assistant-chart', role: 'assistant', content: markdown }]);
    const messages = JSON.parse(stored) as Message[];
    const view = render(<ChatTranscript messages={messages} calls={[]} />);
    const original = view.querySelector('[data-slot="inline-chart"]')!.textContent;
    act(() => root!.unmount());
    root = createRoot(host!);
    render(<ChatTranscript messages={JSON.parse(stored)} calls={[]} />);
    expect(view.querySelector('[data-slot="inline-chart"]')?.textContent).toBe(original);
    expect(view.querySelector('tbody')?.textContent).toContain('Wednesday3');
});

it('bounds rich charts per message and leaves additional charts readable as code with their tables', () => {
    const view = render(<Markdown reply>{Array.from({ length: 5 }, () => markdown).join('\n\n')}</Markdown>);
    expect(view.querySelectorAll('[data-slot="inline-chart"]')).toHaveLength(3);
    expect(view.querySelectorAll('pre code')).toHaveLength(2);
    expect(view.querySelectorAll('[data-chat-table]')).toHaveLength(5);
});

it('keeps fallback table cells literal when labels include backticks, backslashes and pipes', () => {
    const label = 'Path C:\\|folder and `code`';
    const source = formatInlineChart({ ...chart, points: [{ label, value: 5 }] });
    const view = render(<Markdown reply>{source}</Markdown>);
    expect(view.querySelector('tbody td')?.textContent).toBe(label);
    expect(view.querySelectorAll('tbody td')).toHaveLength(2);
});

it('draws bounded bar data with negative and zero values without plotting unknown points', () => {
    const view = render(
        <Markdown reply>
            {formatInlineChart({
                ...chart,
                kind: 'bar',
                points: [
                    { label: 'Loss', value: -1e12 },
                    { label: 'Zero', value: 0 },
                    { label: 'Missing', value: null },
                    { label: 'Gain', value: 1e12 },
                ],
            })}
        </Markdown>,
    );
    const svg = view.querySelector('svg[data-chart="bar"]')!;
    expect(svg.querySelectorAll('.marks path')).toHaveLength(3);
    for (const path of svg.querySelectorAll('path')) {
        expect(path.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    }
    expect(view.querySelector('tbody')?.textContent).toContain('MissingNot available');
});

it('shows an all-unknown chart as no values without inventing data marks', () => {
    const view = render(
        <Markdown reply>
            {formatInlineChart({
                ...chart,
                points: [{ label: 'Unknown', value: null }],
            })}
        </Markdown>,
    );
    const svg = view.querySelector('svg[data-chart="line"]')!;
    expect(svg.getAttribute('aria-label')).toContain('no values');
    expect(svg.querySelectorAll('circle')).toHaveLength(0);
    expect(svg.querySelector('path.line')?.getAttribute('d')).toBe('');
    expect(view.querySelector('tbody')?.textContent).toContain('UnknownNot available');
});

it.each([1e-9, 1e-5, -1e-9, -1e-5])(
    'preserves tiny inline value %s in the axis, accessible range, readout and table',
    (value) => {
        const view = render(
            <Markdown reply>{formatInlineChart({ ...chart, points: [{ label: 'Tiny', value }] })}</Markdown>,
        );
        const svg = view.querySelector('svg[data-chart="line"]')!;
        expect(svg.getAttribute('aria-label')).toContain(String(value));
        const labels = [...svg.querySelectorAll('.grid text')].map((text) => text.textContent!);
        expect(labels.filter((text) => Number(text) !== 0).length).toBeGreaterThan(0);
        expect(labels.every((text) => Number.isFinite(Number(text)))).toBe(true);
        act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
        expect(view.querySelector('[role="status"] strong')?.textContent).toBe(String(value));
        expect(view.querySelector('tbody td:last-child')?.textContent).toBe(String(value));
    },
);

it('preserves existing dataset number formatting without the inline opt-in', () => {
    const view = render(
        <SeriesChart points={[{ label: 'Tiny', value: 1e-9 }]} kind="line" label="Dataset" xName="Row" yName="Value" />,
    );
    const svg = view.querySelector('svg')!;
    expect(svg.getAttribute('aria-label')).toContain('from 0 to 0');
    act(() => svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(view.querySelector('[role="status"] strong')?.textContent).toBe('0');
});
