// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DomainOp, DomainsStatus } from '@socio/shared/domains';

import { DomainsCard } from '../src/modules/operator/DomainsCard';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let routes: Record<string, (body?: unknown) => [number, unknown]>;
let calls: { method: string; path: string; body?: unknown }[];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    routes = {};
    calls = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
        const url = new URL(input, 'http://app.test');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path: url.pathname, body });
        const handler = routes[`${method} ${url.pathname}`];
        const [code, reply] = handler ? handler(body) : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(reply), {
            status: code,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

async function until(check: () => boolean, what: string, ms = 3000) {
    for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        if (check()) {
            return;
        }
        await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for ${what}: ${document.body.textContent}`);
}
const text = () => document.body.textContent ?? '';
const byLabel = (label: string) => document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === name)!;
const click = (element: HTMLElement) => act(() => element.click());

const op = (patch: Partial<DomainOp>): DomainOp => ({
    id: 'op-1',
    kind: 'ensure_base',
    hostname: 'brain.example.test',
    actor: 'olga',
    status: 'ok',
    steps: [],
    startedAt: Date.parse('2026-10-08T10:00:00Z'),
    finishedAt: Date.parse('2026-10-08T10:01:00Z'),
    ...patch,
});
const expires = new Date(Date.now() + 80 * 86_400_000).toISOString();
const ready: DomainsStatus = {
    enabled: true,
    missing: [],
    settings: {
        zone: 'example.test',
        base: 'brain.example.test',
        targetIp: '10.0.0.10',
        upstream: 'http://company-brain_app:4310',
        npmApiUrl: 'http://ingress_proxy:81/api',
        acmeEmail: true,
    },
    base: {
        ok: true,
        certificate: {
            id: 1,
            domains: ['brain.example.test', '*.brain.example.test'],
            expiresOn: expires,
        },
        hostnames: ['brain.example.test', '*.brain.example.test'].map((hostname) => ({
            hostname,
            kind: 'base' as const,
            dnsContent: '10.0.0.10',
            proxyHostId: 2,
            proxyHostOk: true,
            certificate: { id: 1, domains: [], expiresOn: expires },
            createdBy: 'olga',
            createdAt: 0,
            updatedAt: 0,
        })),
    },
    hosts: [
        {
            hostname: 'shop.example.test',
            kind: 'custom',
            dnsContent: '10.0.0.10',
            proxyHostId: 4,
            proxyHostOk: true,
            certificate: {
                id: 3,
                domains: ['shop.example.test'],
                expiresOn: expires,
            },
            createdBy: 'olga',
            createdAt: 0,
            updatedAt: 0,
        },
    ],
    ops: [
        op({
            steps: [
                { item: 'dns', name: 'brain.example.test', action: 'updated' },
                { item: 'certificate', name: 'brain.example.test', action: 'kept' },
            ],
        }),
        op({
            id: 'op-0',
            kind: 'provision',
            hostname: 'x.example.test',
            status: 'failed',
            error: 'DOMAINS_ACME_EMAIL is not set',
        }),
    ],
};

it('says what is missing when the module is off', async () => {
    routes['GET /api/domains'] = () => [200, { enabled: false, missing: ['NPM_CREDENTIALS_FILE'], hosts: [], ops: [] }];
    act(() => root.render(<DomainsCard />));
    await until(() => text().includes('Off: set NPM_CREDENTIALS_FILE'), 'off');
    expect(button('Set up domains')).toBeUndefined();
});

it('shows the base, provisioned names, operations, and starts each operation', async () => {
    let status: DomainsStatus = { ...ready, base: undefined, hosts: [], ops: [] };
    routes['GET /api/domains'] = () => [200, status];
    routes['POST /api/domains/base'] = () => {
        status = { ...ready, running: op({ status: 'running' }) };
        return [202, { op: op({ status: 'running' }) }];
    };
    routes['POST /api/domains/hosts'] = (body) => [
        202,
        {
            op: op({
                kind: 'provision',
                hostname: (body as { hostname: string }).hostname,
                status: 'running',
            }),
        },
    ];
    routes['DELETE /api/domains/hosts/shop.example.test'] = () => [
        202,
        {
            op: op({
                kind: 'remove',
                hostname: 'shop.example.test',
                status: 'running',
            }),
        },
    ];
    act(() => root.render(<DomainsCard />));
    await until(() => text().includes('Not set up'), 'not set up');
    click(button('Set up domains'));
    await until(() => text().includes('Set up base brain.example.test: running'), 'running');
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/domains/base')).toBe(true);
    // Done: the base, names and the operations.
    status = ready;
    await until(() => text().includes('Ready') && !text().includes(': running'), 'ready', 5000);
    expect(text()).toContain('shop.example.test');
    expect(text()).toMatch(/certificate until .* \((79|80) days\)/);
    expect(text()).toContain('dns brain.example.test updated');
    expect(text()).toContain('DOMAINS_ACME_EMAIL is not set');
    expect(button('Repair')).toBeTruthy();
    const input = byLabel('Host name to provision') as HTMLInputElement;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setter.call(input, 'docs.example.test');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(button('Provision'));
    await until(() => calls.some((c) => c.method === 'POST' && c.path === '/api/domains/hosts'), 'provision');
    expect(calls.find((c) => c.path === '/api/domains/hosts')?.body).toEqual({
        hostname: 'docs.example.test',
    });
    click(byLabel('Remove shop.example.test'));
    await until(() => calls.some((c) => c.method === 'DELETE'), 'remove');
});
