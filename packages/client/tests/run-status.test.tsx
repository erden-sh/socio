// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RUN_MODEL_EVENT, RUN_WAIT_EVENT, nextPhase, startPhase, type RunPhase } from '@socio/shared/runs/run-phase';

import { RunStatus } from '../src/modules/chat/RunStatus';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
let commits = 0;
beforeEach(() => {
    vi.useFakeTimers({ now: 100_000 });
    commits = 0;
    // Radix positions the tooltip with ResizeObserver, which jsdom lacks.
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = undefined;
    vi.useRealTimers();
});

function render(phase: RunPhase) {
    if (!host) {
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    }
    act(() =>
        root!.render(
            <Profiler id="status" onRender={() => commits++}>
                <RunStatus phase={phase} dotName="Ada" />
            </Profiler>,
        ),
    );
    return host.querySelector<HTMLElement>('[data-slot="run-phase"]')!;
}

const waiting = (now: number) => {
    let phase = nextPhase(startPhase(now), { type: 'RUN_STARTED' }, now);
    phase = nextPhase(
        phase,
        {
            type: 'CUSTOM',
            name: RUN_MODEL_EVENT,
            value: { label: 'ChatGPT', model: null },
        },
        now,
    );
    return nextPhase(
        phase,
        {
            type: 'CUSTOM',
            name: RUN_WAIT_EVENT,
            value: { expectedMs: 7_000, tokens: 18_200 },
        },
        now,
    );
};

it('shows the phase from run-phase, with a clock from the first second', () => {
    const line = render(waiting(Date.now()));
    const label = line.querySelector('[role="status"]')!;
    expect(label.textContent).toBe('Waiting for ChatGPT');
    expect(line.textContent).toBe('Waiting for ChatGPT');
    act(() => vi.advanceTimersByTime(4_000));
    expect(line.textContent).toBe('Waiting for ChatGPT · 4 s');
    // Screen readers get the label, not the ticking clock.
    expect(line.querySelector('[data-slot="run-clock"]')!.getAttribute('aria-hidden')).toBe('true');
    // 13 px with a shimmer, not the old 9 px dots.
    expect(line.classList).toContain('text-[13px]');
    expect(line.querySelector('[role="status"]')!.classList).toContain('animate-shimmer');
    expect(line.querySelectorAll('span')).toHaveLength(2);
});

it('ticks without re-rendering React; a new phase re-renders', () => {
    const start = Date.now();
    const phase = waiting(start);
    const line = render(phase);
    const before = commits;
    act(() => vi.advanceTimersByTime(6_000));
    expect(line.textContent).toBe('Waiting for ChatGPT · 6 s');
    expect(commits).toBe(before);
    const thinking = nextPhase(phase, { type: 'REASONING_START' }, start + 6_000);
    render(thinking);
    expect(commits).toBe(before + 1);
    expect(line.textContent).toBe('Ada is thinking');
    act(() => vi.advanceTimersByTime(2_000));
    expect(line.textContent).toBe('Ada is thinking · 2 s');
    expect(commits).toBe(before + 1);
});

it('names what a tool does', () => {
    const phase = nextPhase(
        startPhase(Date.now()),
        { type: 'TOOL_CALL_START', toolCallName: 'search_web' },
        Date.now(),
    );
    const line = render(phase);
    act(() => vi.advanceTimersByTime(2_000));
    expect(line.textContent).toBe('Searching the web · 2 s');
    // Nothing to add: no tooltip, not a tab stop.
    expect(line.hasAttribute('tabindex')).toBe(false);
});

it('keeps the usual wait and the prompt size in a tooltip', async () => {
    const line = render(waiting(Date.now()));
    expect(line.textContent).not.toContain('usually');
    expect(line.getAttribute('tabindex')).toBe('0');
    act(() => line.focus());
    await act(async () => vi.advanceTimersByTime(400));
    const tip = document.querySelector('[data-slot="tooltip-content"]');
    expect(tip?.textContent).toContain('Usually ~7 s · ~18k tokens');
});
