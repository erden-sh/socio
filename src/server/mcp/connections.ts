import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { nextTurn } from '@socio/data/events';
import { RESEAL_BATCH, SecretBox, type DataKeyring } from '@socio/foundation/keys/secret-box';
import { MCP_LIMITS, type McpToolView, type McpConnectionView } from '@socio/shared/mcp-connections';

import type { McpConnectionsShape, McpOwnerAccess } from './contract.js';
import { mcpAssert } from './errors.js';
import { McpConnectionRepository, type StoredMcpConnection } from './infra/sqlite/repository.js';
import { boundedJson } from './json.js';
import { mcpUrl } from './network.js';

export const createMcpConnectionInput = z
    .object({
        name: z.string().trim().min(1).max(80),
        url: z.string().max(2048),
        authentication: z.enum(['oauth', 'none']).default('oauth'),
    })
    .strict();
/** Owner and generation fencing apply to every credential read/write, not just the HTTP route. */
export class McpConnections implements McpConnectionsShape {
    private box: SecretBox;
    private controllers = new Map<string, Set<AbortController>>();
    private stopped = false;
    private totalScopes = 0;
    private ownerScopes = new Map<string, number>();
    constructor(
        readonly repository: McpConnectionRepository,
        keys: DataKeyring,
        private access: McpOwnerAccess,
    ) {
        this.box = new SecretBox(keys, 'mcp-credentials');
    }
    get running() {
        return !this.stopped;
    }
    person(userId: string) {
        mcpAssert(
            !this.stopped && this.access.active(userId),
            'Sign in with an active account to manage your connections.',
            403,
        );
    }
    socio(userId: string, dotId: string) {
        this.person(userId);
        mcpAssert(this.access.socio(userId, dotId), 'Socio not found.', 404);
    }
    owned(userId: string, id: string, generation?: number): StoredMcpConnection {
        this.person(userId);
        const row = this.repository.owned(userId, id);
        mcpAssert(row, 'Connection not found.', 404);
        mcpAssert(
            generation === undefined || row.generation === generation,
            'This connection changed; reconnect or review it again.',
            409,
        );
        return row;
    }
    private view(row: StoredMcpConnection): McpConnectionView {
        return {
            id: row.id,
            name: row.name,
            url: row.url,
            authentication: row.authentication,
            state: row.state,
            generation: row.generation,
            catalogRevision: row.catalogRevision,
            tools: JSON.parse(row.catalog),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    list(userId: string) {
        this.person(userId);
        return this.repository.list(userId).map((row) => this.view(row));
    }
    get(userId: string, id: string) {
        return this.view(this.owned(userId, id));
    }
    async create(userId: string, input: z.input<typeof createMcpConnectionInput>, now = Date.now()) {
        this.person(userId);
        const data = createMcpConnectionInput.parse(input);
        const url = mcpUrl(data.url).href;
        return this.repository.atomic(async () => {
            this.person(userId);
            mcpAssert(
                this.repository.count(userId) < MCP_LIMITS.connections,
                'At most 20 custom connections per person.',
                409,
            );
            const row: StoredMcpConnection = {
                id: randomUUID(),
                userId,
                ...data,
                url,
                state: 'draft',
                generation: 1,
                secret: null,
                catalog: '[]',
                catalogRevision: null,
                createdAt: now,
                updatedAt: now,
            };
            await this.repository.create(row);
            return this.view(row);
        });
    }
    encrypt(userId: string, id: string, generation: number, data: unknown) {
        this.owned(userId, id, generation);
        boundedJson(data, 64 * 1024);
        return this.box.seal({ userId, connectionId: id, generation, data });
    }
    decrypt<T>(userId: string, id: string, generation: number, sealed: string): T {
        this.owned(userId, id, generation);
        let value: {
            userId: string;
            connectionId: string;
            generation: number;
            data: T;
        };
        try {
            value = this.box.open(sealed) as typeof value;
        } catch {
            throw new Error('Connection credentials cannot be opened; reconnect this connection.');
        }
        mcpAssert(
            value.userId === userId && value.connectionId === id && value.generation === generation,
            'Connection credential identity mismatch.',
            409,
        );
        return value.data;
    }
    credentials<T>(userId: string, id: string, generation: number): T | undefined {
        const row = this.owned(userId, id, generation);
        return row.secret ? this.decrypt<T>(userId, id, generation, row.secret) : undefined;
    }
    async saveCredentials(userId: string, id: string, generation: number, data: unknown) {
        boundedJson(data, 64 * 1024);
        await this.repository.atomic(async () => {
            const row = this.owned(userId, id, generation);
            const sealed = this.encrypt(userId, id, generation, data);
            mcpAssert(
                await this.repository.replaceSecret(userId, id, generation, row.secret, sealed),
                'Connection changed while saving credentials.',
                409,
            );
        });
    }
    async disconnect(userId: string, id: string, now = Date.now()) {
        await this.repository.atomic(async () => {
            this.owned(userId, id);
            await this.repository.reset(userId, id, 'disconnected', now);
        });
        this.abort(userId, id);
        return this.get(userId, id);
    }
    grants(userId: string, id: string) {
        this.owned(userId, id);
        return this.repository.grants(userId, id).filter((g) => this.access.socio(userId, g.dotId));
    }
    async grant(userId: string, id: string, input: unknown) {
        const selection = z
            .object({
                generation: z.number().int().positive(),
                catalogRevision: z.string().length(64),
                dotId: z.string().min(1).max(128),
                tools: z.array(z.string().min(1).max(64)).max(MCP_LIMITS.tools),
            })
            .strict()
            .parse(input);
        await this.repository.atomic(async () => {
            const row = this.owned(userId, id, selection.generation);
            mcpAssert(this.access.socio(userId, selection.dotId), 'Socio not found.', 404);
            mcpAssert(
                ['review', 'connected'].includes(row.state) && row.catalogRevision === selection.catalogRevision,
                'Review the current tool catalog before granting access.',
                409,
            );
            const catalog = JSON.parse(row.catalog) as McpToolView[];
            mcpAssert(
                new Set(selection.tools).size === selection.tools.length &&
                    selection.tools.every((name) => catalog.some((tool) => tool.name === name && tool.supported)),
                'Select only supported tools from the reviewed catalog.',
            );
            mcpAssert(
                this.repository.grants(userId, id).length < 100 || this.repository.grant(userId, id, selection.dotId),
                'At most 100 socio grants per connection.',
                409,
            );
            await this.repository.saveGrant(
                userId,
                id,
                {
                    dotId: selection.dotId,
                    tools: selection.tools,
                    catalogRevision: selection.catalogRevision,
                    revision: randomUUID(),
                },
                Date.now(),
            );
            await this.repository.transition(userId, id, row.generation, 'connected', Date.now());
        });
        this.abort(userId, id);
        return this.grants(userId, id);
    }
    async remove(userId: string, id: string) {
        await this.disconnect(userId, id);
        await this.repository.atomic(async () => {
            this.owned(userId, id);
            await this.repository.remove(userId, id);
        });
    }
    connectionCountOf(userId: string) {
        return this.repository.list(userId).filter((row) => row.state !== 'disconnected').length;
    }
    async forgetUser(userId: string) {
        // Account lifecycle can run after the account is already inactive.
        for (const row of this.repository.list(userId)) {
            this.abort(userId, row.id);
            await this.repository.reset(userId, row.id, 'disconnected', Date.now());
        }
    }
    sealStates() {
        const counts = { current: 0, legacy: 0, previous: 0, unknown: 0 };
        for (const row of [...this.repository.allSecrets(), ...this.repository.oauthSecrets()]) {
            if (row.secret) {
                counts[this.box.state(this.box.valueKey(row.secret))]++;
            }
        }
        return counts;
    }
    scoped(userId: string, id: string, generation: number, signal?: AbortSignal) {
        this.owned(userId, id, generation);
        mcpAssert(
            this.totalScopes < 8 && (this.ownerScopes.get(userId) ?? 0) < 4,
            'Too many external operations are already running. Try again when one finishes.',
            429,
        );
        this.totalScopes++;
        this.ownerScopes.set(userId, (this.ownerScopes.get(userId) ?? 0) + 1);
        const key = userId + ':' + id;
        const controller = new AbortController();
        const all = this.controllers.get(key) ?? new Set();
        all.add(controller);
        this.controllers.set(key, all);
        const release = () => {
            if (!all.delete(controller)) {
                return;
            }
            this.totalScopes--;
            this.ownerScopes.set(userId, (this.ownerScopes.get(userId) ?? 1) - 1);
            if (!all.size) {
                this.controllers.delete(key);
            }
        };
        return {
            signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(MCP_LIMITS.requestMs),
                ...(signal ? [signal] : []),
            ]),
            release,
        };
    }
    abort(userId: string, id: string) {
        for (const controller of this.controllers.get(userId + ':' + id) ?? []) {
            controller.abort();
        }
    }
    stop() {
        this.stopped = true;
        for (const all of this.controllers.values()) {
            for (const controller of all) {
                controller.abort();
            }
        }
    }
    resume() {
        this.stopped = false;
    }
    async reseal() {
        let resealed = 0,
            unreadable = 0,
            done = 0;
        const breathe = async () => {
            if (++done % RESEAL_BATCH === 0) {
                await nextTurn();
            }
        };
        for (const row of this.repository.allSecrets()) {
            await breathe();
            if (!row.secret) {
                continue;
            }
            let next: string | undefined;
            try {
                const value = this.box.open(row.secret) as {
                    userId: string;
                    connectionId: string;
                    generation: number;
                };
                mcpAssert(
                    value.userId === row.userId && value.connectionId === row.id && value.generation === row.generation,
                    'Credential identity mismatch.',
                );
                next = this.box.reseal(row.secret);
            } catch {
                unreadable++;
                continue;
            }
            if (next) {
                const current = this.repository.owned(row.userId, row.id);
                if (
                    current &&
                    (await this.repository.replaceSecret(row.userId, row.id, current.generation, row.secret, next))
                ) {
                    resealed++;
                }
            }
        }
        for (const row of this.repository.oauthSecrets()) {
            await breathe();
            try {
                const value = this.box.open(row.secret) as {
                    userId: string;
                    connectionId: string;
                    generation: number;
                };
                mcpAssert(
                    value.userId === row.userId &&
                        value.connectionId === row.connectionId &&
                        value.generation === row.generation,
                    'Consent credential identity mismatch.',
                );
                const next = this.box.reseal(row.secret);
                if (next && (await this.repository.replaceOAuthSecret(row, next))) {
                    resealed++;
                }
            } catch {
                unreadable++;
            }
        }
        return { resealed, unreadable };
    }
}
