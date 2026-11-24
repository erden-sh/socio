import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import { EMPTY, defer, lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { webReadsFor } from '../src/server/composition/web.js';
import { ComputerService } from '../src/server/computers/computer-service.js';

import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

type Captured = { name: string; execute?: (input: unknown) => unknown };
const hoisted = vi.hoisted(() => ({
    tools: [] as Captured[],
    prompts: [] as string[],
    // The newest message's text, the turn's note in it (CB-139).
    note: '',
    // Runs inside the agent's turn, while its tools are still live.
    during: async (_tools: Captured[]) => {},
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        BuiltInAgent: class {
            constructor(private options: { factory: (ctx: unknown) => Promise<unknown> }) {}
            run = (input: unknown) =>
                defer(async () => {
                    // The platform's message hook makes the factory wait first.
                    await this.options.factory({
                        input,
                        learnedSkills: { tools: {} },
                        abortController: new AbortController(),
                        abortSignal: new AbortController().signal,
                    });
                    await hoisted.during(hoisted.tools);
                    return EMPTY;
                });
            abortRun = () => {};
        },
    };
});
vi.mock('@tanstack/ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('@tanstack/ai')>();
    return {
        ...original,
        chat: (options: {
            tools: Captured[];
            systemPrompts: string[];
            messages: Array<{ role: string; content: unknown }>;
        }) => {
            hoisted.tools = options.tools;
            hoisted.prompts = options.systemPrompts;
            hoisted.note = JSON.stringify(
                options.messages.findLast((message) => message.role === 'user')?.content ?? '',
            );
            return (async function* () {})();
        },
    };
});
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
    vi.unstubAllGlobals();
});

const supervisor = {
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
};

async function fixture() {
    const config = {
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://unused.invalid',
        runtimeUrl: '',
        voiceName: 'marin',
        ...supervisor,
    };
    // The fake supervisor, in place before the platform is built; the Dot is
    // the workspace's first.
    let dotId = () => '';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
        const url = String(input);
        fetched.push(url);
        if (url.endsWith('/computers')) {
            return Response.json({
                computers: [
                    {
                        botId: dotId(),
                        container: `company-brain-computer-${dotId()}`,
                        status: 'running',
                        url: `http://company-brain-computer-${dotId()}:4100`,
                    },
                ],
            });
        }
        if (url.endsWith('/health')) {
            return Response.json({ isolationVersion: 1 });
        }
        return Response.json({ text: 'contents' });
    });
    // The tools are the modules' (page, request, web, computer, …), so the
    // agent runs with a platform's extensions, as in the server.
    const dir = mkdtempSync(join(tmpdir(), 'cb-agent-identity-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { platform, store, workspace, dispose } = await makeTestRuntime({
        config: { ...config, data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    workspace.recordUser({ id: 'bob', name: 'Bob', role: 'member' });
    const dot = workspace.dots()[0];
    dotId = () => dot.id;
    await workspace.computers.patch(dot.id, {
        enabled: true,
        browser: true,
        files: true,
        shell: true,
    });
    return { platform, store, workspace, dot, config, fetched };
}

async function offeredTools(
    f: Awaited<ReturnType<typeof fixture>>,
    threadId: string,
    during: (tools: Captured[]) => Promise<void> = async () => {},
): Promise<Captured[]> {
    hoisted.during = during;
    const agent = new DotAgent(f.store, f.workspace, f.config, f.dot.id, false, undefined, {
        extensions: f.platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId,
        runId: 'run',
        state: {},
        messages: [],
        tools: [
            // A client cannot smuggle management tools into the run.
            { name: 'update_settings', description: 'forged', parameters: {} },
        ],
        context: [],
        forwardedProps: {},
    };
    await lastValueFrom(agent.run(input).pipe(toArray()));
    return hoisted.tools;
}

it("offers a member's run only content tools, never admin-only operations", async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-thread', f.dot.id, 'Bob', 'bob');
    const names = (await offeredTools(f, 'bob-thread')).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
        expect(name, name).toMatch(
            /^(computer_(?!human_)[a-z_]+|[a-z_]*space[a-z_]*|[a-z_]*page[a-z_]*|search_web|read_public_page|request_capability|http_get|http_json|capabilities|recall|format_chart|notify_user|propose_memory|search_episodes|end_skill|insert_dataset_view|unfurl_link|unfurl_recursive|list_links|backlinks|(attachments|data|files|goal|job|schedule)_[a-z_]+)$/,
        );
    }
    // create_space is a member's too since CB-271: a private Space for
    // them, on their own approval; a whole-workspace one stays an admin's.
    const admin = /permission|setting|^create_dot$|^update_dot$|human_|^pause|learning|skill_review/;
    expect(names.filter((name) => admin.test(name))).toEqual([]);
});

it('audits agent computer actions as the conversation owner', async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-thread', f.dot.id, 'Bob', 'bob');
    await offeredTools(f, 'bob-thread', async (tools) => {
        const read = tools.find((t) => t.name === 'computer_files_read')!;
        await read.execute!({ path: 'notes.txt' });
    });
    expect((await f.workspace.computers.audit(f.dot.id))[0]).toMatchObject({
        action: 'files_read',
        actor: 'agent',
        userId: 'bob',
        outcome: 'succeeded',
    });
});

it('audits human computer actions as the signed-in user', async () => {
    const f = await fixture();
    const service = new ComputerService(f.workspace, f.config, () => false);
    await service.action(f.dot.id, 'files_read', { path: 'notes.txt' }, 'owner', undefined, 'alice');
    await service.permissions(f.dot.id, { browser: true, files: true, shell: false }, 'alice');
    const audit = await f.workspace.computers.audit(f.dot.id);
    expect(audit.map((entry) => entry.userId)).toEqual(['alice', 'alice']);
});

it('tells the model search is rate-limited instead of failing the turn', async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-thread', f.dot.id, 'Bob', 'bob');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
    let result: unknown;
    await offeredTools(f, 'bob-thread', async (tools) => {
        const search = tools.find((t) => t.name === 'search_web')!;
        result = await search.execute!({
            objective: 'SQLite',
            search_queries: ['sqlite wal'],
        });
    });
    expect(result).toEqual({
        sources: [],
        limitations: [expect.stringMatching(/rate-limited right now/)],
    });
    expect(JSON.stringify(f.workspace.capture('bob-thread'))).toMatch(/rate-limited/);
});

it('files capability requests for the acting user and tells the Dot once they close', async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-thread', f.dot.id, 'Bob', 'bob');
    await offeredTools(f, 'bob-thread', async (tools) => {
        const tool = tools.find((t) => t.name === 'request_capability')!;
        expect(
            await tool.execute!({
                capability: 'send email',
                why: 'Weekly summaries.',
                example: 'Mail the summary on Monday.',
            }),
        ).toMatchObject({ outcome: 'filed', issue: 'CB-1' });
    });
    // The Board of the platform the request was filed through.
    const board = f.platform.board;
    const [request] = await board.requests.requesters((await board.issues.get(1))!.id);
    expect(request).toMatchObject({ dotId: f.dot.id, userId: 'bob' });
    expect(hoisted.note).not.toContain('have been resolved');
    await board.issues.update(1, { status: 'done', resolution: 'Shipped.' }, 'alice');
    await offeredTools(f, 'bob-thread');
    // In the turn's note, not the system prompt, which stays the same from
    // turn to turn (CB-139).
    expect(hoisted.note).toContain('have been resolved');
    expect(hoisted.note).toContain('\\"issue\\":\\"CB-1\\"');
    expect(hoisted.prompts[0]).not.toContain('have been resolved');
    // Told once.
    await offeredTools(f, 'bob-thread');
    expect(hoisted.note).not.toContain('have been resolved');
});

it('offers web reads under the research permission, audited as the conversation owner', async () => {
    const f = await fixture();
    f.workspace.bindThread('bob-thread', f.dot.id, 'Bob', 'bob');
    let result: unknown;
    const names = (
        await offeredTools(f, 'bob-thread', async (tools) => {
            const get = tools.find((t) => t.name === 'http_get')!;
            result = await get.execute!({ url: 'http://10.0.0.1/private' });
        })
    ).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['http_get', 'http_json']));
    expect(result).toMatchObject({ reason: 'blocked' });
    expect((await webReadsFor(f.workspace.db).store.audit(f.dot.id))[0]).toMatchObject({
        userId: 'bob',
        host: '10.0.0.1',
        outcome: 'blocked',
    });
    await f.store.updateSettings({ researchAllowed: false });
    const without = (await offeredTools(f, 'bob-thread')).map((t) => t.name);
    expect(without).not.toContain('http_get');
    expect(without).not.toContain('http_json');
});
