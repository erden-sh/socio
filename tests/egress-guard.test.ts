import { request } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from 'vitest';

import { takeEgressAttempts } from './setup/egress-guard.js';

it('refuses fetch to a public host before any DNS lookup or connection', async () => {
    await expect(fetch('https://telemetry.copilotkit.ai/ingest')).rejects.toThrow();
    expect(takeEgressAttempts()).toEqual(['telemetry.copilotkit.ai:443']);
});

it('refuses a DNS-pinned connection whose pinned address is public', async () => {
    const error = await new Promise<Error>((resolve) => {
        const req = request({
            host: 'api.openai.com',
            port: 443,
            lookup: (_host, _options, callback) => callback(null, [{ address: '203.0.113.7', family: 4 }]),
        });
        req.on('error', resolve);
        req.end();
    });
    expect(error.message).toContain('Test egress guard blocked');
    expect(takeEgressAttempts()).toEqual(['api.openai.com:443 (203.0.113.7)']);
});

it('allows loopback connections', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address() as AddressInfo;
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok');
        expect(takeEgressAttempts()).toEqual([]);
    } finally {
        server.close();
    }
});
