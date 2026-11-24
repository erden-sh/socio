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
import type { CodingSessionCard, CodingSessionView } from '@socio/shared/coding/coding-sessions';

import { api } from '../src/lib/api';
import { CodingSessionPanel, CodingStartBody } from '../src/modules/coding/CodingSessionCard';
import { resultSession } from '../src/modules/dots/CodingSessionRenderer';

// CB-239: the start card and the session card in the chat. Platform
// facts first; the socio's and the agent's words only as plain text.

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
    vi.useRealTimers();
});

const card: CodingSessionCard = {
    kind: 'coding_session',
    socioName: 'Rulo',
    repository: 'erden-sh/socio',
    base: 'main',
    branchPattern: 'socio/rulo/…',
    push: true,
    minutes: 120,
    model: { label: 'Grok 5', outsideProvider: true, host: 'api.x.ai' },
    budgetTokens: 2_000_000,
    allows: ['read the repository', 'push to its own branch under socio/rulo/…'],
    never: 'It can’t change the base or any other branch.',
    visibleTo: 'Sales room',
    task: '**Fix** <img src=x onerror=alert(1)> [link](https://evil.example)‮',
};

it('shows the start card’s facts, the outside provider and the room, with the socio’s words as plain text', () => {
    act(() => root.render(<CodingStartBody card={card} />));
    const text = host.textContent ?? '';
    expect(text).toContain('Rulo wants to work on erden-sh/socio for you for 2 hours');
    expect(text).toContain('socio/rulo/…');
    expect(text).toContain('Grok 5, at api.x.ai');
    expect(text).toContain('The repository’s code it works on is sent to api.x.ai');
    expect(text).toContain('visible to everyone in Sales room');
    expect(text).toContain('2 M tokens');
    // Inert: no element, link or image from the task; hidden characters shown.
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
    expect(text).toContain('**Fix** <img src=x onerror=alert(1)>');
    expect(text).toContain('[U+202E]');
});

it('names the coding agent and that it runs on Socio’s gateway (CB-326), OpenCode on older cards', () => {
    act(() =>
        root.render(
            <CodingStartBody
                card={{ ...card, harness: { id: 'claude-code', label: 'Claude Code', route: 'gateway' } }}
            />,
        ),
    );
    expect(host.querySelector('[data-slot="coding-session-harness"]')?.textContent).toBe(
        'Claude Code, on Socio’s model gateway',
    );
    act(() => root.render(<CodingStartBody card={card} />));
    expect(host.querySelector('[data-slot="coding-session-harness"]')?.textContent).toBe(
        'OpenCode, on Socio’s model gateway',
    );
});
it('says when a session runs on the person’s own plan', () => {
    act(() =>
        root.render(
            <CodingStartBody
                card={{
                    ...card,
                    model: {
                        label: 'ChatGPT gpt-6.1-sol',
                        outsideProvider: true,
                        host: null,
                    },
                    plan: { label: 'ChatGPT' },
                    visibleTo: null,
                }}
            />,
        ),
    );
    const text = host.textContent ?? '';
    expect(text).toContain('ChatGPT gpt-6.1-sol, on your own plan');
    expect(text).toContain(
        'This session runs on your own ChatGPT plan: the repository’s code it works on goes to OpenAI through your plan',
    );
    expect(host.querySelector('[data-slot="coding-session-plan"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="coding-session-outside"]')).toBeNull();
});

const view = (change: Partial<CodingSessionView> = {}): CodingSessionView => ({
    id: 'sess-1',
    socioName: 'Rulo',
    repository: 'erden-sh/socio',
    base: 'main',
    branch: 'socio/rulo/1a2b3c4d',
    model: 'orion',
    modelLabel: 'Homelab (qwen38)',
    push: true,
    state: 'ready',
    endReason: null,
    createdAt: 1,
    endsAt: 2,
    endedAt: null,
    tokens: { used: 1_250_000, left: 750_000, budget: 2_000_000 },
    run: {
        id: 'run-1',
        kind: 'prompt',
        state: 'running',
        startedAt: 1,
        endedAt: null,
        progress: ['edit: src/index.ts', 'bash: pnpm test (running)'],
        summary: null,
        changedFiles: [],
        tokens: null,
    },
    pullRequest: {
        number: 42,
        url: 'https://github.com/erden-sh/socio/pull/42',
    },
    denials: [{ target: 'api.openai.com:443', count: 2 }],
    ...change,
});

it('shows the session card: repository, branch, model, state, tokens, progress and the PR', async () => {
    vi.mocked(api).mockResolvedValue(view());
    await act(async () => root.render(<CodingSessionPanel id="sess-1" />));
    expect(vi.mocked(api)).toHaveBeenCalledWith('/gateway/sessions/sess-1', 'GET', undefined, expect.anything());
    const section = host.querySelector('section')!;
    expect(section.getAttribute('aria-label')).toBe('Coding session on erden-sh/socio');
    const text = section.textContent ?? '';
    expect(text).toContain('Working');
    expect(text).toContain('socio/rulo/1a2b3c4d from main');
    expect(text).toContain('Homelab (qwen38)');
    expect(text).toContain('1.3 M of 2 M');
    expect(text).toContain('bash: pnpm test (running)');
    expect(text).toContain('api.openai.com:443 (2)');
    const link = section.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://github.com/erden-sh/socio/pull/42');
    expect(link.getAttribute('rel')).toContain('noopener');
    // Progress is announced politely to screen readers.
    expect(section.querySelector('[aria-live="polite"]')).not.toBeNull();
});

it('shows the agent’s final message as plain text, and why a session ended', async () => {
    vi.mocked(api).mockResolvedValue(
        view({
            state: 'ended',
            endReason: 'idle',
            pullRequest: null,
            run: {
                ...view().run!,
                state: 'done',
                summary: '# Done\n<script>alert(1)</script>',
                changedFiles: ['a.ts', 'b.ts'],
            },
        }),
    );
    await act(async () => root.render(<CodingSessionPanel id="sess-1" />));
    const text = host.textContent ?? '';
    expect(text).toContain('Ended after 30 minutes without a prompt');
    expect(text).toContain('# Done');
    expect(text).toContain('2 files changed');
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('h1')).toBeNull();
});

it('shows the neutral line when the session isn’t the reader’s', async () => {
    const { ApiError } = await import('../src/lib/api');
    vi.mocked(api).mockRejectedValue(new ApiError('No such session.', 404));
    await act(async () => root.render(<CodingSessionPanel id="sess-1" />));
    expect(host.textContent).toContain('private to the person it works for');
});

it('finds the session a tool result names, and nothing else', () => {
    expect(resultSession(JSON.stringify({ session: { id: 'abc-1' } }))).toBe('abc-1');
    expect(resultSession({ session: { id: '../x' } })).toBeUndefined();
    expect(resultSession('not json')).toBeUndefined();
    expect(resultSession(JSON.stringify({ status: 'refused' }))).toBeUndefined();
});

it('shows the model’s label inert and links only a GitHub pull request', async () => {
    vi.mocked(api).mockResolvedValue(
        view({
            modelLabel: 'Homelab‮evil',
            pullRequest: { number: 7, url: 'javascript:alert(1)' },
        }),
    );
    await act(async () => root.render(<CodingSessionPanel id="sess-1" />));
    const section = host.querySelector('section')!;
    expect(section.textContent).toContain('Homelab[U+202E]evil');
    expect(section.querySelector('a')).toBeNull();
    vi.mocked(api).mockResolvedValue(
        view({
            pullRequest: { number: 8, url: 'https://github.example/pull/8' },
        }),
    );
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<CodingSessionPanel id="sess-2" />));
    expect(host.querySelector('a')).toBeNull();
});
