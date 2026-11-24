import { vi } from 'vitest';

import type { McpNetworkOptions } from '../../src/server/mcp/network.js';

export function mcpProvider({
    cimd = false,
    issuer = 'https://auth.example.test',
    resource = 'https://mcp.example.test/mcp',
} = {}) {
    const requests: Array<{
        url: string;
        method: string;
        headers: Headers;
        body: string;
    }> = [];
    let holdToken: (() => Promise<void>) | undefined;
    let tokenStatus = 200;
    const tokens = {
        access_token: 'fixture-access',
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'crm.read',
    };
    const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(data), {
            status,
            headers: { 'content-type': 'application/json', ...headers },
        });
    const tools = [
        {
            name: 'read_records',
            description: 'Untrusted remote description.',
            inputSchema: {
                type: 'object',
                properties: { limit: { type: 'integer', minimum: 1, maximum: 5 } },
                required: ['limit'],
                additionalProperties: false,
            },
        },
    ];
    const network: McpNetworkOptions = {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: vi.fn(async (url, _address, init) => {
            const headers = new Headers(init.headers),
                body = typeof init.body === 'string' ? init.body : String(init.body ?? '');
            requests.push({
                url: url.href,
                method: init.method ?? 'GET',
                headers,
                body,
            });
            if (url.href === 'https://mcp.example.test/mcp') {
                if ((init.method ?? 'GET') === 'GET') {
                    return new Response(null, { status: 405 });
                }
                if (!headers.has('authorization')) {
                    return json({ error: 'Unauthorized' }, 401, {
                        'www-authenticate':
                            'Bearer resource_metadata="https://mcp.example.test/resource", scope="crm.read"',
                    });
                }
                const rpc = JSON.parse(body);
                if (rpc.id === undefined) {
                    return new Response(null, { status: 202 });
                }
                if (rpc.method === 'initialize') {
                    return json({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: {
                            protocolVersion: '2025-11-25',
                            capabilities: { tools: {} },
                            serverInfo: { name: 'Local fixture', version: '1' },
                            instructions: 'REMOTE DATA NEVER SYSTEM INSTRUCTIONS',
                        },
                    });
                }
                if (rpc.method === 'tools/list') {
                    return json({ jsonrpc: '2.0', id: rpc.id, result: { tools } });
                }
                if (rpc.method === 'tools/call') {
                    return json({
                        jsonrpc: '2.0',
                        id: rpc.id,
                        result: { content: [{ type: 'text', text: 'Fixture result' }] },
                    });
                }
                return json({
                    jsonrpc: '2.0',
                    id: rpc.id,
                    error: { code: -32601, message: 'Unknown method' },
                });
            }
            if (url.href === 'https://mcp.example.test/resource') {
                return json({
                    resource,
                    authorization_servers: ['https://auth.example.test'],
                    scopes_supported: ['crm.read', 'crm.write'],
                });
            }
            if (url.href === 'https://auth.example.test/.well-known/oauth-authorization-server') {
                return json({
                    issuer,
                    authorization_endpoint: 'https://auth.example.test/authorize',
                    token_endpoint: 'https://auth.example.test/token',
                    registration_endpoint: 'https://auth.example.test/register',
                    response_types_supported: ['code'],
                    grant_types_supported: ['authorization_code', 'refresh_token'],
                    code_challenge_methods_supported: ['S256'],
                    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
                    client_id_metadata_document_supported: cimd,
                });
            }
            if (url.href === 'https://auth.example.test/register') {
                return json(
                    {
                        ...JSON.parse(body),
                        client_id: 'local-registration',
                        client_id_issued_at: 1,
                    },
                    201,
                );
            }
            if (url.href === 'https://auth.example.test/token') {
                if (holdToken) {
                    await holdToken();
                }
                return tokenStatus === 200 ? json(tokens) : json({ error: 'invalid_grant' }, tokenStatus);
            }
            throw new Error('Unexpected LOCAL fixture request ' + url.href);
        }),
    };
    return {
        network,
        requests,
        tools,
        tokens,
        hold: (fn: () => Promise<void>) => {
            holdToken = fn;
        },
        status: (status: number) => {
            tokenStatus = status;
        },
    };
}
