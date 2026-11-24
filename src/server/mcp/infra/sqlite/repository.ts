import type { DatabaseSync } from 'node:sqlite';

import { transaction, sqliteData } from '@socio/data/open';
import type { McpConnectionState, McpToolView, McpGrantView } from '@socio/shared/mcp-connections';

export interface StoredMcpConnection {
    id: string;
    userId: string;
    name: string;
    url: string;
    authentication: 'oauth' | 'none';
    state: McpConnectionState;
    generation: number;
    secret: string | null;
    catalog: string;
    catalogRevision: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface StoredMcpOAuth {
    stateHash: string;
    connectionId: string;
    userId: string;
    generation: number;
    cookieHash: string;
    secret: string;
    state: 'pending' | 'exchanging' | 'complete';
    expiresAt: number;
    createdAt: number;
}
export interface StoredMcpCall {
    id: string;
    approvalId: string | null;
    userId: string;
    dotId: string;
    connectionId: string;
    generation: number;
    catalogRevision: string;
    tool: string;
    toolFingerprint: string;
    grantRevision: string;
    argumentsHash: string;
    state: 'planned' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
    result: string | null;
    createdAt: number;
    updatedAt: number;
}
/** All writes use the shared connection's writer queue; synchronous bounded reads never perform network work. */
export class McpConnectionRepository {
    constructor(private db: DatabaseSync) {}
    atomic<T>(fn: () => T | Promise<T>) {
        return sqliteData(this.db).uow.run(async () => fn(), {
            label: 'outbound MCP connection',
        });
    }
    private write<T>(label: string, fn: () => T) {
        return transaction(this.db, label, fn);
    }
    owned(userId: string, id: string) {
        return this.db.prepare('SELECT * FROM mcp_connections WHERE userId=? AND id=?').get(userId, id) as unknown as
            | StoredMcpConnection
            | undefined;
    }
    list(userId: string) {
        return this.db
            .prepare('SELECT * FROM mcp_connections WHERE userId=? ORDER BY createdAt,id LIMIT 20')
            .all(userId) as unknown as StoredMcpConnection[];
    }
    allSecrets() {
        return this.db
            .prepare('SELECT id,userId,generation,secret FROM mcp_connections WHERE secret IS NOT NULL')
            .all() as unknown as Array<Pick<StoredMcpConnection, 'id' | 'userId' | 'generation' | 'secret'>>;
    }
    oauthSecrets() {
        return this.db
            .prepare("SELECT * FROM mcp_oauth_attempts WHERE secret<>''")
            .all() as unknown as StoredMcpOAuth[];
    }
    replaceOAuthSecret(row: StoredMcpOAuth, secret: string) {
        return this.write(
            'rotate MCP consent credentials',
            () =>
                Number(
                    this.db
                        .prepare(
                            'UPDATE mcp_oauth_attempts SET secret=? WHERE stateHash=? AND userId=? AND generation=? AND secret=?',
                        )
                        .run(secret, row.stateHash, row.userId, row.generation, row.secret).changes,
                ) > 0,
        );
    }
    pruneOAuth(now: number) {
        return this.write('expire MCP consent', () =>
            this.db.prepare("DELETE FROM mcp_oauth_attempts WHERE expiresAt<=? OR state='complete'").run(now),
        );
    }
    remove(userId: string, id: string) {
        return this.write('remove MCP connection', () =>
            this.db.prepare('DELETE FROM mcp_connections WHERE userId=? AND id=?').run(userId, id),
        );
    }
    count(userId: string) {
        return Number(this.db.prepare('SELECT COUNT(*) n FROM mcp_connections WHERE userId=?').get(userId)!.n);
    }
    create(row: StoredMcpConnection) {
        return this.write('create MCP connection', () =>
            this.db
                .prepare(
                    'INSERT INTO mcp_connections(id,userId,name,url,authentication,state,generation,secret,catalog,catalogRevision,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                )
                .run(
                    row.id,
                    row.userId,
                    row.name,
                    row.url,
                    row.authentication,
                    row.state,
                    row.generation,
                    row.secret,
                    row.catalog,
                    row.catalogRevision,
                    row.createdAt,
                    row.updatedAt,
                ),
        );
    }
    replaceSecret(userId: string, id: string, generation: number, previous: string | null, next: string | null) {
        return this.write(
            'save MCP credentials',
            () =>
                Number(
                    this.db
                        .prepare(
                            'UPDATE mcp_connections SET secret=? WHERE userId=? AND id=? AND generation=? AND secret IS ?',
                        )
                        .run(next, userId, id, generation, previous).changes,
                ) > 0,
        );
    }
    transition(userId: string, id: string, generation: number, state: McpConnectionState, now: number) {
        return this.write(
            'update MCP connection',
            () =>
                Number(
                    this.db
                        .prepare(
                            'UPDATE mcp_connections SET state=?,updatedAt=? WHERE userId=? AND id=? AND generation=?',
                        )
                        .run(state, now, userId, id, generation).changes,
                ) > 0,
        );
    }
    reset(userId: string, id: string, state: McpConnectionState, now: number) {
        return this.write('reset MCP authorization', () => {
            this.db
                .prepare(
                    "UPDATE mcp_connections SET generation=generation+1,state=?,secret=NULL,catalog='[]',catalogRevision=NULL,updatedAt=? WHERE userId=? AND id=?",
                )
                .run(state, now, userId, id);
            this.db.prepare('DELETE FROM mcp_grants WHERE userId=? AND connectionId=?').run(userId, id);
            this.db.prepare('DELETE FROM mcp_oauth_attempts WHERE userId=? AND connectionId=?').run(userId, id);
            this.db
                .prepare(
                    "UPDATE mcp_calls SET state='cancelled',updatedAt=? WHERE userId=? AND connectionId=? AND state='planned'",
                )
                .run(now, userId, id);
            return this.owned(userId, id);
        });
    }
    saveCatalog(userId: string, id: string, generation: number, tools: McpToolView[], revision: string, now: number) {
        return this.write('review MCP tool catalog', () => {
            const changed =
                Number(
                    this.db
                        .prepare(
                            "UPDATE mcp_connections SET catalog=?,catalogRevision=?,state='review',updatedAt=? WHERE userId=? AND id=? AND generation=?",
                        )
                        .run(JSON.stringify(tools), revision, now, userId, id, generation).changes,
                ) > 0;
            if (changed) {
                this.db.prepare('DELETE FROM mcp_grants WHERE userId=? AND connectionId=?').run(userId, id);
            }
            return changed;
        });
    }
    grant(userId: string, id: string, dotId: string) {
        const row = this.db
            .prepare(
                'SELECT dotId,catalogRevision,tools,revision FROM mcp_grants WHERE userId=? AND connectionId=? AND dotId=?',
            )
            .get(userId, id, dotId);
        return row
            ? {
                  dotId: String(row.dotId),
                  catalogRevision: String(row.catalogRevision),
                  revision: String(row.revision),
                  tools: JSON.parse(String(row.tools)) as string[],
              }
            : undefined;
    }
    grants(userId: string, id: string) {
        return this.db
            .prepare(
                'SELECT dotId,catalogRevision,tools,revision FROM mcp_grants WHERE userId=? AND connectionId=? ORDER BY dotId',
            )
            .all(userId, id)
            .map((row) => ({
                dotId: String(row.dotId),
                catalogRevision: String(row.catalogRevision),
                revision: String(row.revision),
                tools: JSON.parse(String(row.tools)) as string[],
            }));
    }
    saveGrant(userId: string, id: string, grant: McpGrantView, now: number) {
        return this.write('grant reviewed MCP tools', () =>
            this.db
                .prepare(
                    'INSERT INTO mcp_grants(userId,connectionId,dotId,catalogRevision,tools,revision,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connectionId,userId,dotId) DO UPDATE SET catalogRevision=excluded.catalogRevision,tools=excluded.tools,revision=excluded.revision,updatedAt=excluded.updatedAt',
                )
                .run(userId, id, grant.dotId, grant.catalogRevision, JSON.stringify(grant.tools), grant.revision, now),
        );
    }
    createOAuth(row: StoredMcpOAuth) {
        return this.write('start MCP OAuth', () => {
            this.db.prepare('DELETE FROM mcp_oauth_attempts WHERE expiresAt<=?').run(row.createdAt);
            this.db
                .prepare(
                    'INSERT INTO mcp_oauth_attempts(stateHash,connectionId,userId,generation,cookieHash,secret,state,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
                )
                .run(
                    row.stateHash,
                    row.connectionId,
                    row.userId,
                    row.generation,
                    row.cookieHash,
                    row.secret,
                    row.state,
                    row.expiresAt,
                    row.createdAt,
                );
        });
    }
    oauth(userId: string, stateHash: string) {
        return this.db
            .prepare('SELECT * FROM mcp_oauth_attempts WHERE userId=? AND stateHash=?')
            .get(userId, stateHash) as unknown as StoredMcpOAuth | undefined;
    }
    saveOAuth(userId: string, stateHash: string, generation: number, secret: string) {
        return this.write(
            'save MCP PKCE state',
            () =>
                Number(
                    this.db
                        .prepare(
                            "UPDATE mcp_oauth_attempts SET secret=? WHERE userId=? AND stateHash=? AND generation=? AND state IN('pending','exchanging')",
                        )
                        .run(secret, userId, stateHash, generation).changes,
                ) > 0,
        );
    }
    claimOAuth(userId: string, stateHash: string, cookieHash: string, now: number) {
        return this.write(
            'claim MCP callback',
            () =>
                this.db
                    .prepare(
                        "UPDATE mcp_oauth_attempts SET state='exchanging' WHERE userId=? AND stateHash=? AND cookieHash=? AND expiresAt>? AND state='pending' RETURNING *",
                    )
                    .get(userId, stateHash, cookieHash, now) as unknown as StoredMcpOAuth | undefined,
        );
    }
    endOAuth(userId: string, stateHash: string) {
        return this.write('finish MCP callback', () =>
            this.db
                .prepare("UPDATE mcp_oauth_attempts SET state='complete',secret='' WHERE userId=? AND stateHash=?")
                .run(userId, stateHash),
        );
    }
    createCall(row: StoredMcpCall) {
        return this.write('plan external tool call', () =>
            this.db
                .prepare(
                    'INSERT INTO mcp_calls(id,approvalId,userId,dotId,connectionId,generation,catalogRevision,tool,toolFingerprint,grantRevision,argumentsHash,state,result,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                )
                .run(
                    row.id,
                    row.approvalId,
                    row.userId,
                    row.dotId,
                    row.connectionId,
                    row.generation,
                    row.catalogRevision,
                    row.tool,
                    row.toolFingerprint,
                    row.grantRevision,
                    row.argumentsHash,
                    row.state,
                    row.result,
                    row.createdAt,
                    row.updatedAt,
                ),
        );
    }
    call(userId: string, id: string) {
        return this.db.prepare('SELECT * FROM mcp_calls WHERE userId=? AND id=?').get(userId, id) as unknown as
            | StoredMcpCall
            | undefined;
    }
    hasCalls(userId: string, dotId: string) {
        return !!this.db.prepare('SELECT 1 FROM mcp_calls WHERE userId=? AND dotId=? LIMIT 1').get(userId, dotId);
    }
    bindCall(userId: string, id: string, approvalId: string) {
        return this.write(
            'bind external call approval',
            () =>
                Number(
                    this.db
                        .prepare(
                            'UPDATE mcp_calls SET approvalId=? WHERE userId=? AND id=? AND (approvalId IS NULL OR approvalId=?)',
                        )
                        .run(approvalId, userId, id, approvalId).changes,
                ) > 0,
        );
    }
    claimCall(userId: string, id: string, now: number) {
        return this.write(
            'claim external tool dispatch',
            () =>
                Number(
                    this.db
                        .prepare(
                            "UPDATE mcp_calls SET state='sending',updatedAt=? WHERE userId=? AND id=? AND state='planned'",
                        )
                        .run(now, userId, id).changes,
                ) > 0,
        );
    }
    endCall(userId: string, id: string, state: StoredMcpCall['state'], result: string | null, now: number) {
        return this.write('record external tool outcome', () =>
            this.db
                .prepare(
                    "UPDATE mcp_calls SET state=?,result=?,updatedAt=? WHERE userId=? AND id=? AND (state='sending' OR (state='planned' AND ?='cancelled'))",
                )
                .run(state, result, now, userId, id, state),
        );
    }
    recoverCalls(now: number) {
        return this.write('recover interrupted external calls', () =>
            this.db.prepare("UPDATE mcp_calls SET state='unknown',updatedAt=? WHERE state='sending'").run(now),
        );
    }
}
