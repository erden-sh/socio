// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CloudStatus } from '@socio/shared/cloud';

import { CloudConnectionCard } from '../src/modules/operator/CloudConnectionCard';

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root;
let host: HTMLElement;
let reply: [number, unknown];

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', async (input: string) => {
        const url = new URL(input, 'http://app.test');
        const [code, body] = url.pathname === '/api/cloud' ? reply : [404, { error: 'Not found.' }];
        return new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
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

async function show(status: CloudStatus | [number, unknown]) {
    reply = Array.isArray(status) ? status : [200, status];
    act(() => root.render(<CloudConnectionCard />));
    await until(() => !document.querySelector('[data-slot="skeleton"]') && text().includes('Cloud connection'), 'load');
}

it('shows a connected deployment: id, mode, what it may use and the last sync', async () => {
    await show({
        connection: 'connected',
        issuer: 'https://cloud.example.test',
        deploymentId: 'dep_01ABCDEFGHJKMNPQRSTVWXYZ00',
        deploymentMode: 'hosted',
        scopes: ['reports:write', 'push:send', 'updates:read'],
        enrolledAt: Date.UTC(2026, 10, 26, 12),
        lastSyncAt: Date.UTC(2026, 10, 26, 13),
    });
    await until(() => text().includes('dep_01ABCDEFGHJKMNPQRSTVWXYZ00'), 'the deployment id');
    expect(text()).toContain('Connected');
    expect(text()).toContain('Hosted');
    expect(text()).toContain('reports:write, push:send, updates:read');
    expect(text()).toContain('Last sync');
    expect(text()).not.toContain('Not yet');
});

it('says when the key was revoked, and what to do', async () => {
    await show({
        connection: 'revoked',
        issuer: 'https://cloud.example.test',
        deploymentId: 'dep_01ABCDEFGHJKMNPQRSTVWXYZ00',
        deploymentMode: 'self-hosted',
        scopes: [],
    });
    await until(() => text().includes('Revoked'), 'the revoked badge');
    expect(text()).toContain('refused this server’s key');
    expect(text()).toContain('Self-hosted');
    expect(text()).toContain('Nothing');
    expect(text()).toContain('Not yet');
});

it('says when the identity is lost, and shows no deployment', async () => {
    await show({ connection: 'lost', issuer: 'https://cloud.example.test', scopes: [] });
    await until(() => text().includes('Identity lost'), 'the lost badge');
    expect(text()).toContain('SOCIO_CLOUD_REPLACE_LOST=true');
    expect(text()).not.toContain('Deployment mode');
});

it('shows the error when it can’t load', async () => {
    await show([403, { error: 'Only an admin can change this.' }]);
    await until(() => text().includes('Only an admin'), 'the error');
});
