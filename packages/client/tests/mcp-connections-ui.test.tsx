// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { McpConnectionsState } from '@socio/shared/mcp-connections';

import { api } from '../src/lib/api';
import { McpConnectionsSection } from '../src/modules/settings/McpConnectionsSection';

vi.mock('../src/lib/api', () => ({ api: vi.fn() }));
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement, state: McpConnectionsState;
const id = '88b88b88-8888-4888-8888-888888888888';
const unsafe = '<img src="https://untrusted.example/image" onerror="alert(1)">';
beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    state = {
        socios: [{ id: 'dot', name: 'Socio' }],
        connections: [
            {
                id,
                name: unsafe,
                url: 'https://mcp.example.test/mcp',
                authentication: 'none',
                state: 'review',
                generation: 2,
                catalogRevision: 'c'.repeat(64),
                createdAt: 1,
                updatedAt: 1,
                grants: [],
                tools: [
                    {
                        name: 'allowed',
                        description: unsafe,
                        inputSchema: {
                            type: 'object',
                            properties: { note: { type: 'string', description: unsafe } },
                        },
                        fingerprint: 'f'.repeat(64),
                        supported: true,
                    },
                    {
                        name: 'unsupported',
                        description: 'Unsupported constraint',
                        inputSchema: { type: 'object', unsafeKeyword: true },
                        fingerprint: 'd'.repeat(64),
                        supported: false,
                        refusal: 'Unsupported schema keyword.',
                    },
                ],
            },
        ],
    };
    vi.mocked(api)
        .mockReset()
        .mockImplementation(async (path, method = 'GET', body) => {
            if (path === '/mcp-connections' && method === 'GET') {
                return structuredClone(state);
            }
            if (path.endsWith('/grants')) {
                state.connections[0].grants = [
                    {
                        dotId: 'dot',
                        tools: (body as { tools: string[] }).tools,
                        catalogRevision: 'c'.repeat(64),
                        revision: 'reviewed',
                    },
                ];
                return state.connections[0].grants;
            }
            if (path.endsWith('/disconnect')) {
                state.connections[0].state = 'disconnected';
                state.connections[0].tools = [];
                state.connections[0].catalogRevision = null;
                return state.connections[0];
            }
            if (path.endsWith('/discover')) {
                return {
                    connection: state.connections[0],
                    issuer: 'https://auth.example.test/',
                    resource: 'https://mcp.example.test/mcp',
                    scopes: ['crm.read', 'crm.write'],
                    requiredScopes: ['crm.read'],
                    registration: { clientMetadata: true, dynamic: true },
                };
            }
            if (method === 'POST' && path === '/mcp-connections') {
                return {};
            }
            throw new Error('Unexpected fixture action');
        });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label)!;
const click = async (element: HTMLElement) =>
    act(async () => {
        element.click();
    });
const render = async () =>
    act(async () => {
        root.render(<McpConnectionsSection />);
    });
it('renders untrusted metadata as text, disables unsupported tools and grants only explicit selections', async () => {
    await render();
    expect(host.textContent).toContain(unsafe);
    expect(host.querySelectorAll('img,script,iframe,a')).toHaveLength(0);
    expect(vi.mocked(api).mock.calls).toHaveLength(1);
    const tools = host.querySelector('fieldset')!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(tools[0].checked).toBe(false);
    expect(tools[1].disabled).toBe(true);
    expect(JSON.parse(host.querySelector('pre')!.textContent!).inputSchema.properties.note.description).toBe(unsafe);
    await click(tools[0]);
    await click(button('Save tool access for this socio'));
    expect(vi.mocked(api)).toHaveBeenCalledWith('/mcp-connections/' + id + '/grants', 'PUT', {
        generation: 2,
        catalogRevision: 'c'.repeat(64),
        dotId: 'dot',
        tools: ['allowed'],
    });
    expect(host.querySelector<HTMLInputElement>('fieldset input')!.checked).toBe(true);
    await click(button('Disconnect'));
    expect(host.textContent).toContain('Status: disconnected');
    expect(host.querySelector('fieldset')).toBeNull();
});
it('contacts no remote server on load and requests no OAuth scope before explicit review', async () => {
    state.connections[0].authentication = 'oauth';
    state.connections[0].tools = [];
    state.connections[0].catalogRevision = null;
    state.connections[0].state = 'draft';
    await render();
    expect(vi.mocked(api).mock.calls).toEqual([['/mcp-connections']]);
    await click(button('Review authorization'));
    const scopes = host
        .querySelector('[aria-label="Authorization review"]')!
        .querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect([...scopes].map((e) => e.checked)).toEqual([false, false]);
    expect(host.textContent).toContain('https://auth.example.test/');
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith('/authorize'))).toBe(false);
    const secret = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(secret.autocomplete).toBe('new-password');
});
it('does not expose grants or provider errors when loading fails', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Sign in to continue.'));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Sign in to continue.');
    expect(host.querySelectorAll('article')).toHaveLength(0);
    expect(button('Add connection').disabled).toBe(true);
});
it('draws its selects with the shared native select, out of the legacy styles (CB-258)', async () => {
    await render();
    const selects = [...host.querySelectorAll('select')];
    expect(selects.length).toBeGreaterThanOrEqual(2);
    for (const select of selects) {
        expect(select.dataset.slot).toBe('native-select');
        expect(select.classList).toContain('py-0');
        expect(select.classList).toContain('leading-normal');
    }
    const authentication = selects.find((select) =>
        select.closest('label')?.textContent?.startsWith('Authentication'),
    )!;
    expect(authentication.value).toBe('oauth');
});
