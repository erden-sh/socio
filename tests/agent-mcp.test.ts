import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';

import type { AgentActor } from '@socio/foundation/agents/actor';
import type { AgentScope } from '@socio/shared/agents/scopes';
import type { User } from '@socio/shared/types';

import { AgentTokens, type AgentTokenResolver } from '../src/server/agents/contract.js';
import { agentMcpServer } from '../src/server/agents/mcp-tools.js';
import { MockAuthProvider } from '../src/server/auth/mock.js';
import type { PlatformConfig } from '../src/server/composition/config.js';
import { issueDetailView } from '../src/server/issues/views.js';

import { PNG, pngOf } from './fixtures/media.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'bob', name: 'Bob', role: 'member' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
const CONFIG: PlatformConfig = {
    baseUrl: '',
    apiKey: '',
    model: '',
    voiceName: 'marin',
    runtimeUrl: '',
    sessionSecret: 'agent-mcp-test-secret-0123456789abcdef',
};
const ALL: AgentScope[] = ['issues:read', 'issues:write', 'pages:read', 'pages:write'];
const METADATA = 'resource_metadata="http://localhost/.well-known/oauth-protected-resource/mcp"';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.restoreAllMocks();
});

const actorFor = (userId: string, scopes: AgentScope[] = ALL, grantId = `g-${userId}`): AgentActor => ({
    grantId,
    clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    clientName: 'Claude Code',
    clientDomain: 'claude.ai',
    label: 'Claude Code on laptop',
    userId,
    scopes,
});

async function fixture({ resolver = true } = {}) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The fake authorization side: a token per actor, and what it was asked.
    const tokens = new Map<string, AgentActor>();
    const asked: Array<[string, string]> = [];
    // The graph offers the grants' resolver (`AgentTokens`); these tests offer
    // a fake one, or none, which the endpoint reads at each request.
    const fake: AgentTokenResolver | undefined = resolver
        ? async (token, resource) => {
              asked.push([token, resource]);
              return tokens.get(token) ?? null;
          }
        : undefined;
    const { app, platform, workspace, dispose } = await makeTestRuntime({
        config: CONFIG,
        layers: Layer.succeed(AgentTokens, fake),
        app: {
            config: { mode: 'live', baseUrl: '' },
            auth: {
                provider: new MockAuthProvider(USERS, 'secret-0123456789abcdef-xyz'),
                secureCookies: false,
            },
        },
    });
    cleanup.push(dispose);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    const grant = (actor: AgentActor) => {
        const token = `agt_${actor.grantId}_${actor.scopes.join('+')}`;
        tokens.set(token, actor);
        return token;
    };
    /** A real MCP client over Streamable HTTP, into the app. */
    const connect = async (actor: AgentActor) => {
        const client = new Client({ name: 'test-agent', version: '0.1.0' });
        const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
            requestInit: { headers: { Authorization: `Bearer ${grant(actor)}` } },
            fetch: async (url, init) => app.request(String(url), init),
        });
        await client.connect(transport);
        cleanup.push(() => client.close());
        const call = async (name: string, args: Record<string, unknown> = {}) => {
            const result = await client.callTool({ name, arguments: args });
            return {
                isError: !!result.isError,
                data: result.structuredContent as Record<string, unknown>,
                text: (result.content as Array<{ text: string }>)[0]!.text,
            };
        };
        return { client, call };
    };
    /** A raw JSON-RPC POST, for what a client library hides. */
    const post = (body: unknown, headers: Record<string, string> = {}) =>
        app.request('/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                ...headers,
            },
            body: JSON.stringify(body),
        });
    const web = async (userId: string) => {
        const login = await app.request('/api/auth/mock/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
        });
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        return (path: string, method = 'GET', body?: unknown) =>
            app.request(`/api${path}`, {
                method,
                headers: {
                    cookie,
                    ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
    };
    return { app, platform, workspace, grant, connect, post, web, asked };
}

/** One field of each item of a result's list. */
const each = (list: unknown, key: string) => (list as Array<Record<string, unknown>>).map((item) => item[key]);

const toolCall = (name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
});

it('answers 503 without a token resolver', async () => {
    const { post } = await fixture({ resolver: false });
    const response = await post(toolCall('search_issues', { query: 'x' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
        error: 'Connected agents are not set up.',
    });
});

it('answers 401 with the protected resource metadata, without or with a bad token', async () => {
    const { post, grant, asked, workspace, platform } = await fixture();
    const missing = await post(toolCall('search_issues', { query: 'x' }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(`Bearer ${METADATA}`);
    const bad = await post(toolCall('search_issues', { query: 'x' }), {
        Authorization: 'Bearer agt_unknown',
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", error_description="The token is invalid, expired or revoked.", ${METADATA}`,
    );
    // Bound to this resource (RFC 8707): the resolver is told which.
    expect(asked).toEqual([['agt_unknown', 'http://localhost/mcp']]);
    // Service keys and data tokens are never resolved as agent tokens.
    for (const token of ['cbk_abc', 'cbdt_abc']) {
        expect(
            (
                await post(toolCall('search_issues', { query: 'x' }), {
                    Authorization: `Bearer ${token}`,
                })
            ).status,
        ).toBe(401);
    }
    expect(asked).toHaveLength(1);
    // A person who is deactivated, unknown or a service account gets nothing.
    const deactivated = grant(actorFor('carol'));
    workspace.useDeactivated(() => ['carol']);
    const unknown = grant(actorFor('zed'));
    const service = platform.serviceAccounts;
    vi.spyOn(service, 'isService').mockImplementation((id) => id === 'bob');
    const svc = grant(actorFor('bob'));
    for (const token of [deactivated, unknown, svc]) {
        expect(
            (
                await post(toolCall('search_issues', { query: 'x' }), {
                    Authorization: `Bearer ${token}`,
                })
            ).status,
        ).toBe(401);
    }
});

it('checks the host and a browser’s origin, and limits each grant’s rate', async () => {
    const { app, post, grant } = await fixture();
    const token = grant(actorFor('bob'));
    const auth = { Authorization: `Bearer ${token}` };
    expect(
        (
            await app.request('http://evil.example/mcp', {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: '{}',
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await post(toolCall('search_issues', { query: 'x' }), {
                ...auth,
                Origin: 'https://evil.example',
            })
        ).status,
    ).toBe(403);
    // Stateless: no session stream.
    const get = await app.request('/mcp', { headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    for (let i = 1; i < 300; i++) {
        await app.request('/mcp', { method: 'DELETE', headers: auth });
    }
    const limited = await app.request('/mcp', { headers: auth });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    // Another grant has its own count.
    expect(
        (
            await app.request('/mcp', {
                headers: { Authorization: `Bearer ${grant(actorFor('carol'))}` },
            })
        ).status,
    ).toBe(405);
});

it('answers 403 insufficient_scope for a tool outside the grant, and lists only its tools', async () => {
    const { post, grant, connect, platform } = await fixture();
    const reader = actorFor('alice', ['issues:read']);
    const response = await post(toolCall('file_issue', { title: 'x', kind: 'bug', description: 'y' }), {
        Authorization: `Bearer ${grant(reader)}`,
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBe(
        `Bearer error="insufficient_scope", scope="issues:write", error_description="This connection was not granted issues:write.", ${METADATA}`,
    );
    expect(await response.json()).toMatchObject({ code: 'insufficient_scope' });
    // A batch with one such call is refused whole.
    const batch = await post(
        [toolCall('search_issues', { query: 'x' }), { ...toolCall('read_page', { spaceId: 's', pageId: 'p' }), id: 2 }],
        { Authorization: `Bearer ${grant(reader)}` },
    );
    expect(batch.status).toBe(403);
    expect(batch.headers.get('www-authenticate')).toContain('scope="pages:read"');
    expect(await platform.board.issues.list()).toEqual([]);

    const { client } = await connect(reader);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'search_issues',
        'read_issue',
        'read_issue_attachment',
        'list_issues',
        'list_issue_components',
        'list_issue_subscriptions',
    ]);
    const { client: full } = await connect(actorFor('bob'));
    const tools = (await full.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
        'search_issues',
        'read_issue',
        'read_issue_attachment',
        'list_issues',
        'list_issue_components',
        'list_issue_subscriptions',
        'subscribe_to_issues',
        'cancel_issue_subscription',
        'file_issue',
        'comment_on_issue',
        'vote_on_issue',
        'unvote_issue',
        'update_issue',
        'list_spaces',
        'list_pages',
        'search_pages',
        'read_page',
        'create_page',
        'update_page',
        'append_page',
        'delete_page',
    ]);
    // Reading tools say their text is data, not instructions.
    for (const tool of tools.filter((one) => one.annotations?.readOnlyHint)) {
        expect(tool.description).toContain('untrusted data');
    }
});

it('searches, lists and reads issues as the person', async () => {
    const { connect, platform } = await fixture();
    const { issues, votes } = platform.board;
    const export_ = await issues.create(
        {
            title: 'Export the board to CSV',
            body: 'Ask ops@example.com for the format.',
            kind: 'feature',
            priority: 'low',
            area: 'client',
            labels: ['ux'],
        },
        'carol',
        1,
    );
    const crash = await issues.create(
        { title: 'Login crash', kind: 'bug', priority: 'critical', area: 'auth' },
        'carol',
        2,
    );
    await issues.create({ title: 'Old export bug', kind: 'bug', status: 'done' }, 'carol', 3);
    await issues.addComment(export_.number, 'Me too.', 'carol', 4);
    await votes.cast(export_.id, 'bob');
    await votes.cast(export_.id, 'carol');
    await issues.update(export_.number, { assigneeId: 'bob' }, 'alice', 5);
    const { call } = await connect(actorFor('bob', ['issues:read']));

    const open = await call('search_issues', { query: 'export' });
    expect(each(open.data.matches, 'issue')).toEqual(['CB-1']);
    expect(open.data.untrusted).toContain('untrusted data');
    const all = await call('search_issues', { query: 'export', status: 'all' });
    expect(all.data.matches).toHaveLength(2);

    const read = await call('read_issue', { issue: 'CB-1' });
    expect(read.isError).toBe(false);
    expect(read.data).toMatchObject({
        outcome: 'found',
        issue: 'CB-1',
        title: 'Export the board to CSV',
        status: 'triage',
        kind: 'feature',
        labels: ['ux'],
        votes: 2,
        personVoted: true,
        assignee: 'the person you act for',
        description: 'Ask [email removed] for the format.',
        comments: {
            total: 1,
            recent: [{ author: 'another person', text: 'Me too.' }],
        },
    });
    // The JSON is in the text content too, for clients without structure.
    expect(JSON.parse(read.text)).toEqual(read.data);
    const missing = await call('read_issue', { issue: 'CB-99' });
    expect(missing.isError).toBe(true);
    expect(missing.data.outcome).toBe('not_found');

    const listed = await call('list_issues', {});
    // By priority: critical, medium (the default), low.
    expect(each(listed.data.items, 'issue')).toEqual(['CB-2', 'CB-3', 'CB-1']);
    const byVotes = await call('list_issues', { sort: 'votes', limit: 1 });
    expect(byVotes.data).toMatchObject({
        total: 3,
        next: 1,
        items: [{ issue: 'CB-1', votes: 2, personVoted: true }],
    });
    const filtered = await call('list_issues', {
        kind: 'bug',
        priority: 'critical',
        area: 'auth',
        status: 'triage',
    });
    expect(each(filtered.data.items, 'issue')).toEqual([`CB-${crash.number}`]);
    const page2 = await call('list_issues', { sort: 'newest', offset: 2 });
    expect(page2.data).toMatchObject({
        next: null,
        items: [{ issue: 'CB-1' }],
    });
});

it('files as the person after the duplicate check, recording the agent beside them', async () => {
    const { connect, workspace, platform } = await fixture();
    await platform.board.issues.create({ title: 'Export the board to CSV', kind: 'feature' }, 'carol');
    const actor = actorFor('bob');
    const { call } = await connect(actor);
    const input = {
        title: 'Export board to CSV',
        kind: 'feature',
        description: 'We need a CSV export of the board.',
    };
    const close = await call('file_issue', input);
    expect(close.data).toMatchObject({
        outcome: 'possible_duplicates',
        matches: [{ issue: 'CB-1', title: 'Export the board to CSV' }],
    });
    expect(await platform.board.issues.list()).toHaveLength(1);
    const filed = await call('file_issue', { ...input, force: true });
    expect(filed.data).toMatchObject({
        outcome: 'filed',
        issue: 'CB-2',
        status: 'triage',
        url: 'http://localhost/issues/CB-2',
    });
    const issue = (await platform.board.issues.get(2))!;
    // The person's record: reporter and history actor, source agent.
    expect(issue).toMatchObject({
        reporterId: 'bob',
        source: 'agent',
        status: 'triage',
    });
    expect(await platform.board.issues.events(issue.id)).toMatchObject([{ kind: 'created', actorId: 'bob' }]);
    // Both identities, in the agent's row.
    expect(
        workspace.db
            .prepare('SELECT action, targetId, grantId, clientId, clientName, label, userId FROM issue_agent_actions')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([
        {
            action: 'create',
            targetId: null,
            grantId: 'g-bob',
            clientId: actor.clientId,
            clientName: 'Claude Code',
            label: 'Claude Code on laptop',
            userId: 'bob',
        },
    ]);
    const detail = await issueDetailView(platform, issue, 'bob');
    expect(detail.filedByAgent).toMatchObject({
        label: 'Claude Code on laptop',
        userId: 'bob',
    });
    expect(detail.events[0]!.agent).toMatchObject({ grantId: 'g-bob' });
    expect(detail.users.bob).toBe('Bob');
});

it('comments as the person, shown as the agent for them', async () => {
    const { connect, workspace, platform } = await fixture();
    const issue = await platform.board.issues.create({ title: 'Slow search' }, 'carol');
    const { call } = await connect(actorFor('bob'));
    const result = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'Seen on node-1 too.',
    });
    expect(result.data).toMatchObject({ outcome: 'commented', issue: 'CB-1' });
    const [comment] = await platform.board.issues.comments(issue.id);
    expect(comment).toMatchObject({
        authorKind: 'user',
        authorId: 'bob',
        body: 'Seen on node-1 too.',
    });
    const detail = await issueDetailView(platform, (await platform.board.issues.get(1))!, 'bob');
    expect(detail.comments[0]!.agent).toMatchObject({
        label: 'Claude Code on laptop',
        userId: 'bob',
    });
    expect(detail.comments[0]!.dot).toBeUndefined();
    const added = detail.events.find((e) => e.kind === 'comment_added')!;
    expect(added).toMatchObject({ actorId: 'bob', agent: { grantId: 'g-bob' } });
    // The filing was the person's own, from the web: no agent on it.
    expect(detail.filedByAgent).toBeUndefined();
    expect(detail.events[0]!.agent).toBeUndefined();
    expect(
        workspace.db
            .prepare('SELECT action, targetId FROM issue_agent_actions')
            .all()
            .map((row) => ({ ...row })),
    ).toEqual([{ action: 'comment', targetId: comment!.id }]);
    expect((await call('comment_on_issue', { issue: 'CB-7', comment: 'x' })).isError).toBe(true);
});

it('votes once per person, shared with their own web vote', async () => {
    const { connect, workspace, web, platform } = await fixture();
    const issue = await platform.board.issues.create({ title: 'Dark mode' }, 'carol');
    const bob = await web('bob');
    expect((await bob('/issues/1/vote', 'POST')).status).toBe(200);
    const { call } = await connect(actorFor('bob'));
    expect((await call('vote_on_issue', { issue: 'CB-1' })).data).toMatchObject({
        outcome: 'already_voted',
        votes: 1,
    });
    expect((await call('unvote_issue', { issue: 'CB-1' })).data).toMatchObject({
        outcome: 'withdrawn',
        votes: 0,
    });
    expect((await call('unvote_issue', { issue: 'CB-1' })).data).toMatchObject({
        outcome: 'not_voted',
    });
    expect((await call('vote_on_issue', { issue: 'CB-1' })).data).toMatchObject({
        outcome: 'voted',
        votes: 1,
    });
    // The web sees the agent's vote as the person's.
    expect((await bob('/issues/1/vote', 'POST')).status).toBe(200);
    expect(await platform.board.votes.count(issue.id)).toBe(1);
    expect(await platform.board.votes.has(issue.id, 'bob')).toBe(true);
    const rows = workspace.db
        .prepare(
            'SELECT a.action, v.userId, v.dotId FROM issue_agent_actions a JOIN issue_votes v ON v.id = a.targetId ORDER BY a.rowid',
        )
        .all()
        .map((row) => ({ ...row }));
    expect(rows).toEqual([
        { action: 'unvote', userId: 'bob', dotId: null },
        { action: 'vote', userId: 'bob', dotId: null },
    ]);
});

it('changes fields only within the person’s role: a member’s agent can’t change status, an admin’s can', async () => {
    const { connect, workspace, platform } = await fixture();
    await platform.board.issues.create({ title: 'Flaky upload' }, 'bob');
    const member = await connect(actorFor('bob'));
    const refused = await member.call('update_issue', {
        issue: 'CB-1',
        status: 'done',
    });
    expect(refused.isError).toBe(true);
    expect(refused.data).toEqual({
        outcome: 'forbidden',
        message: 'Only an admin can change this.',
    });
    expect((await member.call('update_issue', { issue: 'CB-1', assignee: 'me' })).data.outcome).toBe('forbidden');
    expect(await platform.board.issues.get(1)).toMatchObject({
        status: 'triage',
        assigneeId: null,
    });
    expect(workspace.db.prepare('SELECT COUNT(*) AS n FROM issue_agent_actions').get()).toEqual({ n: 0 });

    const admin = await connect(actorFor('alice'));
    const changed = await admin.call('update_issue', {
        issue: 'CB-1',
        status: 'done',
        priority: 'high',
        labels: ['regression'],
        assignee: 'Bob',
        resolution: 'Fixed in 380fb4c',
    });
    expect(changed.data).toMatchObject({
        outcome: 'updated',
        status: 'done',
        priority: 'high',
        labels: ['regression'],
        assignee: 'another person',
        resolution: 'Fixed in 380fb4c',
    });
    expect(await platform.board.issues.get(1)).toMatchObject({
        status: 'done',
        assigneeId: 'bob',
    });
    const detail = await issueDetailView(platform, (await platform.board.issues.get(1))!, 'alice');
    const byAgent = detail.events.filter((event) => event.agent);
    expect(byAgent.map((event) => event.kind).sort()).toEqual([
        'assignee',
        'labels',
        'priority',
        'resolution',
        'status',
    ]);
    // Every one by the person, the agent beside it.
    expect(new Set(byAgent.map((event) => event.actorId))).toEqual(new Set(['alice']));
    expect(byAgent[0]!.agent).toMatchObject({ userId: 'alice' });
    // Unchanged values write nothing; an unknown assignee is the tool's error.
    expect((await admin.call('update_issue', { issue: 'CB-1', status: 'done' })).data.outcome).toBe('unchanged');
    const nobody = await admin.call('update_issue', {
        issue: 'CB-1',
        assignee: 'Zed',
    });
    expect(nobody).toMatchObject({
        isError: true,
        data: { message: 'Nobody named “Zed” has signed in.' },
    });
    // A grant's audit, for the admin page.
    expect((await platform.board.agentActions.activity('g-alice')).map((line) => line.summary)).toEqual(
        expect.arrayContaining([
            'changed the status of CB-1 “Flaky upload”',
            'changed the priority of CB-1 “Flaky upload”',
        ]),
    );
    expect(await platform.board.agentActions.activity('g-bob')).toEqual([]);
});

it('reads pages only in Spaces the person can read', async () => {
    const { connect, workspace } = await fixture();
    const [everyday] = workspace.spaces();
    const ops = workspace.createSpace('Ops', 'Runbooks');
    const gone = workspace.createSpace('Old', 'Archived');
    const runbook = await workspace.pages.create(
        ops.id,
        { title: 'Deploy runbook', content: 'Run the deploy script.' },
        null,
        'alice',
    );
    const secret = await workspace.pages.create(
        gone.id,
        { title: 'Old deploy notes', content: 'Deploy the old way.' },
        null,
        'alice',
    );
    workspace.db.prepare('UPDATE spaces SET deletedAt=?, deletedBy=? WHERE id=?').run(1, 'alice', gone.id);
    const { call } = await connect(actorFor('bob', ['pages:read']));
    const spaces = await call('list_spaces');
    expect(each(spaces.data.spaces, 'name')).toEqual([everyday!.name, 'Ops']);
    const tree = await call('list_pages', { spaceId: ops.id });
    expect(tree.data.pages).toEqual([
        {
            id: runbook.id,
            parentId: null,
            title: 'Deploy runbook',
            url: `http://localhost/spaces/${ops.id}/pages/${runbook.id}`,
        },
    ]);
    const found = await call('search_pages', { query: 'deploy' });
    expect(each(found.data.results, 'id')).toEqual([runbook.id]);
    expect(each(found.data.results, 'snippet')[0]).toContain('**');
    const page = await call('read_page', { spaceId: ops.id, pageId: runbook.id });
    expect(page.data).toMatchObject({
        title: 'Deploy runbook',
        content: 'Run the deploy script.',
    });
    for (const [name, args] of [
        ['read_page', { spaceId: gone.id, pageId: secret.id }],
        ['list_pages', { spaceId: gone.id }],
        ['search_pages', { query: 'deploy', spaceId: gone.id }],
        ['read_page', { spaceId: ops.id, pageId: secret.id }],
    ] as const) {
        const refused = await call(name, args);
        expect(refused.isError).toBe(true);
        expect(refused.data.outcome).toBe('not_found');
    }
});

it('append_page never saves another transaction\u2019s rolled-back text', async () => {
    const { connect, workspace } = await fixture();
    const [everyday] = workspace.spaces();
    const { call } = await connect(actorFor('bob', ['pages:read', 'pages:write']));
    const made = await call('create_page', { spaceId: everyday!.id, title: 'Shared', content: 'Committed.' });
    const pageId = made.data.id as string;
    const revision = made.data.revision as number;
    // An edit in flight on the shared connection, which rolls back after the
    // append has read the page and before its update takes the lock.
    workspace.db.exec('BEGIN');
    workspace.db.prepare('UPDATE pages SET content=?, revision=revision+1 WHERE id=?').run('Rolled back.', pageId);
    const update = workspace.pages.update.bind(workspace.pages);
    const held = vi.spyOn(workspace.pages, 'update').mockImplementation((...args) => {
        workspace.db.exec('ROLLBACK');
        return update(...args);
    });
    const appended = await call('append_page', {
        spaceId: everyday!.id,
        pageId,
        expectedRevision: revision,
        content: 'Added.',
    });
    if (held.mock.calls.length === 0) {
        workspace.db.exec('ROLLBACK');
    }
    held.mockRestore();
    expect(appended.isError).toBe(true);
    expect(workspace.pages.get(everyday!.id, pageId)).toMatchObject({ content: 'Committed.', revision });
});

it('append_page keeps a code block split across writes as code', async () => {
    const { connect, workspace } = await fixture();
    const [everyday] = workspace.spaces();
    const { call } = await connect(actorFor('bob', ['pages:read', 'pages:write']));
    const made = await call('create_page', { spaceId: everyday!.id, title: 'Code', content: '```html\nfirst line' });
    const inside = await call('append_page', {
        spaceId: everyday!.id,
        pageId: made.data.id,
        expectedRevision: made.data.revision,
        content: '<br>\n```',
    });
    expect(inside.isError).toBe(false);
    const closed = workspace.pages.get(everyday!.id, made.data.id as string);
    expect(closed.content).toBe('```html\nfirst line\n<br>\n```');
    // Once the block is closed, an addition is plain Markdown again.
    const after = await call('append_page', {
        spaceId: everyday!.id,
        pageId: made.data.id,
        expectedRevision: inside.data.revision,
        content: 'one<br>two',
    });
    expect(after.isError).toBe(false);
    expect(workspace.pages.get(everyday!.id, made.data.id as string).content).toBe(
        '```html\nfirst line\n<br>\n```\n\none\\\ntwo',
    );
});

it('creates, updates and deletes pages as the person, with revision guarding updates', async () => {
    const { connect, workspace, grant, post } = await fixture();
    const [everyday] = workspace.spaces();
    const { call } = await connect(actorFor('bob', ['pages:read', 'pages:write']));

    // create_page: a new page in a Space bob can read, recorded as his.
    const made = await call('create_page', {
        spaceId: everyday!.id,
        title: 'Self-hosted model notes',
        content: 'Notes on local inference.',
    });
    expect(made.isError).toBe(false);
    expect(made.data).toMatchObject({ title: 'Self-hosted model notes', parentId: null });
    const pageId = made.data.id as string;
    expect(made.data.url).toBe(`http://localhost/spaces/${everyday!.id}/pages/${pageId}`);
    const revision = made.data.revision as number;
    expect(workspace.pages.get(everyday!.id, pageId).createdBy).toBe('bob');

    // read_page confirms it landed.
    const read = await call('read_page', { spaceId: everyday!.id, pageId });
    expect(read.data.content).toBe('Notes on local inference.');

    // update_page with the right revision replaces the title and body and bumps the revision.
    const updated = await call('update_page', {
        spaceId: everyday!.id,
        pageId,
        expectedRevision: revision,
        title: 'Self-hosted model notes',
        content: 'Notes on local inference (revised).',
    });
    expect(updated.isError).toBe(false);
    expect(updated.data.revision).toBeGreaterThan(revision);
    expect(workspace.pages.get(everyday!.id, pageId).content).toContain('revised');
    // The replaced state is kept as his revision, the same as a web save.
    expect(workspace.pages.revisionsOf(pageId)[0]).toMatchObject({
        authorId: 'bob',
        title: 'Self-hosted model notes',
        body: 'Notes on local inference.',
    });

    // append_page adds Markdown after the body and records him again.
    const appended = await call('append_page', {
        spaceId: everyday!.id,
        pageId,
        expectedRevision: updated.data.revision,
        content: 'A second section.',
    });
    expect(appended.isError).toBe(false);
    expect(appended.data.revision).toBeGreaterThan(updated.data.revision as number);
    expect(workspace.pages.get(everyday!.id, pageId).content).toBe(
        'Notes on local inference (revised).\n\nA second section.',
    );
    expect(workspace.pages.revisionsOf(pageId)[0]).toMatchObject({ authorId: 'bob' });
    // The addition is in the search index, as a web edit's body is.
    const found = await call('search_pages', { query: 'second section', spaceId: everyday!.id });
    expect(each(found.data.results, 'id')).toContain(pageId);
    // The pages table trigger bumped the Space’s live list, as a web save does.
    expect(workspace.counters.read([`pages:${everyday!.id}`])).not.toBe(`pages:${everyday!.id}=0`);

    // A child under that page. Simple HTML is stored as the editor would save it;
    // a script tag stays text.
    const child = await call('create_page', {
        spaceId: everyday!.id,
        title: 'Child note',
        content: '<blockquote>A quoted note</blockquote>\n\n<script>alert(1)</script>',
        parentId: pageId,
    });
    expect(child.isError).toBe(false);
    expect(child.data).toMatchObject({ parentId: pageId, url: expect.stringContaining(`/pages/${child.data.id}`) });
    const storedChild = workspace.pages.get(everyday!.id, child.data.id as string);
    expect(storedChild.createdBy).toBe('bob');
    expect(storedChild.content).toContain('> A quoted note');
    expect(storedChild.content).toContain('<script>alert(1)</script>');

    // A stale expectedRevision fails with the 409 error outcome.
    const stale = await call('update_page', {
        spaceId: everyday!.id,
        pageId,
        expectedRevision: revision,
        content: 'this should not land',
    });
    expect(stale.isError).toBe(true);
    expect(stale.data.outcome).toBe('error');

    // delete_page removes it; a later read is not_found. The child goes first,
    // or the parent refuses while it still has a subpage.
    expect((await call('delete_page', { spaceId: everyday!.id, pageId: child.data.id })).isError).toBe(false);
    const deleted = await call('delete_page', { spaceId: everyday!.id, pageId });
    expect(deleted.isError).toBe(false);
    expect(deleted.data.deleted).toBe(1);
    const after = await call('read_page', { spaceId: everyday!.id, pageId });
    expect(after.isError).toBe(true);
    // A deleted page returns the 410 'deleted' error (not the 404 'not_found').
    expect(after.data.outcome).toBe('error');
    expect(after.data.message).toContain('deleted');

    // A grant without pages:write can’t write: 403 insufficient_scope, and the
    // tools are not offered.
    const reader = actorFor('bob', ['pages:read']);
    for (const body of [
        toolCall('create_page', { spaceId: everyday!.id, title: 'x' }),
        toolCall('update_page', { spaceId: everyday!.id, pageId, expectedRevision: 1, title: 'x' }),
        toolCall('append_page', { spaceId: everyday!.id, pageId, expectedRevision: 1, content: 'x' }),
        toolCall('delete_page', { spaceId: everyday!.id, pageId }),
    ]) {
        const response = await post(body, { Authorization: `Bearer ${grant(reader)}` });
        expect(response.status).toBe(403);
        expect(response.headers.get('www-authenticate')).toContain('scope="pages:write"');
    }
    const { client: readerClient } = await connect(reader);
    const offered = (await readerClient.listTools()).tools.map((tool) => tool.name);
    expect(offered).toContain('read_page');
    expect(offered).toEqual(expect.not.arrayContaining(['create_page', 'update_page', 'append_page', 'delete_page']));
});

it('refuses page writes the web would refuse', async () => {
    const { connect, workspace, platform, grant, post } = await fixture();
    const [everyday] = workspace.spaces();
    const closed = workspace.createSpace('Deals', 'Private');
    await workspace.spaceAccess.setMembersOnly(closed.id, 'alice', true);
    await workspace.spaceAccess.setRole(closed.id, 'alice', 'bob', 'member');
    const secret = await workspace.pages.create(closed.id, { title: 'Terms', content: 'Confidential.' }, null, 'alice');
    const other = workspace.createSpace('Elsewhere', 'Another');
    const abroad = await workspace.pages.create(other.id, { title: 'Abroad', content: 'Not here.' }, null, 'alice');
    const gone = workspace.createSpace('Old', 'Archived');
    await workspace.pages.create(gone.id, { title: 'Old notes', content: 'Gone.' }, null, 'alice');
    workspace.db.prepare('UPDATE spaces SET deletedAt=?, deletedBy=? WHERE id=?').run(1, 'alice', gone.id);

    // A member of a private Space (not its editor) may write, as on the web.
    const member = await connect(actorFor('bob', ['pages:read', 'pages:write']));
    const made = await member.call('create_page', {
        spaceId: closed.id,
        title: 'Bob’s note',
        content: 'From the member.',
        parentId: secret.id,
    });
    expect(made.isError).toBe(false);
    expect(made.data.parentId).toBe(secret.id);
    expect(workspace.pages.get(closed.id, made.data.id as string).createdBy).toBe('bob');

    // Someone who is not a member: the Space is not found, and nothing is written.
    const outsider = await connect(actorFor('carol', ['pages:read', 'pages:write']));
    const before = workspace.pages.list(closed.id).length;
    for (const [name, args] of [
        ['create_page', { spaceId: closed.id, title: 'Sneaky', content: 'no' }],
        ['update_page', { spaceId: closed.id, pageId: secret.id, expectedRevision: 1, title: 'Stolen' }],
        ['append_page', { spaceId: closed.id, pageId: secret.id, expectedRevision: 1, content: 'no' }],
    ] as const) {
        const refused = await outsider.call(name, args);
        expect(refused.isError).toBe(true);
        expect(refused.data.outcome).toBe('not_found');
        expect(refused.text).not.toContain('Confidential');
    }
    expect(workspace.pages.list(closed.id)).toHaveLength(before);
    expect(workspace.pages.get(closed.id, secret.id).title).toBe('Terms');

    // A deleted Space is not found either.
    const archived = await member.call('create_page', { spaceId: gone.id, title: 'Back', content: 'no' });
    expect(archived.isError).toBe(true);
    expect(archived.data.outcome).toBe('not_found');

    // A parent in another Space is not a parent here.
    const crossed = await member.call('create_page', {
        spaceId: everyday!.id,
        title: 'Crossed',
        content: 'no',
        parentId: abroad.id,
    });
    expect(crossed.isError).toBe(true);
    expect(crossed.data.outcome).toBe('not_found');
    expect(workspace.pages.list(everyday!.id).some((page) => page.title === 'Crossed')).toBe(false);
    const moved = await member.call('update_page', {
        spaceId: closed.id,
        pageId: secret.id,
        expectedRevision: secret.revision,
        parentId: abroad.id,
    });
    expect(moved.isError).toBe(true);
    expect(workspace.pages.get(closed.id, secret.id).parentId).toBeNull();

    // A page that is not there.
    for (const [name, args] of [
        ['update_page', { spaceId: everyday!.id, pageId: 'missing-page', expectedRevision: 1, title: 'Nope' }],
        ['append_page', { spaceId: everyday!.id, pageId: 'missing-page', expectedRevision: 1, content: 'no' }],
    ] as const) {
        const missing = await member.call(name, args);
        expect(missing.isError).toBe(true);
        expect(missing.data.outcome).toBe('not_found');
    }

    // A body over the page limit is refused and nothing is stored.
    const huge = 'x'.repeat(100_001);
    const oversized = await member.call('create_page', {
        spaceId: everyday!.id,
        title: 'Too big',
        content: huge,
    });
    expect(oversized.isError).toBe(true);
    expect(workspace.pages.list(everyday!.id).some((page) => page.title === 'Too big')).toBe(false);
    const long = await workspace.pages.create(
        everyday!.id,
        { title: 'Almost full', content: 'y'.repeat(90_000) },
        null,
        'bob',
    );
    const overflow = await member.call('append_page', {
        spaceId: everyday!.id,
        pageId: long.id,
        expectedRevision: long.revision,
        content: 'z'.repeat(20_000),
    });
    expect(overflow.isError).toBe(true);
    expect(overflow.data.message).toContain('100,000');
    expect(workspace.pages.get(everyday!.id, long.id).content).toHaveLength(90_000);

    // A service account is not a person: the tool refuses, as page moves do.
    const account = platform.serviceAccounts.create({ name: 'Reader', role: 'admin' }, 'alice');
    const person = workspace.users().find((user) => user.id === account.id)!;
    const server = agentMcpServer({
        workspace,
        board: platform.board,
        actor: actorFor(account.id, ['pages:read', 'pages:write'], 'g-svc'),
        person,
        origin: 'http://localhost',
    });
    const [client, transport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'svc', version: '0.1.0' });
    await Promise.all([server.connect(transport), mcp.connect(client)]);
    cleanup.push(() => mcp.close());
    const svc = await mcp.callTool({
        name: 'create_page',
        arguments: { spaceId: everyday!.id, title: 'Robot', content: 'no' },
    });
    expect(svc.isError).toBe(true);
    expect(JSON.stringify(svc.structuredContent)).toContain('can’t edit');
    expect(workspace.pages.list(everyday!.id).some((page) => page.title === 'Robot')).toBe(false);
    // The MCP endpoint never lets that account in, even with pages:write on the token.
    const http = await post(toolCall('create_page', { spaceId: everyday!.id, title: 'Robot' }), {
        Authorization: `Bearer ${grant(actorFor(account.id, ['pages:read', 'pages:write'], 'g-svc-http'))}`,
    });
    expect(http.status).toBe(401);
});

it('lets an admin delete a page someone else created; a non-owner non-admin cannot', async () => {
    const { connect, workspace } = await fixture();
    const [everyday] = workspace.spaces();
    const page = await workspace.pages.create(everyday!.id, { title: 'Carol’s page', content: 'mine' }, null, 'carol');
    // Bob (a member, not the creator) cannot delete Carol’s page.
    const bob = await connect(actorFor('bob', ['pages:read', 'pages:write']));
    const refused = await bob.call('delete_page', { spaceId: everyday!.id, pageId: page.id });
    expect(refused.isError).toBe(true);
    expect(refused.data.outcome).toBe('error');
    // The page is still there.
    expect(workspace.pages.get(everyday!.id, page.id).title).toBe('Carol’s page');
    // Alice (an admin) can delete it.
    const alice = await connect(actorFor('alice', ['pages:read', 'pages:write']));
    const ok = await alice.call('delete_page', { spaceId: everyday!.id, pageId: page.id });
    expect(ok.isError).toBe(false);
    expect(ok.data.deleted).toBe(1);
});

/** The content blocks of a call: its JSON first, then any images. */
const blocks = async (client: Client, name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
    return {
        isError: !!result.isError,
        data: result.structuredContent as Record<string, unknown>,
        content,
        images: content.filter((block) => block.type === 'image'),
    };
};
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');

it('reads an item’s and its comments’ attachments, newest images as image content within the caps', async () => {
    const { connect, platform } = await fixture();
    const { issues } = platform.board;
    await issues.create({ title: 'Broken chart' }, 'carol', 1);
    const shot = await issues.addAttachment(1, { name: 'shot.png', mediaType: 'image/png', data: PNG }, 'carol', 2);
    const log = await issues.addAttachment(
        1,
        {
            name: 'console.log',
            mediaType: 'text/plain',
            data: Buffer.from('Error at ops@example.com\nstack'),
        },
        'bob',
        3,
    );
    const comment = await issues.addComment(1, 'Here it is again.', 'carol', 4);
    const second = await issues.addAttachment(
        1,
        {
            name: 'again.png',
            mediaType: 'image/png',
            data: pngOf(64, 2),
            commentId: comment.id,
        },
        'carol',
        5,
    );
    const { client } = await connect(actorFor('bob', ['issues:read']));
    const read = await blocks(client, 'read_issue', { issue: 'CB-1' });
    expect(read.isError).toBe(false);
    expect(read.content[0]!.type).toBe('text');
    expect(JSON.parse(read.content[0]!.text!)).toEqual(read.data);
    expect(read.data.attachments).toMatchObject([
        {
            id: second.id,
            name: 'again.png',
            mediaType: 'image/png',
            size: 64,
            on: 'comment',
            commentAt: new Date(4).toISOString(),
            addedBy: 'another person',
            url: `http://localhost/api/issue-attachments/${second.id}`,
        },
        {
            id: log.id,
            on: 'item',
            mediaType: 'text/plain',
            addedBy: 'the person you act for',
        },
        { id: shot.id, name: 'shot.png', on: 'item', size: PNG.byteLength },
    ]);
    expect(read.data.images).toMatchObject({
        sent: [second.id, shot.id],
        leftOut: [],
    });
    // No uploader's id or hash leaks; just the two images, newest first.
    expect(JSON.stringify(read.data.attachments)).not.toContain('carol');
    expect(read.images).toEqual([
        { type: 'image', data: b64(pngOf(64, 2)), mimeType: 'image/png' },
        { type: 'image', data: b64(PNG), mimeType: 'image/png' },
    ]);

    // The caps: at most 5 images, and 5 MB of them, newest first.
    const many = await issues.create({ title: 'Many shots' }, 'carol', 10);
    const big = await issues.addAttachment(
        many.number,
        { name: 'big.png', mediaType: 'image/png', data: pngOf(3 * 1024 * 1024) },
        'carol',
        11,
    );
    const small = [];
    for (let i = 0; i < 6; i++) {
        small.push(
            await issues.addAttachment(
                many.number,
                { name: `s${i}.png`, mediaType: 'image/png', data: pngOf(100, i) },
                'carol',
                12 + i,
            ),
        );
    }
    const huge = await issues.addAttachment(
        many.number,
        { name: 'huge.png', mediaType: 'image/png', data: pngOf(4 * 1024 * 1024) },
        'carol',
        20,
    );
    const capped = await blocks(client, 'read_issue', { issue: 'CB-2' });
    const list = capped.data.images as Record<string, unknown>;
    // huge (4 MB) first, then 1 MB is left: the small ones fit, 5 at most.
    expect(list.sent).toEqual([huge.id, small[5]!.id, small[4]!.id, small[3]!.id, small[2]!.id]);
    expect(list.leftOut).toEqual([
        { id: small[1]!.id, reason: 'Only the newest 5 images are sent.' },
        { id: small[0]!.id, reason: 'Only the newest 5 images are sent.' },
        { id: big.id, reason: 'Only the newest 5 images are sent.' },
    ]);
    expect(capped.images).toHaveLength(5);
    await issues.deleteAttachment(huge.id, 'carol', 21);
    const bytes = await blocks(client, 'read_issue', { issue: 'CB-2' });
    expect((bytes.data.images as Record<string, unknown>).sent).toEqual([
        small[5]!.id,
        small[4]!.id,
        small[3]!.id,
        small[2]!.id,
        small[1]!.id,
    ]);
    await issues.deleteAttachment(small[5]!.id, 'carol', 22);
    await issues.deleteAttachment(small[4]!.id, 'carol', 22);
    // Now big fits the count, and the size: 3 MB + 4 × 100 bytes.
    expect(
        ((await blocks(client, 'read_issue', { issue: 'CB-2' })).data.images as Record<string, unknown>).sent,
    ).toHaveLength(5);
    const huge2 = await issues.addAttachment(
        many.number,
        { name: 'huge2.png', mediaType: 'image/png', data: pngOf(4 * 1024 * 1024) },
        'carol',
        30,
    );
    await issues.deleteAttachment(small[0]!.id, 'carol', 31);
    const sized = (await blocks(client, 'read_issue', { issue: 'CB-2' })).data.images as Record<string, unknown>;
    expect(sized.sent).toEqual([huge2.id, small[3]!.id, small[2]!.id, small[1]!.id]);
    // Room for a fifth, but not for 3 MB more.
    expect(sized.leftOut).toEqual([{ id: big.id, reason: 'The images sent are at most 5 MB in all.' }]);
});

it('reads one attachment by id: an image as image content, text as text, a PDF as details', async () => {
    const { connect, platform } = await fixture();
    const { issues } = platform.board;
    await issues.create({ title: 'Broken chart' }, 'carol', 1);
    const shot = await issues.addAttachment(1, { name: 'shot.png', mediaType: 'image/png', data: PNG }, 'carol', 2);
    const log = await issues.addAttachment(
        1,
        {
            name: 'console.log',
            mediaType: 'text/plain',
            data: Buffer.from('Error for ops@example.com'),
        },
        'carol',
        3,
    );
    const pdf = await issues.addAttachment(
        1,
        {
            name: 'spec.pdf',
            mediaType: 'application/pdf',
            data: Buffer.from('%PDF-1.4\n%%EOF'),
        },
        'carol',
        4,
    );
    const { client } = await connect(actorFor('bob', ['issues:read']));
    const image = await blocks(client, 'read_issue_attachment', {
        attachment: shot.id,
    });
    expect(image.data).toMatchObject({
        outcome: 'found',
        issue: 'CB-1',
        id: shot.id,
        content: 'image',
        on: 'item',
    });
    expect(image.data.untrusted).toContain('untrusted data');
    expect(image.images).toEqual([{ type: 'image', data: b64(PNG), mimeType: 'image/png' }]);
    const text = await blocks(client, 'read_issue_attachment', {
        attachment: log.id,
    });
    expect(text.data).toMatchObject({
        content: 'text',
        text: 'Error for [email removed]',
        truncated: false,
    });
    expect(text.images).toEqual([]);
    const details = await blocks(client, 'read_issue_attachment', {
        attachment: pdf.id,
    });
    expect(details.data).toMatchObject({
        content: 'metadata only',
        mediaType: 'application/pdf',
    });
    expect(details.content).toHaveLength(1);

    const wrong = await blocks(client, 'read_issue_attachment', {
        attachment: 'nope',
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.data.outcome).toBe('not_found');
    // A deleted attachment, or one of a deleted item, is not found either.
    await issues.deleteAttachment(log.id, 'carol');
    expect((await blocks(client, 'read_issue_attachment', { attachment: log.id })).data.outcome).toBe('not_found');
    await issues.remove(1, 'alice');
    expect((await blocks(client, 'read_issue_attachment', { attachment: shot.id })).data.outcome).toBe('not_found');
});

it('files and comments with attachments as the person, the agent beside them; a bad file writes nothing', async () => {
    const { connect, workspace, platform } = await fixture();
    const { issues } = platform.board;
    const actor = actorFor('bob');
    const { call } = await connect(actor);
    const shot = { name: 'shot.png', mediaType: 'image/png', data: b64(PNG) };
    const filed = await call('file_issue', {
        title: 'Chart axis overlaps',
        kind: 'bug',
        description: 'See the screenshot.',
        attachments: [shot],
    });
    expect(filed.data).toMatchObject({
        outcome: 'filed',
        issue: 'CB-1',
        attachments: [{ name: 'shot.png', mediaType: 'image/png', size: 70 }],
        message: 'Filed CB-1 on the board, in triage, with 1 attachment.',
    });
    const issue = (await issues.get(1))!;
    const [stored] = await issues.attachments(issue.id);
    expect(stored).toMatchObject({ uploaderId: 'bob', commentId: null });
    expect(Buffer.from((await issues.attachment(stored!.id))!.data)).toEqual(PNG);

    const commented = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'And the log.',
        attachments: [
            {
                name: 'console.log',
                mediaType: 'text/plain',
                data: b64(Buffer.from('TypeError: x')),
            },
        ],
    });
    expect(commented.data).toMatchObject({
        outcome: 'commented',
        attachments: [{ name: 'console.log', mediaType: 'text/plain' }],
    });
    const [comment] = await issues.comments(issue.id);
    expect((await issues.attachments(issue.id))[1]).toMatchObject({
        commentId: comment!.id,
        uploaderId: 'bob',
    });
    // Each file's history row is the person's, with the agent recorded.
    const detail = await issueDetailView(platform, (await issues.get(1))!, 'bob');
    const added = detail.events.filter((e) => e.kind === 'attachment_added');
    expect(added).toHaveLength(2);
    for (const event of added) {
        expect(event).toMatchObject({
            actorId: 'bob',
            agent: { grantId: 'g-bob' },
        });
    }
    expect((await platform.board.agentActions.activity('g-bob')).map((line) => line.summary)).toEqual([
        'attached a file to CB-1 “Chart axis overlaps”',
        'commented on CB-1 “Chart axis overlaps”',
        'attached a file to CB-1 “Chart axis overlaps”',
        'filed CB-1 “Chart axis overlaps”',
    ]);

    const count = () => workspace.db.prepare('SELECT COUNT(*) AS n FROM issue_agent_actions').get()!.n;
    const before = count();
    // A wrong type (declared, or by content): nothing is written.
    const html = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'Two files.',
        attachments: [
            shot,
            {
                name: 'page.png',
                mediaType: 'image/png',
                data: b64(Buffer.from('<html><script>x</script>')),
            },
        ],
    });
    expect(html.isError).toBe(true);
    expect(html.data.message).toBe(
        'Nothing was written: “page.png” was refused. Attach a PNG, JPEG, GIF or WebP image, a PDF or a plain text file.',
    );
    const liar = await call('file_issue', {
        title: 'Another one',
        kind: 'bug',
        description: 'x',
        force: true,
        attachments: [{ ...shot, mediaType: 'image/jpeg' }],
    });
    expect(liar.isError).toBe(true);
    // Too big.
    const big = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'Huge.',
        attachments: [
            {
                name: 'big.png',
                mediaType: 'image/png',
                data: b64(pngOf(5 * 1024 * 1024 + 1)),
            },
        ],
    });
    expect(big.isError).toBe(true);
    expect(big.data.message).toBe('Nothing was written: “big.png” was refused. Attachments can be at most 5 MB.');
    // Over the per-item cap: 2 there, 9 more is one too many.
    const over = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'Lots.',
        attachments: Array.from({ length: 9 }, () => shot),
    });
    expect(over.isError).toBe(true);
    expect(over.data.message).toBe(
        'Nothing was written: an item can have at most 10 attachments, and this one has 2, so at most 8 more.',
    );
    expect(await issues.list()).toHaveLength(1);
    expect(await issues.comments(issue.id)).toHaveLength(1);
    expect(await issues.attachments(issue.id)).toHaveLength(2);
    expect(count()).toBe(before);
    // Not base64: refused by the input check.
    const garbled = await call('comment_on_issue', {
        issue: 'CB-1',
        comment: 'x',
        attachments: [{ ...shot, data: 'not base64!' }],
    });
    expect(garbled.isError).toBe(true);
    expect(await issues.comments(issue.id)).toHaveLength(1);
});

it('needs issues:read for read_issue_attachment', async () => {
    const { post, grant } = await fixture();
    const writer = actorFor('bob', ['issues:write']);
    const response = await post(toolCall('read_issue_attachment', { attachment: 'x' }), {
        Authorization: `Bearer ${grant(writer)}`,
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('scope="issues:read"');
});

it('publishes structured dependency fields and files them through the MCP boundary for admins', async () => {
    const { connect, platform } = await fixture();
    await platform.board.issues.create({ title: 'Dependency foundation' }, 'alice');
    await platform.board.issues.create({ title: 'Downstream integration' }, 'alice');
    const { call, client } = await connect(actorFor('alice'));
    const tools = await client.listTools();
    const schema = tools.tools.find((tool) => tool.name === 'file_issue')!.inputSchema;
    expect(schema.properties).toHaveProperty('blockedBy');
    expect(schema.properties).toHaveProperty('blocks');
    const filed = await call('file_issue', {
        title: 'MCP dependency authoring',
        kind: 'feature',
        description: 'Implement prerequisite-aware filing.',
        force: true,
        blockedBy: ['CB-1'],
        blocks: ['CB-2'],
    });
    expect(filed.isError).toBe(false);
    expect(filed.data).toMatchObject({ outcome: 'filed', issue: 'CB-3' });
    const issue = await platform.board.issues.require(3);
    expect(await platform.board.issues.blockedBy(issue.id)).toMatchObject([{ number: 1 }]);
    expect(await platform.board.issues.blocks(issue.id)).toMatchObject([{ number: 2 }]);
    await platform.board.issues.update(issue.number, { status: 'in_progress' }, 'alice');
    const combined = await call('read_issue', { issue: 'CB-3', historyLimit: 2 });
    expect(combined.isError).toBe(false);
    expect(combined.data).toMatchObject({
        blockedBy: [{ issue: 'CB-1' }],
        blocks: [{ issue: 'CB-2' }],
        statusHistory: {
            complete: true,
            next: null,
            events: [
                { kind: 'created', to: 'triage' },
                { kind: 'status', from: 'triage', to: 'in_progress' },
            ],
        },
    });
});

it('exposes paged dated status transitions and complete listing through connected read tools', async () => {
    const { connect, platform } = await fixture();
    const issue = await platform.board.issues.create({ title: 'Dated connected issue' }, 'alice', 1000);
    await platform.board.issues.update(issue.number, { status: 'wont_fix' }, 'alice', 2000);
    await platform.board.issues.update(issue.number, { status: 'open' }, 'alice', 3000);
    const { call, client } = await connect(actorFor('bob', ['issues:read']));
    const tools = await client.listTools();
    expect(tools.tools.find((t) => t.name === 'read_issue')!.inputSchema.properties).toHaveProperty('historyAfter');
    const first = await call('read_issue', { issue: 'CB-1', historyLimit: 2 });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({
        statusHistory: {
            complete: false,
            events: [
                { kind: 'created', from: null, to: 'triage' },
                { kind: 'status', from: 'triage', to: 'wont_fix' },
            ],
        },
    });
    const page = first.data.statusHistory as { next: number };
    const last = await call('read_issue', {
        issue: 'CB-1',
        historyLimit: 2,
        historyAfter: page.next,
    });
    expect(last.data).toMatchObject({
        statusHistory: {
            complete: true,
            next: null,
            events: [{ from: 'wont_fix', to: 'open', at: new Date(3000).toISOString() }],
        },
    });
    expect(await call('list_issues', { sort: 'newest', limit: 1 })).toMatchObject({
        isError: false,
        data: { total: 1, next: null, complete: true, enumeration: 'live' },
    });
});

it('binds subscription recipients to the grant person and requires both board-read and write scopes to create/cancel', async () => {
    const f = await fixture();
    await f.platform.board.issues.create({ title: 'Watched future issue', status: 'open' }, 'alice');
    const { call } = await f.connect(actorFor('bob'));
    const created = await call('subscribe_to_issues', { issues: ['CB-1'] });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({
        outcome: 'subscribed',
        futureTransitionsOnly: true,
        alreadyMatched: false,
    });
    const id = (created.data.watch as { id: string }).id;
    expect((await call('list_issue_subscriptions')).data).toMatchObject({
        items: [{ id, issues: ['CB-1'] }],
        next: null,
    });
    const { call: other } = await f.connect(actorFor('alice'));
    expect((await other('list_issue_subscriptions')).data).toMatchObject({
        items: [],
    });
    expect((await other('cancel_issue_subscription', { subscription: id })).isError).toBe(true);
    const { client: writer, call: writeOnly } = await f.connect(actorFor('bob', ['issues:write']));
    expect((await writer.listTools()).tools.map((t) => t.name)).not.toContain('subscribe_to_issues');
    expect((await writeOnly('subscribe_to_issues', { issues: ['CB-1'] })).isError).toBe(true);
    expect((await call('cancel_issue_subscription', { subscription: id })).data).toMatchObject({
        outcome: 'cancelled',
    });
    expect(
        f.workspace.db
            .prepare('SELECT sourceKind,sourceId,cancelSourceKind,cancelSourceId FROM issue_watches WHERE id=?')
            .get(id),
    ).toMatchObject({
        sourceKind: 'agent',
        sourceId: 'g-bob',
        cancelSourceKind: 'agent',
        cancelSourceId: 'g-bob',
    });
});
