import { expect, it } from 'vitest';

import { TOOL_ICONS, toolLabel } from '@socio/shared/runs/tool-labels';
import { formatDuration, toolOutcome } from '@socio/shared/runs/turn-steps';

// A turn's trace as the web and the app show it (CB-72): how a
// tool step ended, its label in plain words and the icon it names.

it('tells how a tool step ended from its result', () => {
    expect(toolOutcome(undefined, true)).toEqual({ state: 'running' });
    expect(toolOutcome(undefined, false)).toEqual({ state: 'stopped' });
    expect(toolOutcome('{"rows":[]}', false)).toEqual({ state: 'done' });
    // A nonzero exit is not a success.
    expect(toolOutcome(JSON.stringify({ exitCode: 1, stderr: 'File not found' }), false)).toEqual({
        state: 'failed',
        message: 'Exited with code 1.',
    });
    // The runtime's closers for a stop and for a turn that broke off.
    expect(
        toolOutcome(
            JSON.stringify({
                status: 'stopped',
                reason: 'stop_requested',
                message: 'The run was stopped.',
            }),
            false,
        ),
    ).toEqual({ state: 'stopped', message: 'The run was stopped.' });
    expect(
        toolOutcome(
            JSON.stringify({
                status: 'error',
                reason: 'missing_terminal_event',
                message: 'The tool never returned.',
            }),
            false,
        ),
    ).toEqual({ state: 'failed', message: 'The tool never returned.' });
    expect(toolOutcome('{"error":"Unknown tool: x"}', false)).toEqual({
        state: 'failed',
        message: 'Unknown tool: x',
    });
});

it('names tools in plain words, with a fallback for unknown ones', () => {
    expect(toolLabel('search_web', { search_queries: ['otters'] }, {}, true)).toMatchObject({
        icon: 'globe',
        verb: 'Searched the web',
        detail: 'for “otters”',
    });
    expect(toolLabel('computer_navigate', { url: 'https://example.com/a' }, {}, false)).toMatchObject({
        verb: 'Opening',
        detail: 'example.com',
    });
    expect(toolLabel('computer_exec', { command: 'ls -la' }, {}, true)).toMatchObject({
        verb: 'Ran a command',
        detail: 'ls -la',
        code: true,
    });
    expect(toolLabel('frobnicate_widgetList', {}, {}, true)).toMatchObject({
        icon: 'wrench',
        verb: 'Used frobnicate widget list',
    });
    expect(formatDuration(20)).toBe('<0.1s');
    expect(formatDuration(450)).toBe('0.5s');
    expect(formatDuration(8_400)).toBe('8.4s');
    expect(formatDuration(31_200)).toBe('31s');
    expect(formatDuration(72_000)).toBe('1m 12s');
});

it('names only icons in its list, so each client can map them all', () => {
    const names = new Set<string>(TOOL_ICONS);
    expect(names.size).toBe(TOOL_ICONS.length);
    for (const name of ['search_web', 'computer_exec', 'data_query', 'read_space_page', 'not_a_tool']) {
        expect(names.has(toolLabel(name, {}, {}, true).icon), name).toBe(true);
    }
});
