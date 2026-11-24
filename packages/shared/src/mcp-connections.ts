/** External MCP connections belong to one person, including grants to shared socios. */
export const MCP_CONNECTION_STATES = ['draft', 'authorizing', 'review', 'connected', 'disconnected', 'error'] as const;
export type McpConnectionState = (typeof MCP_CONNECTION_STATES)[number];
export const MCP_LIMITS = {
    connections: 20,
    tools: 100,
    catalogBytes: 512 * 1024,
    schemaBytes: 16 * 1024,
    argumentBytes: 4096,
    resultBytes: 1024 * 1024,
    depth: 16,
    nodes: 2000,
    metadataBytes: 32 * 1024,
    oauthMs: 10 * 60_000,
    requestMs: 30_000,
} as const;
export interface McpToolView {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    fingerprint: string;
    supported: boolean;
    refusal?: string;
}
export interface McpConnectionView {
    id: string;
    name: string;
    url: string;
    authentication: 'oauth' | 'none';
    state: McpConnectionState;
    generation: number;
    catalogRevision: string | null;
    tools: McpToolView[];
    createdAt: number;
    updatedAt: number;
}
export interface McpGrantView {
    dotId: string;
    tools: string[];
    catalogRevision: string;
    revision: string;
}
export interface McpConnectionsState {
    connections: Array<McpConnectionView & { grants: McpGrantView[] }>;
    socios: Array<{ id: string; name: string }>;
}
export interface McpDiscoveryView {
    connection: McpConnectionView;
    issuer: string;
    resource: string;
    scopes: string[];
    requiredScopes: string[];
    registration: { clientMetadata: boolean; dynamic: boolean };
}
