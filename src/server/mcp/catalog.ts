import { MCP_LIMITS, type McpToolView } from '@socio/shared/mcp-connections';

import { mcpAssert } from './errors.js';
import { boundedJson, fingerprint } from './json.js';
import { inspectMcpSchema } from './schema.js';

/** No lossy schema conversion. Unsupported schemas remain visible but cannot be granted. */
export function reviewMcpCatalog(input: unknown): {
    tools: McpToolView[];
    revision: string;
} {
    boundedJson(input, MCP_LIMITS.catalogBytes);
    mcpAssert(Array.isArray(input) && input.length <= MCP_LIMITS.tools, 'The external server exposes too many tools.');
    const names = new Set<string>();
    const tools = input
        .map((value): McpToolView => {
            mcpAssert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid external tool catalog.');
            const raw = value as Record<string, unknown>;
            mcpAssert(
                typeof raw.name === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(raw.name) && !names.has(raw.name),
                'External tool names must be unique and bounded.',
            );
            names.add(raw.name);
            mcpAssert(
                raw.description === undefined ||
                    (typeof raw.description === 'string' && raw.description.length <= 2000),
                'External tool description exceeds its limit.',
            );
            mcpAssert(
                raw.inputSchema && typeof raw.inputSchema === 'object' && !Array.isArray(raw.inputSchema),
                'Missing external tool input schema.',
            );
            const data = {
                name: raw.name,
                description: (raw.description as string | undefined) ?? '',
                inputSchema: raw.inputSchema as Record<string, unknown>,
                ...(raw.outputSchema ? { outputSchema: raw.outputSchema as Record<string, unknown> } : {}),
                ...(raw.annotations ? { annotations: raw.annotations as Record<string, unknown> } : {}),
            };
            let refusal: string | undefined;
            try {
                inspectMcpSchema(data.inputSchema);
                if (data.outputSchema) {
                    inspectMcpSchema(data.outputSchema);
                }
            } catch {
                refusal = 'This tool uses a schema outside the supported bounded JSON Schema contract.';
            }
            return {
                ...data,
                fingerprint: fingerprint(data),
                supported: !refusal,
                ...(refusal ? { refusal } : {}),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        tools,
        revision: fingerprint(tools.map(({ fingerprint, name }) => ({ name, fingerprint }))),
    };
}
