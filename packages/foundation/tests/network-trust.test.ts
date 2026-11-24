import { Hono } from 'hono';
import { expect, it } from 'vitest';

import {
    clientAddress,
    computerMayCall,
    computersGuard,
    networkTrustFromEnv,
    peerIsProxy,
} from '../src/http/network-trust.js';

// CB-309: socios' computers reach the app on the computers network for the
// data API only, and never choose the client address rate limits count.

const trust = networkTrustFromEnv({
    COMPUTERS_SUBNET: '10.0.28.0/24',
    TRUSTED_PROXY_SUBNETS: '10.0.4.0/24, 172.18.0.0/16',
});
const fromPeer = (remoteAddress: string | undefined) => ({
    incoming: { socket: { remoteAddress } },
});

it('reads the subnets, and refuses malformed ones at start', () => {
    expect(trust.computers).toBeDefined();
    expect(trust.proxies).toHaveLength(2);
    expect(networkTrustFromEnv({})).toEqual({ proxies: [] });
    expect(() => networkTrustFromEnv({ COMPUTERS_SUBNET: '10.0.28.0' })).toThrow(/COMPUTERS_SUBNET/);
    expect(() => networkTrustFromEnv({ TRUSTED_PROXY_SUBNETS: '10.0.4.0/24, nope' })).toThrow(/"nope"/);
});

it('trusts X-Forwarded-For only from the proxy, never from a computer', () => {
    expect(peerIsProxy(trust, '10.0.4.7')).toBe(true);
    expect(peerIsProxy(trust, '::ffff:10.0.4.7')).toBe(true);
    expect(peerIsProxy(trust, '10.0.28.9')).toBe(false);
    expect(peerIsProxy(trust, '10.0.9.9')).toBe(false);
    // Without proxy subnets: any peer but a computer, as before.
    const open = networkTrustFromEnv({ COMPUTERS_SUBNET: '10.0.28.0/24' });
    expect(peerIsProxy(open, '10.0.9.9')).toBe(true);
    expect(peerIsProxy(open, '10.0.28.9')).toBe(false);
});

it('takes the client address from the proxy’s last hop, else the socket', async () => {
    const app = new Hono();
    app.get('/ip', (c) => c.text(clientAddress(c, true, trust) ?? 'none'));
    app.get('/raw', (c) => c.text(clientAddress(c, false, trust) ?? 'none'));
    const ask = async (peer: string, forwarded = '198.51.100.1, 203.0.113.9') =>
        (await app.request('/ip', { headers: { 'x-forwarded-for': forwarded } }, fromPeer(peer))).text();
    expect(await ask('10.0.4.7')).toBe('203.0.113.9');
    // A computer forging the header is counted by its own address.
    expect(await ask('10.0.28.9')).toBe('10.0.28.9');
    expect(await ask('10.0.28.9', '203.0.113.77')).toBe('10.0.28.9');
    // AUTH_TRUST_PROXY off: always the socket.
    const raw = await app.request('/raw', { headers: { 'x-forwarded-for': '203.0.113.9' } }, fromPeer('10.0.4.7'));
    expect(await raw.text()).toBe('10.0.4.7');
});

it('lets a computer reach the data API, health and actor routes only', async () => {
    for (const path of [
        '/healthz',
        '/api/data',
        '/api/data/datasets/scratch/tables/t/rows',
        '/api/data/job',
        '/api/apps/actor/approvals',
        '/api/plugins/planner/actor/approvals/1/consume',
    ]) {
        expect(computerMayCall(path), path).toBe(true);
    }
    for (const path of [
        '/',
        '/api/auth/sign-in/email',
        '/api/workspace',
        '/api/issues',
        '/api/database',
        '/api/apps/list',
        '/api/plugins/planner/admin',
    ]) {
        expect(computerMayCall(path), path).toBe(false);
    }

    const app = new Hono();
    app.use('*', computersGuard(trust));
    app.all('*', (c) => c.text('reached'));
    const call = (path: string, peer: string | undefined) => app.request(path, { method: 'POST' }, fromPeer(peer));
    const refused = await call('/api/auth/sign-in/email', '10.0.28.9');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
        error: 'Not available from a socio’s computer.',
    });
    expect((await call('/api/data/query', '10.0.28.9')).status).toBe(200);
    expect((await call('/api/auth/sign-in/email', '10.0.4.7')).status).toBe(200);
    // No socket (in-process requests): not a computer.
    expect((await call('/api/auth/sign-in/email', undefined)).status).toBe(200);
    // No COMPUTERS_SUBNET: nothing is refused.
    const open = new Hono();
    open.use('*', computersGuard({ proxies: [] }));
    open.all('*', (c) => c.text('reached'));
    expect((await open.request('/api/issues', {}, fromPeer('10.0.28.9'))).status).toBe(200);
});
