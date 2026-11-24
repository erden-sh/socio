import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import type { ContentPart, ModelMessage } from '@tanstack/ai';
import { from, lastValueFrom, mergeMap, of, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { isTurnNote, withTurnNote } from '@socio/foundation/context/turn-note';
import { RUN_TRACE_EVENT } from '@socio/shared/runs/run-trace';

import type { AppWorkspace as WorkspaceStore } from '../src/server/composition/workspace-parts.js';
import { messageReactions } from '../src/server/context/reactions.js';

import { DotAgent } from './helpers/dot-agent.js';
import type { Store } from './helpers/stores.js';
import type { TestPlatform } from './helpers/test-platform.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-133: a Dot's turn is told of reactions since its last turn, once,
// just before the person's newest message (not in the system prompt, whose
// start stays the same from turn to turn), and the turn's trace records
// how many.
const hoisted = vi.hoisted(() => ({
    prompts: [] as string[],
    messages: [] as ModelMessage[],
}));
vi.mock('@copilotkit/runtime/v2', async (importOriginal) => {
    const original = await importOriginal<typeof import('@copilotkit/runtime/v2')>();
    return {
        ...original,
        BuiltInAgent: class {
            constructor(private options: { factory: (ctx: unknown) => Promise<unknown> }) {}
            run = (input: unknown) => {
                const { threadId, runId } = input as RunAgentInput;
                return from(
                    this.options.factory({
                        input,
                        learnedSkills: { tools: {} },
                        abortController: new AbortController(),
                        abortSignal: new AbortController().signal,
                    }),
                ).pipe(
                    mergeMap(() =>
                        of({ type: 'RUN_STARTED', threadId, runId }, { type: 'RUN_FINISHED', threadId, runId }),
                    ),
                );
            };
            abortRun = () => {};
        },
    };
});
vi.mock('@tanstack/ai', async (importOriginal) => {
    const original = await importOriginal<typeof import('@tanstack/ai')>();
    return {
        ...original,
        chat: (options: { systemPrompts: string[]; messages: ModelMessage[] }) => {
            hoisted.prompts = options.systemPrompts;
            hoisted.messages = options.messages;
            return (async function* () {})();
        },
    };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

async function turn(store: Store, workspace: WorkspaceStore, platform: TestPlatform, dotId: string, runId: string) {
    const agent = new DotAgent(store, workspace, config, dotId, false, undefined, {
        extensions: platform.dotExtensions,
    });
    const input: RunAgentInput = {
        threadId: 'chat',
        runId,
        state: {},
        messages: [
            { id: 'u1', role: 'user', content: 'Earlier question' },
            { id: 'a1', role: 'assistant', content: 'Here is the plan.' },
            { id: `u-${runId}`, role: 'user', content: 'And now?' },
        ],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    const events = await lastValueFrom(agent.run(input).pipe(toArray()));
    const newest = hoisted.messages.at(-1)!;
    const parts = Array.isArray(newest.content) ? newest.content : [];
    // The system prompt never has it.
    expect(hoisted.prompts.join('\n')).not.toContain('Reactions to your');
    expect(newest.role).toBe('user');
    return {
        // The note, when there is one, then the person's own words (after the
        // turn's time marker, CB-141).
        prompt: parts[0] && isTurnNote(parts[0]) && parts[0].type === 'text' ? parts[0].content : '',
        newest:
            typeof newest.content === 'string'
                ? newest.content
                : parts.at(-1)?.type === 'text'
                  ? (parts.at(-1) as { content: string }).content
                  : '',
        earlier: JSON.stringify(hoisted.messages.slice(0, -1)),
        traced: events.filter(
            (event) =>
                event.type === 'CUSTOM' &&
                (event as { name?: string }).name === RUN_TRACE_EVENT &&
                (event as { value?: { kind?: string } }).value?.kind === 'reactions',
        ) as unknown as Array<{ value: unknown }>,
    };
}
const config = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://unused.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
};

it('tells the next turn of new reactions only, once, and traces their counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cb-reactions-'));
    cleanup.push(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: {
            ...config,
            data: { userDataDir: dir },
        },
    });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'alice', name: 'Alice', role: 'admin' });
    const dot = workspace.dots()[0];
    workspace.bindThread('chat', dot.id, 'Plans', 'alice');
    const reactions = messageReactions(workspace.db);
    const message = {
        at: Date.UTC(2026, 9, 21, 14, 2),
        text: 'Here is the plan.',
    };

    // Nothing reacted to: nothing in the prompt, nothing traced.
    const none = await turn(store, workspace, platform, dot.id, 'r0');
    expect(none.prompt).not.toContain('Reactions to your messages');
    expect(none.newest).toBe('And now?');
    expect(none.traced).toEqual([]);

    reactions.add('chat', 'a1', 'alice', 'down', message);
    reactions.add('chat', 'a1', 'alice', 'needs-work', message);
    const first = await turn(store, workspace, platform, dot.id, 'r1');
    expect(first.prompt).toContain('Reactions to your messages since your last turn');
    expect(first.prompt).toContain('{"reaction":"👎 down","message":"Here is the plan.","at":"2026-10-21T14:02Z"}');
    expect(first.prompt).toContain('🛠 needs-work');
    expect(first.newest).toBe('And now?');
    expect(first.earlier).not.toContain('Reactions to your');
    expect(first.traced.map((event) => event.value)).toMatchObject([
        { kind: 'reactions', counts: { down: 1, 'needs-work': 1 } },
    ]);

    // Told once.
    const second = await turn(store, workspace, platform, dot.id, 'r2');
    expect(second.prompt).not.toContain('Reactions to your messages');
    expect(second.traced).toEqual([]);

    // Then only what is new since.
    reactions.add('chat', 'a2', 'alice', 'retry', message);
    const third = await turn(store, workspace, platform, dot.id, 'r3');
    expect(third.prompt).toContain('🔁 retry');
    expect(third.prompt).not.toContain('👎');
    expect(third.traced.map((event) => event.value)).toMatchObject([{ counts: { retry: 1 } }]);
});

it('puts a turn note just before the newest words of the person, in their message', () => {
    const note = 'Reactions to your messages since your last turn: …';
    const image = {
        type: 'image' as const,
        source: { type: 'url' as const, value: 'https://unused.invalid/a.png' },
    };
    const messages: ModelMessage[] = [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
        { role: 'user', content: [{ type: 'text', content: 'Look' }, image] },
        { role: 'assistant', content: null, toolCalls: [] },
    ];
    const noted = withTurnNote(messages, note);
    // Only the newest message from the person changes, and nothing moves.
    expect(noted).toHaveLength(4);
    expect(noted[0]).toBe(messages[0]);
    expect(noted[3]).toBe(messages[3]);
    const parts = noted[2].content as ContentPart[];
    expect(parts.map((part) => part.type)).toEqual(['text', 'text', 'image']);
    expect(isTurnNote(parts[0])).toBe(true);
    expect(parts[0]).toMatchObject({ content: note });
    expect(isTurnNote(parts[1])).toBe(false);
    // A plain message becomes the note and its words.
    expect(withTurnNote(messages.slice(0, 1), note)[0].content).toEqual([
        expect.objectContaining({ content: note }),
        { type: 'text', content: 'First' },
    ]);
    // No message from the person: the note is one of its own.
    expect(withTurnNote([], note)).toEqual([{ role: 'user', content: [expect.objectContaining({ content: note })] }]);
    // No note, nothing changes.
    expect(withTurnNote(messages, '')).toBe(messages);
    // A second note joins the first, in the same part (CB-139).
    const twice = withTurnNote(noted, 'More.')[2].content as ContentPart[];
    expect(twice).toHaveLength(3);
    expect(twice[0]).toMatchObject({ content: `${note}\n\nMore.` });
    expect(isTurnNote(twice[0])).toBe(true);
});
