import type { SchemaSet } from '@socio/data/migrate';

export const mcpConnectionsSchema: SchemaSet = {
    id: 'mcp-connections',
    migrations: [
        {
            version: 1,
            name: 'personal outbound MCP connections and reviewed grants',
            up: `
CREATE TABLE mcp_connections(id TEXT PRIMARY KEY,userId TEXT NOT NULL,name TEXT NOT NULL,url TEXT NOT NULL,authentication TEXT NOT NULL CHECK(authentication IN('oauth','none')),state TEXT NOT NULL CHECK(state IN('draft','authorizing','review','connected','disconnected','error')),generation INTEGER NOT NULL DEFAULT 1,secret TEXT,catalog TEXT NOT NULL DEFAULT '[]',catalogRevision TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE INDEX mcp_connections_owner ON mcp_connections(userId,createdAt);
CREATE TABLE mcp_oauth_attempts(stateHash TEXT PRIMARY KEY,connectionId TEXT NOT NULL,userId TEXT NOT NULL,generation INTEGER NOT NULL,cookieHash TEXT NOT NULL,secret TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','exchanging','complete')),expiresAt INTEGER NOT NULL,createdAt INTEGER NOT NULL);
CREATE INDEX mcp_oauth_owner ON mcp_oauth_attempts(userId,expiresAt);
CREATE TABLE mcp_grants(connectionId TEXT NOT NULL,userId TEXT NOT NULL,dotId TEXT NOT NULL,catalogRevision TEXT NOT NULL,tools TEXT NOT NULL,revision TEXT NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(connectionId,userId,dotId));
CREATE TABLE mcp_calls(id TEXT PRIMARY KEY,approvalId TEXT UNIQUE,userId TEXT NOT NULL,dotId TEXT NOT NULL,connectionId TEXT NOT NULL,generation INTEGER NOT NULL,catalogRevision TEXT NOT NULL,tool TEXT NOT NULL,toolFingerprint TEXT NOT NULL,grantRevision TEXT NOT NULL,argumentsHash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('planned','sending','succeeded','failed','unknown','cancelled')),result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
CREATE INDEX mcp_calls_owner ON mcp_calls(userId,createdAt);
CREATE INDEX mcp_calls_owner_dot ON mcp_calls(userId,dotId,createdAt);
`,
        },
    ],
};
