import { expect, it } from 'vitest';

import { withMcpClient, listMcpCatalog } from '../src/server/mcp/client.js';
import { guardedMcpFetch } from '../src/server/mcp/network.js';

import { mcpProvider } from './helpers/mcp-provider.js';

it('does not authorize, upscope or resend a business POST when the server returns 401/403/500', async () => {
    for (const status of [401, 403, 500]) {
        const provider = mcpProvider(),
            original = provider.network.request!;
        let calls = 0;
        provider.network.request = async (url, address, init, signal) => {
            const message = typeof init.body === 'string' ? JSON.parse(init.body) : {};
            if (message.method === 'tools/call') {
                calls++;
                return new Response('{"error":"invalid_token"}', {
                    status,
                    headers: {
                        'content-type': 'application/json',
                        'www-authenticate':
                            'Bearer resource_metadata="https://mcp.example.test/resource", scope="crm.write"',
                    },
                });
            }
            return original(url, address, init, signal);
        };
        const signal = new AbortController().signal;
        await expect(
            withMcpClient(
                {
                    url: 'https://mcp.example.test/mcp',
                    token: 'fixture-access',
                    signal,
                    fetch: guardedMcpFetch(provider.network),
                },
                (client) =>
                    client.callTool({ name: 'read_records', arguments: { limit: 1 } }, undefined, {
                        signal,
                        timeout: 1000,
                    }),
            ),
        ).rejects.toThrow();
        expect(calls).toBe(1);
        expect(provider.requests.some((r) => r.url.endsWith('/token') || r.url.endsWith('/register'))).toBe(false);
    }
});
it('rejects repeated or excessive paginated tool catalogs through the actual SDK', async () => {
    const provider = mcpProvider(),
        original = provider.network.request!;
    provider.network.request = async (url, address, init, signal) => {
        const message = typeof init.body === 'string' ? JSON.parse(init.body) : {};
        if (message.method === 'tools/list') {
            return new Response(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { tools: [], nextCursor: 'same' },
                }),
                { headers: { 'content-type': 'application/json' } },
            );
        }
        return original(url, address, init, signal);
    };
    const signal = new AbortController().signal;
    await expect(
        withMcpClient(
            {
                url: 'https://mcp.example.test/mcp',
                token: 'fixture-access',
                signal,
                fetch: guardedMcpFetch(provider.network),
            },
            (client) => listMcpCatalog(client, signal),
        ),
    ).rejects.toThrow('repeated');
});
