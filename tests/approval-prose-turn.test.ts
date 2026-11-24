import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAgentInput } from '@ag-ui/core';
import type { ChatMiddleware, ModelMessage } from '@tanstack/ai';
import { from, lastValueFrom, mergeMap, of, toArray } from 'rxjs';
import { afterEach, expect, it, vi } from 'vitest';

import { isTurnNote } from '@socio/foundation/context/turn-note';

import { APPROVAL_GUIDE, APPROVAL_PROSE_CORRECTION } from '../src/server/dots/approval-prose.js';

import { DotAgent } from './helpers/dot-agent.js';
import { makeTestRuntime } from './helpers/test-runtime.js';

// CB-492: a socio's turn carries the rule (the system prompt), flags a final
// reply that asks for approval in prose with nothing waiting (a structured
// log line), and the next turn starts with the correction. The model is a
// fake: `chat` records what it is given and "answers" through the turn's
// middleware.
const hoisted = vi.hoisted(() => ({
    prompts: [] as string[],
    messages: [] as ModelMessage[],
    reply: '',
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
                    mergeMap(async (stream) => {
                        // Drain the fake model's stream, so its middleware runs.
                        for await (const _ of stream as AsyncIterable<unknown>) {
                            // nothing
                        }
                    }),
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
        chat: (options: { systemPrompts: string[]; messages: ModelMessage[]; middleware?: ChatMiddleware[] }) => {
            hoisted.prompts = options.systemPrompts;
            hoisted.messages = options.messages;
            // A stream with no chunks: the reply reaches the turn's middleware only.
            // oxlint-disable-next-line require-yield -- the fake model streams nothing
            return (async function* () {
                for (const middleware of options.middleware ?? []) {
                    await middleware.onFinish?.({} as never, {
                        finishReason: 'stop',
                        content: hoisted.reply,
                        duration: 0,
                    });
                }
            })();
        },
    };
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0).reverse()) {
        await fn();
    }
});

const config = {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: 'https://unused.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
};

async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'cb-approval-prose-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { store, workspace, platform, dispose } = await makeTestRuntime({
        config: { ...config, data: { userDataDir: dir } },
    });
    cleanup.push(dispose);
    workspace.recordUser({ id: 'ada', name: 'Ada', role: 'admin' });
    const dot = workspace.dots()[0];
    workspace.bindThread('chat', dot.id, 'Acme links', 'ada');
    const turn = async (runId: string, messages: RunAgentInput['messages']) => {
        const agent = new DotAgent(store, workspace, config, dot.id, false, undefined, {
            extensions: platform.dotExtensions,
        });
        await lastValueFrom(
            agent
                .run({ threadId: 'chat', runId, state: {}, messages, tools: [], context: [], forwardedProps: {} })
                .pipe(toArray()),
        );
        const newest = hoisted.messages.at(-1)!;
        const parts = Array.isArray(newest.content) ? newest.content : [];
        return {
            prompt: hoisted.prompts.join('\n'),
            note: parts[0] && isTurnNote(parts[0]) && parts[0].type === 'text' ? parts[0].content : '',
        };
    };
    return { dot, turn };
}

it('flags a prose approval ask, logs it, and corrects the next turn', async () => {
    const f = await fixture();
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        logged.push(String(line));
    });

    // The incident: the socio answers with a request for approval in text.
    hoisted.reply = 'Please approve the import of up to 20 linked pages to proceed.';
    const first = await turn(f, 'r1', [{ id: 'u1', role: 'user', content: 'Archive Acme’s reading list' }]);
    expect(first.prompt).toContain(APPROVAL_GUIDE);
    expect(first.note).not.toContain(APPROVAL_PROSE_CORRECTION);
    const flagged = logged.filter((line) => line.startsWith('Approvals: approval_prose'));
    expect(flagged).toEqual([
        `Approvals: approval_prose run="r1" thread="chat" dot="${f.dot.id}" pattern=please_approve`,
    ]);
    // No reply text in the log.
    expect(flagged[0]).not.toContain('linked pages');

    // The person types their approval: the turn is told to use the card.
    hoisted.reply = 'Done.';
    const second = await turn(f, 'r2', [
        { id: 'u1', role: 'user', content: 'Archive Acme’s reading list' },
        { id: 'a1', role: 'assistant', content: 'Please approve the import of up to 20 linked pages to proceed.' },
        { id: 'u2', role: 'user', content: 'You’re approved' },
    ]);
    expect(second.note).toContain(APPROVAL_PROSE_CORRECTION);
    expect(logged.filter((line) => line.startsWith('Approvals: approval_prose'))).toHaveLength(1);
});

it('neither flags nor corrects an ordinary reply', async () => {
    const f = await fixture();
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        logged.push(String(line));
    });
    hoisted.reply = 'Which of the two Acme pages should I update?';
    const turned = await turn(f, 'r1', [
        { id: 'u1', role: 'user', content: 'Update the Acme page' },
        { id: 'a1', role: 'assistant', content: 'Ada approved the import yesterday.' },
        { id: 'u2', role: 'user', content: 'Ok' },
    ]);
    expect(turned.note).not.toContain(APPROVAL_PROSE_CORRECTION);
    expect(logged.filter((line) => line.startsWith('Approvals: approval_prose'))).toEqual([]);
});

const turn = (f: Awaited<ReturnType<typeof fixture>>, runId: string, messages: RunAgentInput['messages']) =>
    f.turn(runId, messages);
