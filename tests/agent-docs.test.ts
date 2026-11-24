import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentActor } from '@socio/foundation/agents/actor';
import type { AgentScope } from '@socio/shared/agents/scopes';
import type { User } from '@socio/shared/types';

import type { AgentDocsCatalog } from '../src/server/agents/contract.js';
import { agentMcpServer } from '../src/server/agents/mcp-tools.js';

import { boardOf } from './helpers/board.js';
import { WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }
});

async function fixture(scopes: AgentScope[], role: User['role'] = 'member') {
    const workspace = new WorkspaceStore(testDatabase());
    cleanup.push(() => workspace.close());
    const person: User = { id: 'reader', name: 'Reader', role };
    workspace.recordUser(person);
    const actor: AgentActor = {
        grantId: 'docs-grant',
        clientId: 'https://agent.example/client.json',
        clientName: 'Agent',
        clientDomain: 'agent.example',
        label: 'Docs reader',
        userId: person.id,
        scopes,
    };
    const rows = [
        { title: 'Chats', description: 'Start a conversation', url: '/docs/chats' },
        {
            title: 'Recovery',
            description: 'Operator recovery',
            url: '/docs/operate/backups',
        },
    ];
    const allowed = (currentRole?: User['role']) =>
        rows.filter((row) => !row.url.startsWith('/docs/operate/') || currentRole === 'admin');
    const docs: AgentDocsCatalog = {
        list: vi.fn((currentRole) => allowed(currentRole)),
        markdown: vi.fn((path, currentRole) =>
            allowed(currentRole).some((row) => row.url === path)
                ? path.startsWith('/docs/operate/')
                    ? '# OPERATOR_SENTINEL'
                    : '# Chats\nStart here.'
                : null,
        ),
        search: vi.fn(async (_query, currentRole) =>
            allowed(currentRole).map((row) => ({
                id: row.url,
                url: row.url,
                type: 'page' as const,
                content: row.title,
            })),
        ),
    };
    const server = agentMcpServer({
        workspace,
        board: boardOf(workspace),
        actor,
        person,
        origin: 'https://brain.example',
        docs,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'docs-test', version: '1' });
    await client.connect(clientSide);
    cleanup.push(() => client.close());
    return { client, docs, person };
}

it('existing page grants expose no documentation tools or catalog access', async () => {
    const { client, docs } = await fixture(['pages:read']);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('read_page');
    expect(names.filter((name) => name.endsWith('_docs'))).toEqual([]);
    const refused = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/chats' },
    });
    expect(refused.isError).toBe(true);
    expect(docs.markdown).not.toHaveBeenCalled();
});

it('a docs-only grant reads product help without gaining workspace page or board tools', async () => {
    const { client, docs } = await fixture(['docs:read']);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        'list_docs',
        'read_docs',
        'search_docs',
    ]);
    const list = await client.callTool({ name: 'list_docs', arguments: {} });
    expect(list.structuredContent).toEqual({
        articles: [
            {
                title: 'Chats',
                description: 'Start a conversation',
                url: '/docs/chats',
            },
        ],
    });
    const article = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/chats' },
    });
    expect(article.structuredContent).toEqual({
        outcome: 'found',
        path: '/docs/chats',
        markdown: '# Chats\nStart here.',
    });
    expect(docs.markdown).toHaveBeenCalledWith('/docs/chats', 'member');
    const search = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'conversation' },
    });
    expect(JSON.stringify(search)).not.toContain('OPERATOR_SENTINEL');
    expect(docs.search).toHaveBeenCalledWith('conversation', 'member');
});

it('hidden and missing articles have the same refusal and caller arguments cannot supply a role', async () => {
    const { client } = await fixture(['docs:read']);
    const hidden = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/operate/backups', role: 'admin' },
    });
    const missing = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/missing' },
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.structuredContent).toEqual(missing.structuredContent);
    expect(JSON.stringify(hidden)).not.toContain('OPERATOR_SENTINEL');
});

it('the current role reaches the shared catalog on every call', async () => {
    const { client, person } = await fixture(['docs:read'], 'admin');
    const first = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/operate/backups' },
    });
    expect(JSON.stringify(first)).toContain('OPERATOR_SENTINEL');
    person.role = 'member';
    const revoked = await client.callTool({
        name: 'read_docs',
        arguments: { path: '/docs/operate/backups' },
    });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain('OPERATOR_SENTINEL');
});

it('external, traversal and oversized inputs fail before reaching the catalog', async () => {
    const { client, docs } = await fixture(['docs:read']);
    for (const path of ['https://outside.example/docs/chats', '/docs/../operate/backups', '/docs/' + 'a'.repeat(241)]) {
        const result = await client.callTool({
            name: 'read_docs',
            arguments: { path },
        });
        expect(result.isError).toBe(true);
    }
    const result = await client.callTool({
        name: 'search_docs',
        arguments: { query: 'a'.repeat(129) },
    });
    expect(result.isError).toBe(true);
    expect(docs.markdown).not.toHaveBeenCalled();
    expect(docs.search).not.toHaveBeenCalled();
});
