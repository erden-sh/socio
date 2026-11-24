import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { PlatformConfig } from '../src/server/composition/config.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';

import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';
import { formatAs } from './support/format.js';

/**
 * The tools a Dot gets in a turn, by name and parameter schema (WORKSPACE-
 * SHELL step 9): moving a tool behind a module must not change what a Dot
 * is offered. The model's `chat` call is captured, so this is the list the
 * model really sees, whichever file a tool comes from.
 */
const seen = vi.hoisted(() => ({
    tools: [] as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
    }>,
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
        chat: (options: { tools: typeof seen.tools }) => {
            seen.tools = options.tools;
            return (async function* () {})();
        },
    };
});

const UUID = /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const BASE: PlatformConfig = {
    baseUrl: 'https://unused.invalid/v1',
    apiKey: 'fixture',
    model: 'fixture',
    voiceName: 'marin',
    runtimeUrl: '',
};

async function platformFor(extra: Partial<PlatformConfig>) {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'cb-dot-tools-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const config: PlatformConfig = {
        ...BASE,
        data: { userDataDir: dir },
        ...extra,
    };
    const { store, workspace, platform, dispose } = await makeTestRuntime({ config });
    cleanup.push(dispose);
    return { store, workspace, platform, config };
}

type Variant = {
    name: string;
    config: Partial<PlatformConfig>;
    /** Changes to the seeded Dot. */
    dot?: Parameters<WorkspaceStore['updateDot']>[1] extends infer D ? Partial<D> : never;
    channel?: boolean;
    /** The chat client offers the page review tool. */
    review?: boolean;
};
const SEARCH = {
    webSearchProvider: 'searxng' as const,
    searxngUrl: 'http://127.0.0.1:44140',
};
const COMPUTER = {
    computerSupervisorUrl: 'http://127.0.0.1:44141',
    computerSupervisorToken: 'fixture-supervisor',
    computerToken: 'fixture-computer',
};
const VARIANTS: Variant[] = [
    { name: 'seeded Dot, plain server', config: {} },
    {
        name: 'seeded Dot, plain server, page review offered',
        config: {},
        review: true,
    },
    { name: 'seeded Dot, search configured', config: SEARCH },
    { name: 'seeded Dot, computer configured', config: COMPUTER },
    {
        name: 'seeded Dot, search and computer configured, review offered',
        config: { ...SEARCH, ...COMPUTER },
        review: true,
    },
    {
        name: 'seeded Dot, research off',
        config: { ...SEARCH, ...COMPUTER },
        dot: { researchAllowed: false },
    },
    {
        name: 'seeded Dot allowed to file issues',
        config: { ...SEARCH, ...COMPUTER },
        dot: { issuesAllowed: true },
    },
    {
        name: 'seeded Dot on a channel',
        config: { ...SEARCH, ...COMPUTER },
        channel: true,
        review: true,
    },
];

// Zod schemas as JSON Schema; anything else (or nothing) as it is.
const schemaOf = (schema: unknown) =>
    schema && typeof schema === 'object' && '_zod' in schema ? z.toJSONSchema(schema as z.ZodType) : (schema ?? null);

async function toolsOf(variant: Variant) {
    const { store, workspace, platform, config } = await platformFor(variant.config);
    const seeded = workspace.dots();
    const dot = seeded[0]!;
    if (variant.dot) {
        workspace.updateDot(dot.id, { ...dot, ...variant.dot });
    }
    workspace.recordUser({ id: 'owner', name: 'Owner', role: 'member' });
    workspace.bindThread('thread', dot.id, 'Test', 'owner');
    seen.tools = [];
    const agent = new DotAgent(store, workspace, config, dot.id, variant.channel ?? false, undefined, {
        extensions: platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId: 'thread',
        runId: 'run',
        state: {},
        messages: [],
        tools: variant.review ? [{ name: 'review_space_page', description: 'Review', parameters: {} }] : [],
        context: [],
        forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    expect(events.map((event) => event.type)).not.toContain(EventType.RUN_ERROR);
    return {
        seeded: seeded.length,
        tools: seen.tools
            .map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: schemaOf(tool.inputSchema),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
}

it('offers each seeded Dot the same tools, with the same parameters', async () => {
    const lists: Record<string, unknown> = {};
    for (const variant of VARIANTS) {
        lists[variant.name] = await toolsOf(variant);
    }
    // Dot ids are random; the file is formatted as the repo's JSON is.
    const text = JSON.stringify(lists).replace(UUID, '<dot>');
    await expect(await formatAs('dot-tool-lists.json', text)).toMatchFileSnapshot(
        './__snapshots__/dot-tool-lists.json',
    );
});

it('has the tools a Dot is promised: pages, requests, web, computer', async () => {
    const { tools } = await toolsOf(VARIANTS[4]!);
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
        expect.arrayContaining([
            'list_authorized_spaces',
            'read_space_page',
            'request_capability',
            'http_get',
            'computer_snapshot',
            'search_web',
        ]),
    );
    expect(new Set(names).size).toBe(names.length);
});

it('keeps module tools out of the agent', () => {
    // The core tools (web search and page reading, which save the turn's
    // captures; learned skills) are the agent's own; every other tool is a
    // module's `dotTools`, reached through `DotExtensions`.
    const modules =
        /^\.\.\/(pages\/page|computers\/computer|issues\/request|web\/web)-tools|^\.\.\/web\/web-reads|^\.\.\/(dataspace|apps|schedules|issues|media|notifications)\//;
    for (const file of ['dot-agent.ts', 'contract.ts']) {
        const source = readFileSync(new URL(`../src/server/dots/${file}`, import.meta.url), 'utf8');
        const imports = [...source.matchAll(/from '(\.[^']*)'/g)].map((match) => match[1]!);
        expect(
            imports.filter((path) => modules.test(path)),
            file,
        ).toEqual([]);
    }
});
