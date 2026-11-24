/**
 * Where MCP connections keep sealed values (CB-322): each connection's
 * credential and each consent in progress, as a column `v`, for a recovery
 * key check of a restored copy of the database.
 */
export const MCP_SEALED_SQL = [
    'SELECT secret AS v FROM mcp_connections WHERE secret IS NOT NULL',
    "SELECT secret AS v FROM mcp_oauth_attempts WHERE secret<>''",
] as const;
