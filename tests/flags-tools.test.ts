import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import type { PlatformConfig } from '../src/server/composition/config.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';

import { DotAgent } from './helpers/dot-agent.js';
import type { Store } from './helpers/stores.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

/**
 * Socio tools follow feature flags (CB-169): the model's `chat` call is
 * captured, as in dot-tool-lists.test.ts, so this is the list the model
 * really sees, and the prompt's mention of those tools goes with them.
 */
const seen = vi.hoisted(() => ({
    tools: [] as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
    }>,
    prompts: [] as string[],
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        // Runs the turn's model factory, as the real agent does, and ends.
        BuiltInAgent: class {
            constructor(private options: ConstructorParameters<typeof original.BuiltInAgent>[0]) {}
            run = (input: RunAgentInput) =>
                new Observable<BaseEvent>((subscriber) => {
                    const abortController = new AbortController();
                    const { factory } = this.options as unknown as {
                        factory: (context: unknown) => Promise<unknown>;
                    };
                    factory({
                        input,
                        abortController,
                        abortSignal: abortController.signal,
                        learnedSkills: { tools: {}, catalog: '' },
                    }).then(
                        () => {
                            subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
                            subscriber.complete();
                        },
                        (error) => subscriber.error(error),
                    );
                });
            abortRun = () => {};
        },
    };
});
vi.mock('@tanstack/ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('@tanstack/ai')>();
    return {
        ...original,
        chat: (options: { tools: typeof seen.tools; systemPrompts?: string[] }) => {
            seen.tools = options.tools;
            seen.prompts = options.systemPrompts ?? [];
            return (async function* () {})();
        },
    };
});

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const CONFIG: PlatformConfig = {
    baseUrl: 'https://unused.invalid/v1',
    apiKey: 'fixture',
    model: 'fixture',
    voiceName: 'marin',
    runtimeUrl: '',
};

let turns = 0;
async function toolNames(
    platform: TestPlatform,
    store: Store,
    workspace: WorkspaceStore,
    config: PlatformConfig,
    userId: string,
) {
    const dot = workspace.dots()[0]!;
    const threadId = `thread-${userId}-${++turns}`;
    workspace.bindThread(threadId, dot.id, 'Test', userId);
    seen.tools = [];
    const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
        extensions: platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId,
        runId: `run-${userId}`,
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(events.map((event) => event.type)).not.toContain(EventType.RUN_ERROR);
    return {
        names: seen.tools.map((tool) => tool.name),
        prompt: seen.prompts.join('\n'),
    };
}

it('leaves a flag’s tools out of the turns of people it is off for', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-flag-tools-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { store, workspace, platform, config, dispose } = await makeTestRuntime({
        config: { ...CONFIG, data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'ana', name: 'Ana', role: 'member' });
    workspace.recordUser({ id: 'ben', name: 'Ben', role: 'member' });
    const before = await toolNames(platform, store, workspace, config, 'ana');
    expect(before.names).toEqual(expect.arrayContaining(['http_get', 'http_json']));
    expect(before.prompt).toContain('Use http_get or http_json');
    // An admin keeps web reads for Ben only.
    await platform.flags.setRule('tenant', 'web-reads', { enabled: false, roles: [], people: ['ben'] }, 'admin');
    const ana = await toolNames(platform, store, workspace, config, 'ana');
    expect(ana.names).not.toContain('http_get');
    expect(ana.names).not.toContain('http_json');
    // Only those tools: everything else stays.
    expect(ana.names.sort()).toEqual(before.names.filter((name) => !name.startsWith('http_')).sort());
    expect(ana.prompt).not.toContain('Use http_get or http_json');
    const ben = await toolNames(platform, store, workspace, config, 'ben');
    expect(ben.names).toEqual(expect.arrayContaining(['http_get', 'http_json']));
});
