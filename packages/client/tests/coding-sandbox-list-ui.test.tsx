// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', () => ({
    api: vi.fn(),
    ApiError: class ApiError extends Error {
        constructor(
            message: string,
            public status: number,
        ) {
            super(message);
        }
    },
}));
import type { CodingSandboxList as SandboxList, CodingSandboxView } from '@socio/shared/coding/coding-sessions';

import { api } from '../src/lib/api';
import { ageText, CodingSandboxList, sandboxStatus } from '../src/modules/coding/CodingSandboxList';

// CB-239: the Computer panel's coding list. Rows from the server
// only (own, or everyone's for an admin), names and branches as plain
// text, Stop as a real button, nothing the agent wrote.

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(api).mockReset();
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const NOW = Date.now();
const row = (over: Partial<CodingSandboxView> = {}): CodingSandboxView => ({
    id: 'sess-1',
    mine: true,
    personName: 'Alice',
    repository: 'erden-sh/socio',
    branch: 'socio/rulo/ab12cd34',
    base: 'main',
    state: 'ready',
    working: false,
    endReason: null,
    createdAt: NOW - 125 * 60_000,
    endsAt: NOW + 3_600_000,
    endedAt: null,
    sandbox: true,
    diskBytes: 3 * 1024 * 1024,
    canStop: true,
    ...over,
});

const flush = () => act(async () => await new Promise((ok) => setTimeout(ok)));

it('words status, age and disk plainly', () => {
    expect(sandboxStatus(row())).toBe('Ready');
    expect(sandboxStatus(row({ working: true }))).toBe('Working');
    expect(sandboxStatus(row({ state: 'starting' }))).toBe('Setting up');
    expect(sandboxStatus(row({ state: 'ended', endReason: 'admin_stopped' }))).toBe('Stopped by an admin');
    expect(ageText(NOW - 30_000, NOW)).toBe('just now');
    expect(ageText(NOW - 125 * 60_000, NOW)).toBe('2 h 5 min ago');
    expect(ageText(NOW - 3 * 86_400_000, NOW)).toBe('3 days ago');
});

it('lists the rows the server gave, with Stop only where allowed, and someone else’s by name', async () => {
    const list: SandboxList = {
        sandboxes: [
            row(),
            row({
                id: 'sess-2',
                mine: false,
                personName: 'Bob',
                branch: 'socio/rulo/<img src=x onerror=alert(1)>',
            }),
            row({
                id: 'sess-3',
                state: 'ended',
                endReason: 'stopped',
                sandbox: false,
                canStop: false,
                diskBytes: null,
            }),
        ],
        diskMeasuredAt: NOW - 5 * 60_000,
    };
    vi.mocked(api).mockResolvedValue(list);
    await act(async () => {
        root.render(<CodingSandboxList dotId="dot-1" active />);
    });
    await flush();
    expect(vi.mocked(api).mock.calls[0]![0]).toBe('/gateway/sandboxes?socio=dot-1');
    const items = host.querySelectorAll('[data-slot="coding-sandbox"]');
    expect(items).toHaveLength(3);
    const text = host.textContent ?? '';
    expect(text).toContain('erden-sh/socio');
    expect(text).toContain('Yours');
    expect(text).toContain('For Bob');
    expect(text).toContain('3 MB on disk');
    expect(text).toContain('disk not measured yet');
    expect(text).toContain('Stopped');
    expect(text).toContain('workspace kept');
    // A branch name is text, never markup.
    expect(host.querySelector('img')).toBeNull();
    // Stop on the two live rows only, each a labeled button.
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Stop the coding session on erden-sh/socio');
    expect(text).toContain('recorded with your name');
});

it('stops through the server and reloads the list', async () => {
    vi.mocked(api).mockImplementation(async (path: string) =>
        path.endsWith('/stop')
            ? row({ state: 'ended', canStop: false })
            : ({ sandboxes: [row()], diskMeasuredAt: null } satisfies SandboxList),
    );
    await act(async () => {
        root.render(<CodingSandboxList dotId="dot-1" active />);
    });
    await flush();
    const stop = host.querySelector('button')!;
    await act(async () => {
        stop.click();
    });
    await flush();
    const calls = vi.mocked(api).mock.calls.map((call) => [call[0], call[1]]);
    expect(calls).toContainEqual(['/gateway/sandboxes/sess-1/stop', 'POST']);
    expect(calls.filter(([path]) => String(path).startsWith('/gateway/sandboxes?'))).toHaveLength(2);
});

it('says so when there is nothing, and loads nothing while its tab is hidden', async () => {
    vi.mocked(api).mockResolvedValue({ sandboxes: [], diskMeasuredAt: null });
    await act(async () => {
        root.render(<CodingSandboxList dotId="dot-1" active={false} />);
    });
    await flush();
    expect(api).not.toHaveBeenCalled();
    await act(async () => {
        root.render(<CodingSandboxList dotId="dot-1" active />);
    });
    await flush();
    expect(host.textContent).toContain('No coding sessions on this computer.');
});
