// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentConsentView, AgentGrantView } from '@socio/shared/agent-grants';

import { ConnectedAgentsSection } from '../src/modules/settings/ConnectedAgentsSection';
import { ConnectAgent, restartAuthorization } from '../src/views/ConnectAgent';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

async function until(check: () => boolean, what: string) {
    for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${host?.textContent}`);
}
const type = (element: HTMLInputElement, value: string) =>
    act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    });
const button = (text: string) => [...host!.querySelectorAll('button')].find((entry) => entry.textContent === text)!;
const mount = (element: React.ReactNode) => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(element));
};

const QUERY = 'client_id=https%3A%2F%2Fclient.example%2Fm.json&scope=issues%3Aread&sig=abc';
const VIEW: AgentConsentView = {
    clientId: 'https://client.example/m.json',
    clientName: 'Claude Code',
    logoUri: null,
    clientUri: null,
    metadataHost: 'client.example',
    clientDomain: null,
    localApp: true,
    redirectUri: 'http://127.0.0.1:33418/callback',
    scopes: ['issues:read', 'pages:read', 'offline_access'],
    personName: 'Ada',
    refusal: null,
};

/** The consent screen at `/connect?…`, its answers from `reply`. */
function consent(view: AgentConsentView) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        calls.push({
            method,
            path: `${url.pathname}${url.search}`,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const reply = method === 'GET' ? view : { url: 'http://127.0.0.1:33418/callback?code=c' };
        return new Response(JSON.stringify(reply), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mount(
        <MemoryRouter initialEntries={[`/connect?${QUERY}`]}>
            <ConnectAgent />
        </MemoryRouter>,
    );
    return { calls, assign };
}

it('shows an unverified local app with a warning, the scopes in words and the person, and approves with a label', async () => {
    const { calls, assign } = consent(VIEW);
    await until(() => !!host!.textContent?.includes('wants to act'), 'consent');
    expect(calls[0].path).toBe(`/api/agent-consent?query=${encodeURIComponent(QUERY)}`);
    const text = host!.textContent!;
    expect(text).toContain('Claude Code wants to act for you');
    expect(host!.querySelector('[data-slot="agent-unverified"]')?.textContent).toBe('Unverified local app');
    expect(text).toContain('Any program there can claim to be Claude Code');
    expect(text).toContain('It will act as you, Ada');
    expect([...host!.querySelectorAll('[aria-label="What it may do"] li')].map((item) => item.textContent)).toEqual([
        'Search and read issues and their comments',
        'Read Spaces, their page trees and search them',
        'Stay connected until you disconnect it, without asking again',
    ]);
    const label = host!.querySelector<HTMLInputElement>('[aria-label="Connection name"]')!;
    expect(label.value).toBe('Claude Code');
    await type(label, 'Claude Code on laptop');
    expect(host!.textContent).toContain('“Claude Code on laptop for Ada”');
    await act(async () => button('Approve').click());
    await until(() => assign.mock.calls.length > 0, 'the redirect');
    expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: '/api/agent-consent',
        body: { query: QUERY, accept: true, label: 'Claude Code on laptop' },
    });
    expect(assign).toHaveBeenCalledWith('http://127.0.0.1:33418/callback?code=c');
});

it('shows a verified domain prominently, and an admin’s refusal disables Approve', async () => {
    consent({
        ...VIEW,
        clientDomain: 'agents.example',
        localApp: false,
        refusal: 'This workspace’s admins allow agents from claude.ai only.',
    });
    await until(() => !!host!.textContent?.includes('wants to act'), 'consent');
    expect(host!.querySelector('[data-slot="agent-domain"]')?.textContent).toBe('agents.example');
    expect(host!.querySelector('[data-slot="agent-unverified"]')).toBeNull();
    expect(host!.textContent).toContain('allow agents from claude.ai only');
    expect(button('Approve').disabled).toBe(true);
    expect(button('Deny').disabled).toBe(false);
});

it('starts the request over without its signature after sign-in', () => {
    expect(
        restartAuthorization(
            '?client_id=c&prompt=login+consent&state=s&exp=1&ba_iat=2&ba_pl=x&ba_param=a&ba_param=b&sig=z',
        ),
    ).toBe('/api/auth/oauth2/authorize?client_id=c&prompt=consent&state=s');
});

it('lists connected agents and disconnects one', async () => {
    let grants: AgentGrantView[] = [
        {
            grantId: 'g1',
            userId: 'u-ada',
            clientId: 'https://client.example/m.json',
            clientName: 'Claude Code',
            clientDomain: null,
            localApp: true,
            label: 'Claude Code on laptop',
            scopes: ['issues:read'],
            createdAt: 1,
            lastUsedAt: null,
            expiresAt: null,
            revokedAt: null,
            revokedBy: null,
        },
    ];
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://app.test').pathname;
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (init?.method === 'DELETE') {
            grants = [];
        }
        return new Response(JSON.stringify({ grants }), {
            headers: { 'Content-Type': 'application/json' },
        });
    });
    mount(<ConnectedAgentsSection />);
    await until(() => !!host!.textContent?.includes('Claude Code on laptop'), 'the list');
    expect(host!.textContent).toContain('Unverified local app');
    expect(host!.textContent).toContain('last used never');
    await act(async () => button('Disconnect').click());
    const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-slot="confirm-disconnect-agent"] button'),
    ].find((entry) => entry.textContent === 'Disconnect')!;
    await act(async () => confirm.click());
    await until(() => !!host!.textContent?.includes('No connected agents.'), 'the empty list');
    expect(calls).toContain('DELETE /api/agent-grants/g1');
});

it('replaces a failed client logo with a neutral icon without hiding consent details', async () => {
    consent({
        ...VIEW,
        clientName: 'Codex',
        logoUri: 'https://persistent.oaistatic.com/sonic/misc/openai-logo.png',
    });
    await until(() => !!host!.querySelector('img'), 'client logo');
    const image = host!.querySelector('img')!;
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(host!.querySelector('img')).toBeNull();
    expect(host!.querySelector('[data-slot="agent-logo-fallback"]')).not.toBeNull();
    expect(host!.textContent).toContain('Codex wants to act for you');
    expect(host!.textContent).toContain('Unverified local app');
    expect(button('Approve').disabled).toBe(false);
});
it('uses the same neutral icon when the client supplies no logo', async () => {
    consent(VIEW);
    await until(() => !!host!.textContent?.includes('wants to act'), 'consent');
    expect(host!.querySelector('[data-slot="agent-logo-fallback"]')).not.toBeNull();
});
