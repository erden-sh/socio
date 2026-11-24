import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { DotAgent } from './helpers/dot-agent.js';
import { Store, WorkspaceStore } from './helpers/stores.js';
import { testDatabase } from './helpers/test-database.js';

type Tool = { name: string; execute?: (input: unknown) => unknown };
const model = vi.hoisted(() => ({
    requests: [] as Array<{
        systemPrompts: string[];
        tools: Tool[];
        debug?: { logger: { error: (m: string, meta?: unknown) => void } };
    }>,
    // Runs inside the turn, while its tools are live.
    during: undefined as undefined | ((tools: Tool[]) => Promise<void>),
}));
// Stand in for the model call; the runtime's skill registry runs for real.
vi.mock('@tanstack/ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('@tanstack/ai')>();
    return {
        ...original,
        chat: (options: { systemPrompts: string[]; tools: Tool[] }) => {
            model.requests.push(options);
            return (async function* () {
                await model.during?.(options.tools);
                yield* [];
            })();
        },
    };
});

const databases: Array<{ close(): void }> = [];
afterEach(() => {
    databases.splice(0).forEach((db) => db.close());
    model.requests.length = 0;
    model.during = undefined;
    vi.restoreAllMocks();
});

function fixture(container: string | null, delivery: boolean) {
    const store = new Store(testDatabase());
    const workspace = new WorkspaceStore(testDatabase());
    databases.push(store, workspace);
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, {
        ...dot,
        learningContainerId: container,
        skillDeliveryEnabled: delivery,
    });
    workspace.bindThread('thread', dot.id, 'Test', 'alice');
    const agent = new DotAgent(
        store,
        workspace,
        {
            apiKey: 'fixture',
            model: 'fixture',
            baseUrl: 'https://unused.invalid',
        },
        dot.id,
    );
    const run = async () => {
        const input: RunAgentInput = {
            threadId: 'thread',
            runId: `run-${model.requests.length}`,
            state: {},
            messages: [{ id: 'u1', role: 'user', content: 'Write the report' }],
            tools: [],
            context: [],
            forwardedProps: {},
        };
        await lastValueFrom(agent.run(input).pipe(toArray()));
        return model.requests.at(-1)!;
    };
    return { workspace, run };
}
const catalog = (request: { systemPrompts: string[] }) =>
    request.systemPrompts.find((p) => p.includes('<copilotkit_learned_skills>'));
const names = (request: { tools: Tool[] }) => request.tools.map((t) => t.name);

it('delivers the fixture snapshot through a custom client into a Dot run', async () => {
    const f = fixture('fixture', true);
    const bytes = new Uint8Array(readFileSync('tests/fixtures/learning-skills.zip'));
    const served = vi.spyOn(f.workspace.skills, 'snapshot').mockReturnValue({
        status: 'snapshot',
        bytes,
        revision: 'fixture@1',
        etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        contentType: 'application/zip',
    });
    const request = await f.run();
    expect(served).toHaveBeenCalledWith('fixture');
    expect(catalog(request)).toContain('{"name":"weekly-report","description":"Write the weekly team report"}');
    expect(names(request)).toEqual(expect.arrayContaining(['copilotkit_load_skill', 'copilotkit_read_skill_file']));
});

it('serves published skills from the local store and loads them on request', async () => {
    const f = fixture('research', true);
    const revision = f.workspace.skills.saveRevision(
        'research',
        'cite-sources',
        'Cite primary sources',
        [{ path: 'SKILL.md', content: 'Link the primary source for every claim.' }],
        'alice',
    );
    // Nothing published yet: an empty catalog, and the turn still runs.
    expect(catalog(await f.run())).toBeUndefined();
    f.workspace.skills.publish(revision.id, 'alice');
    let loaded: unknown;
    model.during = async (tools) => {
        const load = tools.find((t) => t.name === 'copilotkit_load_skill')!;
        loaded = await load.execute!({ skill_name: 'cite-sources' });
    };
    const request = await f.run();
    expect(catalog(request)).toContain('"name":"cite-sources"');
    expect(JSON.parse(String(loaded))).toEqual({
        skill_name: 'cite-sources',
        content: 'Link the primary source for every claim.',
        files: [],
    });
});

it('delivers nothing when delivery is off or the thread has no container', async () => {
    const off = fixture('research', false);
    off.workspace.skills.publish(
        off.workspace.skills.saveRevision(
            'research',
            'cite-sources',
            'Cite',
            [{ path: 'SKILL.md', content: 'x' }],
            'alice',
        ).id,
        'alice',
    );
    const quiet = await off.run();
    expect(catalog(quiet)).toBeUndefined();
    expect(names(quiet)).not.toContain('copilotkit_load_skill');
    const none = fixture(null, false);
    expect(catalog(await none.run())).toBeUndefined();
});

it('keeps conversation content out of model-library error logs', async () => {
    const f = fixture(null, false);
    const request = await f.run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    request.debug!.logger.error('tool-args JSON parse failed', {
        rawArguments: '{"content":"private notes"}',
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('private notes');
    expect(JSON.stringify(errors.mock.calls)).toContain('tool-args JSON parse failed');
});
