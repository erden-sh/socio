import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';

import { MCP_LIMITS } from '@socio/shared/mcp-connections';
import type { McpToolView } from '@socio/shared/mcp-connections';

import { reviewMcpCatalog } from './catalog.js';
import { mcpAssert } from './errors.js';

export interface McpChallenge {
    resourceMetadataUrl?: URL;
    scope?: string;
}
/** No authProvider: the SDK must never silently authorize/upscope and resend a business POST. */
export async function withMcpClient<T>(
    options: {
        url: string;
        fetch: typeof fetch;
        signal: AbortSignal;
        token?: string;
        challenge?: (value: McpChallenge) => void;
    },
    work: (client: Client) => Promise<T>,
): Promise<T> {
    const client = new Client(
        { name: 'socio', version: '1.0.0' },
        {
            capabilities: {},
            // SDK output validation is deferred to our bounded validator worker. Remote
            // schemas/regexes must never compile or run on the app's event loop.
            jsonSchemaValidator: {
                getValidator:
                    <Value>(_schema: JsonSchemaType): JsonSchemaValidator<Value> =>
                    (input: unknown) => ({
                        valid: true,
                        data: input as Value,
                        errorMessage: undefined,
                    }),
            },
        },
    );
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
        requestInit: options.token ? { headers: { Authorization: 'Bearer ' + options.token } } : undefined,
        reconnectionOptions: {
            maxRetries: 0,
            maxReconnectionDelay: 0,
            initialReconnectionDelay: 0,
            reconnectionDelayGrowFactor: 1,
        },
        fetch: async (input, init) => {
            mcpAssert(String(input) === options.url, 'External protocol request changed its destination.');
            const response = await options.fetch(input, {
                ...init,
                signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]),
            });
            if (response.status === 401 && options.challenge) {
                options.challenge(extractWWWAuthenticateParams(response));
            }
            return response;
        },
    });
    try {
        await client.connect(transport, {
            signal: options.signal,
            timeout: MCP_LIMITS.requestMs,
        });
        return await work(client);
    } finally {
        await client.close().catch(() => {});
    }
}
export async function listMcpCatalog(
    client: Client,
    signal: AbortSignal,
): Promise<{ tools: McpToolView[]; revision: string }> {
    const tools: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
        const response = await client.listTools(cursor ? { cursor } : {}, {
            signal,
            timeout: MCP_LIMITS.requestMs,
        });
        tools.push(...response.tools);
        mcpAssert(tools.length <= MCP_LIMITS.tools, 'The external server exposes too many tools.');
        if (!response.nextCursor) {
            return reviewMcpCatalog(tools);
        }
        mcpAssert(!seen.has(response.nextCursor), 'The external tool catalog repeated its cursor.');
        seen.add(response.nextCursor);
        cursor = response.nextCursor;
    }
    throw new Error('The external tool catalog exceeds its page limit.');
}
