import { createECDH, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { openDatabase, sqliteData } from '@socio/data/open';
import type { AgentActor } from '@socio/foundation/agents/actor';
import type { DotTurn } from '@socio/foundation/turns/turn';
import { APPROVAL_CAPABILITIES } from '@socio/shared/approvals';
import type { SkillImportPreview } from '@socio/shared/chat/chat-skills';
import { CODING_TOOL_NAMES } from '@socio/shared/coding/coding-sessions';
import type { User } from '@socio/shared/types';

import { workerKeyPair } from '../src/app-browser/protocol.js';
import { agentMcpServer } from '../src/server/agents/mcp-tools.js';
import { AppBrowserBroker, type BrokerContext } from '../src/server/apps/broker-client.js';
import { browseToolsWith } from '../src/server/apps/browse-tools.js';
import { steeringQueue } from '../src/server/context/steering.js';
import { gitGateway } from '../src/server/gateway/git.js';
import { modelGateway } from '../src/server/gateway/model.js';
import type { PageSearch } from '../src/server/pages/page-search.js';
import { GitHubSkillImporter } from '../src/server/skills/github-import.js';
import { skillSessions, skillsRepository } from '../src/server/skills/repository.js';
import { workspaceSkillTools } from '../src/server/skills/tools.js';
import { WebReads } from '../src/server/web/web-reads.js';

import { PNG } from './fixtures/media.js';
import { testDatabase } from './helpers/test-database.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { EGRESS_SECRET, REPO, SUPERVISOR_TOKEN, codingOf, fakeSupervisor } from './support/coding-fixture.js';

/**
 * The real `fetch`, before the sweep refuses every request: only the
 * coding sessions' loopback fake of the sandbox supervisor gets it.
 */
const loopbackFetch = globalThis.fetch.bind(globalThis);

/*
 * CB-110 review, round 2: every socio tool that writes outside the Board,
 * started in the same synchronous loop as a Board write (as one model step
 * starts its parallel tool calls), at several microtask offsets. Neither
 * may fail, and both writes must stay, also when the Board's unit of work
 * throws after it opened. Under tests a write from outside an open unit
 * fails (the connection guard), so a tool that writes without queueing
 * shows up here as a failure; the throwing Board unit catches writes that
 * slipped in unguarded (a statement prepared earlier) by rolling them back.
 */

// The sweep is one test per Board writer, each on a fresh fixture (a few
// seconds alone), so a new tool adds a little to every test rather than
// to one long one, and no test pays for the state the ones before it
// left. The limit is headroom for a loaded host, not the expected time.
vi.setConfig({ testTimeout: 120_000 });

const USERS: User[] = [
    { id: 'alice', name: 'Alice', role: 'admin' },
    { id: 'carol', name: 'Carol', role: 'member' },
];
/** Microtask hops before the second call starts; `open`: once a unit is. */
const OFFSETS = [0, 5, 15, 27, 'open'] as const;
/**
 * The Board writers below, by name: each gets its own test, so the sweep's
 * tests are known before `setup` builds the writers (which checks this
 * list against them).
 */
const BOARD = [
    'file_improvement',
    'subscribe_to_issues',
    'cancel_issue_subscription',
    'subscribe_to_issues (agent)',
    'cancel_issue_subscription (agent)',
    'comment_on_improvement',
    'vote_improvement',
    'edit_improvement',
    'set_improvement_status',
    'request_capability',
    'file_issue (agent)',
    'comment_on_issue (agent)',
    'vote_on_issue (agent)',
    'update_issue (agent)',
    'update_issue that throws (agent)',
    'a Board unit held open, then thrown (synthetic)',
] as const;

type Result = Record<string, unknown> | undefined;
interface Writer {
    name: string;
    /** Runs the tool once with fresh input. */
    run: () => Promise<Result>;
    /** What its write left (a count, a value) after `run`. */
    probe: () => Promise<unknown> | unknown;
    /** Whether the run's write is there: by default, `probe` changed. */
    wrote?: (before: unknown, after: unknown, result: Result) => boolean;
    /** The run is meant to fail (a Board unit that throws). */
    fails?: boolean;
}

let cleanup: (() => Promise<void>) | undefined;
let board: Writer[] = [];
let others: Writer[] = [];
let skipped: Array<[string, string]> = [];
/** Every socio tool registered for the sweep's turn. */
let registered: string[] = [];
let connection: ReturnType<typeof openDatabase>;

/** The server's stores and platform on a connection, its data in `dir`. */
async function platformOn(connection: DatabaseSync, dir: string) {
    return makeTestRuntime({
        database: connection,
        config: {
            apiKey: '',
            model: '',
            sessionSecret: 'sweep-secret-0123456789abcdef-xyz',
            appOrigin: 'http://localhost',
            data: {
                userDataDir: dir,
                limits: { statementsPerMinute: 1_000_000, maxDatasets: 100_000 },
            },
            dotRequestLimits: {
                perDot: 100_000,
                perUser: 100_000,
                windowMs: 86_400_000,
            },
            schedules: { maxActivePerUser: 100_000, minIntervalMs: 60_000 },
            notificationLimits: { perDot: 1_000_000, perUser: 1_000_000 },
            // CB-232: request_app_access and end_app_access are swept too;
            // CB-239's coding tools too.
            // Its flags are in development: only an internal deployment has them (CB-503).
            deploymentKind: 'internal',
            featureFlags: { 'socio-actor-access': true, 'coding-sessions': true },
        },
        codeRunners: ['alice'],
    });
}

let template: Uint8Array | undefined;
/**
 * The database as the server leaves it once every module migrated, made
 * once: migrating is most of a fresh platform's time, and each test starts
 * from a copy of it instead.
 */
async function migrated() {
    if (template) {
        return template;
    }
    const dir = mkdtempSync(join(tmpdir(), 'cb-sweep-template-'));
    const db = testDatabase();
    await (await platformOn(db, dir)).dispose();
    // The connection is the caller's: still open after dispose.
    template = db.serialize();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    return template;
}

/** A fresh platform, its writers and their seeds: before each test. */
async function setup() {
    skipped = [];
    registered = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Nothing here may reach outside: a request is a failure.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        throw new Error(`Unexpected request to ${String(input)}`);
    });
    // Datasets are files: each data tool's write commits (and syncs) one. In
    // memory where there is a tmpfs, as on Linux, the same SQLite files and
    // statements run without waiting on the disk (much of the sweep's time
    // on a busy host).
    const dir = mkdtempSync(join(existsSync('/dev/shm') ? '/dev/shm' : tmpdir(), 'cb-sweep-'));
    // Until the platform is up, a setup that fails leaves only its folder.
    cleanup = async () => rmSync(dir, { recursive: true, force: true });
    // The server's shape: one connection for the core store and workspace,
    // on a copy of the migrated database (reopened, as on a restart).
    connection = testDatabase();
    connection.deserialize(await migrated());
    const { store, workspace, platform, edge, dispose } = await platformOn(connection, dir);
    for (const user of USERS) {
        workspace.recordUser(user);
    }
    workspace.useDeactivated(() => ['carol']);
    const dot = workspace.dots()[0]!;
    const home = workspace.spaces()[0]!;
    const away = workspace.createSpace('Away', '');
    workspace.updateDot(dot.id, {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: true,
        memoryAllowed: true,
        issuesAllowed: true,
        spaceId: home.id,
        spaceIds: [home.id, away.id],
    });
    // Every approval runs at once (bypass), so each approved action's own
    // writes are swept too, not just the request's.
    for (const capability of Object.values(APPROVAL_CAPABILITIES)) {
        try {
            await platform.approvals.setPolicy('alice', dot.id, capability, 'bypass');
        } catch {
            // Not registered in this platform (a handler that needs a service).
        }
    }
    const thread = workspace.bindThread('sweep', dot.id, 'Chat', 'alice');
    const policy = (capability: string, choice: 'bypass' | 'auto') =>
        platform.approvals.setPolicy('alice', dot.id, capability, choice);
    // Coding sessions (CB-239) over the loopback fake of the sandbox
    // supervisor, which checks each request with the supervisor's own
    // parsers; a listed repository; and a coding model stubbed as offered and
    // usable (the model gateway's resolution isn't what is swept here, and a
    // backend would make other tools reach for it).
    const supervisor = await fakeSupervisor();
    supervisor.behavior.onPrompt = (exec) => supervisor.finish(exec.runId);
    codingOf(edge).service.configure({
        supervisorUrl: supervisor.url,
        supervisorToken: SUPERVISOR_TOKEN,
        egressSecret: EGRESS_SECRET,
        fetch: (input, init) => {
            if (!String(input).startsWith(`${supervisor.url}/`)) {
                throw new Error(`Unexpected request to ${String(input)}`);
            }
            return loopbackFetch(input, init);
        },
        pollSeconds: 0,
        retryMs: 10,
        waitMs: 20_000,
    });
    await gitGateway(platform).repos.save(REPO, { push: true, pushChecklistConfirmed: true }, 'alice');
    const codingModels = modelGateway(platform).settings;
    vi.spyOn(codingModels, 'forRepository').mockResolvedValue([
        {
            id: 'orion',
            label: 'Homelab',
            outsideProvider: false,
            backendHost: null,
        },
    ] as never);
    vi.spyOn(codingModels, 'usable').mockResolvedValue({
        model: { id: 'orion', label: 'Homelab' },
        outsideProvider: false,
        endpoint: { baseUrl: 'http://127.0.0.1:9/v1', model: 'orion' },
    } as never);
    // An approval's continuation turn runs no model here.
    vi.spyOn(platform, 'turnOutcome').mockResolvedValue({ text: '' } as never);
    const names: string[] = [];
    const turn: DotTurn = {
        dot: workspace.dot(dot.id)!,
        userId: 'alice',
        threadId: thread.id,
        channel: false,
        purpose: 'chat',
        check: () => {},
        signal: new AbortController().signal,
        toolNames: () => names,
    };
    const tools = new Map(
        platform.dotExtensions
            .tools(turn)
            .map((tool) => [tool.name, tool as unknown as { execute: (input: unknown) => Promise<Result> }]),
    );
    // Keep the real permission checks, immutable preview validation and queued
    // repository import. Only the bounded GitHub JSON transport is replaced;
    // global fetch still rejects every external request in this sweep.
    const importData = new Map<string, unknown>();
    const importer = new GitHubSkillImporter(skillsRepository(connection), {
        read: async (url) => {
            expect(url.origin).toBe('https://api.github.com');
            const key = url.pathname.replace('/repos/example/sweep-skills/', '');
            const ref = key.match(/^commits\/(sweep-\d+)$/)?.[1];
            if (ref) {
                const document = Buffer.from(
                    `---\nname: import-${ref}\ndescription: Imported beside a Board unit.\n---\nUse only when explicitly invoked.\n`,
                );
                const sha = createHash('sha1').update(`blob ${document.length}\0`).update(document).digest('hex');
                const commit = createHash('sha1').update(ref).digest('hex');
                const tree = createHash('sha1')
                    .update('tree-' + ref)
                    .digest('hex');
                importData.set(key, { sha: commit, commit: { tree: { sha: tree } } });
                importData.set(`git/trees/${tree}`, {
                    sha: tree,
                    truncated: false,
                    tree: [
                        {
                            path: 'SKILL.md',
                            mode: '100644',
                            type: 'blob',
                            sha,
                            size: document.length,
                        },
                    ],
                });
                importData.set(`git/blobs/${sha}`, {
                    sha,
                    size: document.length,
                    encoding: 'base64',
                    content: document.toString('base64'),
                });
            }
            if (!importData.has(key)) {
                throw Error(`Unexpected import fixture: ${key}`);
            }
            const value = importData.get(key);
            return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
        },
    });
    for (const item of workspaceSkillTools(turn, skillsRepository(connection), workspace, importer)) {
        if (item.name === 'preview_workspace_skill_import' || item.name === 'apply_workspace_skill_import') {
            tools.set(item.name, item as unknown as { execute: (input: unknown) => Promise<Result> });
        }
    }
    // The app browser's `app_*` tools (CB-232) over the real broker and a
    // fake of its router in memory: the platform offers them only with the
    // service (APP_BROWSER_URL), an outside one.
    let navigations = 0;
    const browserContexts = new Map<string, BrokerContext>();
    const appBrowser = new AppBrowserBroker({
        actors: platform.actors,
        secret: 'sweep-secret-0123456789abcdef-xyz',
        client: {
            list: async () => ({
                bootId: 'sweep-boot',
                contexts: [...browserContexts.values()],
            }),
            open: async ({ contextId, grantId }) => {
                browserContexts.set(contextId, {
                    id: contextId,
                    grantId,
                    workerKey: workerKeyPair().publicKey,
                    openedAt: 0,
                    lastUsedAt: 0,
                });
                return {
                    bootId: 'sweep-boot',
                    workerKey: browserContexts.get(contextId)!.workerKey,
                };
            },
            deliver: async () => {},
            // Each result a new count: each run records a context audit row.
            command: async () => ({
                title: 'Sweep',
                url: 'http://apps.localhost/',
                blocked: ++navigations,
                offOriginRedirects: 0,
            }),
            close: async (contextId) => {
                browserContexts.delete(contextId);
            },
            closeGrant: async () => {},
        },
    });
    const detachBrowser = appBrowser.attach();
    for (const item of browseToolsWith(
        {
            actors: platform.actors,
            broker: appBrowser,
            conversation: async () => 'private',
            target: () => ({ origin: 'http://apps.localhost' }),
            screenshots: platform.apps.screenshots,
        },
        turn,
    )) {
        tools.set(item.name, item as unknown as { execute: (input: unknown) => Promise<Result> });
    }
    names.push(...tools.keys());
    registered.push(...tools.keys());
    const tool = (name: string) => (input: unknown) => {
        const found = tools.get(name);
        if (!found) {
            throw new Error(`No tool ${name}`);
        }
        return found.execute(input);
    };

    // The connected agents' board tools (CB-90), through the real MCP server.
    const actor: AgentActor = {
        grantId: 'g-alice',
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        clientName: 'Claude Code',
        clientDomain: 'claude.ai',
        label: 'Claude Code in the sweep',
        userId: 'alice',
        scopes: ['issues:read', 'issues:write', 'pages:read'],
    };
    const server = agentMcpServer({
        workspace,
        board: platform.board,
        actor,
        person: USERS[0]!,
        origin: 'http://localhost',
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'sweep', version: '0.1.0' });
    await client.connect(clientSide);
    const mcp = (name: string) => async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: args });
        return result.isError
            ? {
                  error: (result.content as Array<{ text: string }>)[0]?.text ?? '',
              }
            : (result.structuredContent as Result);
    };

    cleanup = async () => {
        detachBrowser();
        await client.close();
        await dispose();
        await supervisor.close();
        connection.close();
        rmSync(dir, { recursive: true, force: true });
    };

    let n = 0;
    const count = (sql: string, ...params: Array<string | number>) =>
        Number(Object.values(connection.prepare(sql).get(...params) as Record<string, number>)[0]);
    const issue = async () => `CB-${(await platform.board.issues.create({ title: `Seed ${++n}` }, 'alice')).number}`;
    const page = async () => workspace.pages.create(home.id, { title: `Page ${++n}`, content: 'One' });

    board = [
        {
            name: 'file_improvement',
            run: () =>
                tool('file_improvement')({
                    title: `A socio filing ${++n}`,
                    kind: 'bug',
                    problem: 'Something broke.',
                    fileAnyway: true,
                }),
            probe: () => count('SELECT count(*) FROM issues'),
        },
        {
            name: 'subscribe_to_issues',
            run: async () => {
                const result = await tool('subscribe_to_issues')({
                    issues: [await issue()],
                });
                const id = (result!.watch as { id: string }).id;
                await tool('cancel_issue_subscription')({ subscription: id });
                return result;
            },
            probe: () => count('SELECT count(*) FROM issue_watches'),
        },
        {
            name: 'cancel_issue_subscription',
            run: async () => {
                const result = await platform.board.watches.create(
                    'alice',
                    { issues: [await issue()] },
                    {
                        sourceKind: 'person',
                        sourceId: 'alice',
                        threadId: null,
                        causeId: null,
                    },
                );
                return tool('cancel_issue_subscription')({
                    subscription: result.watch.id,
                });
            },
            probe: () => count("SELECT count(*) FROM issue_watches WHERE state='cancelled'"),
        },
        {
            name: 'subscribe_to_issues (agent)',
            run: async () => {
                const result = await mcp('subscribe_to_issues')({
                    issues: [await issue()],
                });
                const id = (result!.watch as { id: string }).id;
                await mcp('cancel_issue_subscription')({ subscription: id });
                return result;
            },
            probe: () => count('SELECT count(*) FROM issue_watches'),
        },
        {
            name: 'cancel_issue_subscription (agent)',
            run: async () => {
                const result = await platform.board.watches.create(
                    'alice',
                    { issues: [await issue()] },
                    {
                        sourceKind: 'person',
                        sourceId: 'alice',
                        threadId: null,
                        causeId: null,
                    },
                );
                return mcp('cancel_issue_subscription')({
                    subscription: result.watch.id,
                });
            },
            probe: () => count("SELECT count(*) FROM issue_watches WHERE state='cancelled'"),
        },
        {
            name: 'comment_on_improvement',
            run: async () =>
                tool('comment_on_improvement')({
                    issue: await issue(),
                    comment: 'More evidence.',
                }),
            probe: () => count("SELECT count(*) FROM issue_comments WHERE authorKind='agent'"),
        },
        {
            name: 'vote_improvement',
            run: async () => tool('vote_improvement')({ issue: await issue() }),
            probe: () => count('SELECT count(*) FROM issue_votes'),
        },
        {
            name: 'edit_improvement',
            run: async () =>
                tool('edit_improvement')({
                    issue: await issue(),
                    title: `Edited title ${++n}`,
                }),
            probe: () => count('SELECT count(*) FROM issue_events'),
        },
        {
            name: 'set_improvement_status',
            run: async () => tool('set_improvement_status')({ issue: await issue(), status: 'open' }),
            probe: () => count("SELECT count(*) FROM issue_events WHERE kind='status'"),
        },
        {
            name: 'request_capability',
            run: () =>
                tool('request_capability')({
                    capability: `Capability ${++n}`,
                    why: 'The person needs it.',
                    example: 'Like this.',
                }),
            probe: () => count('SELECT count(*) FROM dot_request_requesters'),
        },
        {
            name: 'file_issue (agent)',
            run: () =>
                mcp('file_issue')({
                    title: `An agent filing ${++n}`,
                    kind: 'bug',
                    description: 'Something broke.',
                    force: true,
                }),
            probe: () => count('SELECT count(*) FROM issues'),
        },
        {
            name: 'comment_on_issue (agent)',
            run: async () => mcp('comment_on_issue')({ issue: await issue(), comment: 'Seen it.' }),
            probe: () => count('SELECT count(*) FROM issue_agent_actions WHERE action=?', 'comment'),
        },
        {
            name: 'vote_on_issue (agent)',
            run: async () => mcp('vote_on_issue')({ issue: await issue() }),
            probe: () => count('SELECT count(*) FROM issue_votes'),
        },
        {
            name: 'update_issue (agent)',
            run: async () => mcp('update_issue')({ issue: await issue(), priority: 'high' }),
            probe: () => count("SELECT count(*) FROM issues WHERE priority='high'"),
        },
        {
            // Assigning a deactivated person fails inside the issue's unit of
            // work, after it opened: it rolls back.
            name: 'update_issue that throws (agent)',
            run: async () => mcp('update_issue')({ issue: await issue(), assignee: 'carol' }),
            probe: () => count("SELECT count(*) FROM issues WHERE assigneeId='carol'"),
            wrote: (before, after) => after === before,
            fails: true,
        },
        {
            // Not a tool: a Board unit that stays open across many microtask
            // hops before it throws, so whatever wrote into it would be rolled
            // back with it, wherever the other tool's write lands.
            name: 'a Board unit held open, then thrown (synthetic)',
            run: () =>
                workspace.data.uow.run(
                    async () => {
                        await platform.board.issues.create({ title: `Held ${++n}` }, 'alice');
                        await hops(400);
                        throw new Error('The Board unit fails.');
                    },
                    { label: 'held board unit' },
                ),
            probe: () => count("SELECT count(*) FROM issues WHERE title LIKE 'Held %'"),
            wrote: (before, after) => after === before,
            fails: true,
        },
    ];

    // Every Board writer has its test (below).
    expect(board.map(({ name }) => name)).toEqual(BOARD);

    // Seeds the other tools act on.
    const files = tool('files_put');
    await files({ path: 'seed.txt', content: 'Seed' });
    await tool('data_create_table')({
        table: 'base',
        columns: [{ name: 'v', type: 'INTEGER' }],
    });
    await tool('data_create_table')({
        table: 'keyed',
        columns: [
            { name: 'k', type: 'INTEGER', primaryKey: true },
            { name: 'v', type: 'INTEGER' },
        ],
    });
    const query = async (sql: string) => {
        const result = (await tool('data_query')({ sql })) as {
            columns?: string[];
            rows?: unknown[];
        };
        const row = result.rows?.[0];
        if (row === undefined) {
            throw new Error(`data_query: ${JSON.stringify(result)}`);
        }
        return Array.isArray(row) ? Number(row[0]) : Number(Object.values(row as object)[0]);
    };
    const edited = await page();
    const moving = await page();
    await tool('schedule_create')({
        title: 'Seed schedule',
        cadence: 'every day at 09:00',
        action: { kind: 'turn', prompt: 'Do the seed thing.' },
    });
    const scheduleId = (await store.allTasks()).find((task) => task.title === 'Seed schedule')!.id;
    const goal = (await tool('goal_set')({
        title: 'Seed goal for the sweep',
        detail: 'Keep going.',
        cadence: 'every day at 10:00',
    })) as Record<string, unknown>;
    let goalId = (await platform.goals.list('alice', dot.id))[0]?.id;
    if (!goalId) {
        throw new Error(`No goal: ${JSON.stringify(goal)}`);
    }
    /** A goal keeps 50 comments: a fresh one before it is full. */
    const roomyGoal = async () => {
        if ((await platform.goals.get('alice', goalId!))!.comments.length < 45) {
            return;
        }
        const title = `Goal with room ${++n}`;
        await tool('goal_set')({
            title,
            detail: 'Keep going.',
            cadence: 'every day at 10:00',
            force: true,
        });
        goalId = (await platform.goals.list('alice', dot.id)).find((goal) => goal.title === title)!.id;
    };
    const index = (workspace.pages as unknown as { index: PageSearch }).index;

    // Pages made before the loop, one per run, for the tools that need one
    // of their own (a read counts once per page and day). A test runs a
    // writer at most twice per offset (the production test: both throwing
    // Board writers beside it).
    const pool = async (size: number) => {
        const made: string[] = [];
        for (let i = 0; i < size; i++) {
            made.push((await page()).id);
        }
        return made;
    };
    const next = (ids: string[]) => {
        const id = ids.pop();
        if (!id) {
            throw new Error('The page pool ran out.');
        }
        return id;
    };
    const runs = 2 * (OFFSETS.length + 1);
    const toRead = await pool(runs);
    const toView = await pool(runs);
    // CB-524: a page of its own per run, so each upload is new there.
    const toUpload = await pool(runs);
    await files({ path: 'seed.png', content: PNG.toString('base64'), encoding: 'base64' });
    // Pending attachments, for the runs that bind them (uploads are rate
    // limited per minute: the clock moves on while they are made).
    const pending: string[] = [];
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    for (let i = 0; i < runs; i++) {
        clock.mockReturnValue(start + i * 2_000);
        const uploaded = await platform.media.upload('alice', {
            name: `pending-${i}.txt`,
            bytes: Buffer.from('Attached'),
            purpose: 'attachment',
        });
        pending.push(uploaded.attachment!.id);
    }
    clock.mockRestore();
    const mediaTurn = { userId: 'alice', dotId: dot.id, threadId: thread.id };
    const steering = steeringQueue(workspace.db);
    const elsewhere = workspace.bindThread('sweep-2', dot.id, 'Chat', 'alice');
    // A push subscription, so a notification for someone away goes out (to
    // the fetch mock, which refuses it) and keeps its image.
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    // Again before each run: a failed push drops the subscription.
    const subscribe = () =>
        platform.notifications.push.subscribe('alice', {
            endpoint: 'https://push.invalid/sweep',
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
            device: 'Sweep browser',
        });
    vi.spyOn(WebReads.prototype, 'read').mockResolvedValue({
        ok: true,
        status: 200,
        url: 'https://images.example/chart.png',
        contentType: 'image/png',
        headers: {},
        body: PNG,
        bytes: PNG.length,
        complete: true,
    } as never);

    // Delegated app access (CB-232): promoted apps a fake audience policy calls
    // delegable (what the internal apps listener answers from the manifest),
    // Alice's read opt-in so each request grants at once, and grants to end:
    // one app and one grant per run. Mini apps count as on for these tools only
    // (the tool list above was built without them).
    const delegable: string[] = [];
    const created = Date.now();
    for (let i = 0; i < 200; i++) {
        const id = `sweepapp${i}`;
        connection
            .prepare(
                "INSERT INTO apps(id, slug, name, dotId, ownerUserId, port, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'alice', 3000, 'promoted', ?, ?)",
            )
            .run(id, id, `Sweep app ${i}`, dot.id, created, created);
        delegable.push(id);
    }
    const lookup = platform.actors.audiences.for.bind(platform.actors.audiences);
    vi.spyOn(platform.actors.audiences, 'for').mockImplementation((audience) =>
        audience.startsWith('app:sweepapp') ? { policyVersion: () => 'v1', personMay: () => true } : lookup(audience),
    );
    vi.spyOn(platform.apps, 'enabled', 'get').mockReturnValue(true);
    vi.spyOn(platform.apps, 'url').mockReturnValue('http://apps.localhost');
    await platform.approvals.setPolicy('alice', dot.id, 'app_access_read', 'bypass');
    const toEnd: string[] = [];
    for (let i = 0; i < 200; i++) {
        toEnd.push(
            (
                await platform.actors.grants.create({
                    personId: 'alice',
                    socioId: dot.id,
                    audiences: ['app:ended'],
                    scopes: ['app:read'],
                    conversationId: thread.id,
                    conversationKind: 'private',
                    task: 'Sweep',
                    policyVersion: 'v1',
                    approvedBy: 'alice',
                    correlationId: `sweep-${i}`,
                })
            ).id,
        );
    }

    // Grants the app_* tools open a context for, one per run.
    const toOpen: string[] = [];
    for (let i = 0; i < runs; i++) {
        toOpen.push(
            (
                await platform.actors.grants.create({
                    personId: 'alice',
                    socioId: dot.id,
                    audiences: [`app:${delegable[i]}`],
                    scopes: ['app:read'],
                    conversationId: thread.id,
                    conversationKind: 'private',
                    task: 'Sweep',
                    policyVersion: 'v1',
                    approvedBy: 'alice',
                    correlationId: `sweep-open-${i}`,
                })
            ).id,
        );
    }

    others = [
        {
            // A coding session (CB-239): asked for, approved
            // on the person's click (its session, grant and sandbox, and the
            // setup run), one prompt as a durable run, then stopped.
            name: 'coding_start / coding_prompt / coding_stop',
            run: async () => {
                const asked = await tool('coding_start')({
                    repository: REPO,
                    task: 'Work beside a Board write',
                    push: true,
                });
                if (asked?.status !== 'pending_approval') {
                    return { error: `coding_start: ${JSON.stringify(asked)}` };
                }
                const decided = await platform.approvals.decide((asked.approval as { id: string }).id, 'alice', true);
                if (decided.status !== 'approved') {
                    return { error: `approval: ${decided.status} ${decided.outcome}` };
                }
                const prompted = await tool('coding_prompt')({ message: 'Work' });
                if (prompted?.status !== 'done') {
                    return { error: `coding_prompt: ${JSON.stringify(prompted)}` };
                }
                const stopped = await tool('coding_stop')({});
                return stopped?.status === 'ended' ? stopped : { error: `coding_stop: ${JSON.stringify(stopped)}` };
            },
            probe: () => count("SELECT count(*) FROM coding_sessions WHERE endReason='stopped'"),
        },
        {
            // A context opened (its row, credential and audit) and closed.
            name: 'app_open / app_close',
            run: async () => {
                const grant = next(toOpen);
                const opened = await tool('app_open')({ grant });
                if (opened?.error) {
                    return opened;
                }
                const closed = await tool('app_close')({ grant });
                return closed?.error ? closed : opened;
            },
            probe: () => count("SELECT count(*) FROM actor_contexts WHERE closeReason='closed_by_socio'"),
        },
        {
            name: 'request_app_access',
            run: () =>
                tool('request_app_access')({
                    app: next(delegable),
                    task: 'Read it beside a Board write',
                }),
            probe: () => count('SELECT count(*) FROM socio_grants'),
        },
        {
            name: 'end_app_access',
            run: () => tool('end_app_access')({ grant: next(toEnd) }),
            probe: () => count('SELECT count(*) FROM socio_grants WHERE revokedAt IS NOT NULL'),
        },
        {
            name: 'create_space_page',
            run: () => tool('create_space_page')({ title: `New ${++n}`, content: 'Text' }),
            probe: () => count('SELECT count(*) FROM pages'),
        },
        {
            name: 'edit_space_page',
            run: () =>
                tool('edit_space_page')({
                    id: edited.id,
                    content: `Edit ${++n}`,
                    expectedRevision: workspace.pages.get(home.id, edited.id).revision,
                }),
            probe: () => workspace.pages.get(home.id, edited.id).content,
        },
        {
            name: 'move_space_page',
            run: () => {
                const at = workspace.pages.list(home.id).some((p) => p.id === moving.id) ? home.id : away.id;
                return tool('move_space_page')({
                    id: moving.id,
                    spaceId: at,
                    toSpaceId: at === home.id ? away.id : home.id,
                });
            },
            probe: () => count('SELECT spaceId = ? AS home FROM pages WHERE id=?', home.id, moving.id),
        },
        {
            name: 'read_space_page',
            // Once per person, page and day: a page of its own each time, made
            // before the run so the tool's first step is its read.
            run: () => tool('read_space_page')({ id: next(toRead) }),
            probe: () => count('SELECT count(*) FROM page_use_days'),
        },
        {
            name: 'search_space_pages',
            run: () => {
                // The stats are written at most once a minute: due now.
                (index as unknown as { flushedAt: number }).flushedAt = 0;
                return tool('search_space_pages')({ query: 'Page' });
            },
            probe: () => {
                index.flush();
                return count('SELECT COALESCE(SUM(queries), 0) FROM page_search_daily');
            },
        },
        {
            name: 'propose_memory',
            run: () => tool('propose_memory')({ text: `Likes the number ${++n}.` }),
            probe: () => {
                // At most 50 proposals wait for the person: they approve them.
                connection.prepare("UPDATE memories SET status='active' WHERE status='proposed'").run();
                return count('SELECT count(*) FROM memories');
            },
        },
        {
            // CB-181: a proposal for the Space's editors.
            name: 'propose_space_memory',
            run: () =>
                tool('propose_space_memory')({
                    space: home.id,
                    text: `Invoices go out on day ${++n}.`,
                }),
            probe: () => {
                // At most 100 wait in a Space: an editor approves them.
                connection.prepare("UPDATE space_memories SET status='active' WHERE status='proposed'").run();
                return count('SELECT count(*) FROM space_memories');
            },
        },
        {
            name: 'data_create_dataset',
            run: () =>
                tool('data_create_dataset')({
                    name: `Dataset ${++n}`,
                    description: '',
                }),
            probe: () => count('SELECT count(*) FROM data_datasets'),
        },
        {
            name: 'data_create_table',
            run: () =>
                tool('data_create_table')({
                    table: `t${++n}`,
                    columns: [{ name: 'v' }],
                }),
            probe: async () => JSON.stringify(await tool('data_describe')({})),
        },
        {
            name: 'data_add_column',
            run: () => tool('data_add_column')({ table: 'base', column: { name: `c${++n}` } }),
            probe: async () => JSON.stringify(await tool('data_describe')({})),
        },
        {
            name: 'data_create_index',
            // Same definition each run: the first creates it, the rest are
            // quiet. Each run is audited (the write the sweep watches).
            run: () =>
                tool('data_create_index')({ table: 'base', name: 'base_by_v', columns: ['v'], ifNotExists: true }),
            probe: () => count("SELECT count(*) FROM data_audit WHERE action='create_index' AND outcome='ok'"),
        },
        {
            name: 'data_drop_index',
            run: async () => {
                await tool('data_create_index')({
                    table: 'keyed',
                    name: 'keyed_by_v',
                    columns: ['v'],
                    ifNotExists: true,
                });
                return tool('data_drop_index')({ table: 'keyed', name: 'keyed_by_v' });
            },
            probe: () => count("SELECT count(*) FROM data_audit WHERE action='drop_index' AND outcome='ok'"),
        },
        {
            name: 'data_analyze',
            run: () => tool('data_analyze')({ table: 'base' }),
            probe: () => count("SELECT count(*) FROM data_audit WHERE action='analyze' AND outcome='ok'"),
        },
        {
            name: 'data_insert',
            run: () => tool('data_insert')({ table: 'base', rows: [{ v: ++n }] }),
            probe: async () => await query('SELECT count(*) AS n FROM base'),
        },
        {
            name: 'data_upsert',
            run: () =>
                tool('data_upsert')({
                    table: 'keyed',
                    rows: [{ k: ++n, v: n }],
                    key: ['k'],
                }),
            probe: async () => await query('SELECT count(*) AS n FROM keyed'),
        },
        {
            name: 'data_request_access',
            run: () =>
                tool('data_request_access')({
                    folder: `shared-${++n}`,
                    access: 'read',
                    reason: 'To read the reports.',
                }),
            probe: async () => {
                await policy(APPROVAL_CAPABILITIES.grantChange, 'bypass');
                return count('SELECT count(*) FROM approval_requests');
            },
        },
        {
            // Auto policy: a rule sends write access to a folder to the person,
            // decided before any model call; the review is recorded.
            name: 'data_request_access (auto policy, a rule decides)',
            run: () =>
                tool('data_request_access')({
                    folder: `private-${++n}`,
                    access: 'write',
                    reason: 'To file the reports.',
                }),
            probe: async () => {
                await policy(APPROVAL_CAPABILITIES.grantChange, 'auto');
                return count('SELECT count(*) FROM approval_auto_decisions');
            },
        },
        {
            // Auto policy with no model to ask: escalated, and recorded.
            name: 'schedule_create (auto policy, no model)',
            run: () =>
                tool('schedule_create')({
                    title: `Auto schedule ${++n}`,
                    cadence: 'every day at 09:00',
                    action: { kind: 'turn', prompt: 'Do the regular thing.' },
                }),
            probe: async () => {
                await policy(APPROVAL_CAPABILITIES.scheduleCreate, 'auto');
                return count('SELECT count(*) FROM approval_auto_decisions');
            },
        },
        {
            // Listing approvals expires the overdue ones first (CB-110: one unit
            // of work behind the Board's, which the turns carry on after).
            name: 'capabilities (expires an overdue approval)',
            run: () => tool('capabilities')({}),
            probe: () => {
                // A pending request past its expiry, before each run.
                connection
                    .prepare(
                        "INSERT INTO approval_requests (id, userId, dotId, capability, summary, payload, status, createdAt, expiresAt) VALUES (?, 'alice', ?, 'schedule.create', 'Overdue', 'null', 'pending', 1, 2)",
                    )
                    .run(`overdue-${++n}`, dot.id);
                return count("SELECT count(*) FROM approval_requests WHERE status='expired'");
            },
        },
        {
            name: 'save_workspace_skill',
            run: () =>
                tool('save_workspace_skill')({
                    name: `sweep-skill-${++n}`,
                    description: 'A workspace skill saved alongside a Board write.',
                    instructions: 'Use only when explicitly invoked.',
                    mode: 'turn',
                }),
            probe: () => count('SELECT count(*) FROM chat_skill_revisions'),
        },
        {
            name: 'apply_workspace_skill_import',
            run: async () => {
                const result = await tool('preview_workspace_skill_import')({
                    url: 'https://github.com/example/sweep-skills',
                    ref: `sweep-${++n}`,
                    path: 'SKILL.md',
                });
                const preview = result?.preview as SkillImportPreview | undefined;
                if (!preview) {
                    throw Error(`No import preview: ${JSON.stringify(result)}`);
                }
                return tool('apply_workspace_skill_import')({
                    previewId: preview.id,
                    sha256: preview.source.sha256,
                });
            },
            // Each fresh source creates an actual attributed immutable revision.
            // Count persisted imported revisions after successful AND throwing
            // Board units, rather than treating apply as a preview/read operation.
            probe: () => count("SELECT count(*) FROM chat_skill_revisions WHERE source='git'"),
        },
        {
            name: 'end_skill',
            run: () => tool('end_skill')({}),
            probe: async () => {
                // A chat skill on in the conversation, before each run.
                const sessions = skillSessions(connection);
                if (!(await sessions.active(thread.id, 'alice'))) {
                    await sessions.start(thread.id, 'sweep-skill', 'alice');
                }
                return count("SELECT count(*) FROM chat_skill_sessions WHERE endReason='model'");
            },
        },
        {
            name: 'files_put',
            run: () => files({ path: `notes/${++n}.txt`, content: 'Note' }),
            probe: async () => JSON.stringify(await tool('files_list')({})),
        },
        {
            name: 'files_copy',
            run: () => tool('files_copy')({ from: 'seed.txt', to: `copies/${++n}.txt` }),
            probe: async () => JSON.stringify(await tool('files_list')({})),
        },
        {
            name: 'insert_dataset_view',
            run: () =>
                tool('insert_dataset_view')({
                    pageId: next(toView),
                    query: 'SELECT v FROM base',
                    display: 'table',
                }),
            probe: () => count("SELECT count(*) FROM pages WHERE content LIKE '%dataset-view%'"),
        },
        {
            // CB-230: a new page, a copy in Files and its media_embeds row, all
            // beside a Board unit (the web reads answer the PNG above).
            name: 'unfurl_link',
            run: () => tool('unfurl_link')({ url: `https://images.example/chart-${++n}.png` }),
            probe: () => count('SELECT count(*) FROM media_embeds'),
        },
        {
            // CB-524: a copy in Files, its media_embeds row and the bypassed
            // approval's rows, beside a Board unit.
            name: 'space_media_upload',
            run: () =>
                tool('space_media_upload')({ spaceId: home.id, pageId: next(toUpload), files: [{ path: 'seed.png' }] }),
            probe: () => count("SELECT count(*) FROM media_embeds WHERE origin='upload'"),
        },
        {
            // CB-271: a request on the person's card, its audit row beside a
            // Board unit; the Space is made only once they approve it.
            name: 'create_space',
            run: () => tool('create_space')({ name: `Space ${++n}` }),
            probe: () =>
                count('SELECT count(*) FROM approval_requests WHERE capability=?', APPROVAL_CAPABILITIES.spaceCreate),
        },
        {
            // CB-366: the Space's row renamed, its audit row beside it.
            name: 'rename_space',
            run: () => tool('rename_space')({ spaceId: away.id, name: `Away ${++n}` }),
            probe: () => count("SELECT count(*) FROM workspace_audit WHERE targetKind='space' AND action='update'"),
        },
        {
            name: 'schedule_create',
            run: () =>
                tool('schedule_create')({
                    title: `Schedule ${++n}`,
                    cadence: 'every day at 09:00',
                    action: { kind: 'turn', prompt: 'Do the regular thing.' },
                }),
            probe: async () => {
                await policy(APPROVAL_CAPABILITIES.scheduleCreate, 'bypass');
                return count('SELECT count(*) FROM tasks');
            },
        },
        {
            name: 'schedule_pause / schedule_resume',
            run: () => {
                const paused = count('SELECT status = ? FROM tasks WHERE id=?', 'paused', scheduleId);
                return tool(paused ? 'schedule_resume' : 'schedule_pause')({
                    scheduleId,
                });
            },
            probe: () => count('SELECT status = ? FROM tasks WHERE id=?', 'paused', scheduleId),
        },
        {
            name: 'goal_set',
            run: () =>
                tool('goal_set')({
                    title: `Goal number ${++n}`,
                    detail: 'Work on it.',
                    cadence: 'every day at 11:00',
                    force: true,
                }),
            probe: () => count('SELECT count(*) FROM goals'),
        },
        {
            name: 'goal_comment',
            run: () => tool('goal_comment')({ goalId, comment: `Progress ${++n}.` }),
            probe: async () => {
                await roomyGoal();
                return count('SELECT count(*) FROM goal_comments');
            },
        },
        {
            name: 'goal_update',
            run: () => tool('goal_update')({ goalId, progress: `Step ${++n}.` }),
            probe: async () => JSON.stringify(await platform.goals.get('alice', goalId)),
        },
        {
            name: 'notify_user (away)',
            run: () => tool('notify_user')({ message: `Ping ${++n}.` }),
            probe: () => {
                platform.notifications.presence.away('alice', 'tab-1');
                return count('SELECT count(*) FROM notifications');
            },
        },
        {
            // The common case: the person is elsewhere in Socio.
            name: 'notify_user (in the app)',
            run: () => tool('notify_user')({ message: `Ping ${++n}.` }),
            probe: () => {
                platform.notifications.presence.tab('alice', 'tab-1', '/issues');
                return count('SELECT count(*) FROM notification_in_app');
            },
        },
        {
            // Away, with a channel that shows messages: the image is kept.
            name: 'notify_user (with an image)',
            run: () =>
                tool('notify_user')({
                    message: `Chart ${++n}.`,
                    image: 'https://images.example/chart.png',
                }),
            probe: async () => {
                platform.notifications.presence.away('alice', 'tab-1');
                await subscribe();
                return count('SELECT count(*) FROM notification_images');
            },
        },
        {
            // A computer's screenshot, stored as the conversation's attachment
            // (CB-157); the computer tools need a computer, so its store runs here.
            name: 'computer_screenshot (its image stored, synthetic)',
            run: async () => ({
                ...(await platform.media.saveToolImage(mediaTurn, {
                    name: `screenshot-${++n}.png`,
                    bytes: PNG,
                })),
            }),
            probe: () => count("SELECT count(*) FROM media_attachments WHERE source='tool'"),
        },
        {
            // A run's new message binds its attachments as the run is accepted
            // (CB-54), beside the step's tool calls.
            name: 'attachments bound for a new message (synthetic)',
            run: async () => {
                const id = next(pending);
                await platform.media.bindNew(
                    mediaTurn,
                    [
                        {
                            id: `message-${++n}`,
                            role: 'user',
                            content: [{ type: 'binary', id, mimeType: 'text/plain' }],
                        },
                    ],
                    new Set(),
                );
                return {};
            },
            probe: () => count("SELECT count(*) FROM media_attachments WHERE source='web' AND boundAt IS NOT NULL"),
        },
        {
            // The person queues a message, with a file, while the step's tool
            // calls run (CB-151, CB-223): the steering route's write.
            name: 'steering message queued (synthetic)',
            run: async () => {
                const queued = await steering.addIfRoom(
                    thread.id,
                    'alice',
                    `Also this ${++n}.`,
                    1_000_000,
                    Date.now(),
                    [
                        {
                            id: 'cbatt_AAAAAAAAAAAAAAAAAAAAAA',
                            name: 'shot.png',
                            mediaType: 'image/png',
                            size: 4,
                            kind: 'image',
                        },
                    ],
                );
                return queued ? {} : { error: 'not queued' };
            },
            probe: () => count('SELECT count(*) FROM chat_steering'),
        },
        {
            // The next round takes what waits as text (CB-151, CB-223): two
            // queued in another chat, both taken, none left or lost.
            name: 'steering messages taken by the next round (synthetic)',
            run: async () => {
                await steering.add(elsewhere.id, 'alice', `First ${++n}.`);
                await steering.add(elsewhere.id, 'alice', `Second ${n}.`);
                const taken = await steering.takeText(elsewhere.id, 'alice');
                return { taken: taken.length };
            },
            probe: () => count('SELECT count(*) FROM chat_steering WHERE threadId=?', elsewhere.id),
            wrote: (before, after, result) => before === 0 && after === 0 && result?.taken === 2,
        },
        {
            // A promoted app's attempts copied from the runtime (CB-146, CB-110),
            // as the apps tick does beside a step's tool calls.
            name: 'app attempts synced from the runtime (synthetic)',
            run: async () => {
                const at = ++n;
                await platform.apps.promotions.attempts.sync(`sweep-app-${at}`, 'boot', [
                    {
                        id: `boot:${at}`,
                        version: 1,
                        kind: 'start',
                        state: 'failed',
                        startedAt: at,
                        upAt: null,
                        endedAt: at,
                        exit: {
                            reason: 'exit',
                            code: 1,
                            signal: null,
                            message: 'Ended.',
                        },
                        lines: ['ended'],
                        dropped: 0,
                    },
                ]);
                return {};
            },
            probe: () => count('SELECT count(*) FROM app_attempts'),
        },
    ];
    skipped.push(
        ['http_get, http_json', 'they fetch outside URLs'],
        ['schedule_cancel', 'covered by schedule_pause / resume (the same act path)'],
        ['job_save, job_run and the other job tools', 'they need a computer (outside service)'],
        ['app_* tools', 'they need the apps runtime (outside service)'],
        [
            'read-only tools',
            'list/describe/query/files_get/attachments/recall: their only writes are data audit rows, which go through writeSoon as the swept data tools’ do (read_space_page and search_space_pages are swept for their stats)',
        ],
    );
}

beforeEach(setup, 60_000);
afterEach(async () => {
    const done = cleanup;
    cleanup = undefined;
    await done?.();
    vi.restoreAllMocks();
});

const hops = async (n: number) => {
    for (let i = 0; i < n; i++) {
        await Promise.resolve();
    }
};

async function pair(first: Writer, second: Writer, offset: (typeof OFFSETS)[number]) {
    const { uow } = sqliteData(connection);
    const before = [await first.probe(), await second.probe()];
    let overlapped = false;
    const calls = [
        () => first.run(),
        async () => {
            if (offset === 'open') {
                for (let i = 0; i < 5000 && !uow.foreignUnit; i++) {
                    await Promise.resolve();
                }
            } else {
                await hops(offset);
            }
            overlapped = !!uow.foreignUnit;
            return second.run();
        },
    ];
    // One synchronous loop starts both, as a model step does.
    const settled = await Promise.allSettled(calls.map((call) => call()));
    // Work a tool deferred until the unit ended (page use counts).
    await new Promise((resolve) => setImmediate(resolve));
    const after = [await first.probe(), await second.probe()];
    const problems: string[] = [];
    [first, second].forEach((writer, i) => {
        const outcome = settled[i]!;
        const result = outcome.status === 'fulfilled' ? outcome.value : undefined;
        const failed =
            outcome.status === 'rejected' ||
            (!!result && typeof result === 'object' && typeof result.error === 'string' && result.error.length > 0);
        if (failed !== !!writer.fails) {
            problems.push(
                `${writer.name} ${failed ? 'failed' : 'did not fail'}: ${
                    outcome.status === 'rejected' ? String(outcome.reason) : JSON.stringify(result)?.slice(0, 300)
                }`,
            );
        }
        const wrote = (writer.wrote ?? ((b, a) => a !== b))(before[i], after[i], result);
        if (!wrote) {
            problems.push(`${writer.name}: its write is missing (${String(before[i])} → ${String(after[i])})`);
        }
    });
    return { problems, overlapped };
}

for (const name of BOARD) {
    it(`runs ${name} beside every other socio tool that writes, in one step, at every offset, and the other way round`, async () => {
        const first = board.find((writer) => writer.name === name)!;
        const problems: string[] = [];
        const overlaps = new Map<string, number>();
        let runs = 0;
        for (const second of others) {
            for (const offset of OFFSETS) {
                const key = `${first.name} × ${second.name}`;
                const outcome = await pair(first, second, offset);
                runs++;
                if (outcome.overlapped) {
                    overlaps.set(key, (overlaps.get(key) ?? 0) + 1);
                }
                problems.push(...outcome.problems.map((line) => `${key} @${offset}: ${line}`));
            }
        }
        // And the other way round: the other tool first, the Board write at once.
        for (const second of others) {
            const outcome = await pair(second, first, 0);
            runs++;
            problems.push(...outcome.problems.map((line) => `${second.name} × ${first.name} (reversed): ${line}`));
        }
        expect(problems).toEqual([]);
        // Each pair really ran the other tool inside an open Board unit.
        const never = others.map((second) => `${first.name} × ${second.name}`).filter((key) => !overlaps.get(key));
        expect(never).toEqual([]);
        expect(runs).toBe(others.length * (OFFSETS.length + 1));
    });
}

it('loses no write in production either, where an outside write would join a unit and roll back with it', async () => {
    // Production mode: the guard lets an outside write join the open unit
    // (and reports it if the unit rolls back). With every tool's writes
    // queued, none joins, so none is lost when the Board unit throws.
    const strict = process.env.VITEST;
    process.env.VITEST = 'false';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const throwing = board.filter((writer) => writer.fails);
        expect(throwing).toHaveLength(2);
        const problems: string[] = [];
        for (const first of throwing) {
            for (const second of others) {
                for (const offset of OFFSETS) {
                    problems.push(
                        ...(await pair(first, second, offset)).problems.map(
                            (line) => `${first.name} × ${second.name} @${offset}: ${line}`,
                        ),
                    );
                }
            }
        }
        expect(problems).toEqual([]);
        expect(errors.mock.calls.filter(([line]) => String(line).startsWith('Data loss'))).toEqual([]);
    } finally {
        process.env.VITEST = strict;
        errors.mockRestore();
    }
});

/**
 * Board write A, then the tool, then Board write B, which opens after the
 * tool's first write has queued behind A, and throws: the tool's later
 * writes (an approved action's, after its awaited request) must not land
 * inside B and roll back with it.
 */
async function triple(tool: Writer) {
    const { uow } = sqliteData(connection);
    const a = board.find((writer) => writer.name === 'file_improvement')!;
    const b = board.find((writer) => writer.name.startsWith('a Board unit held'))!;
    const before = [await a.probe(), await tool.probe(), await b.probe()];
    let queued = false;
    const calls = [
        () => a.run(),
        async () => {
            for (let i = 0; i < 5000 && !uow.foreignUnit; i++) {
                await Promise.resolve();
            }
            return tool.run();
        },
        async () => {
            for (let i = 0; i < 5000 && !uow.waiting; i++) {
                await Promise.resolve();
            }
            queued = uow.waiting > 0;
            return b.run();
        },
    ];
    const settled = await Promise.allSettled(calls.map((call) => call()));
    await new Promise((resolve) => setImmediate(resolve));
    const after = [await a.probe(), await tool.probe(), await b.probe()];
    const problems: string[] = [];
    [a, tool, b].forEach((writer, i) => {
        const outcome = settled[i]!;
        const result = outcome.status === 'fulfilled' ? outcome.value : undefined;
        const failed =
            outcome.status === 'rejected' ||
            (!!result && typeof result === 'object' && typeof result.error === 'string' && result.error.length > 0);
        if (failed !== !!writer.fails) {
            problems.push(
                `${writer.name} ${failed ? 'failed' : 'did not fail'}: ${
                    outcome.status === 'rejected' ? String(outcome.reason) : JSON.stringify(result)?.slice(0, 300)
                }`,
            );
        }
        if (!(writer.wrote ?? ((x, y) => x !== y))(before[i], after[i], result)) {
            problems.push(`${writer.name}: its write is missing (${String(before[i])} → ${String(after[i])})`);
        }
    });
    return { problems, queued };
}

it('keeps a tool’s writes out of a Board unit that opens behind them and throws, in tests and in production', async () => {
    const problems: string[] = [];
    let queuedRuns = 0;
    const strict = process.env.VITEST;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        for (const mode of ['true', 'false']) {
            process.env.VITEST = mode;
            for (const tool of others) {
                const outcome = await triple(tool);
                if (outcome.queued) {
                    queuedRuns++;
                }
                problems.push(
                    ...outcome.problems.map(
                        (line) => `A × ${tool.name} × B (${mode === 'true' ? 'tests' : 'production'}): ${line}`,
                    ),
                );
            }
        }
        expect(problems).toEqual([]);
        expect(errors.mock.calls.filter(([line]) => String(line).startsWith('Data loss'))).toEqual([]);
    } finally {
        process.env.VITEST = strict;
        errors.mockRestore();
    }
    // B really opened behind a queued write in most runs.
    expect(queuedRuns).toBeGreaterThan(others.length);
});

/**
 * Registered socio tools the sweep doesn't run as writers, and why. A new
 * socio tool fails the next test until it gets a writer above (if it
 * writes) or an entry here (CB-110, docs/DATA-LAYER.md).
 */
const NOT_SWEPT: Record<string, string> = {
    preview_workspace_skill_import:
        'bounded public GitHub reads and in-memory actor-bound preview cache; no durable writes or install',
    list_workspace_skills: 'read-only',
    read_workspace_skill: 'read-only',
    list_authorized_spaces: 'read-only',
    list_space_pages: 'read-only',
    recall: 'read-only',
    format_chart: 'pure bounded formatting, no reads or writes',
    list_improvements: 'read-only',
    list_issue_subscriptions: 'read-only',
    search_improvements: 'read-only',
    read_improvement: 'read-only',
    data_list: 'read-only but for data audit rows (writeSoon)',
    data_describe: 'read-only but for data audit rows (writeSoon)',
    data_query: 'read-only but for data audit rows (writeSoon)',
    files_get: 'read-only but for data audit rows (writeSoon)',
    files_list: 'read-only but for data audit rows (writeSoon)',
    attachments_list: 'read-only',
    attachments_view: 'read-only',
    schedule_list: 'read-only',
    goal_list: 'read-only',
    search_episodes: 'read-only (CB-180)',
    http_get: 'fetches outside URLs; its web audit row goes through writeSoon',
    http_json: 'fetches outside URLs; its web audit row goes through writeSoon',
    schedule_cancel: 'the same act path as schedule_pause / schedule_resume',
    app_snapshot: 'the broker command path app_open runs (its one write: a context audit row through writeSoon)',
    app_click: 'the broker command path app_open runs',
    app_type: 'the broker command path app_open runs',
    app_screenshot: 'the broker command path app_open runs; its image is saved as the swept attachment tools’ are',
    // CB-328: page knowledge graph tools. The writers go through the same
    // page repositories (uow) as create/edit_space_page, which are swept; the
    // readers read pages and the new page_tags/page_links tables (read-only).
    tag_page: 'writes page_tags through the page repository (uow), as create_space_page does',
    untag_page: 'writes page_tags through the page repository (uow), as edit_space_page does',
    list_pages_by_tag: 'read-only (page_tags join pages)',
    link_pages: 'writes page_links through the page repository (uow), as create_space_page does',
    unlink_pages: 'writes page_links through the page repository (uow), as edit_space_page does',
    list_links: 'read-only (page_links)',
    backlinks: 'read-only (page_links)',
    delete_space_page:
        'soft-deletes through the page repository (uow), as the swept page tools do; covered by tests/page-delete-tool.test.ts',
    unfurl_recursive:
        'creates pages through the page tools (uow) as unfurl_link (swept) does, plus tag/link writes through the page repositories; above the threshold, an approval request through the approvals unit (CB-492)',
    repo_extract:
        'CB-267: needs a listed repository and GitHub (a loopback fake in tests/gateway-extract.test.ts); every write is transaction(), the approvals unit or writeSoon',
    coding_status:
        'reads the session and its sandbox; its writes are a refusal’s sampled deny row (writeSoon) and, when access ended, the end coding_stop runs (swept)',
    coding_diff:
        'reads the sandbox; its writes are a refusal’s sampled deny row (writeSoon) and, when access ended, the end coding_stop runs (swept)',
    coding_open_pr:
        'opens a pull request on GitHub (outside service; a loopback fake in tests/coding-open-pr.test.ts); its one write is a transaction()',
    edit_own_soul:
        'CB-330: a socio edits its own Soul through SoulStore.saveSelf (transaction()), the same versioning the human soul routes use; covered by tests/soul.test.ts',
};

it('accounts for every registered socio tool: swept as a writer, or listed with why not', () => {
    const writers = new Set(
        [...board, ...others].flatMap(({ name }) => name.split(' / ').map((part) => part.split(' ')[0]!)),
    );
    // The sweep skips only what it lists.
    expect(skipped.map(([name]) => name)).toHaveLength(5);
    expect(registered.length).toBeGreaterThan(20);
    expect(registered.filter((name) => !writers.has(name) && !(name in NOT_SWEPT))).toEqual([]);
    // Every coding session tool is offered here and accounted for: the
    // sweep's platform has the supervisor (a fake).
    expect(
        CODING_TOOL_NAMES.filter((name) => !registered.includes(name) || !(writers.has(name) || name in NOT_SWEPT)),
    ).toEqual([]);
    // And the list stays true: nothing in it is swept, or gone.
    expect(Object.keys(NOT_SWEPT).filter((name) => writers.has(name) || !registered.includes(name))).toEqual([]);
});
