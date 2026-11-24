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
import { CODING_PRIVATE_LINE, type CodingSessionView } from '@socio/shared/coding/coding-sessions';

import { api, ApiError } from '../src/lib/api';
import { CodingSessionPanel } from '../src/modules/coding/CodingSessionCard';
import { PrivateCodingLine, resultSession, withheldResult } from '../src/modules/dots/CodingSessionRenderer';

// CB-239: in a room, a coding session's
// results are its person's. Everyone else sees one neutral line, from a
// withheld result or a session the server won't show them.

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

const flush = () => act(async () => await new Promise((ok) => setTimeout(ok)));

it('knows a withheld result, and never reads a session id out of one', () => {
    const withheld = JSON.stringify({
        withheld: true,
        tool: 'coding_prompt',
        status: 'ok',
        note: 'private',
    });
    expect(withheldResult(withheld)).toBe(true);
    expect(resultSession(withheld)).toBeUndefined();
    expect(withheldResult(JSON.stringify({ session: { id: 's1' } }))).toBe(false);
    expect(withheldResult('not json')).toBe(false);
});

it('shows the neutral line, and nothing else, for a withheld result', () => {
    act(() => root.render(<PrivateCodingLine />));
    expect(host.textContent).toBe(CODING_PRIVATE_LINE);
});

it('shows the neutral line when the session isn’t the viewer’s (404)', async () => {
    vi.mocked(api).mockRejectedValue(new ApiError('No such session.', 404));
    await act(async () => {
        root.render(<CodingSessionPanel id="sess-1" />);
    });
    await flush();
    expect(host.textContent).toBe(CODING_PRIVATE_LINE);
});

it('says the agent’s words are hidden once its person may no longer use the repository', async () => {
    const view: CodingSessionView = {
        id: 'sess-1',
        socioName: 'Rulo',
        repository: 'erden-sh/socio',
        base: 'main',
        branch: 'socio/rulo/ab12cd34',
        model: 'orion',
        modelLabel: 'Homelab',
        push: true,
        state: 'ended',
        endReason: 'revoked',
        createdAt: Date.now(),
        endsAt: Date.now(),
        endedAt: Date.now(),
        tokens: { used: 1, left: 1, budget: 2 },
        run: {
            id: 'run-1',
            kind: 'prompt',
            state: 'done',
            startedAt: Date.now(),
            endedAt: Date.now(),
            progress: [],
            summary: null,
            changedFiles: [],
            tokens: 1,
        },
        pullRequest: null,
        denials: [],
        resultsWithheld: true,
    };
    vi.mocked(api).mockResolvedValue(view);
    await act(async () => {
        root.render(<CodingSessionPanel id="sess-1" />);
    });
    await flush();
    expect(host.querySelector('[data-slot="coding-session-withheld"]')?.textContent).toContain(
        'you can no longer use this repository',
    );
});
