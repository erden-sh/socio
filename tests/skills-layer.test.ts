// The skills' layer and the composition's step offer every skills tag on the
// connection's own repositories, with `/compact` over `ContextFitting` and
// `/unfurl`'s tools over `PageTools`.
import type { RunAgentInput } from '@ag-ui/core';
import { Context, Effect, Layer } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';

import { PageError } from '@socio/foundation/pages/page-error';

import { Approvals, type ApprovalsShape } from '../src/server/approvals/contract.js';
import { LegacyWorkspace } from '../src/server/composition/base.js';
import { skillsLayers } from '../src/server/composition/skills.js';
import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { ContextFitting, type ContextFittingShape } from '../src/server/context/contract.js';
import { contextFitting } from '../src/server/context/fit.js';
import { PageTools, type PageAccessInput, type PageToolsShape } from '../src/server/pages/contract.js';
import {
    Compact,
    SkillRegistry,
    SkillSessions,
    UnfurlTools,
    WorkspaceSkills,
    type CompactTurn,
    type UnfurlToolOptions,
} from '../src/server/skills/contract.js';
import { SkillsLive } from '../src/server/skills/layer.js';
import { ChatSkills } from '../src/server/skills/registry.js';
import { skillSessions, skillsRepository } from '../src/server/skills/repository.js';

import { testDatabase } from './helpers/test-database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const fn of cleanup.splice(0).reverse()) {
        fn();
    }
});

/** The approvals the skills register their capability with (CB-492). */
function approvals() {
    const registered: string[] = [];
    const shape = {
        register: (handler: { capability: string }) => {
            registered.push(handler.capability);
            return shape;
        },
    } as unknown as ApprovalsShape;
    return { shape, registered };
}

function database() {
    const db = testDatabase();
    cleanup.push(() => db.close());
    return db;
}

/** A `/compact` turn with no messages: only what the fitting gets matters. */
function compactTurn(threadId: string): CompactTurn {
    return {
        input: { threadId, runId: 'run', messages: [], tools: [], context: [], state: {}, forwardedProps: {} },
        messages: [],
        maxImages: 0,
        markers: { all: () => new Map() } as unknown as CompactTurn['markers'],
        adapter: {} as CompactTurn['adapter'],
        model: 'model',
        fit: {} as CompactTurn['fit'],
        signal: new AbortController().signal,
    } satisfies CompactTurn & { input: RunAgentInput };
}

it('offers the connection’s repositories, the registry over them, /compact and /unfurl over the tags it yields', async () => {
    const db = database();
    const compacted: string[] = [];
    const fitting: ContextFittingShape = {
        fit: (adapter) => adapter,
        compactNow: async (_adapter, _options, request) => {
            compacted.push((request as { threadId: string }).threadId);
            return { folded: 2, turns: 2 };
        },
    };
    const asked: PageAccessInput[] = [];
    const pages = {
        access: (input: PageAccessInput) => {
            asked.push(input);
            return {
                space: () => {
                    throw new PageError('This socio can’t use that Space.', 403);
                },
            };
        },
    } as unknown as PageToolsShape;

    const approved = approvals();
    const layer = SkillsLive(db).pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(ContextFitting, fitting),
                Layer.succeed(PageTools, pages),
                Layer.succeed(Approvals, approved.shape),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));

    // One repository of each per connection: the instances the module's hooks and the socios use.
    expect(Context.get(context, WorkspaceSkills)).toBe(skillsRepository(db));
    expect(Context.get(context, SkillSessions)).toBe(skillSessions(db));
    const registry = Context.get(context, SkillRegistry);
    expect(registry).toBeInstanceOf(ChatSkills);
    // A large `unfurl_recursive` asks on a card (CB-492): its capability, once.
    expect(approved.registered).toEqual(['unfurl.recursive']);
    await Context.get(context, WorkspaceSkills).save(
        { name: 'triage', description: 'Sort it', instructions: 'Sort the issue.', mode: 'turn' },
        'carol',
    );
    expect((await registry.list()).map((skill) => skill.name)).toContain('triage');

    // `/compact` goes through the fitting it was given.
    const said = await Context.get(context, Compact).compact(compactTurn('thread-1'));
    expect(compacted).toEqual(['thread-1']);
    expect(said).toBe('Compacted: 2 earlier turns folded into this chat’s notes.');

    // `/unfurl` asks the page tools for the turn's access before it reads anything.
    const check = () => {};
    const turn = { check, threadId: 'thread-1', dot: { spaceId: 'space-1' } } as unknown as UnfurlToolOptions['turn'];
    const tools = Context.get(context, UnfurlTools).unfurlTools({
        reads: {} as UnfurlToolOptions['reads'],
        media: {} as UnfurlToolOptions['media'],
        turn,
    });
    const link = tools[0];
    expect(link.name).toBe('unfurl_link');
    const result = await link.execute!(
        (link.parameters as z.ZodType).parse({ url: 'https://example.com/post' }) as never,
    );
    expect(result).toMatchObject({ error: 'This socio can’t use that Space.' });
    expect(asked).toEqual([{ spaceId: 'space-1', threadId: 'thread-1', check, usedBy: null }]);
});

it("builds the graph's step from the workspace's connection, over the graph's fitting and page tools", async () => {
    const db = database();
    // The context's and the pages' bridges, which the graph builds before this step.
    const layer = skillsLayers.bridges.pipe(
        Layer.provide(
            Layer.mergeAll(
                Layer.succeed(LegacyWorkspace, { db } as unknown as WorkspaceStore),
                Layer.succeed(ContextFitting, contextFitting),
                Layer.succeed(PageTools, {} as PageToolsShape),
                Layer.succeed(Approvals, approvals().shape),
            ),
        ),
    );
    const context = await Effect.runPromise(Layer.build(layer).pipe(Effect.scoped));
    expect(Context.get(context, WorkspaceSkills)).toBe(skillsRepository(db));
    expect(Context.get(context, SkillSessions)).toBe(skillSessions(db));
    expect(Context.get(context, SkillRegistry)).toBeInstanceOf(ChatSkills);
    expect(Object.keys(Context.get(context, Compact))).toEqual(['compact']);
    expect(Object.keys(Context.get(context, UnfurlTools))).toEqual(['unfurlTools', 'unfurlRecursiveTools']);
    // It yields what it reads of other features; it doesn't offer them again.
    expect(Context.getOption(context, ContextFitting)._tag).toBe('None');
    expect(Context.getOption(context, PageTools)._tag).toBe('None');
    expect(Context.getOption(context, Approvals)._tag).toBe('None');
});
